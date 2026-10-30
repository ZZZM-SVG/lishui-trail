// planner.mjs —— 城郊文旅线路个性化规划
// 宏观：带时间预算的定向越野问题（Orienteering Problem）。节点可选"深度游览"或"打卡"两种强度。
//       求解：贪心插入 + 2-opt/Or-opt 局部搜索 + 模拟退火 + 多次重启（确定性种子，可复现）
// 微观：每段用 DEM + OSM 路网 + 水域约束的 A* 最小代价路径生成真实几何
// 反馈：用真实几何时间回代校验预算；超预算时按"单位收益耗时"剔除节点并重优化（repair 循环）
import { haversine, clamp, round } from './geo.mjs';
import { walkMinutes } from './terrain.mjs';
import { DIM_LABEL } from './dataset.mjs';

/** 游览强度：深度=1.0，打卡=0.45（快速通过、只做核心看点） */
export const VISIT_MODES = { full: 1.0, quick: 0.45 };
export const MODE_LABEL = { full: '深度游览', quick: '快速打卡' };

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const approxDist = (a, b) => {
  const kx = 111320 * Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180), ky = 110574;
  return Math.hypot((b.lon - a.lon) * kx, (b.lat - a.lat) * ky);
};

// ------------------------------------------------------------------ 节点收益
export function computeProfit(poi, P, month) {
  let pref = 0;
  for (const [d, w] of Object.entries(P.interests)) pref += w * (poi.dims[d] || 0);
  pref = clamp(pref, 0, 1);
  const level = clamp((poi.levelBonus || 0) / 0.6, 0, 1);
  const richness = clamp(Math.log1p(poi.nEntity + 0.5 * poi.nVirtual) / Math.log1p(50), 0, 1);
  const rarity = poi.type === '离散点' ? 0.35 : 0.75;
  let season = 1, seasonalMismatch = false;
  if (poi.months && poi.months.length && !poi.months.includes(month)) {
    season = 0.35; seasonalMismatch = true;
  }
  const profit = 100 * (0.62 * pref + 0.18 * level + 0.10 * richness + 0.10 * rarity) * season;
  const matched = Object.keys(P.interests)
    .filter((d) => (poi.dims[d] || 0) > 0)
    .sort((a, b) => P.interests[b] - P.interests[a])
    .map((d) => DIM_LABEL[d]);
  return { profit: round(profit, 2), pref: round(pref, 3), seasonalMismatch, matched: matched.slice(0, 3) };
}

// ------------------------------------------------------------------ 段间时间估计
function legEstimate(T, a, b, samples = 20) {
  let dist = 0, time = 0;
  let plon = a.lon, plat = a.lat, pe = T.elevationAt(a.lon, a.lat);
  for (let k = 1; k <= samples; k++) {
    const t = k / samples;
    const lon = a.lon + (b.lon - a.lon) * t;
    const lat = a.lat + (b.lat - a.lat) * t;
    const e = T.elevationAt(lon, lat);
    const seg = approxDist({ lon: plon, lat: plat }, { lon, lat });
    if (seg > 0) {
      if (Number.isFinite(e) && Number.isFinite(pe)) time += walkMinutes(seg, e - pe);
      dist += seg;
    }
    plon = lon; plat = lat; pe = e;
  }
  let detour = 1.3;
  const pd = T.pathDistanceM;
  if (pd) {
    const ds = [0.3, 0.5, 0.7].map((f) => pd(a.lon + (b.lon - a.lon) * f, a.lat + (b.lat - a.lat) * f))
      .filter((x) => x != null);
    if (ds.length) {
      const mean = ds.reduce((s, x) => s + x, 0) / ds.length;
      detour = clamp(1.05 + Math.min(mean, 1200) / 1200 * 0.5, 1.05, 1.55);
    }
  }
  // 阻挡感知：直线若穿越面状水域或陡坡，实际需绕行，抬高绕行系数（否则求解器会低估段耗时）
  if (T.isWaterArea && T.slopeAt) {
    let waterHit = 0, steepHit = 0;
    const K = 12;
    for (let k = 1; k < K; k++) {
      const f = k / K;
      const lon = a.lon + (b.lon - a.lon) * f, lat = a.lat + (b.lat - a.lat) * f;
      if (T.isWaterArea(lon, lat)) waterHit++;
      const s = T.slopeAt(lon, lat);
      if (Number.isFinite(s) && s > 20) steepHit++;
    }
    detour += 0.9 * (waterHit / (K - 1)) + 0.6 * (steepHit / (K - 1));
    detour = clamp(detour, 1.05, 2.4);
  }
  return { timeMin: time * detour, distM: dist * detour };
}

