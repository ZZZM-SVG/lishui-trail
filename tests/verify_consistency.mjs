// verify_consistency.mjs —— 自校验模块（lib/verify.mjs）的回归测试
//
// 来源：一次真实 AGH 会话中，平缓路线（累计爬升恰好 0 m）被判
//   [fail] 累计爬升一致性: 独立重算 0 m vs 报告 0 m（偏差 100.00%）
// 根因是判据写成 `reported > 0 ? |重算-报告|/报告 : 1` —— 报告值为 0 时无条件判 100% 偏差。
// 本套件同时守住两头：
//   ① 零值/小值指标不得误报失败；
//   ② 判据也不能被放宽到"永远通过"——真实不一致必须仍然被抓出来。
//
// 运行：node tests/verify_consistency.mjs   （成功 exit 0）

import assert from 'node:assert';
import { verifyRoute } from '../packages/lishui-trail-plugin/lib/verify.mjs';
import { loadDataset } from '../packages/lishui-trail-plugin/lib/dataset.mjs';
import { loadTerrain } from '../packages/lishui-trail-plugin/lib/terrain.mjs';
import { normalizeProfile } from '../packages/lishui-trail-plugin/lib/profile.mjs';
import { planTrip } from '../packages/lishui-trail-plugin/lib/engine.mjs';

const ds = loadDataset();
const T = loadTerrain();
const P = normalizeProfile({ persona: 'slow', durationMs: undefined, durationMin: 300 });
const lines = [];
const L = (s = '') => lines.push(String(s));
let failed = 0;
const check = (name, fn) => {
  try { fn(); L(`  [pass] ${name}`); }
  catch (e) { failed += 1; L(`  [FAIL] ${name}: ${e.message}`); }
};
const pick = (name) => { const c = (r) => r.checks.find((x) => x.name === name); return c; };

// ---------------------------------------------------------------- ① 合成路线：零爬升 / 零里程
// 用石臼湖西岸一段真实坐标构造一条平缓路线（该处高程恒为个位数米）
const flat = [
  { lon: 118.91270, lat: 31.50330 },
  { lon: 118.92000, lat: 31.50330 },
  { lon: 118.92730, lat: 31.50330 },
];
let flatDist = 0;
for (let i = 1; i < flat.length; i++) {
  const a = flat[i - 1], b = flat[i];
  flatDist += Math.hypot((b.lon - a.lon) * 111320 * Math.cos(31.5 * Math.PI / 180),
                         (b.lat - a.lat) * 110574);
}
const ascentOf = (coords) => T.stats(coords).ascentM;
const flatAscent = ascentOf(flat);

const mkRoute = (over) => ({
  coords: flat,
  legs: [{ fromName: '合成', toName: '合成', coords: flat, distanceM: Math.round(flatDist) }],
  itinerary: [{ poiId: '__start__', name: '合成起点', dwellMin: 0 }],
  metrics: {
    totalDistanceM: Math.round(flatDist),
    totalAscentM: flatAscent,
    ...(over || {}),
  },
});

L('=== ① 零值指标不得误报失败 ===');
L(`  合成路线：${flat.length} 点 / 直线 ${Math.round(flatDist)} m / 实测爬升 ${flatAscent} m`);

check('平缓路线（爬升恰为 0）应通过全部检查', () => {
  // 只有当石臼湖岸真的是平的，这条断言才具有"零值"意义；否则下面会打印实际值
  const r = verifyRoute({ ds, T, P, route: mkRoute(), risk: null });
  const c = pick('累计爬升一致性')(r);
  assert.strictEqual(c.status, 'pass', `累计爬升一致性本应 pass，实为 ${c.status}（${c.detail}）`);
  assert.strictEqual(r.failed, 0, `不应有失败项，实为 ${r.failed}：${r.checks.filter((x) => x.status === 'fail').map((x) => x.name).join('、')}`);
});

check('把报告爬升写成 0（重算为 0）应 pass，写成 0（重算非 0）应 fail', () => {
  const r0 = verifyRoute({ ds, T, P, route: mkRoute({ totalAscentM: 0 }), risk: null });
  const c0 = pick('累计爬升一致性')(r0);
  const recomputed = ascentOf(flat);
  if (recomputed === 0) {
    assert.strictEqual(c0.status, 'pass', `重算与报告同为 0 时应 pass，实为 ${c0.status}（${c0.detail}）`);
    assert.ok(!/100\.00%/.test(c0.detail), `报告为 0 时不应再出现"偏差 100.00%"的退化表述：${c0.detail}`);
  } else {
    // 该点若并非完全平坦，则报告 0 与重算不符，必须判 fail —— 判据不能被放宽成永远通过
    assert.strictEqual(c0.status, 'fail', `重算 ${recomputed} m 而报告 0 m，应 fail`);
  }
});

