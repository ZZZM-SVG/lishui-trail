// risk.mjs —— 旅游风险预判：地形 / 气象 / 时段日照 / 涉水 / 偏远救援 / 通行可达 / 体能匹配
import { clamp, round, haversine } from './geo.mjs';
import { sunTimes, toCST } from './sun.mjs';
import { climateAdvice, monthlyClimateRisk } from './climate.mjs';

export const RISK_FACTORS = {
  terrain:    { label: '地形与坡度', weight: 0.22 },
  weather:    { label: '气象与季节', weight: 0.16 },
  daylight:   { label: '日照与时段', weight: 0.16 },
  water:      { label: '涉水与湿滑', weight: 0.12 },
  remoteness: { label: '偏远与救援', weight: 0.14 },
  access:     { label: '通行与可达性', weight: 0.10 },
  fitness:    { label: '体能匹配度', weight: 0.10 },
};

const LEVELS = [
  { max: 24, level: '低',   color: '#2e7d32', advice: '可按计划执行，保持常规户外注意。' },
  { max: 44, level: '较低', color: '#7cb342', advice: '整体可控，注意补水与节奏。' },
  { max: 64, level: '中',   color: '#f9a825', advice: '需针对性准备：防晒/雨具/照明，控制爬升节奏。' },
  { max: 84, level: '高',   color: '#ef6c00', advice: '建议调整方案：缩短路线或提前出发，并告知亲友行程。' },
  { max: 101, level: '极高', color: '#c62828', advice: '不建议按当前方案出行，请更换时段或大幅降低强度。' },
];

const lin = (x, x0, x1) => clamp((x - x0) / (x1 - x0), 0, 1);

/** 沿路线采样，得到与水域、既有路径的距离极值 */
function sampleAlong(T, coords, n = 60) {
  let minWater = Infinity, maxPath = 0, minPath = Infinity;
  const step = Math.max(1, Math.floor(coords.length / n));
  for (let i = 0; i < coords.length; i += step) {
    const c = coords[i];
    const w = T.waterDistanceM(c.lon, c.lat);
    if (w != null && w < minWater) minWater = w;
    const p = T.pathDistanceM(c.lon, c.lat);
    if (p != null) { if (p > maxPath) maxPath = p; if (p < minPath) minPath = p; }
  }
  return { minWaterM: Number.isFinite(minWater) ? Math.round(minWater) : null,
           maxPathM: Math.round(maxPath), minPathM: Number.isFinite(minPath) ? Math.round(minPath) : null };
}

