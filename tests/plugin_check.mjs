// plugin_check.mjs —— 无模型验证：用假 Cordis Context 加载插件，核对注册定义与真实执行结果。
// 这是 AGH 官方示例采用的验证方式（tools/public-docs/examples.test.ts 同思路），不依赖真实模型。
import assert from 'node:assert';
import { lishuiTrailPlugin } from '../packages/lishui-trail-plugin/index.mjs';

const Kind = Symbol.for('TypeBox.Kind');
const problems = [];
const note = (s) => problems.push(s);

// ---- 假 Context：只实现插件声明依赖的 extension 行 API ----
const tools = new Map();
const hooks = [];
const fakeAgnes = {
  ctx: { log: { info: () => {} } },
  registerTool(def) {
    if (tools.has(def.name)) note(`工具名重复：${def.name}`);
    tools.set(def.name, def);
  },
  on(name, fn) { hooks.push({ name, fn }); },
};
const ctx = { extension: () => fakeAgnes };

console.log('=== 1) 加载插件 ===');
assert.ok(lishuiTrailPlugin, '插件未导出');
assert.deepStrictEqual(lishuiTrailPlugin.inject, ['extension'], 'inject 声明应为 ["extension"]');
lishuiTrailPlugin.apply(ctx);
console.log(`已注册工具 ${tools.size} 个：${[...tools.keys()].join(', ')}`);
console.log(`已注册观察 hook：${hooks.map((h) => h.name).join(', ') || '（无）'}`);

// ---- 2) 结构检查：参数必须是带 TypeBox kind 的 Schema，元数据必须齐备 ----
console.log('\n=== 2) 结构与元数据检查 ===');
const expectedMeta = ['isReadOnly', 'isDestructive', 'isConcurrencySafe', 'isOpenWorld', 'replay', 'requiresApproval'];
for (const t of tools.values()) {
  if (!t.description || t.description.length < 10) note(`${t.name}: description 缺失或过短`);
  if (typeof t.execute !== 'function') note(`${t.name}: execute 不是函数`);
  const p = t.parameters;
  if (!p || p[Kind] !== 'Object') note(`${t.name}: parameters 不是带 TypeBox kind 的 Object Schema`);
  if (p && p.type !== 'object') note(`${t.name}: parameters.type 应为 object`);
  if (p && !Array.isArray(p.required)) note(`${t.name}: parameters.required 缺失`);
  if (p && typeof p.properties !== 'object') note(`${t.name}: parameters.properties 缺失`);
  for (const [k, v] of Object.entries(p?.properties || {})) {
    if (!v || !v[Kind]) note(`${t.name}.${k}: 属性缺少 TypeBox kind 标记`);
  }
  for (const m of expectedMeta) if (t.meta?.[m] === undefined) note(`${t.name}: meta.${m} 未声明`);
  if (t.meta?.isReadOnly !== true) note(`${t.name}: 应为只读（isReadOnly=true）`);
  if (t.meta?.isOpenWorld !== false) note(`${t.name}: 应为封闭世界（isOpenWorld=false）`);
}
console.log(problems.length ? `发现 ${problems.length} 处问题` : '全部通过');
if (problems.length) { for (const p of problems) console.log('  ✗', p); process.exit(1); }

// ---- 3) 工具参数契约检查：required 中列出的键必须存在于 properties ----
for (const t of tools.values()) {
  for (const r of t.parameters.required || []) {
    if (!(r in t.parameters.properties)) note(`${t.name}: required 含未声明的键 ${r}`);
  }
}

// ---- 4) 真实执行每个工具 ----
console.log('\n=== 3) 执行结果检查 ===');
const call = async (name, args = {}) => {
  const t = tools.get(name);
  const res = await Promise.resolve(t.execute(args));
  assert.ok(res && Array.isArray(res.content) && res.content.length, `${name}: 返回缺少 content`);
  assert.strictEqual(res.content[0].type, 'text', `${name}: content[0].type 应为 text`);
  JSON.stringify(res.structured); // 必须可序列化
  return res;
};
const head = (s, n = 220) => String(s).split('\n').slice(0, 6).join('\n').slice(0, n);

const rStatus = await call('lishui_trail_status');
console.log('--- lishui_trail_status ---\n' + rStatus.content[0].text);

const rQuery = await call('lishui_trail_query', { dims: ['village', 'intangible'], limit: 5 });
console.log('\n--- lishui_trail_query ---\n' + rQuery.content[0].text);

const rPlan = await call('lishui_trail_plan', {
  persona: 'slow', interestText: '想走慢城水乡，看古村老街，体验非遗和采摘',
  fitness: 'normal', durationMin: 300, date: '2026-10-18', startTime: '08:30', visitDepth: 'balanced',
});
console.log('\n--- lishui_trail_plan(brief) ---\n' + rPlan.content[0].text);

assert.ok(rPlan.structured.ok, '规划应可行');
assert.ok(rPlan.structured.metrics.stopCount >= 1, '至少应有 1 个停靠点');
assert.ok(rPlan.structured.verification.fail === 0, '自校验不应有失败项');
// 深度约束生效
const M = rPlan.structured.metrics;
assert.ok(M.depthStops >= Math.ceil(M.depthTargetPct / 100 * M.stopCount),
  `深度游览站数 ${M.depthStops} 未达到目标占比 ${M.depthTargetPct}%`);

const rRisk = await call('lishui_trail_risk', { fitness: 'relaxed', durationMin: 240, party: { children: 1 }, date: '2026-07-15' });
console.log('\n--- lishui_trail_risk ---\n' + head(rRisk.content[0].text, 400));
assert.ok(rRisk.structured.risk.score >= 0 && rRisk.structured.risk.score <= 100, '风险分应在 0—100');

const firstStopId = rPlan.structured.itinerary[1].poiId;
const rAlt = await call('lishui_trail_alternatives', { poiId: firstStopId, k: 3 });
console.log('\n--- lishui_trail_alternatives ---\n' + rAlt.content[0].text);

const rExp = await call('lishui_trail_export', { persona: 'photo', durationMin: 240, format: 'both' });
const gpxOk = /<gpx[^>]*>/i.test(rExp.structured.gpx || '');
const csvOk = (rExp.structured.csv || '').split('\n').length > 2;
console.log(`\n--- lishui_trail_export --- GPX 头部有效=${gpxOk}｜CSV 行数=${(rExp.structured.csv || '').split('\n').length}`);
assert.ok(gpxOk, 'GPX 应为合法 XML 头');
assert.ok(csvOk, 'CSV 应包含表头与数据行');

console.log('\n=== 4) 复现性检查（相同种子两次规划应完全一致）===');
const a1 = await call('lishui_trail_plan', { persona: 'slow', durationMin: 240, seed: 424242 });
const a2 = await call('lishui_trail_plan', { persona: 'slow', durationMin: 240, seed: 424242 });
assert.strictEqual(JSON.stringify(a1.structured.itinerary.map((s) => s.poiId)),
  JSON.stringify(a2.structured.itinerary.map((s) => s.poiId)), '相同种子结果应完全一致');
console.log('相同种子两次规划点位序列一致 ✓');

console.log('\n全部插件检查通过 ✓');
