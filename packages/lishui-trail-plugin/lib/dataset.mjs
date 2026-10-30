// dataset.mjs —— 离线数据集加载与检索（零依赖，数据随包分发或被 LISHUI_DATA_DIR 覆盖）
import fs from 'node:fs';
import path from 'node:path';
import { resolveDataDir } from './terrain.mjs';
import { haversine } from './geo.mjs';

export const DIM_LABEL = {
  landscape: '自然山水', water: '湖荡水利', farming: '田园农业', red: '红色记忆',
  village: '古村老街', religion: '宗教古迹', intangible: '非遗民俗',
  museum: '展馆文艺', resort: '休闲度假', food: '物产美食',
};

let CACHE = null;

export function loadDataset(opts = {}) {
  if (CACHE && !opts.force) return CACHE;
  const dir = opts.dataDir || resolveDataDir(opts.dir);
  const ds = JSON.parse(fs.readFileSync(path.join(dir, 'pois.json'), 'utf8'));
  const byId = new Map(ds.pois.map((p) => [p.id, p]));

  const api = {
    dir, meta: ds.meta, pois: ds.pois, byId,
    water: ds.water || [], immovable: ds.immovable || [], excluded: ds.excluded || [],
    rules: ds.rules || '',

    get(id) { return byId.get(id) || null; },

    /** 条件检索 */
    query({ dims = null, type = null, district = null, town = null, keyword = null,
            near = null, radiusM = null, minLevel = null, limit = 200 } = {}) {
      let out = ds.pois;
      if (dims && dims.length) out = out.filter((p) => dims.some((d) => (p.dims[d] || 0) > 0));
      if (type) out = out.filter((p) => p.type === type);
      if (district) out = out.filter((p) => p.district === district);
      if (town) out = out.filter((p) => p.town === town);
      if (minLevel != null) out = out.filter((p) => (p.levelBonus || 0) >= minLevel);
      if (keyword) {
        const k = String(keyword);
        out = out.filter((p) => p.name.includes(k) ||
          (p.entities || []).some((e) => e.name.includes(k) || (e.cat || '').includes(k)) ||
          (p.virtuals || []).some((v) => v.name.includes(k)));
      }
      if (near && radiusM != null) {
        out = out.map((p) => ({ p, d: haversine(near, p) }))
                 .filter((x) => x.d <= radiusM)
                 .sort((a, b) => a.d - b.d)
                 .map((x) => Object.assign({}, x.p, { _distM: Math.round(x.d) }));
      }
      return out.slice(0, limit);
    },

    nearest(lon, lat, { excludeId = null, maxM = null } = {}) {
      let best = null, bd = Infinity;
      for (const p of ds.pois) {
        if (excludeId && p.id === excludeId) continue;
        const d = haversine({ lon, lat }, p);
        if (d < bd) { bd = d; best = p; }
      }
      if (maxM != null && bd > maxM) return null;
      return { poi: best, distM: Math.round(bd) };
    },

    /** 数据溯源信息（供可复现性证据） */
    provenance() {
      return {
        dataset: ds.meta.name, source: ds.meta.source,
        sourceSha256: ds.meta.sourceSha256, crs: ds.meta.crs,
        counts: ds.meta.counts, bbox: ds.meta.bbox,
      };
    },
  };
  CACHE = api;
  return api;
}
