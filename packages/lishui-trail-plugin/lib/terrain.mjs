// terrain.mjs —— 离线地形引擎：DEM 双线性取高程、坡度、Tobler 步行时间、
//                基于 A* 的最小代价路径（沿真实路网、避让水域与陡崖）、地形剖面统计
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { haversine, pathLength, bboxOf, clamp, round, D2R } from './geo.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 依次尝试：显式目录 → 环境变量 → 插件包根 data/（随包分发）→ 工作区 data/ → 当前工作目录 data/ */
export function resolveDataDir(explicit) {
  const cands = [];
  if (explicit) cands.push(explicit);
  if (process.env.LISHUI_DATA_DIR) cands.push(process.env.LISHUI_DATA_DIR);
  cands.push(path.resolve(HERE, '..', 'data'));            // 插件包内自带数据（安装为快照后仍可用）
  cands.push(path.resolve(HERE, '..', '..', '..', 'data')); // 仓库中的 lishui-trail/data
  cands.push(path.resolve(process.cwd(), 'data'));
  for (const c of cands) {
    try { if (fs.existsSync(path.join(c, 'pois.json'))) return c; } catch { /* ignore */ }
  }
  return cands[0];
}

// ---------------------------------------------------------------- 最小堆
class MinHeap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(k, v) {
    const a = this.a; a.push([k, v]);
    let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; }
  }
  pop() {
    const a = this.a; const top = a[0]; const last = a.pop();
    if (a.length) {
      a[0] = last; let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m;
      }
    }
    return top;
  }
}

// ------------------------------------------------------------ Tobler 步行速度
/** Tobler 步行速度函数（Tobler's hiking function）：speed(km/h) = 6·exp(-3.5·|tanθ + 0.05|)，θ 为坡度角 */
export function toblerSpeedKmh(slopeTan) {
  return 6 * Math.exp(-3.5 * Math.abs(slopeTan + 0.05));
}
/** 两点间（水平距离 m 与高差 m）的步行时间（分钟） */
export function walkMinutes(distM, dhM) {
  if (distM <= 0) return 0;
  const v = toblerSpeedKmh(dhM / distM);      // km/h
  return (distM / 1000) / v * 60;
}

// ------------------------------------------------------------------- 主引擎
let CACHE = null;

