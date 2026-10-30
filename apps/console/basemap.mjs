// basemap.mjs —— 离线底图渲染（v2：多图层 / 高清 / 等高线）
//
// 为什么由服务端出图：比赛要求离线运行，现场没有瓦片服务可用，也不能接入任何在线地图。
// 这里用 Node 内置 zlib 手写 PNG 编码，把本地地理数据渲染成底图：
//   * 地形层 terrain —— 高程分层设色（16 带 × 12 光照档 = 192 色）+ 20m 等高线
//   * 网络层 network —— 水域 / 河渠 / 步道 / 分级路网（调色板 PNG + tRNS 透明）
// 全流程零第三方依赖、零网络。
//
// 数据来源：地形 AWS Open Data Terrain Tiles（SRTM 派生）；水系与路网 OpenStreetMap（ODbL 1.0）。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const hex2rgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

/** 输出相对 DEM 的倍率：DEM 60m/格 → 输出 30m/格 */
const OUT_K = 2;
/** 内部超采样倍率：按 4×DEM 分辨率绘制，最后 2×2 降采样，线条自带抗锯齿 */
const SS = 2;
/** 地形分层档数 */
const N_BAND = 16;
const N_LIGHT = 12;

/** 地形分层设色：低地米白 → 丘陵黄绿 → 山脊褐（16 带，0—450m） */
const TERRAIN_BANDS = [
  '#FAF8F1', '#F7F5EA', '#F3F1E2', '#EFEDDA', '#EAEBCF', '#E3E7C5', '#DBE1BB', '#D2DAB0',
  '#C9D3A6', '#BECC9C', '#B3C493', '#A8BC8A', '#B8B183', '#C0A97C', '#C7A076', '#CD9770',
];

/** 索引约定 */
const IDX_TRANSPARENT = 0;
const IDX_WATER_AREA = 64;
const IDX_WATER_LINE = 65;
const IDX_WETLAND = 66;
const IDX_TRAIL = 67;
const IDX_ROAD_MINOR = 68;
const IDX_ROAD_MAJOR = 69;
const IDX_ROAD_TRUNK = 70;

const LINE_WATER = /river|stream|canal|drain|ditch/;
const TRAIL_CLASSES = new Set(['footway', 'path', 'steps', 'track', 'cycleway']);
const MAJOR_CLASSES = new Set(['secondary', 'primary', 'trunk']);

/* ============================================================ 调色板 */

export function terrainPalette() {
  const pal = new Array(256).fill([0, 0, 0]);
  for (let b = 0; b < N_BAND; b++) {
    const [r, g, bl] = hex2rgb(TERRAIN_BANDS[b]);
    for (let l = 0; l < N_LIGHT; l++) {
      const k = 0.55 + 0.47 * (l / (N_LIGHT - 1)); // 西北光照：背光面压暗，亮部可轻微提亮
      pal[b * N_LIGHT + l] = [Math.round(r * k), Math.round(g * k), Math.round(bl * k)];
    }
  }
  return pal;
}

export function networkPalette() {
  const pal = new Array(256).fill([0, 0, 0]);
  pal[IDX_WATER_AREA] = hex2rgb('#A6C6E0');
  pal[IDX_WATER_LINE] = hex2rgb('#8FB6D8');
  pal[IDX_WETLAND] = hex2rgb('#BDD3C5');
  pal[IDX_TRAIL] = hex2rgb('#B5773C');
  pal[IDX_ROAD_MINOR] = hex2rgb('#C4AD82');
  pal[IDX_ROAD_MAJOR] = hex2rgb('#8F7A56');
  pal[IDX_ROAD_TRUNK] = hex2rgb('#F7F1E0');
  return pal;
}

/* ============================================================ 主渲染 */

/**
 * 渲染底图。返回 { layers: {terrain, network}, projection, labels, stats }
 * projection 供前端把经纬度映射到像素：x = (lon - originLon) / dLon，y = (originLat - lat) / dLat
 */