export function assessRisk({ ds, T, P, route }) {
  const month = Number(P.date.slice(5, 7));
  const clim = climateAdvice(month);
  const M = route.metrics;
  const months = monthlyClimateRisk(month);

  // ---------- 1) 地形与坡度 ----------
  const slopeRatio = clamp(M.maxSlopeDeg / Math.max(P.constraints.maxSlopeDeg, 1), 0, 2);
  const ascentRatio = clamp(M.totalAscentM / Math.max(P.constraints.maxAscentM, 1), 0, 2);
  const steepRatio = M.totalDistanceM > 0 ? M.steepDistanceM / M.totalDistanceM : 0;
  const terrain = clamp(0.40 * clamp(M.maxSlopeDeg / 35, 0, 1)
                      + 0.32 * clamp(M.totalAscentM / Math.max(P.constraints.maxAscentM, 1), 0, 1.2) / 1.2
                      + 0.28 * clamp(steepRatio * 3, 0, 1), 0, 1);

  // ---------- 2) 气象与季节 ----------
  const weather = clamp(0.45 * months.heat + 0.35 * months.cold
                      + 0.55 * months.rainProbability + 0.30 * months.convective, 0, 1);

  // ---------- 3) 日照与时段 ----------
  const st = sunTimes(new Date(`${P.date}T04:00:00Z`), route.start.lon, route.start.lat);
  const [sh, sm] = P.startTime.split(':').map(Number);
  const startMin = sh * 60 + sm;
  const finishMin = startMin + M.totalMin;
  const sunsetMin = st.polar ? null : Math.round(((st.sunset + 8 * 3600000) % 86400000) / 60000);
  const daylightMargin = sunsetMin == null ? 999 : sunsetMin - finishMin;
  const daylight = clamp(1 - daylightMargin / 120, 0, 1);

  // ---------- 4) 涉水与湿滑 ----------
  const sw = sampleAlong(T, route.coords, 70);
  const waterFactor = sw.minWaterM == null ? 0.35 : clamp(1 - sw.minWaterM / 150, 0, 1);

  // ---------- 5) 偏远与救援 ----------
  let maxSupport = 0;
  const stopIds = new Set(route.itinerary.map((s) => s.poiId));
  const others = ds.pois.filter((p) => !stopIds.has(p.id));
  const step = Math.max(1, Math.floor(route.coords.length / 40));
  for (let i = 0; i < route.coords.length; i += step) {
    const c = route.coords[i];
    let d = Infinity;
    for (const p of others) {
      const dd = haversine(c, p);
      if (dd < d) d = dd;
      if (d < 200) break;
    }
    if (Number.isFinite(d) && d > maxSupport) maxSupport = d;
  }
  const remoteness = clamp(0.55 * clamp(sw.maxPathM / 1000, 0, 1)
                         + 0.45 * clamp((maxSupport - 400) / 2600, 0, 1), 0, 1);

  // ---------- 6) 通行与可达性 ----------
  const BAD = /待核|遗址|遗存|建设中|已毁/;
  const badStops = route.itinerary.filter((s) => s.poiId !== route.start.id &&
    (BAD.test(s.status || '') || s.seasonalMismatch));
  const seasonalCount = route.itinerary.filter((s) => s.seasonalMismatch).length;
  const nStop = Math.max(1, M.stopCount);
  const access = clamp(0.5 * clamp(badStops.length / nStop * 1.5, 0, 1)
                     + 0.5 * clamp(seasonalCount / nStop * 2, 0, 1), 0, 1);

  // ---------- 7) 体能匹配 ----------
  const budgetUse = M.totalMin / P.durationMin;
  const fitness = clamp(0.45 * clamp(M.totalAscentM / Math.max(P.constraints.maxAscentM, 1), 0, 1.3) / 1.3
                      + 0.30 * clamp(M.totalDistanceM / Math.max(P.constraints.maxDistanceM, 1), 0, 1.3) / 1.3
                      + 0.25 * clamp(budgetUse, 0, 1), 0, 1);

  // ---------- 权重自适应 ----------
  const w = { ...Object.fromEntries(Object.entries(RISK_FACTORS).map(([k, v]) => [k, v.weight])) };
  if ([6, 7, 8].includes(month)) { w.weather *= 1.5; w.water *= 1.3; w.daylight *= 1.1; }
  if ([12, 1, 2].includes(month)) { w.weather *= 1.4; w.daylight *= 1.35; w.remoteness *= 1.1; }
  if (P.party.elderly > 0 || P.party.children > 0) {
    w.terrain *= 1.3; w.fitness *= 1.4; w.daylight *= 1.2; w.remoteness *= 1.15;
  }
  const wsum = Object.values(w).reduce((a, b) => a + b, 0);
  for (const k of Object.keys(w)) w[k] = w[k] / wsum;

  const factors = { terrain, weather, daylight, water: waterFactor, remoteness, access, fitness };
  let score = 0;
  const detail = [];
  for (const [k, v] of Object.entries(factors)) {
    score += w[k] * v;
    detail.push({ key: k, label: RISK_FACTORS[k].label, value: round(v, 3),
                  weight: round(w[k], 3), contribution: round(w[k] * v * 100, 1) });
  }
  score = Math.round(score * 100);
  detail.sort((a, b) => b.contribution - a.contribution);
  const lv = LEVELS.find((l) => score < l.max) || LEVELS[LEVELS.length - 1];

  // ---------- 缓释建议 ----------
  const mitigations = [];
  if (terrain > 0.5) mitigations.push(`最大坡度 ${M.maxSlopeDeg}°、累计爬升 ${M.totalAscentM} m 已接近或超过你的体能上限（${P.constraints.maxSlopeDeg}° / ${P.constraints.maxAscentM} m）：建议缩短陡坡段或在第 ${Math.max(1, Math.floor(M.stopCount / 2))} 个停留点折返。`);
  if (steepRatio > 0.15) mitigations.push(`陡坡（>15°）路段占 ${(steepRatio * 100).toFixed(1)}%（约 ${(M.steepDistanceM / 1000).toFixed(1)} km）：下坡请使用登山杖，雨后避开该段。`);
  if (months.heat > 0.4) mitigations.push(`当月平均最高气温 ${months.normals.tmax}℃：11:00—15:00 避免连续爬升，人均携带 ≥1.5 L 饮水与电解质。`);
  if (months.cold > 0.3) mitigations.push(`当月平均最低气温 ${months.normals.tmin}℃：注意结冰路面与失温，携带保温层。`);
  if (months.rainProbability > 0.3) mitigations.push(`历史降水日 ${months.normals.rainDays} 天/月（遇雨概率约 ${Math.round(months.rainProbability * 100)}%）：携带雨具，预留 20% 机动时间。`);
  if (months.convective > 0.5) mitigations.push('梅雨/台风季强对流潜势偏高：雷雨时远离山脊、水岸与孤立大树。');
  if (daylight > 0.4) mitigations.push(`预计 ${toCST((startMin * 60000) + M.totalMin * 60000, 8)} 结束，日落 ${sunsetMin == null ? '—' : String(Math.floor(sunsetMin / 60)).padStart(2, '0') + ':' + String(sunsetMin % 60).padStart(2, '0')}（余量 ${daylightMargin} 分钟）：须携带头灯，或提前 ${Math.max(15, 120 - daylightMargin)} 分钟出发。`);
  if (waterFactor > 0.5) mitigations.push(`路线最近距水域约 ${sw.minWaterM} m：湖岸/水库边湿滑且水深不明，勿下水、勿靠近无护栏岸边；看护儿童。`);
  if (remoteness > 0.5) mitigations.push(`离既有步道最远约 ${sw.maxPathM} m、离最近资源点约 ${Math.round(maxSupport)} m：建议结伴、共享实时位置给亲友。`);
  if (badStops.length) mitigations.push(`有 ${badStops.length} 个停靠点运营状态为「${[...new Set(badStops.map((s) => s.status || '季节性'))].join('/')}」：出行前电话确认开放，必要时替换为同类替代点。`);
  if (fitness > 0.65) mitigations.push(`行程强度已达体能上限的 ${Math.round(fitness * 100)}%：建议降低 1—2 个停靠点或把体能档位下调一档重算。`);
  if (!mitigations.length) mitigations.push('未发现显著风险项：保持常规户外准备（饮水、防晒、告知行程）即可。');

  return {
    score, level: lv.level, color: lv.color, advice: lv.advice,
    factors: detail,
    evidence: {
      maxSlopeDeg: M.maxSlopeDeg, steepRatio: round(steepRatio, 3),
      totalAscentM: M.totalAscentM, totalDistanceM: M.totalDistanceM,
      minWaterDistanceM: sw.minWaterM, maxDistanceToTrailM: sw.maxPathM,
      maxDistanceToSupportM: Math.round(maxSupport),
      finishTime: toCST(startMin * 60000 + M.totalMin * 60000, 8),
      sunsetTime: sunsetMin == null ? null : `${String(Math.floor(sunsetMin / 60)).padStart(2, '0')}:${String(sunsetMin % 60).padStart(2, '0')}`,
      daylightMarginMin: daylightMargin === 999 ? null : daylightMargin,
      sunriseTime: st.polar ? null : toCST(st.sunrise, 8),
      seasonalMismatchStops: seasonalCount,
      accessUncertainStops: badStops.length,
      constraints: P.constraints,
      climate: months.normals, climateSource: clim.tips,
    },
    mitigations,
  };
}
