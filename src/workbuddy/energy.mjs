// 对齐 lib/core/energy_engine.dart：Mifflin-St Jeor 估算 BMR，活动系数估算 TDEE。
import { hasKidneyRisk } from './profile.mjs';

const ACTIVITY_FACTORS = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  high: 1.725,
  extreme: 1.9,
};

export function calculateBmr(profile) {
  const base = 10 * profile.weightKg + 6.25 * profile.heightCm - 5 * profile.age;
  return profile.gender === 'male' ? base + 5 : base - 161;
}

export function calculateTdee(profile, exerciseCalories = 0) {
  return calculateBmr(profile) * ACTIVITY_FACTORS[profile.activityLevel] + exerciseCalories;
}

function shouldLoseWeight(profile) {
  const heightM = profile.heightCm / 100;
  const bmi = profile.weightKg / (heightM * heightM);
  return bmi >= 24;
}

export function calculateTargetCalories(profile, tdee) {
  let raw;
  switch (profile.goal) {
    case 'fatLoss':
      raw = tdee - 400;
      break;
    case 'muscleGain':
      raw = tdee + 250;
      break;
    case 'maintain':
      raw = tdee;
      break;
    // bloodPressure / bloodLipids / bloodSugar / uricAcid
    default:
      raw = shouldLoseWeight(profile) ? tdee - 300 : tdee;
  }

  const floor = profile.gender === 'female' ? 1200 : 1500;
  return raw < floor ? floor : raw;
}

// 对齐 NutritionTargetEngine。
export function calculateNutritionTargets(profile, targetCalories) {
  let proteinFactor = 1.0;
  if (profile.goal === 'fatLoss') proteinFactor = 1.4;
  if (profile.goal === 'muscleGain') proteinFactor = 1.6;

  const professionalProtein = hasKidneyRisk(profile);
  const proteinG = professionalProtein
    ? profile.weightKg
    : profile.weightKg * proteinFactor;
  const fatG = (targetCalories * 0.3) / 9;
  const carbsRaw = (targetCalories - proteinG * 4 - fatG * 9) / 4;

  return {
    calories: targetCalories,
    proteinG,
    fatG,
    carbsG: carbsRaw < 130 ? 130 : carbsRaw,
    fiberG: 25,
    sodiumMg: (profile.healthRisks ?? []).includes('highBloodPressure') ? 1500 : 2300,
    waterMl: profile.weightKg * 30,
    requiresProfessionalProteinGuidance: professionalProtein,
  };
}

// 对齐 classifyTargetNutrient。
export function classifyTargetNutrient(value, target) {
  if (target <= 0) return 'ok';
  const ratio = value / target;
  if (ratio < 0.7) return 'low';
  if (ratio < 0.9) return 'slightlyLow';
  if (ratio <= 1.2) return 'ok';
  if (ratio <= 1.5) return 'slightlyHigh';
  return 'high';
}

// 对齐 classifyUpperLimitNutrient。
export function classifyUpperLimitNutrient(value, upperLimit) {
  if (upperLimit <= 0) return 'ok';
  const ratio = value / upperLimit;
  if (ratio <= 0.9) return 'ok';
  if (ratio <= 1.2) return 'slightlyHigh';
  return 'high';
}
