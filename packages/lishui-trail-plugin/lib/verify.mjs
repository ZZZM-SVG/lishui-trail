// verify.mjs —— 结果自校验：独立重算关键指标并逐项断言行/警告
import crypto from 'node:crypto';
import { haversine, round, clamp } from './geo.mjs';

function hashCoords(coords) {
  const s = coords.map((c) => `${c.lon.toFixed(5)},${c.lat.toFixed(5)}`).join(';');
  return crypto.createHash('sha256').update(s).digest('hex');
}

/**
 * 一致性判据：相对容差 + 绝对下限，取较宽者。
 *
 * 早先这里写成 `reported > 0 ? |重算-报告|/报告 : 1`，即"报告值为 0 就直接判 100% 偏差"。
 * 于是任何**累升/里程恰为 0** 的平缓路线都会无条件报 fail —— 明明两边都是 0。
 * 现在报告值为 0（或极小）时改用绝对容差判定；这同时也是小量指标抗取整抖动的正确做法。
 */
function tolOf(reported, relTol, absTol) {
  return Math.max(relTol * Math.abs(reported || 0), absTol);
}

/** 生成检查说明：报告值 > 0 时保留原"相对偏差 xx%"表述，否则给出绝对差值 */
function devText(labelA, a, labelB, reported, diff, tol, absTol) {
  if (reported > 0) {
    return `${labelA} ${a} m vs ${labelB} ${reported} m，相对偏差 ${(diff / reported * 100).toFixed(2)}%`;
  }
  const unit = Math.abs(tol - absTol) < 1e-9 ? `绝对容差 ${absTol} m` : `容差 ${tol.toFixed(1)} m`;
  return `${labelA} ${a} m vs ${labelB} ${reported} m（差 ${diff.toFixed(1)} m，${unit}）`;
}

/**
 * @param {object} ctx {ds, T, P, route, risk, replanner?}
 * replanner: 可选 () => route，用于复现性校验（同种子重算）
 */
