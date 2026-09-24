import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { localHistoryDatabasePath } from './local-history-paths.mjs';

export const DEFAULT_MEAL_RETENTION_DAYS = 180;
const MAX_RETENTION_DAYS = 3650;

function nowIso(now) { return new Date(now()).toISOString(); }
function parse(value) { return value == null ? null : JSON.parse(value); }
function value(value) { return JSON.stringify(value); }
function checkDays(days) {
  if (!Number.isInteger(days) || days < 1 || days > MAX_RETENTION_DAYS) throw coded('INVALID_RETENTION', `餐食保留天数必须在 1 到 ${MAX_RETENTION_DAYS} 之间`);
  return days;
}
function coded(code, message) { const error = new Error(message); error.code = code; return error; }
function requireId(value, field = 'requestId') {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(value)) throw coded('INVALID_REQUEST', `${field} 必须是 8–128 位字母、数字、下划线或短横线`);
  return value;
}

export function createLocalHistoryStore({ databasePath = localHistoryDatabasePath(), now = Date.now } = {}) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(databasePath);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS profile (
      id INTEGER PRIMARY KEY CHECK (id = 1), profile_json TEXT NOT NULL,
      revision INTEGER NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meals (
      meal_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, local_date TEXT NOT NULL,
      timezone TEXT NOT NULL, meal_type TEXT NOT NULL, confirmed_items TEXT NOT NULL,
      result_json TEXT NOT NULL, domain_version TEXT NOT NULL, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS meals_by_date ON meals(local_date, expires_at);
    CREATE TABLE IF NOT EXISTS operations (
      request_id TEXT PRIMARY KEY, kind TEXT NOT NULL, target_id TEXT, response_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  const readSetting = (key, fallback = null) => parse(db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value) ?? fallback;
  const writeSetting = (key, data) => db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value(data));
  if (!readSetting('config')) writeSetting('config', { profileMemory: false, mealRecording: false, mealRetentionDays: DEFAULT_MEAL_RETENTION_DAYS, consentRevision: 0 });

  function config() { return readSetting('config'); }
  function requireProfileMemory() { if (!config().profileMemory) throw coded('PROFILE_MEMORY_DISABLED', '用户尚未同意在本机保存基础档案'); }
  function requireMealRecording() { if (!config().mealRecording) throw coded('MEAL_RECORDING_DISABLED', '用户尚未同意保存餐食记录'); }
  function profileRow() { return db.prepare('SELECT profile_json, revision, updated_at FROM profile WHERE id = 1').get(); }
  function operation(requestId) { return db.prepare('SELECT response_json FROM operations WHERE request_id = ?').get(requestId); }
  function rememberOperation(requestId, kind, targetId, response) {
    db.prepare('INSERT INTO operations (request_id, kind, target_id, response_json, created_at) VALUES (?, ?, ?, ?, ?)').run(requestId, kind, targetId, value(response), nowIso(now));
  }
  function cleanupExpired() {
    const response = db.prepare('DELETE FROM meals WHERE expires_at <= ?').run(nowIso(now));
    return response.changes;
  }

  return {
    databasePath,
    status() {
      cleanupExpired();
      const row = profileRow(); const current = config();
      return { code: 'OK', storage: 'local-sqlite', profileMemory: current.profileMemory, mealRecording: current.mealRecording,
        mealRetentionDays: current.mealRetentionDays, profile: row ? { exists: true, revision: row.revision, updatedAt: row.updated_at } : { exists: false },
        mealCount: Number(db.prepare('SELECT COUNT(*) AS count FROM meals').get().count) };
    },
    configure({ profileMemory, mealRecording, mealRetentionDays = undefined }) {
      const current = config();
      if (typeof profileMemory !== 'boolean' || typeof mealRecording !== 'boolean') throw coded('INVALID_CONFIG', 'profileMemory 和 mealRecording 必须为布尔值');
      const next = { ...current, profileMemory, mealRecording, mealRetentionDays: mealRetentionDays === undefined ? current.mealRetentionDays : checkDays(mealRetentionDays), consentRevision: current.consentRevision + 1 };
      writeSetting('config', next);
      return this.status();
    },
    getProfile({ details = false } = {}) {
      requireProfileMemory(); const row = profileRow();
      if (!row) return { code: 'PROFILE_NOT_FOUND', profile: null };
      const profile = parse(row.profile_json);
      if (details) return { code: 'OK', profile, revision: row.revision, updatedAt: row.updated_at };
      const required = ['gender', 'age', 'heightCm', 'weightKg', 'activityLevel', 'goal'];
      return { code: 'OK', profile: { fields: Object.keys(profile), missingFields: required.filter((field) => !(field in profile)), revision: row.revision, updatedAt: row.updated_at } };
    },
    saveProfile({ profile, expectedRevision = undefined, requestId }) {
      requireProfileMemory(); requireId(requestId); if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw coded('INVALID_PROFILE', 'profile 必须是对象');
      const existing = operation(requestId); if (existing) return parse(existing.response_json);
      const row = profileRow();
      if (expectedRevision !== undefined && (!Number.isInteger(expectedRevision) || expectedRevision !== (row?.revision ?? 0))) throw coded('PROFILE_CONFLICT', '档案已在其他会话更新，请重新读取后再保存');
      const revision = (row?.revision ?? 0) + 1; const updatedAt = nowIso(now);
      db.prepare('INSERT INTO profile (id, profile_json, revision, updated_at) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET profile_json = excluded.profile_json, revision = excluded.revision, updated_at = excluded.updated_at').run(value(profile), revision, updatedAt);
      const response = { code: 'OK', revision, updatedAt }; rememberOperation(requestId, 'save_profile', 'profile', response); return response;
    },
    saveMeal({ mealId = crypto.randomUUID(), expectedRevision = undefined, localDate, timezone, mealType, confirmedItems, result, domainVersion, requestId }) {
      requireMealRecording(); requireId(requestId); if (typeof localDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(localDate)) throw coded('INVALID_MEAL', 'localDate 必须为 YYYY-MM-DD');
      if (typeof timezone !== 'string' || timezone.length > 64 || typeof mealType !== 'string' || !Array.isArray(confirmedItems) || !result || typeof result !== 'object') throw coded('INVALID_MEAL', '餐食记录格式不正确');
      const existingOperation = operation(requestId); if (existingOperation) return parse(existingOperation.response_json);
      const existing = db.prepare('SELECT revision FROM meals WHERE meal_id = ?').get(mealId);
      if (existing && expectedRevision !== existing.revision) throw coded('MEAL_CONFLICT', '餐食已更新，请重新读取后再修订');
      if (!existing && expectedRevision !== undefined) throw coded('MEAL_CONFLICT', '该餐食不存在，不能按修订保存');
      const revision = (existing?.revision ?? 0) + 1; const updatedAt = nowIso(now); const days = config().mealRetentionDays;
      const expiresAt = new Date(now() + days * 86_400_000).toISOString();
      db.prepare(`INSERT INTO meals (meal_id, revision, local_date, timezone, meal_type, confirmed_items, result_json, domain_version, created_at, updated_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(meal_id) DO UPDATE SET revision = excluded.revision, local_date = excluded.local_date, timezone = excluded.timezone, meal_type = excluded.meal_type, confirmed_items = excluded.confirmed_items, result_json = excluded.result_json, domain_version = excluded.domain_version, updated_at = excluded.updated_at, expires_at = excluded.expires_at`)
        .run(mealId, revision, localDate, timezone, mealType, value(confirmedItems), value(result), domainVersion, existing ? db.prepare('SELECT created_at FROM meals WHERE meal_id = ?').get(mealId).created_at : updatedAt, updatedAt, expiresAt);
      const response = { code: 'OK', mealId, revision, expiresAt }; rememberOperation(requestId, 'save_meal', mealId, response); return response;
    },
    listMeals({ startDate, endDate, limit = 50 } = {}) {
      requireMealRecording(); cleanupExpired(); if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw coded('INVALID_LIST', 'limit 必须在 1 到 50 之间');
      const rows = db.prepare(`SELECT meal_id, revision, local_date, timezone, meal_type, confirmed_items, result_json, domain_version, updated_at, expires_at FROM meals
        WHERE (? IS NULL OR local_date >= ?) AND (? IS NULL OR local_date <= ?) ORDER BY local_date DESC, updated_at DESC LIMIT ?`).all(startDate ?? null, startDate ?? null, endDate ?? null, endDate ?? null, limit);
      return { code: 'OK', meals: rows.map((row) => ({ mealId: row.meal_id, revision: row.revision, localDate: row.local_date, timezone: row.timezone, mealType: row.meal_type, confirmedItems: parse(row.confirmed_items), result: parse(row.result_json), domainVersion: row.domain_version, updatedAt: row.updated_at, expiresAt: row.expires_at })) };
    },
    getDayReview({ localDate }) {
      requireMealRecording(); cleanupExpired(); if (typeof localDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(localDate)) throw coded('INVALID_DATE', 'localDate 必须为 YYYY-MM-DD');
      const meals = this.listMeals({ startDate: localDate, endDate: localDate }).meals;
      const totals = meals.reduce((sum, meal) => {
        const nutrition = meal.result?.mealNutrition || {};
        for (const field of ['calories', 'proteinG', 'fatG', 'carbsG', 'fiberG', 'sodiumMg']) sum[field] += Number(nutrition[field] || 0);
        return sum;
      }, { calories: 0, proteinG: 0, fatG: 0, carbsG: 0, fiberG: 0, sodiumMg: 0 });
      return { code: 'OK', localDate, recordedMeals: meals.length, totals, meals };
    },
    exportData({ scope }) {
      if (!['profile', 'meals', 'all'].includes(scope)) throw coded('INVALID_EXPORT', 'scope 必须为 profile、meals 或 all');
      cleanupExpired();
      const row = profileRow();
      const meals = db.prepare('SELECT meal_id, revision, local_date, timezone, meal_type, confirmed_items, result_json, domain_version, updated_at, expires_at FROM meals WHERE expires_at > ? ORDER BY local_date DESC, updated_at DESC LIMIT 50').all(nowIso(now)).map((meal) => ({ mealId: meal.meal_id, revision: meal.revision, localDate: meal.local_date, timezone: meal.timezone, mealType: meal.meal_type, confirmedItems: parse(meal.confirmed_items), result: parse(meal.result_json), domainVersion: meal.domain_version, updatedAt: meal.updated_at, expiresAt: meal.expires_at }));
      const payload = { format: 'chichulaide-local-history/1', exportedAt: nowIso(now), scope,
        ...(scope === 'profile' || scope === 'all' ? { profile: row ? parse(row.profile_json) : null } : {}),
        ...(scope === 'meals' || scope === 'all' ? { meals } : {}) };
      const directory = path.join(path.dirname(databasePath), 'exports');
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const file = path.join(directory, `eatwise-export-${payload.exportedAt.replace(/[:.]/g, '-')}.json`);
      fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      return { code: 'OK', scope, file, mealCount: meals.length, hasProfile: Boolean(row) };
    },
    deleteData({ scope, requestId }) {
      requireId(requestId); if (!['profile', 'meals', 'all'].includes(scope)) throw coded('INVALID_DELETE', 'scope 必须为 profile、meals 或 all');
      const existing = operation(requestId); if (existing) return parse(existing.response_json);
      db.exec('BEGIN IMMEDIATE');
      try {
        if (scope === 'profile' || scope === 'all') db.prepare('DELETE FROM profile').run();
        if (scope === 'meals' || scope === 'all') db.prepare('DELETE FROM meals').run();
        if (scope === 'all') writeSetting('config', { profileMemory: false, mealRecording: false, mealRetentionDays: DEFAULT_MEAL_RETENTION_DAYS, consentRevision: config().consentRevision + 1 });
        const response = { code: 'OK', scope }; rememberOperation(requestId, 'delete', scope, response); db.exec('COMMIT'); return response;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    close() { db.close(); },
  };
}
