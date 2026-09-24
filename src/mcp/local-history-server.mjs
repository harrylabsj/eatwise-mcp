#!/usr/bin/env node
import crypto from 'node:crypto';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createLocalHistoryStore } from './local-history-store.mjs';
import { buildConfirmedMealReview } from './confirmed-meal.mjs';
import { validateProfile, validateProfilePatch } from '../workbuddy/profile.mjs';

const SERVER_NAME = 'chichulaide-history-local';
const SERVER_VERSION = '0.2.0';
const PROTOCOL_VERSION = '2025-03-26';
const PROFILE_FIELDS = new Set(['gender', 'age', 'heightCm', 'weightKg', 'activityLevel', 'goal', 'targetWeightKg', 'healthRisks', 'lifeStage']);

export const LOCAL_HISTORY_TOOLS = [
  { name: 'history_status', description: '查看本机 SQLite 档案与餐食记录的授权和可用状态，不返回身体资料。', inputSchema: schema({}), annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'configure_local_storage', description: '只在用户明确选择后，启用或关闭本机档案记忆、餐食记录，并设置餐食保留天数（默认 180 天）。关闭不删除既有数据，删除请使用 delete_local_data。', inputSchema: schema({ profileMemory: { type: 'boolean' }, mealRecording: { type: 'boolean' }, mealRetentionDays: { type: 'integer', minimum: 1, maximum: 3650 } }, ['profileMemory', 'mealRecording']), annotations: { readOnlyHint: false, openWorldHint: false } },
  { name: 'get_profile', description: '读取已授权的本机基础档案。summary 只返回资料完整度；details 仅在用户要求查看本人资料时使用。', inputSchema: schema({ view: { type: 'string', enum: ['summary', 'details'] } }), annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'update_profile', description: '保存或更新用户明确提供的基础档案。partial 只更新给出的字段；expectedRevision 用于避免覆盖另一个对话的更新。', inputSchema: schema({ patch: { type: 'object' }, expectedRevision: { type: 'integer', minimum: 0 }, requestId: requestIdSchema() }, ['patch', 'requestId']), annotations: { readOnlyHint: false, openWorldHint: false } },
  { name: 'review_and_save_meal', description: '对用户已明确确认的餐食用本机档案确定性重算。save=true 仅在用户授权保存餐食且已确认食物和份量时使用；修订同一餐时传 mealId 和 expectedRevision。', inputSchema: schema({ mealText: { type: 'string', minLength: 1, maxLength: 2000 }, mealType: { type: 'string', enum: ['breakfast', 'lunch', 'dinner', 'snack', 'lateNight'] }, confirmedItems: { type: 'array', minItems: 1, maxItems: 50 }, localDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, timezone: { type: 'string', minLength: 1, maxLength: 64 }, confirmed: { type: 'boolean' }, save: { type: 'boolean' }, mealId: { type: 'string', minLength: 8, maxLength: 128 }, expectedRevision: { type: 'integer', minimum: 1 }, requestId: requestIdSchema(), profileOverride: { type: 'object' } }, ['mealText', 'mealType', 'confirmedItems', 'localDate', 'timezone', 'confirmed', 'save']), annotations: { readOnlyHint: false, openWorldHint: false } },
  { name: 'list_meals', description: '读取当前用户在本机已保存的餐食记录，默认最多 50 条。', inputSchema: schema({ startDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, endDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, limit: { type: 'integer', minimum: 1, maximum: 50 } }), annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'get_day_review', description: '汇总指定日期已保存的确认餐食；只有已记录的餐食会计入，不能据此断言当天记录完整。', inputSchema: schema({ localDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } }, ['localDate']), annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'export_local_data', description: '仅在用户明确要求导出时，生成本机 JSON 数据文件并返回其路径。', inputSchema: schema({ scope: { type: 'string', enum: ['profile', 'meals', 'all'] } }, ['scope']), annotations: { readOnlyHint: false, openWorldHint: false } },
  { name: 'delete_local_data', description: '删除本机档案、餐食或全部数据。只能在用户明确确认删除范围后调用。', inputSchema: schema({ scope: { type: 'string', enum: ['profile', 'meals', 'all'] }, requestId: requestIdSchema() }, ['scope', 'requestId']), annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } },
];