export function renderBasemap(dataDir, opts = {}) {
  const meta = JSON.parse(fs.readFileSync(path.join(dataDir, 'dem.json'), 'utf8'));
  const raw = fs.readFileSync(path.join(dataDir, 'dem.bin'));
  const elev = new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength >> 1);
  const W = meta.width, H = meta.height;

  // 输出与画布尺寸
  const OW = W * OUT_K, OH = H * OUT_K;          // 输出像素
  const CW = OW * SS, CH = OH * SS;              // 画布像素（超采样）
  const K = OUT_K * SS;                          // DEM → 画布倍率

  const midLat = meta.originLat - meta.cellLatDeg * H / 2;
  const dxM = meta.cellLonDeg * 111320 * Math.cos(midLat * Math.PI / 180);
  const dyM = meta.cellLatDeg * 110574;

  /* ---------- 1) 在 DEM 分辨率上算坡度光照（连续值，供上采样插值） ---------- */
  const zAt = (x, y) => elev[clamp(y, 0, H - 1) * W + clamp(x, 0, W - 1)];
  const hsField = new Float32Array(W * H);

  const zenith = Math.PI / 4;
  const cosZ = Math.cos(zenith), sinZ = Math.sin(zenith);
  const azimuth = 315 * Math.PI / 180;
  const zFactor = opts.zFactor ?? 1.9;

  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      const dzdx = (zAt(x + 1, y) - zAt(x - 1, y)) / (2 * dxM);
      const dzdy = (zAt(x, y - 1) - zAt(x, y + 1)) / (2 * dyM);   // 向北为正
      const slope = Math.atan(Math.hypot(dzdx, dzdy) * zFactor);
      let aspect = Math.atan2(dzdy, -dzdx);
      if (aspect < 0) aspect += Math.PI * 2;
      let hs = cosZ * Math.cos(slope) + sinZ * Math.sin(slope) * Math.cos(azimuth - aspect);
      hsField[row + x] = clamp((hs + 1) / 2, 0, 1);
    }
  }

  /* ---------- 2) 等高线（在 DEM 上做 marching squares，写到画布掩膜） ---------- */
  const mask = new Uint8Array(CW * CH);   // 0 无 / 1 细等高线 / 2 计曲线（每 5 条）
  const contourOpts = opts.contour ?? {};
  const cStep = contourOpts.step ?? 25;
  const cHeavy = contourOpts.heavyEvery ?? 4;   // 每 4 条 = 100m 计曲线

  // SRTM 在平原存在 ±1—2m 量化噪声，直接提线会满屏碎线 → 先做 3×3 均值平滑（仅用于等高线）
  const smooth = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let s = 0, n = 0;
      for (let oy = -1; oy <= 1; oy++) {
        const yy = clamp(y + oy, 0, H - 1);
        for (let ox = -1; ox <= 1; ox++) { s += zAt(x + ox, yy); n++; }
      }
      smooth[y * W + x] = s / n;
    }
  }

  const drawContourSeg = (x0, y0, x1, y1, v) => {
    let ax = Math.round(x0 * K), ay = Math.round(y0 * K);
    const bx = Math.round(x1 * K), by = Math.round(y1 * K);
    const dx = Math.abs(bx - ax), dy = -Math.abs(by - ay);
    const sx = ax < bx ? 1 : -1, sy = ay < by ? 1 : -1;
    let err = dx + dy;
    const half = v === 2 ? 1 : 0;
    for (let g = 0; g < dx - dy + 2; g++) {
      for (let oy = -half; oy <= half; oy++) {
        for (let ox = -half; ox <= half; ox++) {
          const px = ax + ox, py = ay + oy;
          if (px >= 0 && py >= 0 && px < CW && py < CH) {
            const i = py * CW + px;
            if (mask[i] < v) mask[i] = v;
          }
        }
      }
      if (ax === bx && ay === by) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; ax += sx; }
      if (e2 <= dx) { err += dx; ay += sy; }
    }
  };

  const interp = (v0, v1, lv) => (lv - v0) / (v1 - v0);
  let nContourCells = 0;
  for (let y = 0; y < H - 1; y++) {
    for (let x = 0; x < W - 1; x++) {
      const a = smooth[y * W + x], b = smooth[y * W + x + 1];
      const c = smooth[(y + 1) * W + x + 1], d = smooth[(y + 1) * W + x];
      const lo = Math.min(a, b, c, d), hi = Math.max(a, b, c, d);
      if (hi - lo < 1.5) continue;   // 平原噪声格不提线
      const first = Math.ceil(lo / cStep) * cStep;
      if (first > hi) continue;
      nContourCells++;
      for (let lv = first, n = 0; lv < hi; lv += cStep, n++) {
        const v = (Math.round(lv / cStep) % cHeavy === 0) ? 2 : 1;
        let idx = 0;
        if (a > lv) idx |= 8;
        if (b > lv) idx |= 4;
        if (c > lv) idx |= 2;
        if (d > lv) idx |= 1;
        if (idx === 0 || idx === 15) continue;
        // 四条边上的交点：top=(tx,y) right=(x+1,ry) bottom=(bx,y+1) left=(x,ly)
        const tx = x + interp(a, b, lv);
        const ry = y + interp(b, c, lv);
        const bx = x + interp(d, c, lv);
        const ly = y + interp(a, d, lv);
        switch (idx) {
          case 1: case 14: drawContourSeg(x, ly, bx, y + 1, v); break;
          case 2: case 13: drawContourSeg(x + 1, ry, bx, y + 1, v); break;
          case 3: case 12: drawContourSeg(x, ly, x + 1, ry, v); break;
          case 4: case 11: drawContourSeg(tx, y, x + 1, ry, v); break;
          case 6: case 9: drawContourSeg(tx, y, bx, y + 1, v); break;
          case 7: case 8: drawContourSeg(x, ly, tx, y, v); break;
          case 5: drawContourSeg(tx, y, x + 1, ry, v); drawContourSeg(x, ly, bx, y + 1, v); break;
          case 10: drawContourSeg(tx, y, x, ly, v); drawContourSeg(x + 1, ry, bx, y + 1, v); break;
          default: break;
        }
      }
    }
  }

  /* ---------- 3) 地形层：双线性上采样 (高程, 光照) → 分层设色 + 等高线压暗 ---------- */
  const terrainIdx = new Uint8Array(CW * CH);
  const eMin = ((t) => Number.isFinite(t) ? t : 0)(meta.stats?.min ?? 0);
  const eMax = ((t) => Number.isFinite(t) ? t : 450)(meta.stats?.max ?? 450);
  const bandSpan = Math.max(1, eMax - eMin);

  for (let cy = 0; cy < CH; cy++) {
    const fy = cy / K;
    const y0 = Math.floor(fy), ty = fy - y0;
    const y1 = Math.min(H - 1, y0 + 1);
    const ya = clamp(y0, 0, H - 1) * W;
    const yb = y1 * W;
    const rowC = cy * CW;
    for (let cx = 0; cx < CW; cx++) {
      const fx = cx / K;
      const x0 = Math.floor(fx), tx = fx - x0;
      const x1 = Math.min(W - 1, x0 + 1);
      const xa = clamp(x0, 0, W - 1);
      const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty), w01 = (1 - tx) * ty, w11 = tx * ty;

      const e = elev[ya + xa] * w00 + elev[ya + x1] * w10 + elev[yb + xa] * w01 + elev[yb + x1] * w11;
      const hs = hsField[ya + xa] * w00 + hsField[ya + x1] * w10 + hsField[yb + xa] * w01 + hsField[yb + x1] * w11;

      let band = Math.floor(((e - eMin) / bandSpan) * N_BAND);
      if (band < 0) band = 0; else if (band >= N_BAND) band = N_BAND - 1;
      const light = Math.round(Math.pow(hs, 0.8) * (N_LIGHT - 1));   // gamma 提亮中间调
      terrainIdx[rowC + cx] = band * N_LIGHT + light;
    }
  }

  /* ---------- 4) 网络层：水域 + 路网（超采样画布，最后降采样自带抗锯齿） ---------- */
  const netIdx = new Uint8Array(CW * CH);   // 0 = 透明；索引越大越优先（降采样取 max）
  const putNet = (x, y, v) => {
    const px = Math.round(x), py = Math.round(y);
    if (px < 0 || py < 0 || px >= CW || py >= CH) return;
    const i = py * CW + px;
    if (netIdx[i] < v) netIdx[i] = v;
  };

  // 带宽度（半径）的折线
  const strokeLine = (pts, v, radius) => {
    for (let i = 1; i < pts.length; i++) {
      const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
      if (!Number.isFinite(x0) || !Number.isFinite(y0) || !Number.isFinite(x1) || !Number.isFinite(y1)) continue;
      let ax = Math.round(x0), ay = Math.round(y0);
      const bx = Math.round(x1), by = Math.round(y1);
      const dx = Math.abs(bx - ax), dy = -Math.abs(by - ay);
      const sx = ax < bx ? 1 : -1, sy = ay < by ? 1 : -1;
      let err = dx + dy;
      const r = Math.max(0, Math.round(radius));
      for (let g = 0; g < dx - dy + 3; g++) {
        if (r === 0) putNet(ax, ay, v);
        else {
          for (let oy = -r; oy <= r; oy++) {
            for (let ox = -r; ox <= r; ox++) {
              if (ox * ox + oy * oy > r * r + r) continue;
              putNet(ax + ox, ay + oy, v);
            }
          }
        }
        if (ax === bx && ay === by) break;
        const e2 = 2 * err;
        if (e2 >= dy) { err += dy; ax += sx; }
        if (e2 <= dx) { err += dx; ay += sy; }
      }
    }
  };

  const toPx = (lon, lat) => [((lon - meta.originLon) / meta.cellLonDeg) * K, ((meta.originLat - lat) / meta.cellLatDeg) * K];
  const isClosed = (c) => c.length >= 4 &&
    Math.abs(c[0][0] - c[c.length - 1][0]) < 1e-9 && Math.abs(c[0][1] - c[c.length - 1][1]) < 1e-9;

  let osm = null, osmWarning = null;
  try { osm = JSON.parse(fs.readFileSync(path.join(dataDir, 'osm.json'), 'utf8')); }
  catch (e) { osmWarning = `OSM 底图数据不可用（${e.message}），仅渲染地形晕渲。`; }

  const fillPoly = (pts, v) => {
    let minY = Infinity, maxY = -Infinity;
    for (const p of pts) { if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1]; }
    const r0 = Math.max(0, Math.floor(minY)), r1 = Math.min(CH - 1, Math.ceil(maxY));
    for (let y = r0; y <= r1; y++) {
      const yy = y + 0.5, xs = [];
      for (let i = 1; i < pts.length; i++) {
        const A = pts[i - 1], B = pts[i];
        if ((A[1] <= yy && B[1] > yy) || (B[1] <= yy && A[1] > yy)) {
          xs.push(A[0] + (yy - A[1]) / (B[1] - A[1]) * (B[0] - A[0]));
        }
      }
      if (xs.length < 2) continue;
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const xa = Math.max(0, Math.round(xs[k])), xb = Math.min(CW - 1, Math.round(xs[k + 1]));
        for (let x = xa; x <= xb; x++) putNet(x, y, v);
      }
    }
  };

  let nArea = 0, nLine = 0, nPath = 0;
  if (osm) {
    // 1) 面状水域
    for (const w of osm.waters || []) {
      const c = w.coords;
      if (!c || !isClosed(c) || LINE_WATER.test(w.kind)) continue;
      fillPoly(c.map(([lon, lat]) => toPx(lon, lat)), w.kind === 'wetland' ? IDX_WETLAND : IDX_WATER_AREA);
      nArea++;
    }
    // 2) 线状水域（河道 / 运河 / 溪流，以及未闭合水面轮廓）
    for (const w of osm.waters || []) {
      const c = w.coords;
      if (!c || c.length < 2 || (isClosed(c) && !LINE_WATER.test(w.kind))) continue;
      const v = w.kind === 'wetland' ? IDX_WETLAND : IDX_WATER_LINE;
      strokeLine(c.map(([lon, lat]) => toPx(lon, lat)), v, K * 0.55);
      nLine++;
    }
    // 3) 路网：按等级分线宽，步道单独着色（游览场景下 footway / track 才是主角）
    for (const p of osm.paths || []) {
      const c = p.coords;
      if (!c || c.length < 2) continue;
      const isTrail = TRAIL_CLASSES.has(p.cls);
      const isMajor = MAJOR_CLASSES.has(p.cls);
      const v = isTrail ? IDX_TRAIL : isMajor ? IDX_ROAD_MAJOR : IDX_ROAD_MINOR;
      if (isTrail) strokeLine(c.map(([lon, lat]) => toPx(lon, lat)), v, K * 0.45);
      else {
        // 道路画两层：深色描边 → 浅色填心，读起来像地形图上的分级公路
        const px = c.map(([lon, lat]) => toPx(lon, lat));
        strokeLine(px, IDX_ROAD_MAJOR, K * (isMajor ? 1.05 : 0.85));
        strokeLine(px, IDX_ROAD_TRUNK, K * (isMajor ? 0.55 : 0.4));
      }
      nPath++;
    }
  }

  /* ---------- 5) 2×2 降采样到输出尺寸，并在输出分辨率上合成等高线 ---------- */
  const terrainOut = downsampleMode(terrainIdx, CW, CH, SS);
  const maskOut = downsampleMax(mask, CW, CH, SS);
  const netOut = downsampleMax(netIdx, CW, CH, SS);

  // 等高线 = 同色系压暗（细线 4 档 / 计曲线 7 档），天然融进地形设色里
  for (let i = 0; i < terrainOut.length; i++) {
    const m = maskOut[i];
    if (!m) continue;
    const v = terrainOut[i];
    const band = Math.floor(v / N_LIGHT);
    const light = v - band * N_LIGHT;
    terrainOut[i] = band * N_LIGHT + Math.max(0, light - (m === 2 ? 7 : 4));
  }

  const terrainPal = terrainPalette();
  const netPal = networkPalette();
  const netTrns = new Array(256).fill(255);
  netTrns[IDX_TRANSPARENT] = 0;

  const labels = osm ? buildLabels(dataDir, meta, osm) : [];

  return {
    layers: {
      terrain: { png: encodePalettePng(terrainOut, terrainPal, OW, OH), width: OW, height: OH },
      network: { png: encodePalettePng(netOut, netPal, OW, OH, netTrns), width: OW, height: OH },
    },
    projection: {
      originLon: meta.originLon, originLat: meta.originLat,
      dLon: meta.cellLonDeg / OUT_K, dLat: meta.cellLatDeg / OUT_K,
      width: OW, height: OH,
      cellMetersApprox: meta.cellMetersApprox / OUT_K,
    },
    labels,
    stats: {
      outWidth: OW, outHeight: OH, contourStep: cStep, bands: N_BAND, lightSteps: N_LIGHT,
      contourCells: nContourCells, waterAreas: nArea, waterLines: nLine, paths: nPath,
      labels: labels.length, osmWarning,
    },
  };
}