export function loadTerrain(opts = {}) {
  if (CACHE && !opts.force) return CACHE;
  const dir = resolveDataDir(opts.dataDir);

  // --- DEM ---
  let dem = null, demWarning = null;
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'dem.json'), 'utf8'));
    const buf = fs.readFileSync(path.join(dir, 'dem.bin'));
    const raw = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2);
    dem = {
      meta,
      w: meta.width, h: meta.height,
      originLon: meta.originLon, originLat: meta.originLat,
      dLon: meta.cellLonDeg, dLat: meta.cellLatDeg,
      data: raw,
    };
  } catch (e) {
    demWarning = `DEM 不可用（${e.message}），已降级为平地模型：坡度风险与地形绕行失效。`;
  }

  const latForM = dem ? (dem.originLat - dem.dLat * dem.h / 2) : 31.6;
  const metrics = dem
    ? {
        dx: dem.dLon * 111320 * Math.cos(latForM * D2R),
        dy: dem.dLat * 110574,
      }
    : { dx: 60, dy: 60 };
  // 等效格边长（米）。A* 里的"距离类"阈值一律按米表达、在此换算成格，
  // 否则换一次 DEM 分辨率，这些阈值（原为 wd<3 格、pd/6 格）的物理含义就会漂。
  metrics.cell = (metrics.dx + metrics.dy) / 2;
  /** 米 → 格（至少 1 格） */
  const cellsFor = (meters) => Math.max(1, Math.round(meters / (metrics.cell || 60)));

  // --- OSM 路网与水域 ---
  let osm = null, osmWarning = null;
  try {
    osm = JSON.parse(fs.readFileSync(path.join(dir, 'osm.json'), 'utf8'));
  } catch (e) {
    osmWarning = `OSM 路网/水域不可用（${e.message}），已降级：不沿既有步道、不做水域避让。`;
  }

  const grids = dem ? buildGrids(dem, osm, metrics) : null;

  CACHE = {
    dir, dem, demWarning, metrics, grids, osmWarning,
    hasOsm: !!osm,

    // ---------------- 高程/坡度 ----------------
    elevationAt(lon, lat) {
      if (!dem) return 0;
      const fx = (lon - dem.originLon) / dem.dLon;
      const fy = (dem.originLat - lat) / dem.dLat;
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      if (x0 < 0 || y0 < 0 || x0 >= dem.w - 1 || y0 >= dem.h - 1) return NaN;
      const tx = fx - x0, ty = fy - y0;
      const d = dem.data;
      const v00 = d[y0 * dem.w + x0], v10 = d[y0 * dem.w + x0 + 1];
      const v01 = d[(y0 + 1) * dem.w + x0], v11 = d[(y0 + 1) * dem.w + x0 + 1];
      return (v00 * (1 - tx) + v10 * tx) * (1 - ty) + (v01 * (1 - tx) + v11 * tx) * ty;
    },

    /** 局部坡度（度） */
    slopeAt(lon, lat, step = 1) {
      if (!dem) return 0;
      const zx = this.dem.data; // eslint-disable-line
      const z = (a, b) => this.elevationAt(a, b);
      const dLon = dem.dLon * step, dLat = dem.dLat * step;
      const dzdx = (z(lon + dLon, lat) - z(lon - dLon, lat)) / (2 * dem.dLon * step * 111320 * Math.cos(lat * D2R));
      const dzdy = (z(lon, lat + dLat) - z(lon, lat - dLat)) / (2 * dem.dLat * step * 110574);
      return Math.atan(Math.hypot(dzdx, dzdy)) * 180 / Math.PI;
    },

    /** 沿线采样地形剖面 */
    profile(coords, samples = null) {
      if (!coords || coords.length < 2) return [];
      const out = [];
      const n = samples ?? Math.max(8, Math.min(240, Math.round(pathLength(coords) / 120)));
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        const seg = t * (coords.length - 1);
        const k = Math.min(coords.length - 2, Math.floor(seg));
        const f = seg - k;
        const lon = coords[k].lon + (coords[k + 1].lon - coords[k].lon) * f;
        const lat = coords[k].lat + (coords[k + 1].lat - coords[k].lat) * f;
        const e = this.elevationAt(lon, lat);
        const dist = pathLength(coords.slice(0, k + 1)) + haversine(coords[k], { lon, lat });
        out.push({ d: Math.round(dist), e: Number.isFinite(e) ? Math.round(e * 10) / 10 : null,
                   lon: round(lon, 5), lat: round(lat, 5) });
      }
      return out;
    },

    /** 沿几何的统计量：距离 / 爬升 / 下降 / 最大坡度 / 陡坡占比 / 步行时间 */
    stats(coords) {
      let dist = 0, up = 0, down = 0, timeMin = 0;
      let maxSlope = 0, steep = 0, steepDist = 0;
      for (let i = 1; i < coords.length; i++) {
        const d = haversine(coords[i - 1], coords[i]);
        if (d < 1e-6) continue;
        const e0 = this.elevationAt(coords[i - 1].lon, coords[i - 1].lat);
        const e1 = this.elevationAt(coords[i].lon, coords[i].lat);
        let dh = 0;
        if (Number.isFinite(e0) && Number.isFinite(e1)) {
          dh = e1 - e0;
          if (dh > 0) up += dh; else down -= dh;
        }
        const slopeTan = Math.abs(dh) / d;
        const slopeDeg = Math.atan(slopeTan) * 180 / Math.PI;
        if (slopeDeg > maxSlope) maxSlope = slopeDeg;
        if (slopeDeg > 15) { steep++; steepDist += d; }
        dist += d;
        timeMin += walkMinutes(d, dh);
      }
      return {
        distanceM: Math.round(dist),
        ascentM: Math.round(up), descentM: Math.round(down),
        maxSlopeDeg: round(maxSlope, 1),
        steepDistanceM: Math.round(steepDist),
        steepRatio: dist > 0 ? round(steepDist / dist, 3) : 0,
        walkMinutes: Math.round(timeMin * 10) / 10,
      };
    },

    /** 网格到最近水域/最近路径的距离（米）；无数据返回 null */
    waterDistanceM(lon, lat) { return gridDist(grids?.waterDist, dem, lon, lat, metrics); },
    pathDistanceM(lon, lat) { return gridDist(grids?.pathDist, dem, lon, lat, metrics); },
    isWater(lon, lat) { return gridFlag(grids?.waterUnion, dem, lon, lat) === 1; },
    /** 是否落在面状水域（湖泊/水库）内——这类位置不可作为停靠点 */
    isWaterArea(lon, lat) { return gridFlag(grids?.water, dem, lon, lat) === 1; },

    /** A* 最小代价路径：优先严格约束；无解时逐级放宽（更大搜索域 → 允许涉水/放宽坡度），并标记降级原因 */
    leastCostPath(a, b, o = {}) {
      if (!dem) return { coords: [a, b], degraded: 'no-dem', stats: this.stats([a, b]) };
      // 搜索域以"米"为基准（默认在两点包围盒外扩 1.8 km），再换算成格；
      // 仍兼容显式传入的 marginCells（历史诊断脚本在用）。
      const marginCells = o.marginCells ?? cellsFor(o.marginMeters ?? 1800);
      const strict = astar(this, a, b, { ...o, marginCells });
      if (!strict.unreachable) return strict;
      // 回退一：扩大搜索域（3 倍）
      const wider = astar(this, a, b, { ...o, marginCells: marginCells * 3 });
      if (!wider.unreachable) { wider.degraded = 'wider-search'; return wider; }
      // 回退二：允许涉水 + 放宽坡度上限（保持极高的水域代价，仍优先绕行）
      const relaxed = astar(this, a, b, {
        ...o,
        marginCells: marginCells * 3,
        water: 'penalty',
        maxSlopeDeg: (o.maxSlopeDeg ?? 38) + 10,
      });
      if (!relaxed.unreachable) { relaxed.degraded = 'relaxed-constraints'; return relaxed; }
      relaxed.degraded = 'unresolved';
      return relaxed;
    },
  };
  return CACHE;
}

