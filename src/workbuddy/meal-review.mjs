import { buildDailyTargets } from './daily-targets.mjs';
import { classifyTargetNutrient, classifyUpperLimitNutrient } from './energy.mjs';
import { loadCommonFoodVocabulary, loadFoodDatabase } from './food-database.mjs';
import { parseMealText } from './food-text-parser.mjs';
import { addNutrition, buildMealItem, sumNutrition, validateTodayBefore } from './nutrition.mjs';
import { validateProfile, validateSafetyContext } from './profile.mjs';
import { resolveStructuredItems } from './meal-input.mjs';
import { buildMealRecommendation, buildRecommendation } from './recommendation.mjs';
import { evaluateSafety } from './safety.mjs';

export const MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'snack', 'lateNight'];

// 各餐次占全天目标的参考份额；未提供 mealType 时按 1/3 估算。
const MEAL_SHARES = {
  breakfast: 0.25,
  lunch: 0.35,
  dinner: 0.35,
  snack: 0.1,
  lateNight: 0.1,
};
const DEFAULT_SHARE = 0.33;

const MEAL_TYPE_LABELS = {
  breakfast: '早餐',
  lunch: '午餐',
  dinner: '晚餐',
  snack: '加餐',
  lateNight: '夜宵',
};

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

// POST /v1/workbuddy/meal-review：接收一顿餐的中文描述，估算营养并只给一个行动重点。
// 无状态：不记录 profile 与 mealText，不调用外部模型。
export function buildMealReview(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw badRequest('输入必须是对象');
  const mode = input.mode ?? 'personalized';
  if (!['general', 'personalized'].includes(mode)) throw badRequest('mode 必须是 general/personalized');
  if (input.profile !== undefined && input.safetyContext !== undefined) throw badRequest('profile 与 safetyContext 不可同时提供');
  if (mode === 'personalized' && input.safetyContext !== undefined) throw badRequest('个性化分析请将已知安全信息写入 profile');
  const profile = mode === 'personalized' || input.profile !== undefined
    ? validateProfile(input.profile) : validateSafetyContext(input.safetyContext);
  const structured = input.items !== undefined;
  const mealText = input.mealText ?? (structured ? '' : undefined);
  if (typeof mealText !== 'string' || (!structured && !mealText.trim())) throw badRequest('mealText 必须是非空字符串，或提供已确认 items');
  if (mealText.length > 2000) throw badRequest('mealText 过长（最多 2000 字）');
  if (input.source !== undefined && !['text', 'image'].includes(input.source)) throw badRequest('source 必须是 text/image');
  if ((structured || input.source === 'image') && input.confirmed !== true) throw badRequest('图片候选或结构化 items 必须先经用户明确确认，confirmed=true');
  if (mode === 'general' && (input.todayBefore != null || input.dayComplete === true)) throw badRequest('general 仅提供单餐信息，不接受 todayBefore/dayComplete；个性化累计需要完整 profile');

  let mealType = null;
  if (input.mealType !== undefined && input.mealType !== null) {
    if (!MEAL_TYPES.includes(input.mealType)) {
      throw badRequest(`mealType 必须是 ${MEAL_TYPES.join(' / ')} 之一`);
    }
    mealType = input.mealType;
  }

  const todayBefore = validateTodayBefore(input.todayBefore);
  if (input.dayComplete !== undefined && typeof input.dayComplete !== 'boolean') {
    throw badRequest('dayComplete 必须是布尔值');
  }
  if (input.dayComplete === true && !todayBefore) {
    throw badRequest('dayComplete=true 时必须提供 todayBefore');
  }
  const dayComplete = input.dayComplete === true;
  const foods = loadFoodDatabase();
  const resolved = structured ? resolveStructuredItems(input.items, foods) : null;
  const parsed = structured ? [] : parseMealText(mealText, foods);
  const recognizedItems = resolved?.recognizedItems ?? parsed.map((item) => buildMealItem(item.food, item.amount));
  const safety = evaluateSafety({ profile, mealText: [mealText, ...(input.items ?? []).map((item) => item.name ?? '')].join('，') });
  const recognizedFoods = foods.filter((food) => recognizedItems.some((item) => item.foodId === food.id));
  const unrecognizedSegments = resolved?.unresolved ?? findUnrecognizedSegments(mealText, recognizedFoods);
  const clarificationItems = findClarificationItems(
    unrecognizedSegments.length > 0 ? [mealText, ...unrecognizedSegments] : [],
    loadCommonFoodVocabulary(),
  );
  const mealNutrition = sumNutrition(recognizedItems);
  const parseAssumptions = resolved?.assumptions ?? [
    '未写份量的按常见默认份量估算；无法换算的数量、否定或修订描述不计入，请用已确认结构化条目重试。',
  ];
  // 口径说明随数据走（food.parseNote，如熟面营养不含酱料），业务代码不按 id 特判。
  for (const food of recognizedFoods) {
    if (food.parseNote) parseAssumptions.push(food.parseNote);
  }
  if (unrecognizedSegments.length > 0) {
    parseAssumptions.push('部分描述未识别或份量无法换算，未计入估算；信息不完整，暂停整体评价。');
  }

  // 安全转介：保留已识别餐食和营养估算，但不给任何饮食行动或目标。
  if (safety.level === 'refer') {
    return {
      mealType,
      dailyTargets: null,
      recognizedItems,
      unrecognizedSegments,
      clarificationItems,
      mealNutrition,
      daySoFar: null,
      assessment: {
        type: 'safety_referral',
        severity: 'high',
        mainIssue: '建议先咨询专业渠道',
        reason: safety.reasons.join(' '),
        scope: 'meal',
        comparisonTargets: null,
        status: null,
      },
      action: {
        principle: '这类情况请先咨询医生或注册营养师，本服务不提供饮食行动建议。',
        examples: [],
      },
      assumptions: parseAssumptions,
      confidence: 'low',
      safety,
    };
  }

  if (unrecognizedSegments.length > 0 || mode === 'general') {
    const incomplete = unrecognizedSegments.length > 0;
    const caution = safety.level === 'caution';
    const composition = describeComposition(recognizedItems, foods);
    return {
      mode, mealType, dailyTargets: null, recognizedItems, unrecognizedSegments, clarificationItems, composition,
      mealNutrition, daySoFar: null,
      assessment: {
        type: caution ? 'safety' : incomplete ? 'incomplete' : 'meal_information',
        severity: caution ? 'high' : 'info', scope: 'meal',
        mainIssue: caution ? '蛋白质建议需要谨慎' : incomplete ? '本餐信息不完整，暂不评价整体' : composition.summary,
        reason: caution ? safety.reasons.join(' ') : incomplete ? '有食物或份量未计入，当前数字仅代表已识别部分。' : '这是已确认食物的搭配信息；均衡要结合全天与长期习惯，尚未建档时不判断个人达标。',
        comparisonTargets: null, status: null,
      },
      action: {
        principle: caution ? '蛋白质目标和补充方式请以医生或临床营养师建议为准。' : incomplete ? '请补充未计入食物或确认份量后再复盘。' : '下一餐可参考主食、蛋白质食物和蔬菜的组合；这是一般搭配信息，不是个人摄入目标。',
        examples: [],
      },
      assumptions: [...parseAssumptions, ...(mode === 'general' ? ['未建档：仅按食物库计算，不使用默认个人资料或成人目标公式。'] : [])],
      confidence: incomplete ? 'low' : aggregateConfidence(recognizedItems), safety,
    };
  }

  // 每日目标（复用 daily-targets 的同一套规则；caution 如肾风险仍给保守目标）。
  const { dailyTargets } = buildDailyTargets({ profile });
  const targets = {
    calories: dailyTargets.calories,
    proteinG: dailyTargets.proteinG,
    fatG: dailyTargets.fatG,
    carbsG: dailyTargets.carbsG,
    fiberG: dailyTargets.fiberG,
    sodiumMg: dailyTargets.sodiumMg,
  };

  const share = mealType ? MEAL_SHARES[mealType] : DEFAULT_SHARE;
  const mealReference = scaleTargets(targets, share);

  const scope = todayBefore ? 'day' : 'meal';
  const dayTotals = todayBefore ? addNutrition(todayBefore, mealNutrition) : null;
  const evaluated = scope === 'day' ? dayTotals : mealNutrition;
  const comparisonTargets = scope === 'day' ? targets : mealReference;

  const recommendation = scope === 'day'
    ? buildRecommendation({ profile, daySoFar: dayTotals, targets, items: recognizedItems, allowDeficit: dayComplete })
    : buildMealRecommendation({ profile, meal: mealNutrition, reference: mealReference, items: recognizedItems });

  const assumptions = [
    ...parseAssumptions,
    '每日目标基于 Mifflin-St Jeor 公式和自述活动水平估算，存在个体差异。',
  ];
  if (scope === 'meal') {
    const label = mealType ? MEAL_TYPE_LABELS[mealType] : '该餐';
    assumptions.push(
      `未提供 todayBefore：本次只评价当前这一餐，对照${label}参考份额（约全天目标的 ${Math.round(share * 100)}%），不做全天判断。`,
    );
  } else {
    assumptions.push(
      dayComplete
        ? '已提供 todayBefore 且 dayComplete=true：按完整全天累计评估，可判断摄入不足。'
        : '已提供 todayBefore：按截至目前累计评估；当天尚未记录完成，只判断明显过量，不判断摄入不足。',
    );
  }

  return {
    mealType,
    dailyTargets,
    recognizedItems,
    unrecognizedSegments,
    clarificationItems,
    mealNutrition,
    daySoFar: {
      ...(dayTotals ?? mealNutrition),
      basis: scope === 'day' ? 'meal_plus_todayBefore' : 'meal_only',
    },
    assessment: {
      type: recommendation.type,
      severity: recommendation.severity,
      mainIssue: recommendation.mainIssue,
      reason: recommendation.reason,
      scope,
      comparisonTargets,
      status: buildStatus(scope, evaluated, comparisonTargets, { allowDeficit: dayComplete }),
    },
    action: {
      principle: recommendation.action,
      examples: recommendation.examples,
    },
    assumptions,
    confidence: aggregateConfidence(recognizedItems),
    safety: {
      ...safety,
      ...(recommendation.safetyNote ? { recommendationNote: recommendation.safetyNote } : {}),
    },
  };
}