/* ============================================================ 注记数据 */

/** 从锚点 / 水系 / 路网提取可标注名称，按 zoom 分级显示 */
function buildLabels(dataDir, meta, osm) {
  const out = [];
  const inBox = (lon, lat) => lon > meta.bbox.minLon && lon < meta.bbox.maxLon && lat > meta.bbox.minLat && lat < meta.bbox.maxLat;

  // 1) 镇街：用锚点重心（镇名标在资源较密的中心更自然）
  try {
    const ds = JSON.parse(fs.readFileSync(path.join(dataDir, 'pois.json'), 'utf8'));
    const byTown = new Map();
    for (const p of ds.pois || []) {
      if (!p.town || p.town === '自定义起点') continue;
      const g = byTown.get(p.town) || { n: 0, lon: 0, lat: 0, e: 0 };
      g.n++; g.lon += p.lon; g.lat += p.lat; g.e += (p.nEntity || 0);
      byTown.set(p.town, g);
    }
    const ranked = [...byTown.entries()]
      .map(([town, g]) => ({ town, lon: g.lon / g.n, lat: g.lat / g.n, n: g.n, e: g.e }))
      .sort((a, b) => b.e - a.e);
    for (const t of ranked) {
      if (!inBox(t.lon, t.lat)) continue;
      out.push({ kind: 'town', text: t.town.replace(/[镇街道]$/, ''), lon: t.lon, lat: t.lat, rank: t.e, minZoom: 0 });
    }

    // 2) 重点资源锚点（单体多 / 等级加成高者）
    const anchors = (ds.pois || [])
      .map((p) => ({ p, score: (p.nEntity || 0) * 10 + (p.levelBonus || 0) * 20 + (p.nVirtual || 0) * 5 }))
      .sort((a, b) => b.score - a.score);
    const seen = new Set();
    for (const { p, score } of anchors) {
      if (score < 60 || !inBox(p.lon, p.lat)) continue;
      const key = p.name;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        kind: 'poi', text: p.name, lon: p.lon, lat: p.lat, rank: score,
        minZoom: score >= 220 ? 1.2 : 2.2,
      });
      if (out.length > 260) break;
    }
  } catch { /* 锚点数据缺失时只出自然要素名 */ }

  // 3) 水库 / 湖：取面状水域的坐标重心（点数越多面积越大，越值得标注）
  const named = new Map();
  for (const w of osm.waters || []) {
    if (!w.name || !w.coords || w.coords.length < 12) continue;
    const prev = named.get(w.name);
    if (prev && prev.len >= w.coords.length) continue;
    let lon = 0, lat = 0;
    for (const [x, y] of w.coords) { lon += x; lat += y; }
    lon /= w.coords.length; lat /= w.coords.length;
    named.set(w.name, { len: w.coords.length, lon, lat, kind: w.kind });
  }
  for (const [name, v] of [...named.entries()].sort((a, b) => b[1].len - a[1].len).slice(0, 40)) {
    if (!inBox(v.lon, v.lat)) continue;
    out.push({ kind: 'water', text: name, lon: v.lon, lat: v.lat, rank: v.len, minZoom: 1.4 });
  }

  // 4) 主要道路：取每条命名道路的中点
  const roads = (osm.paths || [])
    .filter((p) => p.name && MAJOR_CLASSES.has(p.cls) && p.coords && p.coords.length >= 4)
    .sort((a, b) => b.coords.length - a.coords.length);
  const seenRoad = new Set();
  for (const r of roads.slice(0, 40)) {
    if (seenRoad.has(r.name)) continue;
    seenRoad.add(r.name);
    const m = r.coords[Math.floor(r.coords.length / 2)];
    if (!inBox(m[0], m[1])) continue;
    out.push({ kind: 'road', text: r.name, lon: m[0], lat: m[1], rank: r.coords.length, minZoom: 2.6 });
  }

  return out;
}