function toCell(dem, lon, lat) {
  return { c: (lon - dem.originLon) / dem.dLon, r: (dem.originLat - lat) / dem.dLat };
}
function cellLon(dem, c) { return dem.originLon + c * dem.dLon; }
function cellLat(dem, r) { return dem.originLat - r * dem.dLat; }

function gridFlag(g, dem, lon, lat) {
  if (!g || !dem) return 0;
  const { c, r } = toCell(dem, lon, lat);
  const x = Math.floor(c), y = Math.floor(r);
  if (x < 0 || y < 0 || x >= dem.w || y >= dem.h) return 0;
  return g[y * dem.w + x];
}
function gridDist(g, dem, lon, lat, metrics) {
  if (!g || !dem) return null;
  const { c, r } = toCell(dem, lon, lat);
  const x = clamp(Math.floor(c), 0, dem.w - 1), y = clamp(Math.floor(r), 0, dem.h - 1);
  const v = g[y * dem.w + x];
  if (v >= 65000) return null;
  return Math.round(v * (metrics.cell || metrics.dx));
}

// ------------------------------------------------------ 栅格化与距离变换
function buildGrids(dem, osm, metrics) {
  const W = dem.w, H = dem.h;
  // 面状水域（湖泊/水库/湿地等闭合面）：硬障碍，禁行
  // 线状河道（river/stream/canal 等）：软障碍，代价抬高但允许跨越（现实中有桥/涵）
  const waterArea = new Uint8Array(W * H);
  const waterLine = new Uint8Array(W * H);
  const pathG = new Uint8Array(W * H);

  // 整数 Bresenham 描线（注意 dy 必须取负；否则 y 永不推进、线段被画成横条并空转至上限）
  const plotLine = (a, b, fn) => {
    let x0 = Math.round(a.c), y0 = Math.round(a.r);
    const x1 = Math.round(b.c), y1 = Math.round(b.r);
    if (!Number.isFinite(x0) || !Number.isFinite(y0) || !Number.isFinite(x1) || !Number.isFinite(y1)) return;
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    const cap = dx - dy + 2;
    for (let i = 0; i < cap; i++) {
      fn(x0, y0);
      if (x0 === x1 && y0 === y1) return;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  };
  const setCell = (g, x, y, v = 1) => {
    if (x >= 0 && y >= 0 && x < W && y < H) g[y * W + x] = v;
  };

  if (osm) {
    // --- 水域面填充（闭合环用扫描线填充；未闭合的线按宽度 1 描边）---
    for (const w of osm.waters || []) {
      const pts = (w.coords || []).map(([lon, lat]) => toCell(dem, lon, lat));
      if (pts.length < 2) continue;
      const closed = Math.abs(pts[0].c - pts[pts.length - 1].c) < 1e-6 &&
                     Math.abs(pts[0].r - pts[pts.length - 1].r) < 1e-6;
      if (closed && pts.length >= 4 && !/river|stream|canal|drain|ditch/.test(w.kind)) {
        let rmin = Infinity, rmax = -Infinity;
        for (const p of pts) { rmin = Math.min(rmin, p.r); rmax = Math.max(rmax, p.r); }
        const r0 = clamp(Math.floor(rmin) - 1, 0, H - 1), r1 = clamp(Math.ceil(rmax) + 1, 0, H - 1);
        for (let r = r0; r <= r1; r++) {
          const y = r + 0.5;
          const xs = [];
          for (let i = 1; i < pts.length; i++) {
            const A = pts[i - 1], B = pts[i];
            if ((A.r <= y && B.r > y) || (B.r <= y && A.r > y)) {
              xs.push(A.c + (y - A.r) / (B.r - A.r) * (B.c - A.c));
            }
          }
          if (xs.length < 2) continue;
          xs.sort((p, q) => p - q);
          for (let k = 0; k + 1 < xs.length; k += 2) {
            const xa = Math.max(0, Math.ceil(xs[k] - 0.5));
            const xb = Math.min(W - 1, Math.floor(xs[k + 1] - 0.5));
            for (let x = xa; x <= xb; x++) waterArea[r * W + x] = 1;
          }
        }
      } else {
        for (let i = 1; i < pts.length; i++) plotLine(pts[i - 1], pts[i], (x, y) => setCell(waterLine, x, y));
      }
    }
    // --- 路网描边 + 1 格膨胀（供沿路偏置）---
    for (const w of osm.paths || []) {
      const pts = (w.coords || []).map(([lon, lat]) => toCell(dem, lon, lat));
      for (let i = 1; i < pts.length; i++) plotLine(pts[i - 1], pts[i], (x, y) => setCell(pathG, x, y));
    }
    dilate(pathG, W, H, 1);
  }

  // 距离场用"全部水域"（面+线），供贴水风险判定
  const waterUnion = new Uint8Array(W * H);
  let nWater = 0, nWaterLine = 0, nPath = 0;
  for (let i = 0; i < waterUnion.length; i++) {
    if (waterArea[i] || waterLine[i]) waterUnion[i] = 1;
    if (waterArea[i]) nWater++;
    if (waterLine[i]) nWaterLine++;
    if (pathG[i]) nPath++;
  }
  const waterDist = chamfer(waterUnion, W, H, true);
  const pathDist = chamfer(pathG, W, H, true);
  return {
    water: waterArea, waterLine, waterUnion, pathG, waterDist, pathDist,
    nWaterCells: nWater, nWaterLineCells: nWaterLine, nPathCells: nPath,
  };
}

function dilate(g, W, H, k) {
  let cur = g;
  for (let it = 0; it < k; it++) {
    const nx = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let v = 0;
        for (let dy = -1; dy <= 1 && !v; dy++) {
          for (let dx = -1; dx <= 1 && !v; dx++) {
            const yy = y + dy, xx = x + dx;
            if (yy >= 0 && yy < H && xx >= 0 && xx < W && cur[yy * W + xx]) v = 1;
          }
        }
        nx[y * W + x] = v;
      }
    }
    cur = nx;
  }
  g.set(cur);
}

