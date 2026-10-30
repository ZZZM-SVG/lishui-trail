// profile.mjs —— 个性化画像：归一化、约束推导、兴趣预设
import { clamp } from './geo.mjs';
import { DIM_LABEL } from './dataset.mjs';

export const DIM_KEYS = Object.keys(DIM_LABEL);

/** 体能档位 → 约束与速度（速度系数乘在 Tobler 基准时间上，>1 表示更快） */
export const FITNESS = {
  relaxed: { label: '休闲', maxSlopeDeg: 18, maxAscentM: 320, maxDistanceM: 8000, speedFactor: 0.85 },
  normal:  { label: '常规', maxSlopeDeg: 25, maxAscentM: 620, maxDistanceM: 14000, speedFactor: 1.0 },
  strong:  { label: '强健', maxSlopeDeg: 33, maxAscentM: 1100, maxDistanceM: 24000, speedFactor: 1.15 },
};

/** 常见人群画像预设（供 Agent 快速映射自然语言，也可被用户覆盖） */
export const PERSONAS = {
  family:    { label: '亲子家庭', dims: { farming: 1, village: 0.8, water: 0.7, food: 0.6, intangible: 0.6 },
               fitness: 'relaxed', durationMin: 210, party: { adults: 2, children: 1 } },
  photo:     { label: '摄影打卡', dims: { landscape: 1, water: 0.9, village: 0.7, farming: 0.6 },
               fitness: 'normal', durationMin: 300 },
  history:   { label: '历史人文', dims: { red: 1, village: 0.9, religion: 0.8, intangible: 0.7, museum: 0.7 },
               fitness: 'normal', durationMin: 300 },
  nature:    { label: '自然观光', dims: { landscape: 1, water: 0.6, farming: 0.4 },
               fitness: 'strong', durationMin: 360 },
  slow:      { label: '慢城休闲', dims: { village: 1, farming: 0.9, food: 0.8, intangible: 0.7, water: 0.6 },
               fitness: 'relaxed', durationMin: 240 },
  culture:   { label: '非遗民俗', dims: { intangible: 1, village: 0.8, food: 0.8, religion: 0.6 },
               fitness: 'normal', durationMin: 270 },
};

/**
 * 归一化用户画像。
 * 输入可以是自然语言解析后的任意字段组合，缺省项按安全默认值补齐。
 */
