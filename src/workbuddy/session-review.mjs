import { isDeepStrictEqual } from 'node:util';
import { buildMealReview } from './meal-review.mjs';
import { addNutrition, emptyNutrition } from './nutrition.mjs';

function invalid(message) {
  const error = new Error(message);
  error.statusCode = 400;
  throw error;
}

function object(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${label} 必须是对象`);
  if (Object.keys(value).some((key) => !allowed.includes(key))) invalid(`${label} 含未知字段`);
}

function entry(value) {
  object(value, ['mealId', 'revision', 'input'], 'entry');
  if (typeof value.mealId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value.mealId)) invalid('mealId 必须是 1–64 位字母、数字、下划线或短横线');
  if (!Number.isSafeInteger(value.revision) || value.revision < 1) invalid('revision 必须是正整数');
  object(value.input, ['mealText', 'mealType', 'items', 'source', 'confirmed'], 'entry.input');
  if (value.input.confirmed !== true) invalid('会话累计只接受已确认餐食 confirmed=true');
  return value;
}

// Stateless round-trip: the host keeps the returned session in conversation
// context. Never reads/writes user files or trusts model-generated totals.
export function reviewSession(input) {
  object(input, ['date', 'meal', 'session', 'mode', 'profile', 'safetyContext', 'dayComplete'], 'session-review');
  if (typeof input.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.date)) invalid('date 必须是已确认的 YYYY-MM-DD');
  const date = new Date(`${input.date}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== input.date) invalid('date 不是有效日期');
  if (input.dayComplete !== undefined && typeof input.dayComplete !== 'boolean') invalid('dayComplete 必须是布尔值');
  const previous = input.session ?? { date: input.date, entries: [] };
  object(previous, ['date', 'entries'], 'session');
  if (previous.date !== input.date) invalid('session 日期不同；确认新日期后不传旧 session，从单餐开始');
  if (!Array.isArray(previous.entries) || previous.entries.length > 50) invalid('session.entries 最多 50 餐');
  const ids = new Set();
  for (const item of previous.entries) {
    entry(item);
    if (ids.has(item.mealId)) invalid('session 存在重复 mealId');
    ids.add(item.mealId);
  }
  const next = entry(input.meal);
  const old = previous.entries.find((item) => item.mealId === next.mealId);
  const retry = old && next.revision === old.revision && isDeepStrictEqual(next.input, old.input);
  if (!retry && next.revision !== (old?.revision ?? 0) + 1) invalid('修订必须使用相同 mealId 和上一版 revision+1；重试同一版时内容必须相同');
  if (!old && previous.entries.length === 50) invalid('会话最多 50 餐，请从新的单餐分析开始');
  const context = {
    mode: input.mode ?? 'general',
    ...(input.profile !== undefined ? { profile: input.profile } : {}),
    ...(input.safetyContext !== undefined ? { safetyContext: input.safetyContext } : {}),
  };
  if (context.mode === 'general' && input.dayComplete === true) invalid('general 不做全天不足判断；请使用完整 profile 的 personalized 模式');
  const current = buildMealReview({ ...context, ...next.input });
  if (current.safety.level === 'refer' || current.unrecognizedSegments.length > 0) {
    return { ...current, session: previous, sessionUpdate: 'not_applied' };
  }
  let before = emptyNutrition();
  // Recompute only other meals. The previous revision of this meal is excluded.
  for (const item of previous.entries.filter((item) => item.mealId !== next.mealId)) {
    const result = buildMealReview({ ...context, ...item.input });
    if (result.safety.level === 'refer') return { ...result, session: previous, sessionUpdate: 'not_applied' };
    if (result.unrecognizedSegments.length > 0) invalid('此前餐食信息不完整，请先修订，或不传 session 只分析本餐');
    before = addNutrition(before, result.mealNutrition);
  }
  const result = context.mode === 'personalized'
    ? buildMealReview({ ...context, ...next.input, todayBefore: before, dayComplete: input.dayComplete ?? false })
    : current;
  const entries = old
    ? previous.entries.map((item) => item.mealId === next.mealId ? next : item)
    : [...previous.entries, next];
  return {
    ...result,
    session: { date: input.date, entries },
    sessionUpdate: retry ? 'unchanged' : old ? 'replaced' : 'added',
    sessionNutrition: addNutrition(before, current.mealNutrition),
  };
}