/** 两遍 chamfer 距离变换，返回以"格"为单位的距离（65535 表示不可达/无源） */
function chamfer(mask, W, H, toSource) {
  const INF = 65535;
  const d = new Uint16Array(W * H);
  for (let i = 0; i < d.length; i++) d[i] = toSource ? (mask[i] ? 0 : INF) : INF;
  const a = 1, b = 1.414;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (d[i] === 0) continue;
      let m = d[i];
      if (y > 0) m = Math.min(m, d[i - W] + a);
      if (x > 0) m = Math.min(m, d[i - 1] + a);
      if (x > 0 && y > 0) m = Math.min(m, d[i - W - 1] + b);
      if (x < W - 1 && y > 0) m = Math.min(m, d[i - W + 1] + b);
      d[i] = Math.min(m, INF);
    }
  }
  for (let y = H - 1; y >= 0; y--) {
    for (let x = W - 1; x >= 0; x--) {
      const i = y * W + x;
      if (d[i] === 0) continue;
      let m = d[i];
      if (y < H - 1) m = Math.min(m, d[i + W] + a);
      if (x < W - 1) m = Math.min(m, d[i + 1] + a);
      if (x < W - 1 && y < H - 1) m = Math.min(m, d[i + W + 1] + b);
      if (x > 0 && y < H - 1) m = Math.min(m, d[i + W - 1] + b);
      d[i] = Math.min(m, INF);
    }
  }
  return d;
}

