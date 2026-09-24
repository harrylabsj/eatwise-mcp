import { servingAmount, servingGrams, withinServingLimit } from './meal-input.mjs';

// 逐规则对齐 lib/core/food_text_parser.dart（App 端 FoodTextParser）。
// 只识别内置食物库中的食物；未识别的文本不会产生任何编造的营养数字。

const CHINESE_NUMBERS = new Map([
  ['半', 0.5],
  ['一', 1],
  ['两', 2],
  ['二', 2],
  ['三', 3],
  ['四', 4],
  ['五', 5],
  ['六', 6],
  ['七', 7],
  ['八', 8],
  ['九', 9],
  ['十', 10],
]);

const SEPARATORS = /[，,、。；;\n]/;
const NUMBER_CHARS = '半一两二三四五六七八九十0123456789.';
const UNIT_CHARS = '个碗杯份根片瓶包块餐串勺只张把笼两克斤gG';
const DIGIT_QUANTITY_PATTERN = /^\d+(?:\.\d+)?\s*(?:个|碗|杯|份|根|片|瓶|包|块|餐|串|勺|只|张|把|笼|克|g|G|两|斤)$/;

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function parseMealText(input, foods) {
  const text = String(input || '').trim();
  if (!text) return [];

  const candidates = [];
  for (const food of foods) {
    const names = [food.displayName || food.name, food.name, ...(Array.isArray(food.aliases) ? food.aliases : [])];
    for (const name of names) {
      if (!name) continue;
      const pattern = new RegExp(escapeRegExp(name), 'g');
      const matches = [...text.matchAll(pattern)];
      for (const match of matches) {
        if (!isSafeShortMention(text, name, match.index, match.index + name.length)) continue;
        candidates.push({
          food,
          name,
          index: match.index,
          end: match.index + name.length,
          isCanonical: name === food.name || name === food.displayName,
        });
      }
    }
  }
  const mentions = selectLongestNonOverlappingMentions(candidates);
  // 同一段文本可能命中多条记录（同一俗名挂在多条记录上，例如「西红柿」同时是 4 条番茄记录的别名）。
  // 选中一条后若它的单位换算不出来（「两个西红柿」遇到单位为克的记录），就换同一段的其它候选，
  // 而不是整段丢掉。语义仍限定在同一段文字命中的记录之间，不会跨段乱配。
  for (const mention of mentions) {
    mention.alternatives = candidates.filter(
      (other) => other !== mention && other.index === mention.index && other.end === mention.end,
    );
  }
  mentions.sort((a, b) => a.index - b.index);

  const parsed = [];
  for (let i = 0; i < mentions.length; i += 1) {
    const current = mentions[i];
    const nextIndex = i + 1 < mentions.length ? mentions[i + 1].index : text.length;
    // 无分隔符时，数字后置数量（“鸡蛋2个米饭”）归属于前一个食物；
    // 中文前置数量（“两个鸡蛋一碗米饭”）归属于后一个食物。
    // 这样兼容常见的“食物2个”与“两个食物”两种写法。
    const previous = i > 0 ? mentions[i - 1] : null;
    const betweenPreviousAndCurrent = previous
      ? text.slice(previous.end, current.index).trim()
      : '';
    const currentHasNumericPreviousSuffix = Boolean(
      previous
      && DIGIT_QUANTITY_PATTERN.test(betweenPreviousAndCurrent),
    );
    const start = currentHasNumericPreviousSuffix
      ? current.index
      : segmentStart(text, current.index);
    // 仅当后面还有食物时，才剥掉段尾的引导份量词（数字/中文数字/单位），
    // 避免“两个鸡蛋，再来一碗米饭”中“一碗”污染鸡蛋的数量解析；
    // 最后一个食物不剥，以保留“鸡蛋2个”这类食物后数量。
    // 与 Dart 端有意分歧：Dart 保留该行为，Node 端按审查要求修正。
    const betweenCurrentAndNext = i + 1 < mentions.length
      ? text.slice(current.end, nextIndex).trim()
      : '';
    const end = i + 1 < mentions.length && !DIGIT_QUANTITY_PATTERN.test(betweenCurrentAndNext)
      ? segmentEnd(text, nextIndex)
      : nextIndex;
    const segment = text.slice(start, end).split(SEPARATORS)[0];
    // Negations/corrections are ambiguous in free text: leave the segment unresolved.
    // Structured input is the primary path and can express consumedFraction=0.
    if (/(?:没吃|没喝|不吃|不喝|不要|未吃|剩下|剩了|不是|改成|其实)/.test(segment)) continue;
    const serving = parseServingFromAny(segment, current);
    if (serving) parsed.push(serving);
  }
  return mergeParsedFoods(parsed);
}