// ------------------------------------------------------------------ 主求解
export function solveRoute({ ds, T, P, opts = {} }) {
  const month = Number(P.date.slice(5, 7));
  const budget = P.durationMin;
  const warnings = [...P.warnings];

  const must = P.mustVisit.filter((id) => ds.get(id));
  const unknownMust = P.mustVisit.filter((id) => !ds.get(id));
  if (unknownMust.length) warnings.push(`必去点不存在，已忽略：${unknownMust.join('、')}`);

  // -------- 1) 起点（默认：无想山景区；作为集合点，默认不计游览停留）--------
  let startNode;
  if (P.start && Number.isFinite(P.start.lon) && Number.isFinite(P.start.lat)) {
    const n = ds.nearest(P.start.lon, P.start.lat);
    // 落在某个资源点近旁才借用它的名称与街镇；否则这是一个纯坐标起点。
    // town 必须始终有值：AGH 的 ToolResult 信封不接受 undefined，缺字段会导致整次工具调用被拒。
    const nearLabel = Boolean(n && n.poi && n.distM < 600);
    startNode = {
      id: '__start__',
      name: nearLabel ? `起点：${n.poi.name}` : '自定义起点',
      town: nearLabel && n.poi.town ? n.poi.town : '自定义起点',
      lon: P.start.lon, lat: P.start.lat, type: '起点', dwell: 0, isDepot: true,
      entities: [], virtuals: [], nEntity: 0, nVirtual: 0, levelBonus: 0, dims: {}, months: [],
    };
  } else if (P.start && P.start.poiId && ds.get(P.start.poiId)) {
    startNode = { ...ds.get(P.start.poiId) };
  } else {
    startNode = { ...(ds.get('LS-28') || ds.pois[0]) };
  }
  const startIsMust = must.includes(startNode.id);
  const depotDwell = startIsMust ? (startNode.dwell || 0) : 0;
  if (startIsMust) warnings.push(`起点「${startNode.name}」同时出现在必去点中：已按"先游览起点再出发"处理，起点停留 ${depotDwell} 分钟。`);
  startNode = { ...startNode, dwell: depotDwell, isDepot: true };

  // -------- 1b) 起点范围校验：自定义起点若远离数据集覆盖范围，给出可解释的失败原因 --------
  // 否则只能落到"预算过小"这类笼统提示，用户无法判断是自己坐标填错了还是预算不够。
  let outOfRangeReason = null;
  if (startNode.id === '__start__') {
    const b = ds.meta.bbox;
    const outside = startNode.lon < b.minLon || startNode.lon > b.maxLon ||
                    startNode.lat < b.minLat || startNode.lat > b.maxLat;
    const near = ds.nearest(startNode.lon, startNode.lat);
    const nearName = near && near.poi ? near.poi.name : '（无）';
    const nearKm = near ? (near.distM / 1000).toFixed(1) : '—';
    if (outside && (!near || near.distM > 15000)) {
      outOfRangeReason = `自定义起点（${startNode.lon.toFixed(4)}, ${startNode.lat.toFixed(4)}）落在数据集覆盖范围外`
        + `（经度 ${b.minLon}—${b.maxLon}，纬度 ${b.minLat}—${b.maxLat}），距最近资源点「${nearName}」直线约 ${nearKm} km，`
        + '任何候选资源点都无法在合理预算内往返，因此不生成方案。';
      warnings.push(`自定义起点超出数据集覆盖范围（距最近资源点约 ${nearKm} km）。`);
    } else if (outside) {
      warnings.push(`自定义起点位于数据集边界外（距最近资源点「${nearName}」约 ${nearKm} km），已就近参与计算，请确认坐标是否正确。`);
    }
  }

  // -------- 2) 候选集与收益 --------
  const avoid = new Set(P.avoid);
  const cand = [];
  for (const p of ds.pois) {
    if (avoid.has(p.id)) continue;
    if (p.id === startNode.id) continue;
    const pr = computeProfit(p, P, month);
    if (pr.profit <= 0.5) continue;
    cand.push({ poi: p, ...pr });
  }
  const reach = [];
  for (const c of cand) {
    const a = legEstimate(T, startNode, c.poi), b = legEstimate(T, c.poi, startNode);
    const rt = a.timeMin + b.timeMin + c.poi.dwell * VISIT_MODES.quick;
    if (rt <= budget * 1.6) { c.access = rt; reach.push(c); }
  }
  reach.sort((a, b) => b.profit - a.profit);
  const cap = opts.maxCandidates ?? 110;
  const picked = reach.slice(0, cap);
  for (const id of must) if (!picked.some((c) => c.poi.id === id)) {
    const c = reach.find((x) => x.poi.id === id);
    if (c) picked.push(c);
    else if (id !== startNode.id) warnings.push(`必去点「${ds.get(id).name}」超出可达范围，未能纳入。`);
  }

  // -------- 3) 时间/距离矩阵 --------
  const nodes = [startNode, ...picked.map((c) => c.poi)];
  const n = nodes.length;
  const M = { t: Array.from({ length: n }, () => new Float64Array(n)), d: Array.from({ length: n }, () => new Float64Array(n)) };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const e = legEstimate(T, nodes[i], nodes[j]);
      M.t[i][j] = M.t[j][i] = e.timeMin;
      M.d[i][j] = M.d[j][i] = e.distM;
    }
  }
  const profit = nodes.map((x, i) => (i === 0 ? 0 : picked[i - 1].profit));
  const baseDwell = nodes.map((x) => x.dwell || 0);
  const mustIdx = must.map((id) => nodes.findIndex((x) => x.id === id)).filter((i) => i > 0);

  // 游览深度约束（软）：deep=每站都要深度游览；balanced=至少一半站深度；wide=允许大量快速打卡
  const DEPTH_TARGET = { deep: 1.0, balanced: 0.5, wide: 0.25 }[P.visitDepth] ?? 0.5;
  const DEPTH_PENALTY = 30; // 每缺少一个"深度游览"停靠点的软惩罚（相对收益量级）

  // 游览强度（可变）：默认全部"深度"；打卡时收益按比例折算
  const modeOf = (modes, i) => modes[i] ?? 'full';
  const dwellAt = (modes, i) => baseDwell[i] * VISIT_MODES[modeOf(modes, i)];

  const evalOrder = (order, modes) => {
    let t = 0, d = 0, pr = 0, stops = 0, fulls = 0;
    for (let i = 1; i < order.length; i++) {
      const md = modeOf(modes, order[i]);
      t += M.t[order[i - 1]][order[i]] + dwellAt(modes, order[i]);
      d += M.d[order[i - 1]][order[i]];
      pr += profit[order[i]] * (md === 'full' ? 1 : 0.78);
      stops++; if (md === 'full') fulls++;
    }
    if (P.loop) { t += M.t[order[order.length - 1]][0]; d += M.d[order[order.length - 1]][0]; }
    const needFull = Math.ceil(DEPTH_TARGET * stops);
    const depthDeficit = Math.max(0, needFull - fulls);
    return { timeMin: t, distM: d, profit: pr, over: Math.max(0, t - budget), stops, fulls, depthDeficit };
  };
  // 目标函数：收益 − 超预算罚 − 深度不足罚 − 轻微时间成本。
  // 时间成本让"同样收益下更紧凑、可容纳更多停靠点"成为更优解（否则可行解之间没有紧凑性偏好）。
  const TIME_COST = 0.04;
  const objective = (r) => r.profit - 12 * r.over - DEPTH_PENALTY * r.depthDeficit - TIME_COST * r.timeMin;
  const hasMust = (order) => mustIdx.every((mi) => order.includes(mi));
  // 统计已选序列中"深度游览"站数（不含起点）
  const countFull = (order, modes) => {
    let c = 0;
    for (let i = 1; i < order.length; i++) if (modeOf(modes, order[i]) === 'full') c++;
    return c;
  };

  // -------- 4) 贪心插入（同时尝试两种游览强度）--------
  function greedyInsert(rng) {
    const order = [0];
    const modes = {};
    const pool = new Set(picked.map((_, k) => k + 1));
    for (const mi of [...mustIdx].sort((a, b) => profit[b] - profit[a])) {
      let best = null;
      const prevR = evalOrder(order, modes);
      for (let pos = 1; pos <= order.length; pos++) {
        for (const md of ['full', 'quick']) {
          const m2 = { ...modes, [mi]: md };
          const c2 = [...order.slice(0, pos), mi, ...order.slice(pos)];
          const r = evalOrder(c2, m2);
          if (r.over > 0) continue;
          const dObj = objective(r) - objective(prevR);
          if (!best || dObj > best.dObj) best = { order: c2, modes: m2, dObj };
        }
      }
      if (best) { order.splice(0, order.length, ...best.order); Object.assign(modes, best.modes); pool.delete(mi); }
    }
    for (;;) {
      let best = null;
      const prevR = evalOrder(order, modes);
      const prevObj = objective(prevR);
      for (const k of pool) {
        for (let pos = 1; pos <= order.length; pos++) {
          for (const md of ['full', 'quick']) {
            const m2 = { ...modes, [k]: md };
            const c2 = [...order.slice(0, pos), k, ...order.slice(pos)];
            const r = evalOrder(c2, m2);
            if (r.over > 0) continue;
            const dT = r.timeMin - prevR.timeMin;
            const dObj = objective(r) - prevObj;
            if (dObj <= 1e-6) continue; // 只有净收益为正才值得插入（已含深度软惩罚）
            const ratio = dObj / Math.max(dT, 1e-6) * (1 + 0.15 * (rng() - 0.5));
            if (!best || ratio > best.ratio) best = { order: c2, modes: m2, ratio };
          }
        }
      }
      if (!best) break;
      order.splice(0, order.length, ...best.order);
      Object.assign(modes, best.modes);
      for (const k of [...pool]) if (order.includes(k)) pool.delete(k);
    }
    return { order, modes };
  }

  function localSearch(init, rng, rounds = 320) {
    let cur = init.order.slice(), curM = { ...init.modes };
    let curR = evalOrder(cur, curM);
    for (let it = 0; it < rounds; it++) {
      const c2 = cur.slice(), m2 = { ...curM };
      const op = rng(), L = c2.length;
      if (op < 0.30 && L >= 4) {
        const i = 1 + Math.floor(rng() * (L - 2));
        const j = i + 1 + Math.floor(rng() * (L - i));
        const seg = c2.slice(i, j + 1).reverse();
        c2.splice(i, seg.length, ...seg);
      } else if (op < 0.55 && L >= 3) {
        const i = 1 + Math.floor(rng() * (L - 1));
        const node = c2.splice(i, 1)[0];
        const pos = 1 + Math.floor(rng() * c2.length);
        c2.splice(Math.min(pos, c2.length), 0, node);
      } else if (op < 0.78 && L >= 4) {
        const i = 1 + Math.floor(rng() * (L - 1));
        const j = 1 + Math.floor(rng() * (L - 1));
        [c2[i], c2[j]] = [c2[j], c2[i]];
      } else if (L >= 2) {
        const i = c2[1 + Math.floor(rng() * (L - 1))];
        m2[i] = (m2[i] ?? 'full') === 'full' ? 'quick' : 'full';
      }
      if (!hasMust(c2)) continue;
      const r = evalOrder(c2, m2);
      if (objective(r) > objective(curR)) { cur = c2; curM = m2; curR = r; }
    }
    return { order: cur, modes: curM, r: curR };
  }

  function anneal(init, rng, iters = 3000) {
    let cur = init.order.slice(), curM = { ...init.modes };
    let curR = evalOrder(cur, curM);
    let best = cur.slice(), bestM = { ...curM }, bestR = curR;
    const pool = picked.map((_, k) => k + 1).filter((k) => !cur.includes(k));
    for (let it = 0; it < iters; it++) {
      const temp = 40 * (1 - it / iters) + 0.4;
      const c2 = cur.slice(), m2 = { ...curM };
      const op = rng(), L = c2.length;
      if (op < 0.20 && pool.length) {
        const k = pool[Math.floor(rng() * pool.length)];
        c2.splice(1 + Math.floor(rng() * (c2.length - 1)), 0, k);
        m2[k] = rng() < 0.5 ? 'full' : 'quick';
      } else if (op < 0.38 && L >= 3) {
        const removable = [];
        for (let i = 1; i < L; i++) if (!mustIdx.includes(c2[i])) removable.push(i);
        if (!removable.length) continue;
        c2.splice(removable[Math.floor(rng() * removable.length)], 1);
      } else if (op < 0.66 && L >= 4) {
        const i = 1 + Math.floor(rng() * (L - 2));
        const j = i + 1 + Math.floor(rng() * (L - i));
        const seg = c2.slice(i, j + 1).reverse();
        c2.splice(i, seg.length, ...seg);
      } else if (op < 0.88 && L >= 3) {
        const i = 1 + Math.floor(rng() * (L - 1));
        const node = c2.splice(i, 1)[0];
        const pos = 1 + Math.floor(rng() * c2.length);
        c2.splice(Math.min(pos, c2.length), 0, node);
      } else if (L >= 2) {
        const i = c2[1 + Math.floor(rng() * (L - 1))];
        m2[i] = (m2[i] ?? 'full') === 'full' ? 'quick' : 'full';
      }
      if (!hasMust(c2)) continue;
      const r = evalOrder(c2, m2);
      const dObj = objective(r) - objective(curR);
      if (dObj >= 0 || rng() < Math.exp(dObj / temp)) {
        cur = c2; curM = m2; curR = r;
        const inside = new Set(cur);
        for (const k of pool.slice()) if (inside.has(k)) pool.splice(pool.indexOf(k), 1);
        if (objective(curR) > objective(bestR)) { best = cur.slice(); bestM = { ...curM }; bestR = curR; }
      }
    }
    return { order: best, modes: bestM, r: bestR };
  }

  // -------- 5) 多次重启 + 基线对照 --------
  const greedy0 = greedyInsert(mulberry32(P.seed));
  const greedyR0 = evalOrder(greedy0.order, greedy0.modes);

  // 随机可行基线：随机贪心（随机顺序插入）若干次的平均
  const randTrials = [];
  for (let k = 0; k < 30; k++) {
    const rk = mulberry32(P.seed + 31337 * (k + 1));
    const order = [0], modes = {};
    const shuffle = picked.map((_, i) => i + 1);
    for (let i = shuffle.length - 1; i > 0; i--) { const j = Math.floor(rk() * (i + 1)); [shuffle[i], shuffle[j]] = [shuffle[j], shuffle[i]]; }
    for (const k2 of shuffle) {
      for (let pos = 1; pos <= order.length; pos++) {
        const md = rk() < 0.6 ? 'full' : 'quick';
        const m2 = { ...modes, [k2]: md };
        const c2 = [...order.slice(0, pos), k2, ...order.slice(pos)];
        const r = evalOrder(c2, m2);
        if (r.over <= 0) { order.splice(0, order.length, ...c2); Object.assign(modes, m2); break; }
      }
    }
    const r = evalOrder(order, modes);
    if (order.length > 1) randTrials.push(r.profit);
  }
  const randMean = randTrials.length ? randTrials.reduce((a, b) => a + b, 0) / randTrials.length : 0;

  let best = null;
  const restartLog = [];
  const restarts = opts.restarts ?? 8;
  for (let k = 0; k < restarts; k++) {
    const r2 = mulberry32(P.seed + 7919 * (k + 1));
    const g = greedyInsert(r2);
    const ls = localSearch(g, r2, 320);
    const sa = anneal(ls, r2, opts.saIterations ?? 3000);
    const candBest = objective(sa.r) > objective(ls.r) ? sa : ls;
    restartLog.push({ restart: k + 1, nodes: candBest.order.length - 1,
                      profit: round(candBest.r.profit, 1), timeMin: Math.round(candBest.r.timeMin) });
    if (!best || objective(candBest.r) > objective(best.r)) best = candBest;
  }
  if (!best) best = greedy0;

  // -------- 6) 真实几何 + 预算回代修复 --------
  const legCache = new Map();   // 段几何缓存：key = "fromId>toId"，回填阶段大量重复求段时可复用
  function legOf(a, b) {
    const key = `${a.id}>${b.id}`;
    const hit = legCache.get(key);
    if (hit) return hit;
    const lc = T.leastCostPath(a, b, { maxSlopeDeg: P.constraints.maxSlopeDeg + 5 });
    const st = lc.stats || T.stats([a, b]);
    const rec = {
      fromId: a.id, toId: b.id, fromName: a.name, toName: b.name,
      distanceM: st.distanceM, ascentM: st.ascentM, descentM: st.descentM,
      maxSlopeDeg: st.maxSlopeDeg, steepRatio: st.steepRatio,
      walkMinutes: round(st.walkMinutes / P.constraints.speedFactor, 1),
      unreachable: !!lc.unreachable, reason: lc.reason || null,
      crossedWater: !!lc.crossedWater,
      coords: lc.coords, degraded: lc.degraded || null,
    };
    legCache.set(key, rec);
    return rec;
  }
  const seqOf = (order) => (P.loop ? [...order, 0] : order);
  const realWalkMin = (order) => {
    const seq = seqOf(order);
    let t = 0;
    for (let i = 1; i < seq.length; i++) t += legOf(nodes[seq[i - 1]], nodes[seq[i]]).walkMinutes;
    return t;
  };
  const realProfitOf = (order, modes) => {
    let pr = 0;
    for (let i = 1; i < order.length; i++) pr += profit[order[i]] * (modeOf(modes, order[i]) === 'full' ? 1 : 0.78);
    return pr;
  };
  const realDwellMin = (order, modes) => {
    let d = 0;
    for (let i = 1; i < order.length; i++) d += dwellAt(modes, order[i]);
    return d;
  };
  const fullCountOf = (order, modes) => {
    let c = 0;
    for (let i = 1; i < order.length; i++) if (modeOf(modes, order[i]) === 'full') c++;
    return c;
  };
  const depthOk = (order, modes) => fullCountOf(order, modes) >= Math.ceil(DEPTH_TARGET * (order.length - 1)) || order.length <= 1;

  function buildReal(routeObj) {
    const order = routeObj.order, modes = routeObj.modes;
    const legs = [];
    let mergedCoords = [];
    const seq = seqOf(order);
    for (let i = 1; i < seq.length; i++) {
      const a = nodes[seq[i - 1]], b = nodes[seq[i]];
      const lc = legOf(a, b);
      legs.push(lc);
      if (mergedCoords.length && lc.coords.length) mergedCoords.push(...lc.coords.slice(1));
      else mergedCoords.push(...lc.coords);
    }
    const stops = [];
    let clock = 0, prof = 0;
    for (let i = 0; i < order.length; i++) {
      const idx = order[i], nd = nodes[idx];
      if (i > 0) clock += legs[i - 1].walkMinutes;
      const md = i === 0 ? 'full' : modeOf(modes, idx);
      const dw = Math.round(dwellAt(modes, idx));
      const rec = idx === 0 ? null : picked[idx - 1];
      if (idx !== 0) prof += profit[idx] * (md === 'full' ? 1 : 0.78);
      const statuses = new Set((nd.entities || []).map((e) => e.status));
      stops.push({
        poiId: nd.id, name: nd.name, type: nd.type, town: nd.town,
        lon: round(nd.lon, 6), lat: round(nd.lat, 6),
        arriveMin: Math.round(clock), departMin: Math.round(clock + dw), dwellMin: dw,
        mode: i === 0 ? 'depot' : md, modeLabel: i === 0 ? '集合点' : MODE_LABEL[md],
        profit: rec ? round(profit[idx] * (md === 'full' ? 1 : 0.78), 2) : 0,
        matched: rec ? rec.matched : [], seasonalMismatch: rec ? rec.seasonalMismatch : false,
        status: [...statuses].filter((s) => s && s !== 'nan').slice(0, 2).join('/') || '正常',
        nEntity: nd.nEntity, levelBonus: nd.levelBonus,
        elevationM: Math.round(T.elevationAt(nd.lon, nd.lat)),
      });
      clock += dw;
    }
    let totalAscent = 0, totalDescent = 0, maxSlope = 0, steepDist = 0;
    for (const l of legs) {
      totalAscent += l.ascentM; totalDescent += l.descentM;
      maxSlope = Math.max(maxSlope, l.maxSlopeDeg);
      steepDist += l.distanceM * (l.steepRatio || 0);
    }
    const walkMin = round(legs.reduce((s, l) => s + l.walkMinutes, 0), 1);
    const dwellMin = Math.round(stops.reduce((s, x) => s + x.dwellMin, 0));
    return {
      legs, stops, coords: mergedCoords, profit: prof,
      totalWalkMin: walkMin, totalDwellMin: dwellMin, totalMin: Math.round(walkMin + dwellMin),
      totalDistanceM: Math.round(legs.reduce((s, l) => s + l.distanceM, 0)),
      totalAscentM: Math.round(totalAscent), totalDescentM: Math.round(totalDescent),
      maxSlopeDeg: round(maxSlope, 1), steepDistanceM: Math.round(steepDist),
      unreachableLegs: legs.filter((l) => l.unreachable).length,
    };
  }

  // 预算回代修复：每轮在"降级"与"移除"之间选最划算的一步，保证每轮真实耗时单调下降 → 必然收敛。
  // （早期版本会反复对同一点降级而被局部搜索改回，导致空转 15 轮仍超预算。）
  const repairLog = [];
  let cur = { order: best.order.slice(), modes: { ...best.modes } };
  let real = buildReal(cur);
  const diag = { budget, initialRealTotalMin: real.totalMin, initialStops: cur.order.length - 1 };
  let guard = 0;
  while (real.totalMin > budget && guard < 30) {
    guard++;
    const before = real.totalMin;
    const stops = cur.order.length - 1;
    if (stops <= 0) break;
    const fulls = countFull(cur.order, cur.modes);
    const needFull = Math.max(1, Math.ceil(DEPTH_TARGET * stops));

    let action = null;
    for (let i = 1; i < cur.order.length; i++) {
      const idx = cur.order[i];
      if (mustIdx.includes(idx)) continue;
      const md = modeOf(cur.modes, idx);
      // (a) 降级为打卡：省下的停留时间，损失 22% 收益；需仍满足深度目标
      if (md === 'full' && (fulls - 1) >= needFull) {
        const save = baseDwell[idx] * (1 - VISIT_MODES.quick);
        if (save > 0.5) {
          const score = (profit[idx] * 0.22) / save;
          if (!action || score < action.score) action = { i, idx, kind: 'downgrade', score, save };
        }
      }
      // (b) 移除：省下进出两段真实步行 + 本点停留；中间新直连段用真实几何补回（已缓存）
      const inW = real.legs[i - 1] ? real.legs[i - 1].walkMinutes : 0;
      const outW = real.legs[i] ? real.legs[i].walkMinutes : 0;
      const nextIdx = (i + 1 < cur.order.length) ? cur.order[i + 1] : (P.loop && cur.order.length > 2 ? 0 : null);
      const bridge = nextIdx === null ? 0 : legOf(nodes[cur.order[i - 1]], nodes[nextIdx]).walkMinutes;
      const save = Math.max(0, inW + outW - bridge) + dwellAt(cur.modes, idx);
      if (save > 0.5) {
        const score = (profit[idx] * (md === 'full' ? 1 : 0.78)) / save;
        if (!action || score < action.score) action = { i, idx, kind: 'remove', score, save };
      }
    }
    if (!action) break;
    if (action.kind === 'downgrade') {
      cur.modes = { ...cur.modes, [action.idx]: 'quick' };
      repairLog.push({ step: guard, action: 'downgrade', poiId: nodes[action.idx].id, name: nodes[action.idx].name, timeBefore: before });
    } else {
      cur.order = [...cur.order.slice(0, action.i), ...cur.order.slice(action.i + 1)];
      repairLog.push({ step: guard, action: 'remove', poiId: nodes[action.idx].id, name: nodes[action.idx].name, timeBefore: before });
    }
    real = buildReal(cur);
    repairLog[repairLog.length - 1].timeAfter = real.totalMin;
    repairLog[repairLog.length - 1].kind = action.kind;
  }

  // -------- 6b) 真实几何回填（refill）：用真实 A* 段耗时把"估计偏差导致被误剔"的高价值点补回 --------
  // 只做插入（不移动/不删除），每轮完成后耗时严格增加，因此必然收敛。
  const refillLog = [];
  let refillRounds = 0;
  const REFILL_CAND = opts.refillCandidates ?? 24;
  while (refillRounds < (opts.refillRounds ?? 8)) {
    refillRounds++;
    const baseProfit = realProfitOf(cur.order, cur.modes);
    const pool = [];
    for (let k = 1; k < nodes.length; k++) if (!cur.order.includes(k)) pool.push(k);
    if (!pool.length) break;
    pool.sort((x, y) => profit[y] - profit[x]);
    const trial = pool.slice(0, REFILL_CAND);
    let bestIns = null;
    for (const k of trial) {
      for (let pos = 1; pos <= cur.order.length; pos++) {
        for (const md of ['full', 'quick']) {
          const o2 = [...cur.order.slice(0, pos), k, ...cur.order.slice(pos)];
          const m2 = { ...cur.modes, [k]: md };
          const walk = realWalkMin(o2);
          const dwell = realDwellMin(o2, m2);
          if (Math.round(walk + dwell) > budget) continue;
          if (!depthOk(o2, m2)) continue;
          const gain = realProfitOf(o2, m2) - baseProfit;
          if (gain > 0.5 && (!bestIns || gain > bestIns.gain)) {
            bestIns = { order: o2, modes: m2, gain, added: nodes[k].name,
                        timeMin: Math.round(walk + dwell) };
          }
        }
      }
    }
    if (!bestIns) break;
    cur = { order: bestIns.order, modes: bestIns.modes };
    refillLog.push({ round: refillRounds, added: bestIns.added, gain: round(bestIns.gain, 1), timeMin: bestIns.timeMin });
  }

  // 回填后尝试把"打卡"升格为"深度游览"（预算允许时，提升游览质量）
  if (VISIT_MODES.quick < 1) {
    for (let i = 1; i < cur.order.length; i++) {
      const idx = cur.order[i];
      if (modeOf(cur.modes, idx) !== 'quick') continue;
      const m2 = { ...cur.modes, [idx]: 'full' };
      const t2 = realWalkMin(cur.order) + realDwellMin(cur.order, m2);
      if (Math.round(t2) <= budget) {
        cur.modes = m2;
        repairLog.push({ step: repairLog.length + 1, action: 'upgrade', poiId: nodes[idx].id, name: nodes[idx].name, timeBefore: real.totalMin, timeAfter: Math.round(t2) });
      }
    }
  }
  real = buildReal(cur);

  // 修复后若只剩起点，说明该预算下无法形成行程 —— 原因按"最能解释得通的那一条"给出
  if (cur.order.length <= 1) {
    const missed = must
      .filter((id) => id !== startNode.id)
      .map((id) => ds.get(id).name);
    const fallback = missed.length
      ? `在给定时间预算与体能约束下，必去点「${missed.join('、')}」无法与起点构成一次可完成的行程`
        + `（预算 ${budget} 分钟过小，或该点需长距离绕行），因此不生成方案。`
      : '在给定时间预算与体能约束下，从该起点出发没有任何候选资源点能形成一次有意义的行程（预算过小，或候选点受水域/坡度限制需长距离绕行）。';
    for (const nm of missed) {
      const w = `必去点「${nm}」超出可达范围，未能纳入。`;
      if (!warnings.includes(w)) warnings.push(w);
    }
    return {
      feasible: false,
      reason: outOfRangeReason || fallback,
      start: { id: startNode.id, name: startNode.name, lon: round(startNode.lon, 6), lat: round(startNode.lat, 6) },
      loop: P.loop, itinerary: [], legs: [], coords: [], metrics: null, solver: null, warnings,
    };
  }

  return {
    feasible: cur.order.length > 1,
    reason: cur.order.length > 1 ? null : '在给定时间预算与体能约束下，没有任何候选资源点能形成一次有意义的行程（预算过小或起点过于偏远）。',
    start: { id: startNode.id, name: startNode.name, lon: round(startNode.lon, 6), lat: round(startNode.lat, 6) },
    loop: P.loop,
    itinerary: real.stops, legs: real.legs, coords: real.coords,
    metrics: {
      stopCount: Math.max(0, real.stops.length - 1),
      totalDistanceM: real.totalDistanceM, totalAscentM: real.totalAscentM, totalDescentM: real.totalDescentM,
      totalWalkMin: real.totalWalkMin, totalDwellMin: real.totalDwellMin, totalMin: real.totalMin,
      budgetMin: budget, budgetUsedPct: Math.round(real.totalMin / budget * 100),
      maxSlopeDeg: real.maxSlopeDeg, steepDistanceM: real.steepDistanceM,
      totalProfit: round(real.profit, 1),
      depthStops: real.stops.filter((s) => s.mode === 'full').length,
      quickStops: real.stops.filter((s) => s.mode === 'quick').length,
      depthPreference: P.visitDepth, depthPreferenceLabel: P.visitDepthLabel,
      depthTargetPct: Math.round(DEPTH_TARGET * 100),
      unreachableLegs: real.unreachableLegs,
    },
    solver: {
      candidates: picked.length, restarts, saIterations: opts.saIterations ?? 3000,
      baselineGreedy: { nodes: greedy0.order.length - 1, profit: round(greedyR0.profit, 1), timeMin: Math.round(greedyR0.timeMin) },
      baselineRandom: { trials: randTrials.length, meanProfit: round(randMean, 1) },
      best: { nodes: cur.order.length - 1, profit: round(real.profit, 1), timeMin: real.totalMin },
      gainVsGreedyPct: greedyR0.profit > 0 ? round((real.profit - greedyR0.profit) / greedyR0.profit * 100, 1) : 0,
      gainVsRandomPct: randMean > 0 ? round((real.profit - randMean) / randMean * 100, 1) : 0,
      repairLog, restartLog, seed: P.seed, refillLog,
      legEvaluations: legCache.size, diag,
      finalRealTotalMin: real.totalMin,
    },
    warnings,
  };
}
