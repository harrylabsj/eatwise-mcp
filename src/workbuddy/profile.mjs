// UserProfile 的最小化严格校验与归一化，对齐 lib/core/models.dart 的枚举。
// 只收集估算每日营养所需的最少个人信息；不接收姓名、电话、城市。

export const GENDERS = ['male', 'female'];
export const ACTIVITY_LEVELS = ['sedentary', 'light', 'moderate', 'high', 'extreme'];
export const GOALS = [
  'fatLoss',
  'maintain',
  'muscleGain',
  'bloodPressure',
  'bloodLipids',
  'bloodSugar',
  'uricAcid',
];
export const HEALTH_RISKS = [
  'highBloodPressure',
  'bloodLipids',
  'bloodSugar',
  'highUricAcid',
  'fattyLiver',
  'kidney',
  'cardiovascular',
];
export const LIFE_STAGES = ['general', 'pregnancy', 'breastfeeding'];
export const ALLOWED_PROFILE_FIELDS = [
  'gender',
  'age',
  'heightCm',
  'weightKg',
  'activityLevel',
  'goal',
  'targetWeightKg',
  'healthRisks',
  'lifeStage',
];

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function requireEnum(value, allowed, field) {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw badRequest(`profile.${field} 必须是 ${allowed.join(' / ')} 之一`);
  }
  return value;
}

function requireNumber(value, field, { min, max, integer = false }) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw badRequest(`profile.${field} 必须是数字`);
  }
  if (integer && !Number.isInteger(value)) {
    throw badRequest(`profile.${field} 必须是整数`);
  }
  if (value < min || value > max) {
    throw badRequest(`profile.${field} 必须在 ${min} 到 ${max} 之间`);
  }
  return value;
}

// 数据最小化：与营养估算无关的敏感字段一律拒绝。
export const FORBIDDEN_PROFILE_FIELDS = [
  'name',
  'phone',
  'city',
  'idCard',
  'medicalRecord',
];

export function validateProfile(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw badRequest('profile 必须是对象');
  }

  const forbidden = FORBIDDEN_PROFILE_FIELDS.filter((field) => field in input);
  if (forbidden.length > 0) {
    throw badRequest(
      `profile 包含不允许的字段：${forbidden.join('、')}（本服务只需要最少的营养估算信息）`,
    );
  }
  const unknown = Object.keys(input).filter((field) => !ALLOWED_PROFILE_FIELDS.includes(field));
  if (unknown.length > 0) {
    throw badRequest(`profile 包含未知字段：${unknown.join('、')}`);
  }

  const profile = {
    gender: requireEnum(input.gender, GENDERS, 'gender'),
    age: requireNumber(input.age, 'age', { min: 3, max: 120, integer: true }),
    heightCm: requireNumber(input.heightCm, 'heightCm', { min: 80, max: 230 }),
    weightKg: requireNumber(input.weightKg, 'weightKg', { min: 20, max: 300 }),
    activityLevel: requireEnum(input.activityLevel, ACTIVITY_LEVELS, 'activityLevel'),
    goal: requireEnum(input.goal, GOALS, 'goal'),
    healthRisks: [],
  };

  if (input.targetWeightKg !== undefined && input.targetWeightKg !== null) {
    // 与 App profile 保持输入兼容；当前每日营养目标只基于当前体重和 goal，
    // targetWeightKg 仅作合法性校验，不参与热量或营养素计算。
    profile.targetWeightKg = requireNumber(input.targetWeightKg, 'targetWeightKg', {
      min: 20,
      max: 300,
    });
  }

  if (input.healthRisks !== undefined) {
    if (!Array.isArray(input.healthRisks)) {
      throw badRequest('profile.healthRisks 必须是数组');
    }
    for (const risk of input.healthRisks) {
      if (!HEALTH_RISKS.includes(risk)) {
        throw badRequest(`profile.healthRisks 包含未知值：${String(risk)}`);
      }
    }
    profile.healthRisks = [...new Set(input.healthRisks)];
  }

  if (input.lifeStage !== undefined && input.lifeStage !== null) {
    profile.lifeStage = requireEnum(input.lifeStage, LIFE_STAGES, 'lifeStage');
  } else {
    profile.lifeStage = 'general';
  }

  return profile;
}

// 用于本地档案的渐进建档。它只验证用户这次明确提供的字段；
// 需要进行个性化营养计算时仍必须调用 validateProfile 确认档案完整。
export function validateProfilePatch(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw badRequest('profile patch 必须是对象');
  const forbidden = FORBIDDEN_PROFILE_FIELDS.filter((field) => field in input);
  if (forbidden.length > 0) throw badRequest(`profile 包含不允许的字段：${forbidden.join('、')}`);
  const unknown = Object.keys(input).filter((field) => !ALLOWED_PROFILE_FIELDS.includes(field));
  if (unknown.length > 0) throw badRequest(`profile 包含未知字段：${unknown.join('、')}`);
  const result = {};
  if ('gender' in input) result.gender = requireEnum(input.gender, GENDERS, 'gender');
  if ('age' in input) result.age = requireNumber(input.age, 'age', { min: 3, max: 120, integer: true });
  if ('heightCm' in input) result.heightCm = requireNumber(input.heightCm, 'heightCm', { min: 80, max: 230 });
  if ('weightKg' in input) result.weightKg = requireNumber(input.weightKg, 'weightKg', { min: 20, max: 300 });
  if ('activityLevel' in input) result.activityLevel = requireEnum(input.activityLevel, ACTIVITY_LEVELS, 'activityLevel');
  if ('goal' in input) result.goal = requireEnum(input.goal, GOALS, 'goal');
  if ('targetWeightKg' in input) result.targetWeightKg = input.targetWeightKg === null ? null : requireNumber(input.targetWeightKg, 'targetWeightKg', { min: 20, max: 300 });
  if ('healthRisks' in input) {
    if (!Array.isArray(input.healthRisks) || input.healthRisks.some((risk) => !HEALTH_RISKS.includes(risk))) throw badRequest('profile.healthRisks 无效');
    result.healthRisks = [...new Set(input.healthRisks)];
  }
  if ('lifeStage' in input) result.lifeStage = requireEnum(input.lifeStage, LIFE_STAGES, 'lifeStage');
  return result;
}

export function hasKidneyRisk(profile) {
  return (profile.healthRisks ?? []).includes('kidney');
}

// Optional, user-supplied safety facts for a non-personalized meal review.
// No demographic defaults and no adult target formula in this mode.
export function validateSafetyContext(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw badRequest('safetyContext 必须是对象');
  const allowed = ['age', 'lifeStage', 'healthRisks'];
  if (Object.keys(input).some((key) => !allowed.includes(key))) throw badRequest('safetyContext 只接收 age/lifeStage/healthRisks');
  const context = { healthRisks: [] };
  if (input.age !== undefined) context.age = requireNumber(input.age, 'age', { min: 3, max: 120, integer: true });
  if (input.lifeStage !== undefined) context.lifeStage = requireEnum(input.lifeStage, LIFE_STAGES, 'lifeStage');
  if (input.healthRisks !== undefined) {
    if (!Array.isArray(input.healthRisks) || input.healthRisks.some((risk) => !HEALTH_RISKS.includes(risk))) throw badRequest('safetyContext.healthRisks 无效');
    context.healthRisks = [...new Set(input.healthRisks)];
  }
  return context;
}
