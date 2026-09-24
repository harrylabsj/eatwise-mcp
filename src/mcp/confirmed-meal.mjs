import { loadFoodDatabase } from '../workbuddy/food-database.mjs';
import { buildMealReview } from '../workbuddy/meal-review.mjs';

const MAX_AMOUNT = 100;

// Rebuild the result from user-confirmed food ids and amounts. The original
// message is used only for the trusted safety receipt digest and is never
// persisted by the Connector.
export function buildConfirmedMealReview({ profile, mealText, mealType, confirmedItems }) {
  if (!Array.isArray(confirmedItems) || confirmedItems.length === 0 || confirmedItems.length > 50) {
    const error = new Error('confirmedItems 必须是 1–50 项');
    error.code = 'INVALID_MEAL_INPUT';
    error.statusCode = 400;
    throw error;
  }
  const byId = new Map(loadFoodDatabase().map((food) => [food.id, food]));
  const seen = new Set();
  const items = [];
  for (const input of confirmedItems) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) invalidItems();
    const food = byId.get(input.foodId);
    const amount = input.amount;
    if (!food || seen.has(food.id) || typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT) {
      invalidItems();
    }
    if (input.name !== undefined && input.name !== food.name) invalidItems();
    seen.add(food.id);
    items.push({ foodId: food.id, name: food.name, amount });
  }

  const canonicalText = items
    .map((item) => `${item.amount}${byId.get(item.foodId).defaultUnit}${item.name}`)
    .join('，');
  const result = buildMealReview({ profile, mealText: canonicalText, mealType });
  const resultIds = new Set(result.recognizedItems.map((item) => item.foodId));
  if (resultIds.size !== items.length || items.some((item) => !resultIds.has(item.foodId))) invalidItems();
  return { result, confirmedItems: result.recognizedItems };
}

function invalidItems() {
  const error = new Error('confirmedItems 含有未知食物、重复食物或非法份量');
  error.code = 'INVALID_MEAL_INPUT';
  error.statusCode = 400;
  throw error;
}