export function verifyRoute({ ds, T, P, route, risk, replanner = null }) {
  const checks = [];
  const add = (name, status, detail, extra = {}) => checks.push({ name, status, detail, ...extra });

  // 1) 坐标有效性
  const b = ds.meta.bbox;
  const MARGIN = 0.05;
  const outOfBox = route.coords.filter((c) =>
    c.lon < b.minLon - MARGIN || c.lon > b.maxLon + MARGIN ||
    c.lat < b.minLat - MARGIN || c.lat > b.maxLat + MARGIN);
  add('坐标有效性', outOfBox.length === 0 ? 'pass' : 'fail',
      `${route.coords.length} 个几何点，越界 ${outOfBox.length} 个（容差 ${MARGIN}°）`);

  // 2) 距离一致性（独立用 Haversine 重算）
  let dist = 0;
  for (let i = 1; i < route.coords.length; i++) dist += haversine(route.coords[i - 1], route.coords[i]);
  const distDiff = Math.abs(dist - route.metrics.totalDistanceM);
  const distTol = tolOf(route.metrics.totalDistanceM, 0.01, 1);
  add('距离一致性', distDiff <= distTol ? 'pass' : 'fail',
      `${devText('独立重算', Math.round(dist), '报告', route.metrics.totalDistanceM, distDiff, distTol, 1)}`,
      { recomputed: Math.round(dist) });

  // 3) 分段统计一致性（每段用坐标重算步行时间）
  let walk = 0, maxSlope = 0, ascent = 0, worst = 0;
  for (const l of route.legs) {
    const st = T.stats(l.coords);
    walk += st.walkMinutes / P.constraints.speedFactor;
    ascent += st.ascentM;
    maxSlope = Math.max(maxSlope, st.maxSlopeDeg);
    const rel = l.distanceM > 0 ? Math.abs(st.distanceM - l.distanceM) / l.distanceM : 0;
    worst = Math.max(worst, rel);
  }
  add('分段统计一致性', worst < 0.02 ? 'pass' : 'fail',
      `逐段重算最大距离相对偏差 ${(worst * 100).toFixed(2)}%`);

  // 4) 爬升一致性
  const ascentDiff = Math.abs(ascent - route.metrics.totalAscentM);
  const ascentTol = tolOf(route.metrics.totalAscentM, 0.02, 2);
  add('累计爬升一致性', ascentDiff <= ascentTol ? 'pass' : 'fail',
      `${devText('独立重算', Math.round(ascent), '报告', route.metrics.totalAscentM, ascentDiff, ascentTol, 2)}`);

  // 5) 时间预算一致性
  const dwell = route.itinerary.reduce((s, x) => s + x.dwellMin, 0);
  const total = walk + dwell;
  const usedPct = total / P.durationMin;
  add('时间预算一致性',
      usedPct <= 1.03 ? 'pass' : (usedPct <= 1.10 ? 'warn' : 'fail'),
      `独立重算 ${Math.round(total)} 分钟 / 预算 ${P.durationMin} 分钟（占用 ${(usedPct * 100).toFixed(1)}%）`);

  // 6) 坡度约束
  const slopeLimit = P.constraints.maxSlopeDeg + 5;
  add('坡度约束', maxSlope <= slopeLimit ? 'pass' : 'fail',
      `实测最大坡度 ${round(maxSlope, 1)}° vs 允许上限 ${slopeLimit}°（画像上限 ${P.constraints.maxSlopeDeg}° + 路径容差 5°）`);

  // 7) 必去点与避开点
  const visited = new Set(route.itinerary.map((s) => s.poiId));
  const missing = P.mustVisit.filter((id) => !visited.has(id));
  const touched = P.avoid.filter((id) => visited.has(id));
  add('必去点覆盖', missing.length === 0 ? 'pass' : 'fail',
      missing.length ? `未覆盖：${missing.join('、')}` : `全部 ${P.mustVisit.length} 个必去点已纳入`);
  add('避开点约束', touched.length === 0 ? 'pass' : 'fail',
      touched.length ? `误入：${touched.join('、')}` : `全部 ${P.avoid.length} 个避开点已规避`);

  // 8) 停靠点可解析
  const unknown = route.itinerary.filter((s) => s.poiId !== '__start__' && !ds.get(s.poiId));
  add('停靠点可解析', unknown.length === 0 ? 'pass' : 'fail',
      unknown.length ? `数据集外的停靠点：${unknown.map((s) => s.poiId).join('、')}` : '所有停靠点均可回溯到数据集');

  // 9) 风险阈值
  const hot = (risk?.factors || []).filter((f) => f.value > 0.9);
  add('风险阈值', hot.length === 0 ? 'pass' : 'warn',
      hot.length ? `超过 0.9 的因子：${hot.map((f) => `${f.label}(${f.value})`).join('、')}` : '无因子超过 0.9');

  // 10) 可复现性
  route.coordsHash = hashCoords(route.coords);
  if (replanner) {
    const again = replanner();
    const same = hashCoords(again.coords) === route.coordsHash;
    add('可复现性（同种子重算）', same ? 'pass' : 'fail',
        same ? `几何哈希一致 ${route.coordsHash.slice(0, 16)}…`
             : `几何哈希不一致：${route.coordsHash.slice(0, 16)}… vs ${hashCoords(again.coords).slice(0, 16)}…`);
  }

  // 11) 几何退化检查
  const dup = route.coords.filter((c, i) => i > 0 &&
    Math.abs(c.lon - route.coords[i - 1].lon) < 1e-9 && Math.abs(c.lat - route.coords[i - 1].lat) < 1e-9);
  add('几何退化', dup.length === 0 ? 'pass' : 'warn', `重复相邻点 ${dup.length} 处`);

  const failed = checks.filter((c) => c.status === 'fail').length;
  const warned = checks.filter((c) => c.status === 'warn').length;
  return {
    checks, passed: checks.length - failed - warned, failed, warned,
    ok: failed === 0,
    summary: `${checks.length} 项检查：通过 ${checks.length - failed - warned}，警告 ${warned}，失败 ${failed}`,
  };
}

export { hashCoords };