/* ============================================================ 降采样 */

/** 2×2 取众数色（用于地形层；全不同时取最暗的，避免把陡坡压平） */
function downsampleMode(src, CW, CH, ss) {
  const OW = CW / ss, OH = CH / ss;
  const out = new Uint8Array(OW * OH);
  for (let y = 0; y < OH; y++) {
    const r0 = (y * ss) * CW;
    const r1 = (y * ss + 1) * CW;
    for (let x = 0; x < OW; x++) {
      const a = src[r0 + x * ss], b = src[r0 + x * ss + 1];
      const c = src[r1 + x * ss], d = src[r1 + x * ss + 1];
      out[y * OW + x] =
        a === b || a === c || a === d ? a :
        b === c || b === d ? b :
        c === d ? c : Math.min(a, b, c, d);
    }
  }
  return out;
}

/** 2×2 取最大索引（用于网络层：索引越大越优先，透明=0 自动让位） */
function downsampleMax(src, CW, CH, ss) {
  const OW = CW / ss, OH = CH / ss;
  const out = new Uint8Array(OW * OH);
  for (let y = 0; y < OH; y++) {
    for (let x = 0; x < OW; x++) {
      const i = (y * ss) * CW + x * ss;
      const a = src[i], b = src[i + 1], c = src[i + CW], d = src[i + CW + 1];
      out[y * OW + x] = Math.max(a, b, c, d);
    }
  }
  return out;
}