L('');
L('=== ② 判据不可被放宽为"永远通过" ===');
check('报告爬升放大 10 倍必须被判 fail', () => {
  const real = Math.max(ascentOf(flat), 20);      // 取一个有量级的值，避免 0 的歧义
  const r = verifyRoute({ ds, T, P, route: mkRoute({ totalAscentM: real * 10 }), risk: null });
  const c = pick('累计爬升一致性')(r);
  assert.strictEqual(c.status, 'fail', `报告值明显错误时应 fail，实为 ${c.status}（${c.detail}）`);
});
check('报告里程放大 3 倍必须被判 fail', () => {
  const r = verifyRoute({ ds, T, P, route: mkRoute({ totalDistanceM: Math.round(flatDist) * 3 }), risk: null });
  const c = pick('距离一致性')(r);
  assert.strictEqual(c.status, 'fail', `报告里程明显错误时应 fail，实为 ${c.status}（${c.detail}）`);
});
check('报告爬升与重算一致（非零）必须 pass', () => {
  const real = 137;
  const r = verifyRoute({ ds, T, P, route: mkRoute({ totalAscentM: real }), risk: null });
  const c = pick('累计爬升一致性')(r);
  // 重算值由真实地形决定；只有当真值恰为 137 时才应 pass，否则应 fail（说明判据敏感）
  const recomputed = ascentOf(flat);
  const expect = Math.abs(recomputed - real) <= Math.max(0.02 * real, 2) ? 'pass' : 'fail';
  assert.strictEqual(c.status, expect, `重算 ${recomputed} vs 报告 ${real}，期望 ${expect}，实为 ${c.status}`);
});

L('');
L('=== ③ 真实规划：可行方案不应出现失败项 ===');
const SCENARIOS = [
  ['慢城休闲 300min', { persona: 'slow', interestText: '慢城水乡古村老街非遗乡野采摘', fitness: 'normal', durationMin: 300, startTime: '08:30', date: '2026-10-18', seed: 20261010 }],
  ['亲子 180min', { persona: 'family', fitness: 'relaxed', durationMin: 180, startTime: '09:00', date: '2026-10-10', loop: true, party: { adults: 2, children: 1 } }],
  ['石臼湖西岸自定义起点（平缓）', { persona: 'slow', fitness: 'normal', durationMin: 270, startTime: '09:00', date: '2026-10-11', loop: true, visitDepth: 'deep', party: { adults: 2, children: 1, elderly: 1 }, startLon: 118.9127, startLat: 31.5033 }],
  ['摄影打卡 强体力 360min', { persona: 'photo', fitness: 'strong', durationMin: 360, startTime: '08:00', date: '2026-10-18' }],
  ['自然观光 200min', { persona: 'nature', fitness: 'normal', durationMin: 200, startTime: '07:30', date: '2026-10-18' }],
  ['历史人文 老人2 240min', { persona: 'history', fitness: 'relaxed', durationMin: 240, startTime: '09:00', date: '2026-10-18', party: { adults: 2, elderly: 2 } }],
];
for (const [name, input] of SCENARIOS) {
  check(`真实规划｜${name}`, () => {
    const res = planTrip({ profile: normalizeProfile(input), doVerify: true, replanForVerify: true });
    assert.ok(res.ok, `方案应可行：${res.route?.reason || ''}`);
    L(`        ${res.verification.summary}  爬升=${res.route.metrics.totalAscentM} m 里程=${res.route.metrics.totalDistanceM} m`);
    assert.strictEqual(res.verification.failed, 0,
      `可行方案不应有失败项：${res.verification.checks.filter((c) => c.status === 'fail').map((c) => `${c.name}（${c.detail}）`).join('；')}`);
    assert.strictEqual(res.verification.checks.length, 12, `带 replanForVerify 时应为 12 项，实为 ${res.verification.checks.length}`);
  });
}

L('');
L(`=== 结果：${failed === 0 ? '全部通过' : `${failed} 项失败`} ===`);
console.log(lines.join('\n'));
process.exit(failed === 0 ? 0 : 1);