// ------------------------------------------------------------------ A*

/**
 * A* 工作数组池（已弃用，保留说明）：
 * 曾按窗口容量缓存 gScore/cameFrom/closed 以减少分配，实测只快约 5%，
 * 却因不同腿的窗口尺寸各异、每个尺寸各留一份，使常驻内存涨到 380 MB 以上。
 * 得不偿失，故改回每次新建。
 */

function astar(T, a, b, o = {}) {
  const dem = T.dem, W = dem.w, H = dem.h, g = T.grids;
  const { dx, dy } = T.metrics;
  const cm = T.metrics.cell || (dx + dy) / 2;   // 等效格边长（米），用于把米制阈值换算成格
  const margin = o.marginCells ?? 30;
  let ca = toCell(dem, a.lon, a.lat), cb = toCell(dem, b.lon, b.lat);
  const x0 = clamp(Math.floor(Math.min(ca.c, cb.c)) - margin, 0, W - 1);
  const x1 = clamp(Math.ceil(Math.max(ca.c, cb.c)) + margin, 0, W - 1);
  const y0 = clamp(Math.floor(Math.min(ca.r, cb.r)) - margin, 0, H - 1);
  const y1 = clamp(Math.ceil(Math.max(ca.r, cb.r)) + margin, 0, H - 1);
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;

  const s = { x: clamp(Math.round(ca.c), x0, x1) - x0, y: clamp(Math.round(ca.r), y0, y1) - y0 };
  const t = { x: clamp(Math.round(cb.c), x0, x1) - x0, y: clamp(Math.round(cb.r), y0, y1) - y0 };

  const N = bw * bh;
  const gScore = new Float64Array(N).fill(Infinity);
  const cameFrom = new Int32Array(N).fill(-1);
  const closed = new Uint8Array(N);
  const start = s.y * bw + s.x, goal = t.y * bw + t.x;
  const MAXSLOPE = o.maxSlopeDeg ?? 38;
  const waterMode = o.water ?? 'block';   // block=水域禁行；penalty=允许涉水但代价极高（降级回退用）
  let crossedWater = false;

  const elev = (x, y) => dem.data[(y + y0) * W + (x + x0)];
  // 启发式：以 5 km/h 估剩余时间的上界。这里是整个搜索最热的一行，
  // 用等距圆柱近似代替 haversine（该启发式本就带 0.98 权重、不求严格可采纳）。
  const hkx = 111320 * Math.cos(b.lat * D2R), hky = 110574;
  const hx = (x, y) => {
    const ddx = (cellLon(dem, x + x0) - b.lon) * hkx;
    const ddy = (cellLat(dem, y + y0) - b.lat) * hky;
    return Math.hypot(ddx, ddy) / 1000 / 5.0 * 60;
  };

  gScore[start] = 0;
  const heap = new MinHeap();
  heap.push(hx(s.x, s.y), start);
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

  while (heap.size) {
    const [, cur] = heap.pop();
    if (cur === goal) break;
    if (closed[cur]) continue;
    closed[cur] = 1;
    const cx = cur % bw, cy = (cur - cx) / bw;
    const e0 = elev(cx, cy);
    for (const [ddx, ddy] of DIRS) {
      const nx = cx + ddx, ny = cy + ddy;
      if (nx < 0 || ny < 0 || nx >= bw || ny >= bh) continue;
      const ni = ny * bw + nx;
      if (closed[ni]) continue;
      const gi = (ny + y0) * W + (nx + x0);
      const isWA = g && g.water[gi];                          // 面状水域：硬障碍
      const onRoad = g && g.pathG[gi];                        // 落在既有道路上（桥/堤/涵可跨越水域）
      if (isWA && waterMode === 'block' && !onRoad) continue;
      const isWL = g && g.waterLine[gi];                      // 线状河道：软障碍（桥涵可通行）
      const step = ddx && ddy ? Math.hypot(dx, dy) : (ddx ? dx : dy);
      const e1 = elev(nx, ny);
      const dh = e1 - e0;
      const slopeDeg = Math.atan(Math.abs(dh) / step) * 180 / Math.PI;
      if (slopeDeg > MAXSLOPE) continue;                      // 陡崖禁行
      let cost = walkMinutes(step, dh);
      if (slopeDeg > 15) cost *= 1 + 1.6 * (slopeDeg - 15) / 15;
      if (isWL) cost *= 3.5;                                  // 跨越河道：抬高代价，优先走桥
      if (isWA) cost *= onRoad ? 3 : 10;                      // 沿堤/桥穿水代价高但可行；无路入水仅降级时触发
      if (g) {
        const pd = g.pathDist[gi];
        if (pd === 0) cost *= 0.72;                          // 沿既有步道更省力
        else cost *= 1 + 0.55 * Math.min(1, (pd * cm) / 360); // 离开步道有代价（360 m 内线性）
        const wd = g.waterDist[gi];
        if (wd * cm < 180) cost *= 1.6;                      // 贴水行进：湿滑/绕行代价（180 m 内）
      }
      const ng = gScore[cur] + cost;
      if (ng < gScore[ni]) {
        gScore[ni] = ng;
        cameFrom[ni] = cur;
        heap.push(ng + hx(nx, ny) * 0.98, ni);
      }
    }
  }

  if (!Number.isFinite(gScore[goal])) {
    return { coords: [a, b], unreachable: true, stats: T.stats([a, b]),
             reason: '在当前代价约束下（坡度 ≤ ' + MAXSLOPE + '°，水域禁行）未能找到可行路径' };
  }
  const raw = [];
  {
    let cur = goal;
    while (cur !== -1 && raw.length < N) {
      const cx = cur % bw, cy = (cur - cx) / bw;
      if (g && (g.water[(cy + y0) * W + (cx + x0)] || g.waterLine[(cy + y0) * W + (cx + x0)])) crossedWater = true;
      raw.push({ lon: cellLon(dem, cx + x0), lat: cellLat(dem, cy + y0) });
      cur = cameFrom[cur];
    }
  }
  raw.reverse();
  raw[0] = { lon: a.lon, lat: a.lat };
  raw[raw.length - 1] = { lon: b.lon, lat: b.lat };
  const coords = simplify(raw, o.toleranceM ?? 12);
  return {
    coords, stats: T.stats(coords), estimatedMinutes: round(gScore[goal], 1),
    crossedWater, maxSlopeDeg: MAXSLOPE,
  };
}

/** Douglas-Peucker 简化 */
function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  const kx = 111320 * Math.cos(pts[0].lat * D2R), ky = 110574;
  while (stack.length) {
    const [i0, i1] = stack.pop();
    let maxD = -1, idx = -1;
    const ax = pts[i0].lon * kx, ay = pts[i0].lat * ky;
    const bx = pts[i1].lon * kx, by = pts[i1].lat * ky;
    const vx = bx - ax, vy = by - ay;
    const L2 = vx * vx + vy * vy;
    for (let i = i0 + 1; i < i1; i++) {
      const px = pts[i].lon * kx, py = pts[i].lat * ky;
      let d;
      if (L2 < 1e-9) d = Math.hypot(px - ax, py - ay);
      else {
        let tt = ((px - ax) * vx + (py - ay) * vy) / L2;
        tt = clamp(tt, 0, 1);
        d = Math.hypot(px - (ax + tt * vx), py - (ay + tt * vy));
      }
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol && idx > 0) {
      keep[idx] = 1;
      stack.push([i0, idx], [idx, i1]);
    }
  }
  const out = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]);
  return out.length >= 2 ? out : pts;
}

export { simplify };