/* ============================================================ PNG 编码 */

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const tag = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([tag, data])) >>> 0, 0);
  return Buffer.concat([len, tag, data, crc]);
}

/**
 * 编码 8 位调色板索引 PNG（IHDR + PLTE [+ tRNS] + IDAT + IEND），filter 固定 0。
 * trns 为 256 项 alpha 数组时写入 tRNS，实现"背景透明"的叠加图层。
 */
export function encodePalettePng(index, palette, W, H, trns) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8;    // bitDepth
  ihdr[9] = 3;    // colorType: palette
  ihdr[10] = 0;   // compression
  ihdr[11] = 0;   // filter
  ihdr[12] = 0;   // interlace

  const plte = Buffer.alloc(256 * 3);
  for (let i = 0; i < 256; i++) {
    const c = palette[i] || [0, 0, 0];
    plte[i * 3] = c[0]; plte[i * 3 + 1] = c[1]; plte[i * 3 + 2] = c[2];
  }

  const raw = Buffer.alloc((W + 1) * H);
  const src = Buffer.from(index.buffer, index.byteOffset, W * H);
  for (let y = 0; y < H; y++) {
    raw[y * (W + 1)] = 0;
    src.copy(raw, y * (W + 1) + 1, y * W, y * W + W);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });

  const parts = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('PLTE', plte),
  ];
  if (trns) {
    // tRNS 可截断：尾部的 255 可省略，省体积
    let last = trns.length - 1;
    while (last >= 0 && trns[last] === 255) last--;
    if (last >= 0) parts.push(chunk('tRNS', Buffer.from(trns.slice(0, last + 1))));
  }
  parts.push(chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}
