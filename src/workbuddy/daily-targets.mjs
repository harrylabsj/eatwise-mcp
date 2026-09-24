import { calculateBmr, calculateNutritionTargets, calculateTargetCalories, calculateTdee } from './energy.mjs';
import { validateProfile } from './profile.mjs';
import { evaluateSafety } from './safety.mjs';

// POST /v1/workbuddy/daily-targets：用最少个人信息估算每日营养所需。
// 无状态：不记录 profile，每次请求独立计算。
export function buildDailyTargets(input) {
  const profile = validateProfile(input?.profile);
  const safety = evaluateSafety({ profile });

  // 安全转介（未成年、孕期、哺乳期）：不用成人 Mifflin 公式给数值目标。
  if (safety.level === 'refer') {
    return {
      dailyTargets: null,
      energy: null,
      assumptions: [
        '未成年人、孕期或哺乳期的营养需求需要医生或注册营养师个体化制定，本服务不提供成人公式估算值。',
      ],
      confidence: 'low',
      safety,
    };
  }

  const bmr = calculateBmr(profile);
  const tdee = calculateTdee(profile);
  const targetCalories = calculateTargetCalories(profile, tdee);
  const targets = calculateNutritionTargets(profile, targetCalories);

  const assumptions = [
    'BMR 按 Mifflin-St Jeor 公式估算，TDEE 按自述活动水平乘以活动系数。',
    '热量目标按目标类型调整：减脂 -400 kcal，增肌 +250 kcal，慢病管理目标在 BMI≥24 时 -300 kcal；女性下限 1200 kcal，男性下限 1500 kcal。',
    '蛋白质按体重系数估算（减脂 1.4 g/kg，增肌 1.6 g/kg，其他 1.0 g/kg），脂肪按热量 30% 估算，碳水取剩余热量且不低于 130 g。',
  ];
  if (targets.requiresProfessionalProteinGuidance) {
    assumptions.push('你选择了肾功能关注：蛋白质目标按 1.0 g/kg 保守给出，请以医生或临床营养师建议为准。');
  }
  if (profile.healthRisks.includes('highBloodPressure')) {
    assumptions.push('你关注高血压：钠目标按 1500 mg 收紧（一般人群 2300 mg）。');
  }

  return {
    dailyTargets: {
      calories: Math.round(targets.calories),
      proteinG: round1(targets.proteinG),
      fatG: round1(targets.fatG),
      carbsG: round1(targets.carbsG),
      fiberG: round1(targets.fiberG),
      sodiumMg: Math.round(targets.sodiumMg),
      waterMl: Math.round(targets.waterMl),
      requiresProfessionalProteinGuidance: targets.requiresProfessionalProteinGuidance,
    },
    energy: {
      bmr: Math.round(bmr),
      tdee: Math.round(tdee),
      targetCalories: Math.round(targetCalories),
    },
    assumptions,
    confidence: 'medium',
    safety,
  };
}

function round1(value) {
  return Math.round(value * 10) / 10;
}