function schema(properties, required = []) { return { type: 'object', additionalProperties: false, properties, required }; }
function requestIdSchema() { return { type: 'string', minLength: 8, maxLength: 128, pattern: '^[A-Za-z0-9_-]+$' }; }
function error(code, message) { const result = new Error(message); result.code = code; return result; }
function assertObject(value, label) { if (!value || typeof value !== 'object' || Array.isArray(value)) throw error('BAD_ARGUMENTS', `${label} 必须是对象`); return value; }
function dateValid(value) { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value; }

function defaultStore() {
  return createLocalHistoryStore({ databasePath: process.env.CHICHULAIDE_LOCAL_HISTORY_PATH || undefined });
}

export function createLocalHistoryService({ store = defaultStore() } = {}) {
  async function call(name, raw = {}) {
    const args = assertObject(raw, 'arguments');
    if (name === 'history_status') return store.status();
    if (name === 'configure_local_storage') return store.configure(args);
    if (name === 'get_profile') return store.getProfile({ details: args.view === 'details' });
    if (name === 'update_profile') {
      const current = store.getProfile({ details: true });
      const patch = assertObject(args.patch, 'patch');
      if (Object.keys(patch).some((key) => !PROFILE_FIELDS.has(key))) throw error('INVALID_PROFILE', 'patch 包含不允许的字段');
      const merged = { ...(current.profile || {}), ...validateProfilePatch(patch) };
      return store.saveProfile({ profile: merged, expectedRevision: args.expectedRevision, requestId: args.requestId });
    }
    if (name === 'review_and_save_meal') {
      if (!dateValid(args.localDate)) throw error('INVALID_MEAL', 'localDate 必须为有效 YYYY-MM-DD');
      if (args.confirmed !== true) throw error('MEAL_NOT_CONFIRMED', '用户尚未确认食物和份量，不能计算或保存餐食');
      let savedProfile;
      try { savedProfile = store.getProfile({ details: true }).profile; } catch (cause) {
        if (!args.profileOverride) throw cause;
      }
      const profile = validateProfile(args.profileOverride || savedProfile || {});
      const reviewed = buildConfirmedMealReview({ profile, mealText: args.mealText, mealType: args.mealType, confirmedItems: args.confirmedItems });
      if (reviewed.result.safety?.level === 'refer') return { code: 'SAFETY_REFERRAL', result: reviewed.result };
      if (!args.save) return { code: 'OK', saved: false, result: reviewed.result, confirmedItems: reviewed.confirmedItems };
      if (!args.requestId) throw error('INVALID_REQUEST', '保存餐食必须提供 requestId');
      const saved = store.saveMeal({ mealId: args.mealId, expectedRevision: args.expectedRevision, localDate: args.localDate, timezone: args.timezone, mealType: args.mealType, confirmedItems: reviewed.confirmedItems, result: reviewed.result, domainVersion: '0.4.0', requestId: args.requestId });
      return { ...saved, saved: true, result: reviewed.result };
    }
    if (name === 'list_meals') return store.listMeals(args);
    if (name === 'get_day_review') return store.getDayReview(args);
    if (name === 'export_local_data') return store.exportData(args);
    if (name === 'delete_local_data') return store.deleteData(args);
    throw error('TOOL_NOT_FOUND', `未知工具：${name}`);
  }
  return { store, call, close: () => store.close() };
}

function response(id, result) { process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`); }
function toolResponse(id, result) { response(id, { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, ...(result?.code && result.code !== 'OK' ? { isError: true } : {}) }); }
function rpcError(id, code, message) { process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } })}\n`); }
export function startStdio(service = createLocalHistoryService()) {
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n'); buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let request;
      try { request = JSON.parse(line); } catch { rpcError(null, -32700, 'Parse error'); continue; }
      if (request?.id === undefined) continue;
      if (request.method === 'initialize') { response(request.id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: { listChanged: false } }, serverInfo: { name: SERVER_NAME, version: SERVER_VERSION } }); continue; }
      if (request.method === 'ping') { response(request.id, {}); continue; }
      if (request.method === 'tools/list') { response(request.id, { tools: LOCAL_HISTORY_TOOLS }); continue; }
      if (request.method !== 'tools/call') { rpcError(request.id, -32601, 'Method not found'); continue; }
      service.call(request.params?.name, request.params?.arguments).then((result) => toolResponse(request.id, result)).catch((cause) => toolResponse(request.id, { code: cause.code || 'TOOL_ERROR', message: cause.message || '工具执行失败' }));
    }
  });
  return service;
}

// npm exposes bin commands through symlinks; resolve them before comparing.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) startStdio();