function scaleTargets(targets, share) {
  const scaled = {};
  for (const [key, value] of Object.entries(targets)) {
    scaled[key] = Math.round(value * share * 10) / 10;
  }
  return scaled;
}

// meal scope 只表达过量风险：calories/fatG/sodiumMg 用上限型分类；
// proteinG/carbsG/fiberG 为 null，明确表示单餐不评估不足（可由其他餐补足）。
// day scope 保持完整分类。
function buildStatus(scope, evaluated, comparisonTargets, { allowDeficit = false } = {}) {
  if (scope === 'meal') {
    return {
      calories: classifyUpperLimitNutrient(evaluated.calories, comparisonTargets.calories),
      proteinG: null,
      fatG: classifyUpperLimitNutrient(evaluated.fatG, comparisonTargets.fatG),
      carbsG: null,
      fiberG: null,
      sodiumMg: classifyUpperLimitNutrient(evaluated.sodiumMg, comparisonTargets.sodiumMg),
    };
  }
  if (!allowDeficit) {
    return {
      calories: classifyUpperLimitNutrient(evaluated.calories, comparisonTargets.calories),
      proteinG: null,
      fatG: classifyUpperLimitNutrient(evaluated.fatG, comparisonTargets.fatG),
      carbsG: null,
      fiberG: null,
      sodiumMg: classifyUpperLimitNutrient(evaluated.sodiumMg, comparisonTargets.sodiumMg),
    };
  }
  return {
    calories: classifyTargetNutrient(evaluated.calories, comparisonTargets.calories),
    proteinG: classifyTargetNutrient(evaluated.proteinG, comparisonTargets.proteinG),
    fatG: classifyTargetNutrient(evaluated.fatG, comparisonTargets.fatG),
    carbsG: classifyTargetNutrient(evaluated.carbsG, comparisonTargets.carbsG),
    fiberG: classifyTargetNutrient(evaluated.fiberG, comparisonTargets.fiberG),
    sodiumMg: classifyUpperLimitNutrient(evaluated.sodiumMg, comparisonTargets.sodiumMg),
  };
}

