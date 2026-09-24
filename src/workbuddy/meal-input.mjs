import { buildMealItem } from './nutrition.mjs';

function invalid(message) {
  const error = new Error(message);
  error.statusCode = 400;
  throw error;
}

// Only database serving units and explicit mass units have a known conversion.
// In particular, twelve dumplings are not twelve default servings of dumplings.
const MASS_UNITS = new Map([['克', 1], ['g', 1], ['G', 1], ['两', 50], ['斤', 500]]);

// 单项上限：防呆，不是业务限制。
// 质量换算后不得超过 5 千克；非质量单位（个/碗/杯…）按份数不得超过 100 份。
// 注意：成分库记录用「克」作默认单位、默认份量 100（即 1 份=100 克），
// 若按“amount ≤ 100”判上限，会把「150 克五花肉」这类正常说法一并拒掉，所以按克数判。
export const MAX_GRAMS = 5000;
export const MAX_SERVINGS = 100;

export function servingAmount(food, quantity, unit) {
  const mass = MASS_UNITS.get(unit);
  if (mass) return quantity * mass / food.defaultGrams * food.defaultAmount;
  if (unit === '份' && (food.tags ?? []).includes('一人份')) return quantity * food.defaultAmount;
  return unit === food.defaultUnit ? quantity : null;
}

export function servingGrams(food, amount) {
  return food.defaultGrams * amount / food.defaultAmount;
}

export function withinServingLimit(quantity, unit, amount, grams) {
  if (!Number.isFinite(grams) || grams <= 0 || grams > MAX_GRAMS) return false;
  return MASS_UNITS.has(unit) ? true : amount <= MAX_SERVINGS;
}

export function resolveStructuredItems(items, foods) {
  if (!Array.isArray(items) || items.length === 0 || items.length > 50) {
    invalid('items 必须是 1–50 项已确认食物');
  }
  const byId = new Map(foods.map((food) => [food.id, food]));
  const recognizedItems = [];
  const unresolved = [];
  const assumptions = [];
  for (const [index, item] of items.entries()) {
    const prefix = `items[${index}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) invalid(`${prefix} 必须是对象`);
    const allowed = ['foodId', 'name', 'quantity', 'unit', 'consumedFraction', 'confidence'];
    if (Object.keys(item).some((key) => !allowed.includes(key))) invalid(`${prefix} 含未知字段；不要传营养数字`);
    if (item.foodId !== undefined && (typeof item.foodId !== 'string' || !item.foodId.trim())) invalid(`${prefix}.foodId 无效`);
    if (item.name !== undefined && (typeof item.name !== 'string' || !item.name.trim() || item.name.length > 100)) invalid(`${prefix}.name 无效`);
    if (!item.foodId && !item.name) invalid(`${prefix} 需要 foodId 或 name`);
    if (typeof item.quantity !== 'number' || !Number.isFinite(item.quantity) || item.quantity <= 0 || item.quantity > 10000) invalid(`${prefix}.quantity 必须是 0–10000 之间的正数`);
    if (typeof item.unit !== 'string' || !item.unit.trim() || item.unit.length > 10) invalid(`${prefix}.unit 无效`);
    const fraction = item.consumedFraction ?? 1;
    if (typeof fraction !== 'number' || !Number.isFinite(fraction) || fraction < 0 || fraction > 1) invalid(`${prefix}.consumedFraction 必须在 0–1 之间`);
    if (item.confidence !== undefined && !['medium', 'low'].includes(item.confidence)) invalid(`${prefix}.confidence 只允许 medium/low`);
    // A supplied id must resolve; never silently replace an unknown id by a name.
    const food = item.foodId ? byId.get(item.foodId) : foods.find((food) => food.name === item.name);
    if (food && item.name && food.name !== item.name) invalid(`${prefix} 的 foodId 与 name 不一致`);
    if (fraction === 0) continue; // Explicitly not eaten.
    if (!food) {
      unresolved.push(`${item.name ?? item.foodId}：食物库未收录，未计入`);
      continue;
    }
    const amount = servingAmount(food, item.quantity, item.unit);
    if (amount === null || !Number.isFinite(amount) || amount <= 0
      || !withinServingLimit(item.quantity, item.unit, amount, servingGrams(food, amount))) {
      unresolved.push(`${food.name} ${item.quantity}${item.unit}：无法可靠换算，请确认克数或使用${food.defaultUnit}，未计入`);
      continue;
    }
    const result = buildMealItem(food, amount * fraction);
    if (item.confidence === 'low') result.confidence = 'low';
    recognizedItems.push(result);
    assumptions.push(`${food.name}按 ${item.quantity}${item.unit} × 实际食用比例 ${fraction} 换算为 ${result.grams} 克。`);
  }
  return { recognizedItems, unresolved, assumptions };
}
