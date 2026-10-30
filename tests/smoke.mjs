// smoke.mjs —— 端到端烟测：一次完整规划 + 校验，打印关键指标
import { planTrip, suggestAlternatives } from '../packages/lishui-trail-plugin/lib/engine.mjs';

const profile = {
  persona: 'slow',
  interestText: '想走慢城水乡，看古村和老街，顺便体验非遗和乡野采摘',
  fitness: 'normal',
  durationMin: 300,
  startTime: '08:30',
  date: '2026-10-18',
  seed: 20261010,
};

console.log('=== 规划开始 ===');
const t0 = Date.now();
const res = planTrip({ profile, doVerify: true, replanForVerify: true });
console.log('耗时(ms):', Date.now() - t0);
console.log('ok:', res.ok);
console.log('environment:', JSON.stringify(res.environment));
if (!res.ok) { console.log('不可行'); process.exit(1); }

console.log('\n--- 画像 ---');
console.log(res.profile.summary.join('\n'));

console.log('\n--- 行程 ---');
for (const s of res.route.itinerary) {
  console.log(`${String(s.arriveMin).padStart(4)}-${String(s.departMin).padStart(4)}  ${s.name}  (${s.type}·${s.town})  停留${s.dwellMin}  收益${s.profit}  高程${s.elevationM}`);
}
console.log('\n--- 指标 ---');
console.log(JSON.stringify(res.route.metrics, null, 1));
console.log('\n--- 求解器 ---');
console.log(JSON.stringify({ candidates: res.route.solver.candidates, improvementPct: res.route.solver.improvementPct,
  greedy: res.route.solver.greedyOnly, best: res.route.solver.best, repair: res.route.solver.repairLog }, null, 1));
console.log('\n--- 风险 ---');
console.log('score', res.risk.score, res.risk.level);
console.log(res.risk.factors.map((f) => `${f.label}=${f.value}(w${f.weight})`).join('  '));
console.log('mitigations:'); res.risk.mitigations.forEach((m) => console.log(' -', m));
console.log('\n--- 校验 ---');
console.log(res.verification.summary);
res.verification.checks.forEach((c) => console.log(`  [${c.status}] ${c.name}: ${c.detail}`));
console.log('\n--- 几何点数 ---', res.route.coords.length);
console.log('--- 替代点建议 ---');
const alt = suggestAlternatives({ poiId: res.route.itinerary[1].poiId, k: 3 });
console.log(JSON.stringify(alt, null, 1).slice(0, 900));

// 断言：可行方案的自校验不得出现失败项。
// （此前本文件只打印不判定，等于"自校验失败也照样 exit 0"，会漏掉真缺陷。）
if (res.verification.failed > 0) {
  console.error(`\n✗ 可行方案的自校验出现 ${res.verification.failed} 项失败：`
    + res.verification.checks.filter((c) => c.status === 'fail').map((c) => `${c.name}（${c.detail}）`).join('；'));
  process.exit(1);
}
if (res.verification.checks.length !== 12) {
  console.error(`\n✗ 带 replanForVerify 时自校验应为 12 项，实为 ${res.verification.checks.length} 项`);
  process.exit(1);
}
