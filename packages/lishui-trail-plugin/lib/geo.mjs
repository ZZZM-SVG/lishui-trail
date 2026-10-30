// geo.mjs —— 球面几何与坐标工具（零依赖）
export const R_EARTH = 6371008.8; // WGS84 平均半径 (m)
export const D2R = Math.PI / 180;
export const R2D = 180 / Math.PI;

export function haversine(a, b) {
  const dLat = (b.lat - a.lat) * D2R;
  const dLon = (b.lon - a.lon) * D2R;
  const la1 = a.lat * D2R, la2 = b.lat * D2R;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function bearing(a, b) {
  const la1 = a.lat * D2R, la2 = b.lat * D2R;
  const dLon = (b.lon - a.lon) * D2R;
  const y = Math.sin(dLon) * Math.cos(la2);
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLon);
  return (Math.atan2(y, x) * R2D + 360) % 360;
}

export function destination(a, brgDeg, distM) {
  const d = distM / R_EARTH, br = brgDeg * D2R;
  const la1 = a.lat * D2R, lo1 = a.lon * D2R;
  const la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(br));
  const lo2 = lo1 + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(la1),
                               Math.cos(d) - Math.sin(la1) * Math.sin(la2));
  return { lon: ((lo2 * R2D + 540) % 360) - 180, lat: la2 * R2D };
}

/** 大圆插值：t=0 → a，t=1 → b */
export function interpolate(a, b, t) {
  const d = haversine(a, b);
  if (d < 1e-6) return { lon: a.lon, lat: a.lat };
  const A = Math.sin((1 - t) * d / R_EARTH) / Math.sin(d / R_EARTH);
  const B = Math.sin(t * d / R_EARTH) / Math.sin(d / R_EARTH);
  const la1 = a.lat * D2R, lo1 = a.lon * D2R, la2 = b.lat * D2R, lo2 = b.lon * D2R;
  const x = A * Math.cos(la1) * Math.cos(lo1) + B * Math.cos(la2) * Math.cos(lo2);
  const y = A * Math.cos(la1) * Math.sin(lo1) + B * Math.cos(la2) * Math.sin(lo2);
  const z = A * Math.sin(la1) + B * Math.sin(la2);
  return { lon: Math.atan2(y, x) * R2D, lat: Math.atan2(z, Math.hypot(x, y)) * R2D };
}

export function pathLength(coords) {
  let s = 0;
  for (let i = 1; i < coords.length; i++) s += haversine(coords[i - 1], coords[i]);
  return s;
}

export function bboxOf(coords) {
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const c of coords) {
    if (c.lon < minLon) minLon = c.lon;
    if (c.lon > maxLon) maxLon = c.lon;
    if (c.lat < minLat) minLat = c.lat;
    if (c.lat > maxLat) maxLat = c.lat;
  }
  return { minLon, maxLon, minLat, maxLat };
}

export function distToPolyline(pt, coords) {
  let best = Infinity;
  for (let i = 1; i < coords.length; i++) {
    best = Math.min(best, distToSegment(pt, coords[i - 1], coords[i]));
  }
  return best;
}

export function distToSegment(p, a, b) {
  // 在小范围内用局部平面近似（km 级线段，误差可忽略）
  const kx = 111320 * Math.cos(p.lat * D2R), ky = 110574;
  const ax = (a.lon - p.lon) * kx, ay = (a.lat - p.lat) * ky;
  const bx = (b.lon - p.lon) * kx, by = (b.lat - p.lat) * ky;
  const vx = bx - ax, vy = by - ay;
  const L2 = vx * vx + vy * vy;
  if (L2 < 1e-9) return Math.hypot(ax, ay);
  let t = -(ax * vx + ay * vy) / L2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(ax + t * vx, ay + t * vy);
}

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const round = (v, n = 3) => Math.round(v * 10 ** n) / 10 ** n;
