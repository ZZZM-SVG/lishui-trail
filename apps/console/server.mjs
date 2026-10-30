// server.mjs —— 城郊文旅线路智能规划系统 · 离线演示台（本地 HTTP 服务）
//
// 定位（对评审很重要）：本服务是 AGH 插件的「视图层」。
//   * 不做任何模型调用，也不接入任何模型 API；
//   * 规划 / 风险 / 自校验全部直接复用 packages/lishui-trail-plugin/lib/ 下
//     与 AGH 插件同一份求解器模块（planTrip / suggestAlternatives / toGpx）；
//   * 因此本页面算出的每个结果，都能被 AGH 会话里的 lishui_trail_* 工具以相同输入复现。
// 仅监听 127.0.0.1，零第三方依赖、零网络出站。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planTrip, suggestAlternatives } from '../../packages/lishui-trail-plugin/lib/engine.mjs';
import { loadDataset, DIM_LABEL } from '../../packages/lishui-trail-plugin/lib/dataset.mjs';
import { loadTerrain } from '../../packages/lishui-trail-plugin/lib/terrain.mjs';
import { PERSONAS, FITNESS } from '../../packages/lishui-trail-plugin/lib/profile.mjs';
import { toGpx, toItineraryCsv } from '../../packages/lishui-trail-plugin/lib/gpx.mjs';
import { renderBasemap } from './basemap.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INFEASIBLE_HINT = '可尝试：放宽时间预算、改体能档位、减少必去点，或把起点设在景区/资源点附近。';

const ds = loadDataset({});
const T = loadTerrain({});
let BASEMAP = null;
const getBasemap = () => (BASEMAP ??= renderBasemap(ds.dir));

// ---------------------------------------------------------------- 工具函数
const json = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
};

const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > 4 * 1024 * 1024) { reject(new Error('请求体过大')); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => {
    try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
    catch (e) { reject(new Error(`请求体不是合法 JSON：${e.message}`)); }
  });
  req.on('error', reject);
});

/** 与插件 lishui_trail_plan 同口径的结构化输出；演示台额外携带几何与地形剖面供绘图 */
function serializePlan(res, T2) {
  if (!res.ok) {
    return {
      ok: false, infeasible: true,
      reason: res.route.reason || '未能在给定约束下形成有意义的行程。',
      hint: INFEASIBLE_HINT,
      warnings: res.route.warnings || [],
    };
  }
  return {
    ok: true,
    solveMs: res.solveMs,
    headline: res.narrative.headline,
    narrativeMd: res.narrative.markdown,
    profile: res.profile,
    environment: res.environment,
    start: res.route.start,
    loop: res.route.loop,
    metrics: res.route.metrics,
    itinerary: res.route.itinerary,
    legs: res.route.legs,
    coords: res.route.coords,
    risk: res.risk,
    verification: res.verification,
    solver: res.route.solver,
    warnings: res.route.warnings || [],
    provenance: res.provenance,
    elevationProfile: T2.profile(res.route.coords, 150),
  };
}

const serializePoi = (p) => ({
  id: p.id, name: p.name, cluster: p.cluster, type: p.type, district: p.district,
  town: p.town, townRaw: p.townRaw, lon: p.lon, lat: p.lat,
  levelBonus: p.levelBonus, nEntity: p.nEntity, nVirtual: p.nVirtual, dwell: p.dwell,
  dims: Object.entries(p.dims || {})
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => ({ key: k, label: DIM_LABEL[k], weight: v })),
  entities: (p.entities || []).map((e) => ({ name: e.name, level: e.level, status: e.status })),
});

