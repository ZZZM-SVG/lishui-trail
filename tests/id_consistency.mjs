// id_consistency.mjs —— 点位 ID 一致性核查
//
// 背景：真实 AGH 会话中，模型把 lishui_trail_plan 行程里的 poiId 回传给 lishui_trail_alternatives，
// 却得到同 ID 不同名称的基准点（行程里是「郭兴庄园」，替代接口说是「回峰山」）。
// 本脚本核查：行程 poiId → ds.get(poiId) → alternatives 基准点，三者是否自洽。
import { loadDataset } from '../packages/lishui-trail-plugin/lib/dataset.mjs';
import { planTrip, suggestAlternatives } from '../packages/lishui-trail-plugin/lib/engine.mjs';

const ds = loadDataset();
const profile = {
  persona: 'slow',
  interestText: '想走慢城水乡，看古村和老街，顺便体验非遗和乡野采摘',
  fitness: 'normal', durationMin: 300, startTime: '08:30', date: '2026-10-18', seed: 20261010,
};
const res = planTrip({ profile, doVerify: false });
const lines = ['=== 行程 poiId → ds.get → alternatives 基准点 ==='];
let bad = 0;
for (const s of res.route.itinerary) {
  const got = s.poiId === '__start__' ? null : ds.get(s.poiId);
  const alt = s.poiId === '__start__' ? null : suggestAlternatives({ poiId: s.poiId, k: 1 });
  const gotName = got ? got.name : '（起点，无数据集记录）';
  const altName = alt && alt.ok ? alt.base.name : `ERROR:${alt ? alt.error : 'n/a'}`;
  const consistent = s.poiId === '__start__' ? true : (gotName === s.name && altName === s.name);
  if (!consistent) bad += 1;
  lines.push(`${consistent ? '✓' : '✗'} ${s.poiId}  行程名称=${s.name}  ds.get=${gotName}  alternatives=${altName}`);
}

// 反向核查：同名点位是否存在重复 ID / 同 ID 多条记录
const byId = new Map();
for (const p of ds.pois) {
  if (!byId.has(p.id)) byId.set(p.id, []);
  byId.get(p.id).push(p.name);
}
const dupIds = [...byId.entries()].filter(([, names]) => names.length > 1);
lines.push('', `数据集点位条数=${ds.pois.length}，不同 ID 数=${byId.size}，重复 ID 数=${dupIds.length}`);
for (const [id, names] of dupIds.slice(0, 10)) lines.push(`  重复 ID ${id}: ${names.join(' / ')}`);

// 名称反查
for (const nm of ['郭兴庄园', '回峰山', '无想山景区', '幸庄湿地公园']) {
  const hits = ds.pois.filter((p) => p.name.includes(nm)).map((p) => `${p.id}:${p.name}`);
  lines.push(`名称「${nm}」→ ${hits.join(' | ') || '（无）'}`);
}

lines.push('', bad === 0 ? '结论：一致 ✓' : `结论：发现 ${bad} 处不一致 ✗`);
console.log(lines.join('\n'));
process.exit(bad === 0 ? 0 : 1);
