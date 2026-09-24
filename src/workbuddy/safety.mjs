// 安全分流：本服务只做日常饮食参考，不做诊断和治疗。
// level: ok（正常参考）/ caution（可参考但需谨慎）/ refer（建议转专业渠道）。
import { hasKidneyRisk } from './profile.mjs';

const ACUTE_SYMPTOMS = [
  '胸痛', '胸闷', '呼吸困难', '晕倒', '昏厥', '剧烈腹痛', '呕血', '便血',
  '高烧', '严重头晕', '食物中毒',
];
const EATING_DISORDER = ['暴食', '催吐', '厌食', '绝食', '吃了就吐', '不敢吃饭'];
const DIAGNOSIS_OR_MEDS = [
  '诊断', '确诊', '停药', '换药', '吃什么药', '药量', '胰岛素', '降糖药', '降压药',
];
const PREGNANCY_TERMS = ['怀孕', '孕期', '孕妇', '哺乳', '月子'];

export function evaluateSafety({ profile = {}, mealText = '' }) {
  const reasons = [];
  const text = String(mealText || '');

  if (profile.age < 18) {
    reasons.push('未成年人：生长发育期的营养目标需要医生或注册营养师个体化制定，本结果不适用减脂目标。');
  }
  if (profile.lifeStage === 'pregnancy' || profile.lifeStage === 'breastfeeding') {
    reasons.push('孕期/哺乳期：营养需求变化大，请以产科医生或临床营养师建议为准。');
  }
  for (const term of PREGNANCY_TERMS) {
    if (text.includes(term)) {
      reasons.push(`描述中提到“${term}”：孕期/哺乳期相关饮食请以医生建议为准。`);
      break;
    }
  }
  for (const term of ACUTE_SYMPTOMS) {
    if (text.includes(term)) {
      reasons.push(`描述中提到“${term}”：这可能是急性症状，请及时就医，不要按饮食建议处理。`);
      break;
    }
  }
  for (const term of EATING_DISORDER) {
    if (text.includes(term)) {
      reasons.push(`描述中提到“${term}”：疑似进食障碍信号，建议尽快联系医生或心理/营养专业人员。`);
      break;
    }
  }
  for (const term of DIAGNOSIS_OR_MEDS) {
    if (text.includes(term)) {
      reasons.push(`描述中提到“${term}”：诊断、用药或停药问题请咨询医生，本服务不提供医疗建议。`);
      break;
    }
  }
  if (hasKidneyRisk(profile)) {
    reasons.push('肾功能关注：蛋白质目标和补充方式请以医生或临床营养师建议为准。');
  }

  const refer = reasons.length > 0 &&
    (profile.age < 18 ||
      (profile.lifeStage && profile.lifeStage !== 'general') ||
      PREGNANCY_TERMS.some((term) => text.includes(term)) ||
      ACUTE_SYMPTOMS.some((term) => text.includes(term)) ||
      EATING_DISORDER.some((term) => text.includes(term)) ||
      DIAGNOSIS_OR_MEDS.some((term) => text.includes(term)));

  return {
    level: refer ? 'refer' : reasons.length > 0 ? 'caution' : 'ok',
    reasons,
    note: '本服务只提供日常饮食参考，不构成诊断、治疗或用药建议。',
  };
}