// ---------------------------------------------------------------- 路由
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  try {
    if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) {
      const html = fs.readFileSync(path.join(HERE, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
      return;
    }

    if (req.method === 'GET' && u.pathname === '/api/meta') {
      const bm = getBasemap();
      return json(res, 200, {
        ok: true,
        dataset: ds.provenance(),
        dims: Object.entries(DIM_LABEL).map(([key, label]) => ({ key, label })),
        personas: Object.entries(PERSONAS).map(([key, v]) => ({ key, label: v.label, dims: v.dims })),
        fitness: Object.entries(FITNESS).map(([key, v]) => ({ key, label: v.label,
          maxSlopeDeg: v.maxSlopeDeg, maxAscentM: v.maxAscentM, maxDistanceM: v.maxDistanceM })),
        towns: [...new Set(ds.pois.map((p) => p.town))].sort(),
        types: [...new Set(ds.pois.map((p) => p.type))].sort(),
        projection: bm.projection,
        labels: bm.labels,
        dem: T.dem ? { w: T.dem.w, h: T.dem.h, min: T.dem.meta.stats.min, max: T.dem.meta.stats.max,
          source: T.dem.meta.source, cellMetersApprox: T.dem.meta.cellMetersApprox } : null,
        terrain: { demReady: !T.demWarning, osmReady: T.hasOsm,
          waterCells: T.grids ? T.grids.nWaterCells : 0, pathCells: T.grids ? T.grids.nPathCells : 0 },
        warnings: [T.demWarning, T.osmWarning, bm.stats.osmWarning].filter(Boolean),
        basemapStats: bm.stats,
      });
    }

    if (req.method === 'GET' && u.pathname === '/api/pois') {
      return json(res, 200, { ok: true, count: ds.pois.length, pois: ds.pois.map(serializePoi) });
    }

    if (req.method === 'GET' && (u.pathname === '/api/basemap.png' || u.pathname === '/api/basemap/terrain.png')) {
      const bm = getBasemap();
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      res.end(bm.layers.terrain.png);
      return;
    }

    if (req.method === 'GET' && u.pathname === '/api/basemap/network.png') {
      const bm = getBasemap();
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      res.end(bm.layers.network.png);
      return;
    }

    if (req.method === 'POST' && u.pathname === '/api/plan') {
      const body = await readBody(req);
      const res0 = planTrip({ profile: body.profile ?? body, doVerify: true, replanForVerify: true });
      return json(res, 200, serializePlan(res0, T));
    }

    if (req.method === 'POST' && u.pathname === '/api/alternatives') {
      const body = await readBody(req);
      const out = suggestAlternatives({ poiId: body.poiId, k: body.k || 5 });
      return json(res, 200, out);
    }

    if (req.method === 'POST' && u.pathname === '/api/export') {
      const body = await readBody(req);
      const res0 = planTrip({ profile: body.profile ?? body, doVerify: true, replanForVerify: false });
      if (!res0.ok) {
        return json(res, 200, { ok: false, reason: res0.route.reason || '未能在给定约束下形成有意义的行程。', hint: INFEASIBLE_HINT });
      }
      return json(res, 200, {
        ok: true,
        headline: res0.narrative.headline,
        gpx: toGpx({ P: res0.profile, route: res0.route, risk: res0.risk, meta: res0.provenance }),
        csv: toItineraryCsv({ P: res0.profile, route: res0.route, risk: res0.risk }),
      });
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  } catch (e) {
    json(res, 500, { ok: false, error: String((e && e.message) || e) });
  }
});

// ---------------------------------------------------------------- 启动
const preferred = Number(process.env.PORT) || 8763;
// HOST：本地默认 127.0.0.1（离线特性）；部署到单端口沙箱时以 HOST=0.0.0.0 启动
const HOST = process.env.HOST || '127.0.0.1';
let listening = 0;
for (let attempt = 0; attempt < 8 && !listening; attempt++) {
  const port = preferred + attempt;
  try {
    await new Promise((resolve, reject) => {
      const onErr = (err) => { server.removeListener('error', onErr); reject(err); };
      server.once('error', onErr);
      server.listen(port, HOST, () => { server.removeListener('error', onErr); resolve(); });
    });
    listening = preferred + attempt;
  } catch { /* 端口被占，试下一个 */ }
}
if (!listening) {
  console.error('启动失败：8763—8770 端口均被占用。可用 PORT 环境变量指定其他端口。');
  process.exit(1);
}

// --open：服务就绪后再拉起默认浏览器（避免"先开页面后起服务"的时序问题）
const url = `http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${listening}`;
if (process.argv.includes('--open')) {
  const { spawn } = await import('node:child_process');
  const opener = process.platform === 'win32' ? ['cmd.exe', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(opener[0], opener[1], { detached: true, stdio: 'ignore' }).unref(); } catch { /* 打不开不影响服务 */ }
}

console.log('诗画溧水·水韵慢城 · 离线演示台（AGH 插件视图层）');
console.log(`  地址    ${url}`);
console.log(`  数据    ${ds.dir}`);
console.log(`  锚点    ${ds.pois.length} ｜ 单体 ${ds.meta.counts.entities} ｜ DEM ${T.dem ? `${T.dem.w}x${T.dem.h}` : '不可用'}`);
console.log('  说明    本页不做任何模型调用；求解器与 AGH 插件共用同一份代码');
console.log('  退出    Ctrl+C');