export function normalizeProfile(input = {}) {
  const warnings = [];
  const persona = input.persona && PERSONAS[input.persona] ? PERSONAS[input.persona] : null;

  // ---- 兴趣权重 ----
  let interests = {};
  if (persona) interests = { ...persona.dims };
  if (input.interests && typeof input.interests === 'object') {
    for (const [k, v] of Object.entries(input.interests)) {
      if (!DIM_KEYS.includes(k)) {
        const hit = DIM_KEYS.find((d) => DIM_LABEL[d] === k);
        if (hit) interests[hit] = Number(v);
        else warnings.push(`忽略未知兴趣维度：${k}`);
        continue;
      }
      interests[k] = Number(v);
    }
  }
  if (input.interestText) {
    const t = String(input.interestText);
    const kw = {
      landscape: /山水|山|峰|自然|风景|山野|森林|登高/, water: /湖|水|湿地|水库|河|潟|湖荡|水岸/,
      farming: /采摘|果园|农场|田园|农|蓝莓|草莓|杨梅|茶|花|农业/, red: /红色|革命|抗战|新四军|旧址|烈士|爱国/,
      village: /古村|老街|村落|古镇|民居|宗祠|传统村落|乡村/, religion: /寺|庙|观|宗教|祠|塔|古建|文物/,
      intangible: /非遗|民俗|庙会|节庆|技艺|民俗文化|手工/, museum: /博物馆|展馆|纪念馆|美术馆|书院|文化馆/,
      resort: /度假|温泉|露营|民宿|休闲|游乐/, food: /美食|小吃|特产|土菜|农家菜|物产/,
    };
    for (const [k, re] of Object.entries(kw)) if (re.test(t)) interests[k] = Math.max(interests[k] ?? 0, 1);
  }
  const provided = DIM_KEYS.filter((d) => Number.isFinite(interests[d]) && interests[d] > 0);
  if (!provided.length) {
    warnings.push('未识别到明确兴趣偏好，已按"均衡漫游"补齐默认权重。');
    for (const d of ['landscape', 'village', 'farming', 'water']) interests[d] = 1;
  }
  const clean = {};
  let sum = 0;
  for (const d of DIM_KEYS) {
    const v = Number(interests[d]);
    if (Number.isFinite(v) && v > 0) { clean[d] = clamp(v, 0, 1); sum += clean[d]; }
  }
  for (const d of Object.keys(clean)) clean[d] = clean[d] / sum;

  // ---- 体能 ----
  let fitnessKey = input.fitness || persona?.fitness || 'normal';
  if (!FITNESS[fitnessKey]) {
    const alias = { low: 'relaxed', medium: 'normal', high: 'strong', 休闲: 'relaxed', 常规: 'normal', 强健: 'strong' };
    const k = alias[fitnessKey];
    if (k) fitnessKey = k;
    else { warnings.push(`未知体能档位「${fitnessKey}」，已按常规处理。`); fitnessKey = 'normal'; }
  }
  const base = { ...FITNESS[fitnessKey] };

  // ---- 同行人员 ----
  const party = { adults: 2, elderly: 0, children: 0, ...(persona?.party || {}), ...(input.party || {}) };
  party.adults = Math.max(1, Number(party.adults) || 1);
  party.elderly = Math.max(0, Number(party.elderly) || 0);
  party.children = Math.max(0, Number(party.children) || 0);
  let slopeK = 1, ascentK = 1, speedK = 1;
  if (party.elderly > 0) { slopeK *= 0.80; ascentK *= 0.70; speedK *= 0.85; }
  if (party.children > 0) { slopeK *= 0.75; ascentK *= 0.65; speedK *= 0.80; }

  const constraints = {
    maxSlopeDeg: Math.round(clamp(Number(input.maxSlopeDeg) || base.maxSlopeDeg * slopeK, 8, 45)),
    maxAscentM: Math.round(Number(input.maxAscentM) || base.maxAscentM * ascentK),
    maxDistanceM: Math.round(Number(input.maxDistanceM) || base.maxDistanceM),
    speedFactor: Number(input.speedFactor) || base.speedFactor * speedK,
  };
  if (Number(input.maxSlopeDeg) && Number(input.maxSlopeDeg) > base.maxSlopeDeg && (party.elderly || party.children)) {
    warnings.push('用户手动放宽了坡度上限，但同行含老人/儿童，风险模块会相应提高地形权重。');
  }

  // ---- 时间 ----
  const durationMin = Math.round(clamp(Number(input.durationMin) || persona?.durationMin || 240, 60, 720));
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(input.date || ''))
    ? String(input.date) : new Date().toISOString().slice(0, 10);
  const startTime = /^\d{1,2}:\d{2}$/.test(String(input.startTime || '')) ? String(input.startTime) : '08:30';

  const mustVisit = Array.isArray(input.mustVisit) ? input.mustVisit.filter(Boolean) : [];
  const avoid = Array.isArray(input.avoid) ? input.avoid.filter(Boolean) : [];

  // 游览深度偏好：deep=每站深度游览；balanced=至少一半站深度；wide=允许大量快速打卡
  let visitDepth = input.visitDepth || 'balanced';
  if (!['deep', 'balanced', 'wide'].includes(visitDepth)) {
    const alias = { 深度: 'deep', 均衡: 'balanced', 广度: 'wide', 打卡: 'wide' };
    if (alias[visitDepth]) visitDepth = alias[visitDepth];
    else { warnings.push(`未知游览深度「${visitDepth}」，已按均衡处理。`); visitDepth = 'balanced'; }
  }

  return {
    raw: input,
    persona: input.persona || null,
    interests: clean,
    interestLabels: Object.entries(clean).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ dim: k, label: DIM_LABEL[k], weight: Math.round(v * 100) / 100 })),
    fitness: fitnessKey, fitnessLabel: FITNESS[fitnessKey].label,
    party, constraints, durationMin, date, startTime,
    loop: input.loop !== false && input.loop !== 'false',
    visitDepth,
    visitDepthLabel: { deep: '深度游览', balanced: '深度与广度均衡', wide: '广撒网打卡' }[visitDepth],
    seed: Number.isInteger(input.seed) ? input.seed : 20261010,
    start: input.start || null,
    mustVisit, avoid,
    warnings,
  };
}

export function profileSummary(p) {
  const s = [];
  s.push(`兴趣：${p.interestLabels.slice(0, 4).map((x) => `${x.label}${(x.weight * 100).toFixed(0)}%`).join('、') || '均衡'}`);
  s.push(`体能：${p.fitnessLabel}（坡度≤${p.constraints.maxSlopeDeg}°，爬升≤${p.constraints.maxAscentM}m，路程≤${(p.constraints.maxDistanceM / 1000).toFixed(1)}km）`);
  s.push(`时长：${p.durationMin} 分钟；出发：${p.date} ${p.startTime}`);
  s.push(`游览深度：${p.visitDepthLabel}`);
  const pt = [];
  if (p.party.children) pt.push(`儿童${p.party.children}`);
  if (p.party.elderly) pt.push(`老人${p.party.elderly}`);
  if (pt.length) s.push(`同行：成人${p.party.adults}、${pt.join('、')}`);
  if (p.mustVisit.length) s.push(`必去：${p.mustVisit.join('、')}`);
  if (p.avoid.length) s.push(`避开：${p.avoid.join('、')}`);
  return s;
}
