// 对齐 lib/core/recommendation_engine.dart 的规则优先级。
// 每次只给一个主要问题（mainIssue）和一个行动原则（action）+ 2–3 个中式饮食例子。
//
// 两种评估范围：
// - buildMealRecommendation：只评价当前这一餐（对照餐次参考份额），
//   只标记明显过量（高脂/高钠/高热量）与内容风险，不评价“不足”，
//   因为单餐偏低可以由其他餐补足。
// - buildRecommendation：全天累计规则（提供 todayBefore 时使用）。
import { hasKidneyRisk } from './profile.mjs';

function hasRisk(profile, risk) {
  return profile.healthRisks.includes(risk);
}

function containsAny(items, names) {
  return items.some((item) => names.some((name) => item.name.includes(name)));
}

// meal：本餐营养；reference：该餐次的参考份额（dailyTargets × 餐次份额）。
export function buildMealRecommendation({ profile, meal, reference, items }) {
  if (meal.calories === 0) {
    return {
      type: 'empty',
      severity: 'info',
      mainIssue: '没有识别到食物',
      reason: '这段描述里没有识别到食物库中的食物，无法可靠估算。',
      action: '用“食物 + 份量”再描述一次，例如“一碗米饭、一份清蒸鱼、半碗青菜”。',
      examples: [],
    };
  }

  if (hasKidneyRisk(profile)) {
    return kidneyCaution();
  }

  if (hasRisk(profile, 'highBloodPressure') && meal.sodiumMg > reference.sodiumMg) {
    return {
      type: 'blood_pressure_sodium',
      severity: 'high',
      mainIssue: '这餐钠偏高，优先控盐',
      reason: '你关注高血压，这一餐的钠已经超过该餐次参考量。常见来源是汤面、火锅汤底、酱料、咸菜和外卖。',
      action: '这一餐少喝汤底、少蘸酱料；下一餐选择清蒸、白灼或炖煮。主食正常吃，别用不吃饭补救。',
      examples: ['清蒸鱼 + 西兰花 + 半碗米饭', '豆腐菌菇汤少盐版 + 青菜 + 红薯', '鸡蛋牛奶 + 全麦面包 + 一份水果'],
    };
  }

  if (hasRisk(profile, 'highUricAcid') && containsAny(items, ['啤酒', '白酒', '火锅'])) {
    return uricAcidWarning('这餐');
  }

  // 高脂与高钠按“超出参考量的倍数”取更严重的一方优先。
  const fatRatio = reference.fatG > 0 ? meal.fatG / reference.fatG : 0;
  const sodiumRatio = reference.sodiumMg > 0 ? meal.sodiumMg / reference.sodiumMg : 0;

  if (fatRatio > 1.3 && fatRatio >= sodiumRatio) {
    return {
      type: 'fat_high',
      severity: 'medium',
      mainIssue: '这餐脂肪偏高',
      reason: '这一餐的脂肪明显超过该餐次参考量，常见来源是油炸、肥肉、奶茶、火锅油碟或坚果过量。',
      action: '下一餐避免油炸和肥肉，选择清蒸、白灼、少油炒。',
      examples: ['清蒸鱼 + 青菜 + 半碗米饭', '鸡胸肉沙拉 + 玉米', '无糖豆浆 + 鸡蛋 + 水果'],
    };
  }

  if (sodiumRatio > 1.2) {
    return {
      type: 'sodium_high',
      severity: 'medium',
      mainIssue: '这餐钠偏高',
      reason: '这一餐的钠明显超过该餐次参考量，常见来源是汤底、酱料、腌制食品和外卖。',
      action: '这一餐不喝汤底；下一餐少放盐和酱料，多选新鲜蔬菜。',
      examples: ['豆腐 + 两份青菜 + 米饭半碗', '清蒸鱼 + 西兰花', '鸡蛋牛奶 + 水果'],
    };
  }

  if (meal.calories > reference.calories * 1.5) {
    return {
      type: 'energy_high',
      severity: 'medium',
      mainIssue: '这餐热量明显偏高',
      reason: '这一餐的热量明显超过该餐次参考量，通常来自外卖、甜饮、油炸或聚餐。',
      action: '不要跳餐补救。下一餐选择高蛋白、低油、两份蔬菜。',
      examples: ['鸡胸肉 + 生菜番茄 + 玉米', '鱼 + 两份青菜 + 半碗米饭', '豆腐 + 菌菇 + 红薯'],
    };
  }

  return {
    type: 'no_excess_in_meal',
    severity: 'info',
    mainIssue: '已识别部分未见明显过量',
    reason: '已识别部分未触发明显过量规则；这不代表一餐营养均衡，也不用于判断全天不足。',
    action: '下一餐保持一份优质蛋白、两份蔬菜和适量主食。',
    examples: ['鱼 + 蔬菜 + 半碗米饭', '豆腐 + 菌菇 + 红薯', '鸡蛋牛奶 + 全麦主食 + 水果'],
  };
}