// 按最低可信度聚合：识别条目默认为 medium，因此整体通常也是 medium；
// 任一条目为 low（如标记“估算误差大”）或没有识别到食物时整体为 low。
// 当前不会产生 high——单条估算没有 high 这一级。
function aggregateConfidence(recognizedItems) {
  if (recognizedItems.length === 0) return 'low';
  return recognizedItems.some((item) => item.confidence === 'low') ? 'low' : 'medium';
}

// 按已知食物名称覆盖每个分隔片段，保留其余文本作为未识别内容。
// 这样“米饭和火星肉”仍会披露“和火星肉”，而不会因为同段含有米饭而静默丢失。
function findUnrecognizedSegments(mealText, foods) {
  const names = [];
  for (const food of foods) {
    names.push(food.displayName || food.name, food.name, ...(Array.isArray(food.aliases) ? food.aliases : []));
  }
  const segments = String(mealText)
    .split(/[，,、。；;\n]+/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  const result = [];
  for (const segment of segments) {
    const ranges = [];
    for (const name of names) {
      if (!name) continue;
      const pattern = new RegExp(escapeRegExp(name), 'g');
      for (const match of segment.matchAll(pattern)) {
        ranges.push(expandKnownRange(segment, match.index, match.index + name.length));
      }
    }
    if (ranges.length === 0) {
      result.push(segment);
      continue;
    }
    ranges.sort((a, b) => a.start - b.start || a.end - b.end);
    let cursor = 0;
    for (const range of mergeRanges(ranges)) {
      const unknown = segment.slice(cursor, range.start).trim();
      if (unknown) result.push(unknown);
      cursor = range.end;
    }
    const tail = segment.slice(cursor).trim();
    if (tail) result.push(tail);
  }
  return result.filter((text) => !/^(?:我|今天|中午|早上|晚上|早餐|午餐|晚餐|吃了|喝了|吃|喝|和|加|再来|再加|了|的|\s)+$/.test(text));
}

function findClarificationItems(unrecognizedSegments, vocabulary) {
  const matches = [];
  const seen = new Set();
  for (const segment of unrecognizedSegments) {
    const candidates = vocabulary
      .filter((entry) => [entry.name, ...(entry.aliases ?? [])]
        .some((name) => segment.includes(name)))
      .sort((a, b) => b.name.length - a.name.length);
    for (const entry of candidates) {
      if (seen.has(entry.name)) continue;
      seen.add(entry.name);
      matches.push({
        name: entry.name,
        category: entry.category,
        guidance: entry.guidance,
      });
    }
  }
  return matches;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function expandKnownRange(text, start, end) {
  const prefix = text.slice(0, start).match(
    /(?:\d+(?:\.\d+)?|[半一两二三四五六七八九十]+)\s*(?:个|碗|杯|份|根|片|瓶|包|块|餐|克|g|G|两|斤)\s*$/,
  );
  const suffix = text.slice(end).match(
    /^\s*(?:\d+(?:\.\d+)?|[半一两二三四五六七八九十]+)\s*(?:个|碗|杯|份|根|片|瓶|包|块|餐|克|g|G|两|斤)/,
  );
  return {
    start: prefix ? start - prefix[0].length : start,
    end: suffix ? end + suffix[0].length : end,
  };
}

function mergeRanges(ranges) {
  const merged = [];
  for (const range of ranges) {
    const previous = merged[merged.length - 1];
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

// Describe visible food groups, without diagnosing a deficiency or inventing
// ingredients inside a composite dish. Group labels come from the food catalog.
function describeComposition(items, foods) {
  const byId = new Map(foods.map((food) => [food.id, food]));
  const groups = new Set();
  for (const item of items) {
    if (item.grams <= 0) continue;
    const food = byId.get(item.foodId);
    if (food.category === '主食') groups.add('主食');
    if (food.category === '蛋白质' || (food.tags ?? []).includes('优质蛋白')) groups.add('蛋白质食物');
    if (food.category === '蔬菜' || (food.tags ?? []).includes('蔬菜')) groups.add('蔬菜');
    if (food.category === '水果') groups.add('水果');
  }
  return {
    groups: [...groups],
    summary: items.length === 0 ? '本餐没有需要计入的食物'
      : groups.size > 0 ? `已识别搭配包含${[...groups].join('、')}` : '已计算确认餐食，混合菜不推断完整营养搭配',
    note: '只描述已识别类别，不代表一餐或全天均衡；未列出的类别不等于全天没吃。',
  };
}
