// case_matrix.mjs —— 提交材料用「测试样例矩阵」：正常 / 边界 / 失败 三类，输出可核验的真实结论
//
// 目的：向评委证明系统在三类输入下的行为是可预期的——正常给出方案，边界不崩且给出降级/警告，
// 失败（无解、非法入参）明确报错而不静默返回错误答案。
//
// 运行：node tests/case_matrix.mjs

import { lishuiTrailPlugin } from '../packages/lishui-trail-plugin/index.mjs';

const tools = new Map();
lishuiTrailPlugin.apply({ extension: () => ({ registerTool: (t) => tools.set(t.name, t), on: undefined }) });
const call = async (name, args) => {
  const t = tools.get(name);
  const r = await t.execute(args);
  return r.structured ?? {};
};

const brief = (s) => (typeof s === 'string' && s.length > 120 ? `${s.slice(0, 120)}…` : s);

// 正常样例：慢城休闲画像（与 README / 证据目录一致）
const NORMAL = {
  persona: 'slow', interestText: '想走慢城水乡，看古村和老街，顺便体验非遗和乡野采摘',
  fitness: 'normal', durationMin: 300, startTime: '08:30', date: '2026-10-18', seed: 20261010,
};
const FAMILY = {
  persona: 'family', fitness: 'relaxed', durationMin: 180, date: '2026-10-10',
  startTime: '09:00', loop: true, visitDepth: 'balanced',
  party: { adults: 2, children: 1 }, interestText: '亲子轻松，想看古村与非遗',
};

const FAMILIES = [
  ['正常', 'plan｜慢城休闲 300min', 'lishui_trail_plan', NORMAL],
  ['正常', 'plan｜亲子 180min', 'lishui_trail_plan', FAMILY],
  ['正常', 'query｜非遗+古村', 'lishui_trail_query', { dims: ['village', 'intangible'], limit: 5 }],
  ['正常', 'risk｜亲子 180min', 'lishui_trail_risk', FAMILY],
  ['正常', 'export｜GPX', 'lishui_trail_export', { ...NORMAL, format: 'gpx' }],

  ['边界', 'plan｜预算压到下限 60min', 'lishui_trail_plan', { ...FAMILY, durationMin: 60 }],
  ['边界', 'plan｜区外起点（直线距离 > 70km）', 'lishui_trail_plan', { ...FAMILY, startLon: 118.5, startLat: 32.2 }],
  ['边界', 'plan｜预算 720min + 必去 2 点 + 老人2儿童2', 'lishui_trail_plan', {
    ...FAMILY, durationMin: 720, mustVisit: ['LS-01', 'LS-38'], party: { adults: 1, elderly: 2, children: 2 },
  }],
  ['边界', 'plan｜游览深度 deep / wide 对照', 'lishui_trail_plan', { ...FAMILY, durationMin: 300, visitDepth: 'deep' }],
  ['边界', 'query｜不存在的维度 key', 'lishui_trail_query', { dims: ['nope'], limit: 1 }],
  ['边界', 'query｜空关键词 + 半径 3000m', 'lishui_trail_query', { nearLon: 118.9127, nearLat: 31.5033, radiusM: 3000 }],

  ['失败', 'alternatives｜不存在的点位 ID', 'lishui_trail_alternatives', { poiId: 'NOPE-999' }],
  ['失败', 'plan｜必去点超出预算且无法降级', 'lishui_trail_plan', {
    ...FAMILY, durationMin: 60, mustVisit: ['LS-01', 'LS-38'], avoid: [],
  }],
  ['失败', 'risk｜同上不可行画像', 'lishui_trail_risk', { ...FAMILY, durationMin: 60, mustVisit: ['LS-01', 'LS-38'] }],
  ['失败', 'export｜不可行画像不产出 GPX', 'lishui_trail_export', { ...FAMILY, durationMin: 60, mustVisit: ['LS-01', 'LS-38'], format: 'gpx' }],
];

const lines = [`=== 测试样例矩阵 ${new Date().toISOString()} ===`];
let n = 0;
for (const [family, label, name, args] of FAMILIES) {
  n += 1;
  let s = {};
  let err = null;
  try { s = await call(name, args); } catch (e) { err = e.message; }
  const head = `[${String(n).padStart(2)}][${family}] ${label}`;
  lines.push('', head, `    入参 ${JSON.stringify(args)}`);
  if (err) { lines.push(`    ✗ execute 抛错：${err}`); continue; }
  lines.push(`    ok=${s.ok}${s.reason ? `  reason=${s.reason}` : ''}${s.error ? `  error=${brief(s.error)}` : ''}`);
  if (s.hint) lines.push(`    hint=${s.hint}`);
  if (s.metrics) {
    const M = s.metrics;
    const p = [];
    if (M.stopCount !== undefined) p.push(`站数=${M.stopCount}`);
    if (M.totalDistanceM !== undefined) p.push(`里程=${M.totalDistanceM}m`);
    if (M.totalAscentM !== undefined) p.push(`爬升=${M.totalAscentM}m`);
    if (M.totalMin !== undefined) p.push(`用时=${M.totalMin}/${M.budgetMin ?? '—'}min${M.budgetUsedPct !== undefined ? `(${M.budgetUsedPct}%)` : ''}`);
    if (M.depthStops !== undefined) p.push(`深度=${M.depthStops} 打卡=${M.quickStops}`);
    lines.push(`    ${p.join(' ')}`);
  }
  if (s.risk) lines.push(`    风险=${s.risk.score}/100（${s.risk.level}）`);
  if (s.verification) lines.push(`    自校验=${s.verification.summary}`);
  if (s.itinerary) lines.push(`    行程=${s.itinerary.map((x) => x.name).join(' → ')}`);
  if (s.warnings && s.warnings.length) lines.push(`    警告=${s.warnings.map((w) => brief(w)).join(' | ')}`);
  if (s.legs && s.legs.some((l) => l.unreachable)) lines.push(`    含不可达段：${s.legs.filter((l) => l.unreachable).length}/${s.legs.length}`);
  if (typeof s.count === 'number') lines.push(`    命中 ${s.count} 条：${(s.items || []).map((x) => x.id).join(',') || '—'}`);
  if (s.alternatives) lines.push(`    替代候选=${s.alternatives.map((x) => `${x.id}(相似${x.similarity})`).join(',')}`);
  if (s.gpx !== undefined) lines.push(`    GPX=${s.gpx ? `${s.gpx.length} 字符，头部有效=${/^<\?xml/.test(String(s.gpx))}` : 'null'}`);
  if (s.headline) lines.push(`    方案=${s.headline}`);
}

lines.push('', `=== 共 ${n} 例 ===`);
console.log(lines.join('\n'));