function kidneyCaution() {
  return {
    type: 'safety',
    severity: 'high',
    mainIssue: '蛋白质建议需要谨慎',
    reason: '你选择了肾功能关注，通用高蛋白建议可能不适合你。',
    action: '继续记录饮食，但蛋白质目标和补充方式请以医生或临床营养师建议为准。',
    examples: [],
    safetyNote: '本服务不替代医生诊断和治疗。',
  };
}

function uricAcidWarning(scopeWord) {
  return {
    type: 'uric_acid',
    severity: 'high',
    mainIssue: `${scopeWord}注意尿酸风险`,
    reason: '你关注高尿酸，记录里出现了酒精或火锅这类高风险场景。',
    action: '下一餐避免酒、浓肉汤和动物内脏，多喝水，选择鸡蛋、牛奶、蔬菜和适量主食。',
    examples: ['鸡蛋 + 牛奶 + 青菜 + 米饭半碗', '豆腐 + 菌菇 + 红薯', '清淡鸡胸肉 + 两份蔬菜'],
    safetyNote: '如果已有痛风发作或正在用药，请以医生建议为准。',
  };
}

// daySoFar：当天截至目前（含本餐）的营养汇总；items：本餐识别到的食物。
export function buildRecommendation({ profile, daySoFar, targets, items, allowDeficit = false }) {
  if (daySoFar.calories === 0) {
    return {
      type: 'empty',
      severity: 'info',
      mainIssue: '没有识别到食物',
      reason: '这段描述里没有识别到食物库中的食物，无法可靠估算。',
      action: '用“食物 + 份量”再描述一次，例如“一碗米饭、一份清蒸鱼、半碗青菜”。',
      examples: [],
    };
  }

  if (hasKidneyRisk(profile)) {
    return kidneyCaution();
  }

  if (hasRisk(profile, 'highBloodPressure') && daySoFar.sodiumMg > targets.sodiumMg) {
    return {
      type: 'blood_pressure_sodium',
      severity: 'high',
      mainIssue: '今天优先控盐',
      reason: '你关注高血压，今天钠摄入已经偏高。常见来源是汤面、火锅汤底、酱料、咸菜和外卖。',
      action: '下一餐少汤底、少酱料，选择清蒸、白灼或炖煮。主食正常吃，别用不吃饭补救。',
      examples: ['清蒸鱼 + 西兰花 + 半碗米饭', '豆腐菌菇汤少盐版 + 青菜 + 红薯', '鸡蛋牛奶 + 全麦面包 + 一份水果'],
    };
  }

  if (hasRisk(profile, 'highUricAcid') && containsAny(items, ['啤酒', '白酒', '火锅'])) {
    return uricAcidWarning('今天');
  }

  if (daySoFar.calories > targets.calories + 500) {
    return {
      type: 'energy_high',
      severity: 'medium',
      mainIssue: '今天热量明显偏高',
      reason: '今天摄入已经超过目标较多，通常来自外卖、甜饮、油炸或聚餐。',
      action: '不要跳餐补救。下一餐选择高蛋白、低油、两份蔬菜，明天减少一杯含糖饮料或一次高油外卖。',
      examples: ['鸡胸肉 + 生菜番茄 + 玉米', '鱼 + 两份青菜 + 半碗米饭', '豆腐 + 菌菇 + 红薯'],
    };
  }

  if (allowDeficit && daySoFar.proteinG < targets.proteinG * 0.7) {
    return {
      type: 'protein_low',
      severity: 'medium',
      mainIssue: '蛋白质偏低',
      reason: '今天蛋白质距离目标还比较远。减脂时蛋白质不足，会更饿，也更难保住肌肉。',
      action: '下一餐加一份优质蛋白：鸡蛋、鱼、鸡胸肉、牛奶或豆腐。',
      examples: ['鸡蛋 2 个 + 牛奶 + 全麦面包', '清蒸鱼 + 西兰花 + 米饭半碗', '豆腐 200g + 青菜 + 红薯'],
    };
  }

  if (daySoFar.fatG > targets.fatG * 1.3) {
    return {
      type: 'fat_high',
      severity: 'medium',
      mainIssue: '脂肪偏高',
      reason: '今天脂肪摄入偏高，常见来源是油炸、肥肉、奶茶、火锅油碟或坚果过量。',
      action: '下一餐避免油炸和肥肉，选择清蒸、白灼、少油炒。',
      examples: ['清蒸鱼 + 青菜 + 半碗米饭', '鸡胸肉沙拉 + 玉米', '无糖豆浆 + 鸡蛋 + 水果'],
    };
  }

  if (daySoFar.sodiumMg > targets.sodiumMg * 1.2) {
    return {
      type: 'sodium_high',
      severity: 'medium',
      mainIssue: '钠偏高',
      reason: '今天钠摄入偏高，常见来源是汤底、酱料、腌制食品和外卖。',
      action: '下一餐少放盐和酱料，不喝汤底，多选新鲜蔬菜。',
      examples: ['豆腐 + 两份青菜 + 米饭半碗', '清蒸鱼 + 西兰花', '鸡蛋牛奶 + 水果'],
    };
  }

  if (allowDeficit && daySoFar.fiberG < targets.fiberG * 0.7) {
    return {
      type: 'fiber_low',
      severity: 'low',
      mainIssue: '蔬菜和纤维偏少',
      reason: '今天膳食纤维偏低，通常意味着蔬菜、菌菇、全谷物或水果不够。',
      action: '下一餐加两份蔬菜，主食可以用红薯、玉米、燕麦替换一部分精米精面。',
      examples: ['西兰花 + 菠菜 + 鱼', '菌菇豆腐汤 + 红薯', '燕麦 + 牛奶 + 苹果'],
    };
  }

  if (!allowDeficit) {
    return {
      type: 'no_excess_so_far',
      severity: 'info',
      mainIssue: '截至目前未见明显过量',
      reason: '当前累计热量、脂肪和钠没有明显超过全天上限；当天尚未记录完成，不判断蛋白质或纤维不足。',
      action: '继续正常记录后续餐食，不需要因当前累计偏低而额外补偿。',
      examples: ['鱼 + 蔬菜 + 半碗米饭', '豆腐 + 菌菇 + 红薯', '鸡蛋牛奶 + 全麦主食 + 水果'],
    };
  }

  return {
    type: 'balanced',
    severity: 'info',
    mainIssue: '今天整体接近平衡',
    reason: '目前热量和主要营养结构没有明显偏离。',
    action: '下一餐保持一份优质蛋白、两份蔬菜和适量主食。',
    examples: ['鱼 + 蔬菜 + 半碗米饭', '豆腐 + 菌菇 + 红薯', '鸡蛋牛奶 + 全麦主食 + 水果'],
  };
}
