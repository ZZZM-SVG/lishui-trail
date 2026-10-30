// engine.mjs —— 编排层：画像 → 规划 → 风险 → 自校验 → 说明文本（可离线无模型运行）
import { loadDataset, DIM_LABEL } from './dataset.mjs';
import { loadTerrain } from './terrain.mjs';
import { normalizeProfile, profileSummary } from './profile.mjs';
import { solveRoute, computeProfit } from './planner.mjs';
import { assessRisk } from './risk.mjs';
import { verifyRoute } from './verify.mjs';
import { toGpx, toItineraryCsv } from './gpx.mjs';
import { haversine, round, distToPolyline } from './geo.mjs';

const hhmm = (start, addMin) => {
  const [h, m] = start.split(':').map(Number);
  const t = h * 60 + m + addMin;
  return `${String(Math.floor((t / 60) % 24)).padStart(2, '0')}:${String(Math.round(t % 60)).padStart(2, '0')}`;
};

export function planTrip({ profile, dataDir, doVerify = true, replanForVerify = false } = {}) {
  const ds = loadDataset({ dataDir });
  const T = loadTerrain({ dataDir });
  const P = normalizeProfile(profile);
  const t0 = Date.now();
  const route = solveRoute({ ds, T, P });
  const risk = route.feasible ? assessRisk({ ds, T, P, route }) : null;
  const solveMs = Date.now() - t0;

  let verification = null;
  if (doVerify && route.feasible) {
    verification = verifyRoute({
      ds, T, P, route, risk,
      replanner: replanForVerify ? () => solveRoute({ ds, T, P }) : null,
    });
  }

  const environment = {
    dem: !T.demWarning, osm: !T.osmWarning,
    demWarning: T.demWarning, osmWarning: T.osmWarning,
    dataDir: ds.dir,
    grid: T.dem ? `${T.dem.w}×${T.dem.h} @ ${T.metrics.dx.toFixed(0)}m` : null,
    waterCells: T.grids ? T.grids.nWaterCells : 0,
    waterLineCells: T.grids ? T.grids.nWaterLineCells : 0,
    pathCells: T.grids ? T.grids.nPathCells : 0,
  };

  return {
    ok: route.feasible,
    solveMs,
    environment,
    profile: { ...P, summary: profileSummary(P) },
    route, risk, verification,
    provenance: {
      ...ds.provenance(),
      climate: '南京市气候常年值（1991—2020）',
      dem: T.dem ? T.dem.meta.source : null,
      osm: T.hasOsm ? 'OpenStreetMap (Overpass API, ODbL)' : null,
      solver: 'Orienteering Problem：贪心插入 + 2-opt/Or-opt + 模拟退火 + 多次重启；段间用 DEM 约束 A* 最小代价路径',
    },
    narrative: route.feasible ? buildNarrative({ ds, T, P, route, risk, verification }) : null,
  };
}