// 中文单字不能用普通 substring 规则匹配，否则「蛋糕」「鱼香茄子」「饭后」
// 会分别误记成鸡蛋、鱼和米饭。单字只在独立词段，或带明确数量/量词时参与匹配。
function isSafeShortMention(text, name, start, end) {
  if ([...name.trim()].length !== 1) return true;
  let segmentStart = start;
  while (segmentStart > 0 && !SEPARATORS.test(text[segmentStart - 1])) segmentStart -= 1;
  let segmentEnd = end;
  while (segmentEnd < text.length && !SEPARATORS.test(text[segmentEnd])) segmentEnd += 1;
  const segment = text.slice(segmentStart, segmentEnd).trim();
  const number = '(?:\\d+(?:\\.\\d+)?|[半一两二三四五六七八九十]+)';
  const unit = '(?:个|碗|杯|份|根|片|瓶|包|块|餐|串|勺|只|张|把|笼|克|g|G|两|斤)';
  const context = '(?:(?:我|今天|早餐|午餐|晚餐|早上|中午|晚上)?(?:吃了|喝了|吃|喝|来点|来份)?\\s*)?';
  return new RegExp(`^${context}(?:${number}\\s*${unit}\\s*)?${escapeRegExp(name)}(?:\\s*${number}\\s*${unit})?$`).test(segment);
}

// 复合菜名会包含基础食材名或其他别名，例如“红烧牛肉面”同时包含“牛肉”和“牛肉面”。
// 先选最长的非重叠词段，避免一次描述被拆成多份食物重复计量。
function selectLongestNonOverlappingMentions(candidates) {
  const selected = [];
  const ordered = [...candidates].sort(
    (a, b) => (b.end - b.index) - (a.end - a.index)
      || Number(b.isCanonical) - Number(a.isCanonical)
      || representativeRank(b.food) - representativeRank(a.food)
      || a.index - b.index,
  );
  for (const candidate of ordered) {
    const overlaps = selected.some(
      (mention) => candidate.index < mention.end && candidate.end > mention.index,
    );
    if (!overlaps) selected.push(candidate);
  }
  return selected;
}

function representativeRank(food) {
  if (/平均值/.test(food.name)) return 3;
  if (!/取样|\d+月/.test(food.name)) return 2;
  return 1;
}

function segmentEnd(text, nextIndex) {
  let end = nextIndex;
  while (end > 0) {
    const char = text[end - 1];
    if (NUMBER_CHARS.includes(char) || UNIT_CHARS.includes(char)) {
      end -= 1;
    } else {
      break;
    }
  }
  return end;
}

function segmentStart(text, foodIndex) {
  for (let i = foodIndex - 1; i >= 0; i -= 1) {
    if (SEPARATORS.test(text[i])) return i + 1;
  }
  let start = foodIndex;
  while (start > 0) {
    const char = text[start - 1];
    if (NUMBER_CHARS.includes(char) || UNIT_CHARS.includes(char)) {
      start -= 1;
    } else {
      break;
    }
  }
  return start;
}

function mergeParsedFoods(parsed) {
  const merged = new Map();
  for (const item of parsed) {
    const existing = merged.get(item.food.id);
    merged.set(item.food.id, {
      food: item.food,
      amount: (existing?.amount || 0) + item.amount,
    });
  }
  return [...merged.values()];
}

function parseServing(text, food) {
  const match = text.match(/(\d+(?:\.\d+)?|[半一两二三四五六七八九十]+)\s*(个|碗|杯|份|根|片|瓶|包|块|餐|串|勺|只|张|把|笼|克|g|G|两|斤)/);
  if (!match) return { food, amount: food.defaultAmount };
  const quantity = /^\d/.test(match[1]) ? Number(match[1]) : parseChineseNumber(match[1]);
  if (quantity === null || !Number.isFinite(quantity) || quantity < 0) return null;
  const amount = servingAmount(food, quantity, match[2]);
  if (amount === null || !Number.isFinite(amount) || amount < 0
    || !withinServingLimit(quantity, match[2], amount, servingGrams(food, amount))) return null;
  return { food, amount };
}

function parseServingFromAny(segment, mention) {
  for (const food of [mention.food, ...(mention.alternatives || []).map((item) => item.food)]) {
    const serving = parseServing(segment, food);
    if (serving) return serving;
  }
  return null;
}

function parseChineseNumber(text) {
  if (CHINESE_NUMBERS.has(text)) return CHINESE_NUMBERS.get(text);
  if (text.includes('十')) {
    const parts = text.split('十');
    const tens = parts[0] === '' ? 1 : CHINESE_NUMBERS.get(parts[0]) ?? 1;
    const ones = parts.length > 1 && parts[parts.length - 1] !== ''
      ? CHINESE_NUMBERS.get(parts[parts.length - 1]) ?? 0
      : 0;
    return tens * 10 + ones;
  }
  return null;
}
