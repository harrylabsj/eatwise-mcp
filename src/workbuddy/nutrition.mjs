// 营养换算与汇总，对齐 lib/data/app_state.dart 的 makeMealItem
// 与 lib/core/models.dart 的 MealLog 聚合。

export function buildMealItem(food, amount) {
  const grams = (food.defaultGrams * amount) / food.defaultAmount;
  const factor = grams / 100;
  return {
    foodId: food.id,
    name: food.displayName || food.name,
    amount: round(amount, 2),
    unit: food.defaultUnit,
    grams: round(grams, 1),
    calories: round(food.caloriesPer100g * factor, 1),
    proteinG: round(food.proteinPer100g * factor, 1),
    fatG: round(food.fatPer100g * factor, 1),
    carbsG: round(food.carbsPer100g * factor, 1),
    fiberG: round(food.fiberPer100g * factor, 1),
    sodiumMg: round(food.sodiumMgPer100g * factor, 1),
    compositionSource: food.compositionSource || {
      provider: 'legacy_internal',
      dataset: '项目内置食物库（待权威复核）',
      datasetVersion: 'legacy-v1',
      recordId: food.id,
      sourceUrl: null,
      basis: 'legacy_estimate',
      reviewedAt: null,
    },
    confidence: (food.tags || []).includes('估算误差大') ? 'low' : 'medium',
  };
}

export function emptyNutrition() {
  return { calories: 0, proteinG: 0, fatG: 0, carbsG: 0, fiberG: 0, sodiumMg: 0 };
}

export function sumNutrition(items) {
  const total = emptyNutrition();
  for (const item of items) {
    total.calories += item.calories;
    total.proteinG += item.proteinG;
    total.fatG += item.fatG;
    total.carbsG += item.carbsG;
    total.fiberG += item.fiberG;
    total.sodiumMg += item.sodiumMg;
  }
  return roundNutrition(total);
}

export function addNutrition(a, b) {
  return roundNutrition({
    calories: a.calories + b.calories,
    proteinG: a.proteinG + b.proteinG,
    fatG: a.fatG + b.fatG,
    carbsG: a.carbsG + b.carbsG,
    fiberG: a.fiberG + b.fiberG,
    sodiumMg: a.sodiumMg + b.sodiumMg,
  });
}

const NUTRITION_FIELDS = ['calories', 'proteinG', 'fatG', 'carbsG', 'fiberG', 'sodiumMg'];

// todayBefore：当天这餐之前已累计的营养，全部可选，缺省按 0 处理。
export function validateTodayBefore(input) {
  if (input === undefined || input === null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) {
    const error = new Error('todayBefore 必须是对象');
    error.statusCode = 400;
    throw error;
  }
  const result = emptyNutrition();
  for (const field of NUTRITION_FIELDS) {
    const value = input[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100000) {
      const error = new Error(`todayBefore.${field} 必须是 0 到 100000 之间的数字`);
      error.statusCode = 400;
      throw error;
    }
    result[field] = value;
  }
  return result;
}

function roundNutrition(nutrition) {
  const rounded = {};
  for (const field of NUTRITION_FIELDS) {
    rounded[field] = round(nutrition[field], 1);
  }
  return rounded;
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