/** 生成结构化中文说明（不依赖大模型；Agnes 模型可在此基础上做自然语言改写与追问） */
export function buildNarrative({ ds, T, P, route, risk, verification }) {
  const M = route.metrics;
  const lines = [];
  const push = (s) => lines.push(s);

  push(`## 一句话方案`);
  push(`从「${route.start.name}」出发，${P.loop ? '环线' : '单程'}串联 ${M.stopCount} 个文旅停靠点，` +
       `步行 ${(M.totalDistanceM / 1000).toFixed(1)} km / 累计爬升 ${M.totalAscentM} m / 总耗时约 ${M.totalMin} 分钟` +
       `（预算 ${M.budgetMin} 分钟，占用 ${M.budgetUsedPct}%），综合风险 ${risk.score}/100（${risk.level}）。`);
  push(`游览节奏：${M.depthPreferenceLabel}（目标深度游览占比 ≥ ${M.depthTargetPct}%）——` +
       `实际深度游览 ${Math.max(0, M.depthStops)} 站、快速打卡 ${M.quickStops} 站。`);

  push('');
  push(`## 出行画像`);
  for (const s of profileSummary(P)) push(`- ${s}`);

  push('');
  push(`## 行程时间轴`);
  for (let i = 0; i < route.itinerary.length; i++) {
    const s = route.itinerary[i];
    const tag = i === 0 ? '起点' : `第 ${i} 站`;
    const arr = hhmm(P.startTime, s.arriveMin);
    const dep = hhmm(P.startTime, s.departMin);
    const why = i === 0
      ? '路网与接待条件最好，适合作为集合与返程点。'
      : `匹配兴趣：${(s.matched || []).join('、') || '综合'}；含 ${s.nEntity} 个资源单体` +
        `${s.seasonalMismatch ? '，注意季节性开放时间' : ''}。`;
    push(`- **${arr}–${dep}** ${tag}｜${s.name}（${s.type}·${s.town}）｜${s.modeLabel}｜停留 ${s.dwellMin} 分钟｜高程 ${s.elevationM} m`);
    push(`  - 选取理由：${why}`);
    const leg = route.legs[i - 1];
    if (leg) {
      push(`  - 上一段：${(leg.distanceM / 1000).toFixed(2)} km，爬升 ${leg.ascentM} m，最大坡度 ${leg.maxSlopeDeg}°，` +
           `步行约 ${leg.walkMinutes} 分钟${leg.unreachable ? '（⚠️ 该段未找到可行路径，已退化为直线，请人工确认）' : ''}`);
    }
  }

  push('');
  push(`## 地形剖面（沿轨迹采样）`);
  const prof = T.profile(route.coords, 24);
  const es = prof.map((p) => p.e).filter((x) => x != null);
  if (es.length) {
    push(`- 起止高程 ${es[0]} m → ${es[es.length - 1]} m，最低 ${Math.min(...es)} m，最高 ${Math.max(...es)} m`);
    push(`- 高程序列（米，每段约 ${Math.round(M.totalDistanceM / (es.length - 1))} m）：${es.map((x) => Math.round(x)).join(' → ')}`);
  }

  push('');
  push(`## 风险预判（加权模型）`);
  push(`- 综合 ${risk.score}/100 → **${risk.level}**：${risk.advice}`);
  push(`- 因子贡献（降序）：`);
  for (const f of risk.factors) push(`  - ${f.label}：因子值 ${f.value}，权重 ${f.weight}，贡献 ${f.contribution}`);
  push(`- 关键证据：最大坡度 ${risk.evidence.maxSlopeDeg}°、陡坡占比 ${(risk.evidence.steepRatio * 100).toFixed(1)}%、` +
       `距水域最近 ${risk.evidence.minWaterDistanceM} m、离既有步道最远 ${risk.evidence.maxDistanceToTrailM} m、` +
       `预计 ${risk.evidence.finishTime} 结束（日落 ${risk.evidence.sunsetTime}，余量 ${risk.evidence.daylightMarginMin} 分钟）`);
  push(`- 缓解建议：`);
  for (const m of risk.mitigations) push(`  - ${m}`);

  if (verification) {
    push('');
    push(`## 结果自校验（${verification.summary}）`);
    for (const c of verification.checks) {
      const icon = c.status === 'pass' ? '✅' : c.status === 'warn' ? '⚠️' : '❌';
      push(`- ${icon} ${c.name}：${c.detail}`);
    }
  }

  push('');
  push(`## 求解质量对照（可复现性证据）`);
  const S = route.solver;
  push(`- 候选点 ${S.candidates} 个，模拟退火重启 ${S.restarts} 次 × ${S.saIterations} 轮迭代，随机种子 ${S.seed}`);
  push(`- 纯贪心基线：${S.baselineGreedy.nodes} 站 / 收益 ${S.baselineGreedy.profit} / 用时 ${S.baselineGreedy.timeMin} 分钟`);
  push(`- 随机可行基线（${S.baselineRandom.trials} 次平均）：收益 ${S.baselineRandom.meanProfit}`);
  push(`- 最终方案：${S.best.nodes} 站 / 收益 ${S.best.profit} / 用时 ${S.best.timeMin} 分钟`);
  push(`- 相对贪心提升 **${S.gainVsGreedyPct}%**，相对随机基线提升 **${S.gainVsRandomPct}%**`);
  if (S.repairLog.length) {
    push(`- 预算回代修复记录（共 ${S.repairLog.length} 步）：`);
    for (const r of S.repairLog) {
      push(`  - 第 ${r.step} 步：${r.action === 'downgrade' ? '降级为打卡' : '移除'}「${r.name}」，用时 ${r.timeBefore} → ${r.timeAfter} 分钟`);
    }
  }

  return {
    title: `诗画溧水·水韵慢城 · ${route.itinerary.length - 1} 站${P.fitnessLabel}方案`,
    markdown: lines.join('\n'),
    headline: `${route.itinerary.length - 1} 站 / ${(M.totalDistanceM / 1000).toFixed(1)} km / ${M.totalMin} 分钟 / 风险 ${risk.score}`,
    stops: route.itinerary.map((s) => s.name),
  };
}

/** 异常处置：某停靠点不可用时，给出同维度替代点 */
export function suggestAlternatives({ poiId, k = 3, dataDir }) {
  const ds = loadDataset({ dataDir });
  const base = ds.get(poiId);
  if (!base) return { ok: false, error: `未找到停靠点 ${poiId}` };
  const dims = Object.keys(base.dims || {});
  const scored = [];
  for (const p of ds.pois) {
    if (p.id === poiId) continue;
    if (p.type === '离散点' && base.type !== '离散点') continue;
    const d = haversine(base, p);
    let sim = 0;
    for (const k2 of dims) sim += (p.dims[k2] || 0) * base.dims[k2];
    const simNorm = dims.length ? sim / dims.length : 0;
    if (simNorm <= 0.05) continue;
    scored.push({ poi: p, sim: round(simNorm, 3), distM: Math.round(d),
                  score: simNorm * 100 - d / 100 });
  }
  scored.sort((a, b) => b.score - a.score);
  return {
    ok: true, base: { id: base.id, name: base.name, dims: dims.map((d) => DIM_LABEL[d]) },
    alternatives: scored.slice(0, k).map((x) => ({
      id: x.poi.id, name: x.poi.name, type: x.poi.type, town: x.poi.town,
      lon: x.poi.lon, lat: x.poi.lat, similarity: x.sim, distM: x.distM,
      dims: Object.keys(x.poi.dims).map((d) => DIM_LABEL[d]),
    })),
  };
}

export function exportArtifacts({ profile, dataDir }) {
  const res = planTrip({ profile, dataDir, doVerify: true });
  if (!res.ok) return res;
  return {
    ...res,
    gpx: toGpx({ P: res.profile, route: res.route, risk: res.risk, meta: res.provenance }),
    csv: toItineraryCsv({ P: res.profile, route: res.route, risk: res.risk }),
  };
}

export { DIM_LABEL };
