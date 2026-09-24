import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 内置食物库由 dart run tool/export_food_database.dart 生成，
// 与 Flutter App 的 seedFoods + expandedChineseFoods 对齐。
let cache = null;
let vocabularyCache = null;

function loadPayload() {
  const currentFile = fileURLToPath(import.meta.url);
  const dataFile = path.resolve(path.dirname(currentFile), '../../data/food-database.json');
  return JSON.parse(fs.readFileSync(dataFile, 'utf8'));
}

export function loadFoodDatabase() {
  if (cache) return cache;
  const payload = loadPayload();
  cache = payload.foods;
  return cache;
}

export function loadCommonFoodVocabulary() {
  if (vocabularyCache) return vocabularyCache;
  const payload = loadPayload();
  vocabularyCache = payload.commonVocabulary?.entries ?? [];
  return vocabularyCache;
}

export function getFoodCompositionReference(food) {
  const source = food?.compositionSource;
  if (!source) return { provider: 'legacy_internal', dataset: '项目内置食物库（待权威复核）', basis: 'legacy_estimate' };
  return source;
}
