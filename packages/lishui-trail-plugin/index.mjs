// index.mjs —— 诗画溧水·水韵慢城——城郊文旅线路智能规划系统（AGH 后端工具插件）
//
// 设计约束（对应赛事要求）：
//   * 只通过 AGH 的扩展 API（ctx.extension().registerTool）暴露能力，不自行起服务、不绕过 Host；
//   * 全程离线：数据来自随包分发的 LuShui 数据集与 DEM，路径计算在本机完成；
//   * 零外部依赖、零外部模型：不 import 任何第三方包，不发起任何网络请求；
//   * 纯只读分析：需要写文件时，交由 AGH 自身的文件工具完成（本插件只回传内容）。
//
// 工具参数使用带 TypeBox kind 标记的 Schema；手写 Symbol.for('TypeBox.Kind') 以保持零 import。
import { planTrip, suggestAlternatives } from './lib/engine.mjs';
import { loadDataset } from './lib/dataset.mjs';
import { loadTerrain } from './lib/terrain.mjs';
import { toGpx, toItineraryCsv } from './lib/gpx.mjs';
import { assessRisk } from './lib/risk.mjs';
import { verifyRoute } from './lib/verify.mjs';
import { normalizeProfile } from './lib/profile.mjs';
import { DIM_LABEL } from './lib/dataset.mjs';
// 统一出口：保证返回值严格满足 AGH 的 ToolResult 信封（不得出现 undefined / 非有限数值）。
import { reply } from './lib/envelope.mjs';

// ------------------------------------------------------------------ TypeBox 片段
const Kind = Symbol.for('TypeBox.Kind');
const obj = (properties, required = [], extra = {}) =>
  ({ [Kind]: 'Object', type: 'object', properties, required, additionalProperties: false, ...extra });
const str = (extra) => ({ [Kind]: 'String', type: 'string', ...extra });
const num = (extra) => ({ [Kind]: 'Number', type: 'number', ...extra });
const int = (extra) => ({ [Kind]: 'Integer', type: 'integer', ...extra });
const bool = (extra) => ({ [Kind]: 'Boolean', type: 'boolean', ...extra });
const arr = (items, extra) => ({ [Kind]: 'Array', type: 'array', items, ...extra });

/** 只读分析类工具的统一元数据：不写文件、不联网、无副作用、可安全重放、无需审批 */
const READ_ONLY_META = Object.freeze({
  isReadOnly: true,
  isDestructive: false,
  isConcurrencySafe: true,
  isOpenWorld: false,
  replay: 'safe',
  costHint: undefined,
  deferLoading: false,
  requiresApproval: 'never',
});

/** 通用画像参数（多个工具复用，此处以闭包工厂生成，避免 Schema 被复用时的原型污染） */
const profileProps = () => ({
  persona: str({ description: '人群预设：family 亲子 / photo 摄影 / history 历史人文 / nature 自然观光 / slow 慢城休闲 / culture 非遗民俗' }),
  interestText: str({ description: '自然语言兴趣描述，例如“想看古村老街，顺便体验非遗和采摘”' }),
  interests: obj({
    landscape: num({ description: '0—1' }), water: num(), farming: num(), red: num(),
    village: num(), religion: num(), intangible: num(), museum: num(), resort: num(), food: num(),
  }, [], { additionalProperties: true, description: '按维度直接给权重（0—1）' }),
  fitness: str({ description: '体能：relaxed 休闲 / normal 常规 / strong 强健（或 休闲/常规/强健）' }),
  durationMin: int({ description: '可用时间预算（分钟），60—720' }),
  date: str({ description: '出行日期 YYYY-MM-DD，用于季节与日落计算' }),
  startTime: str({ description: '出发时刻 HH:MM，默认 08:30' }),
  visitDepth: str({ description: '游览节奏：deep 深度游览 / balanced 深度与广度均衡 / wide 广撒网打卡' }),
  loop: bool({ description: '是否环线返回起点，默认 true' }),
  party: obj({ adults: int(), elderly: int(), children: int() }, [], { additionalProperties: true, description: '同行人员，含老人/儿童会收紧坡度与爬升约束' }),
  mustVisit: arr(str(), { description: '必去点位 ID 列表（如 LS-28）' }),
  avoid: arr(str(), { description: '避开的点位 ID 列表' }),
  startLon: num({ description: '自定义起点经度（CGCS2000/WGS84 近似）' }),
  startLat: num({ description: '自定义起点纬度' }),
  seed: int({ description: '随机种子，相同种子+相同输入结果完全可复现' }),
});
const profileRequired = [];

const buildProfile = (a) => {
  const p = {};
  for (const k of ['persona', 'interestText', 'interests', 'fitness', 'durationMin', 'date',
    'startTime', 'visitDepth', 'loop', 'party', 'mustVisit', 'avoid', 'seed']) {
    if (a[k] !== undefined) p[k] = a[k];
  }
  if (a.startLon !== undefined && a.startLat !== undefined) p.start = { lon: a.startLon, lat: a.startLat };
  return p;
};

// ------------------------------------------------------------------ 输出裁剪
const trimLegs = (legs) => (legs || []).map((l) => ({
  from: l.fromName, to: l.toName, distanceM: l.distanceM, ascentM: l.ascentM,
  descentM: l.descentM, maxSlopeDeg: l.maxSlopeDeg, walkMinutes: l.walkMinutes,
  unreachable: !!l.unreachable,
}));

const trimPlan = (res) => ({
  ok: res.ok,
  // 不可行时给出明确原因（结构化字段，便于 Agent 据此改参重试，而不是只能读文本）
  reason: res.ok ? null : (res.route.reason || '未能在给定约束下形成有意义的行程。'),
  hint: res.ok ? null : '可尝试：放宽时间预算、改体能档位、减少必去点，或把起点设在景区/资源点附近。',
  headline: res.narrative ? res.narrative.headline : null,
  environment: res.environment,
  start: res.route.start,
  loop: res.route.loop,
  metrics: res.route.metrics,
  itinerary: res.route.itinerary,
  legs: trimLegs(res.route.legs),
  risk: res.risk,
  verification: res.verification
    ? { summary: res.verification.summary, pass: res.verification.checks.filter((c) => c.status === 'pass').length,
        warn: res.verification.checks.filter((c) => c.status === 'warn').length,
        fail: res.verification.checks.filter((c) => c.status === 'fail').length,
        checks: res.verification.checks }
    : null,
  solver: res.route.solver,
  warnings: res.route.warnings,
  provenance: res.provenance,
});

/** brief 版文本：控制上下文占用；full 版直接给出引擎生成的完整中文说明 */
const briefText = (res) => {
  const M = res.route.metrics, R = res.risk;
  const out = [];
  out.push(`方案：${res.narrative.headline}`);
  out.push(`起点 ${res.route.start.name}｜${res.route.loop ? '环线' : '单程'}｜${M.stopCount} 站`);
  out.push(`游览节奏：${M.depthPreferenceLabel}（深度 ${M.depthStops} 站 / 打卡 ${M.quickStops} 站）`);
  out.push(`里程 ${(M.totalDistanceM / 1000).toFixed(1)} km｜爬升 ${M.totalAscentM} m｜用时 ${M.totalMin}/${M.budgetMin} 分钟（${M.budgetUsedPct}%）`);
  out.push('行程：');
  for (let i = 0; i < res.route.itinerary.length; i++) {
    const s = res.route.itinerary[i];
    const tag = i === 0 ? '起点' : `第${i}站`;
    out.push(`  ${String(s.arriveMin).padStart(3)}–${String(s.departMin).padStart(3)}min ${tag} ${s.name}（${s.type}·${s.town}）${s.modeLabel} 停留${s.dwellMin}min 高程${s.elevationM}m`);
  }
  if (R) {
    out.push(`风险 ${R.score}/100（${R.level}）：${R.advice}`);
    out.push(`  主因：${R.factors.slice(0, 3).map((f) => `${f.label}(贡献${f.contribution})`).join('、')}`);
    out.push(`  缓解：${R.mitigations[0] || '—'}`);
  }
  if (res.verification) out.push(`自校验：${res.verification.summary}`);
  return out.join('\n');
};

// ------------------------------------------------------------------ 插件
export const lishuiTrailPlugin = {
  inject: ['extension'],
  apply(ctx) {
    const agnes = ctx.extension();

    // ---------------- 1) 系统与数据状态 ----------------
    agnes.registerTool({
      name: 'lishui_trail_status',
      description: '查询城郊文旅线路智能规划系统的离线数据与地形能力状态：数据集规模与来源、DEM 分辨率与质量、路网/水域栅格、可用的兴趣维度与人群预设。用于确认本地数据是否就绪（不联网）。',
      parameters: obj({}),
      meta: READ_ONLY_META,
      async execute() {
        const ds = loadDataset();
        const T = loadTerrain();
        const structured = {
          ok: true,
          dataset: ds.provenance(),
          dimensions: Object.entries(DIM_LABEL).map(([k, v]) => ({ key: k, label: v })),
          personas: ['family 亲子家庭', 'photo 摄影打卡', 'history 历史人文', 'nature 自然观光', 'slow 慢城休闲', 'culture 非遗民俗'],
          terrain: {
            dem: !T.demWarning,
            demGrid: T.dem ? `${T.dem.w}×${T.dem.h} @ ${T.metrics.dx.toFixed(0)}m` : null,
            demSource: T.dem ? T.dem.meta.source : null,
            demWarning: T.demWarning,
            osmRouted: T.hasOsm,
            osmWarning: T.osmWarning,
            waterCells: T.grids ? T.grids.nWaterCells : 0,
            pathCells: T.grids ? T.grids.nPathCells : 0,
          },
        };
        const C = structured.dataset.counts || {};
        const lines = [
          `数据集：${structured.dataset.dataset}`,
          `规模：锚点 ${C.anchors}（资源簇 ${C.clusters} + 离散点 ${C.discrete}）｜资源单体 ${C.entities}｜虚拟对象 ${C.virtuals}｜不可移动 ${C.immovable}｜已剔除 ${C.excluded}｜水域要素 ${C.waterFeatures}`,
          `CRS：${structured.dataset.crs}｜原始表格 SHA256：${String(structured.dataset.sourceSha256).slice(0, 16)}…`,
          `范围：经度 ${structured.dataset.bbox.minLon}—${structured.dataset.bbox.maxLon}，纬度 ${structured.dataset.bbox.minLat}—${structured.dataset.bbox.maxLat}`,
          `DEM：${structured.terrain.demGrid || '不可用'}${structured.terrain.demSource ? `（${structured.terrain.demSource}）` : ''}`,
          `路网：${structured.terrain.osmRouted ? `已加载（${structured.terrain.pathCells} 格）` : '未加载（降级为直线距离偏置）'}`,
          `水域禁行栅格：${structured.terrain.waterCells} 格`,
          `兴趣维度：${structured.dimensions.map((d) => d.label).join('、')}`,
        ];
        return reply(lines.join('\n'), structured);
      },
    });

    // ---------------- 2) 文旅资源检索 ----------------
    agnes.registerTool({
      name: 'lishui_trail_query',
      description: '在溧水文旅资源数据集中按兴趣维度、类型、街镇、关键词或空间范围检索资源单体，返回名称、分级、包含的实体数量与坐标。可先检索再据此设置必去点。',
      parameters: obj({
        dims: arr(str({ description: `兴趣维度 key：${Object.keys(DIM_LABEL).join('/')}` })),
        type: str({ description: '类型，如 景区 / 产业园区 / 旅游村 / 离散点' }),
        town: str({ description: '街镇名称，如 洪蓝街道' }),
        keyword: str({ description: '名称关键词' }),
        nearLon: num({ description: '中心点经度' }),
        nearLat: num({ description: '中心点纬度' }),
        radiusM: num({ description: '搜索半径（米），配合 nearLon/nearLat 使用' }),
        limit: int({ description: '返回条数上限，默认 20' }),
      }),
      meta: READ_ONLY_META,
      async execute(a) {
        const ds = loadDataset();
        const near = (a.nearLon !== undefined && a.nearLat !== undefined) ? { lon: a.nearLon, lat: a.nearLat } : null;
        const rows = ds.query({
          dims: a.dims || null, type: a.type || null, town: a.town || null,
          keyword: a.keyword || null, near, radiusM: a.radiusM ?? null, limit: a.limit || 20,
        });
        const structured = {
          ok: true, count: rows.length,
          items: rows.map((p) => ({
            id: p.id, name: p.name, type: p.type, town: p.town,
            lon: p.lon, lat: p.lat, levelBonus: p.levelBonus,
            nEntity: p.nEntity, nVirtual: p.nVirtual,
            dims: Object.keys(p.dims || {}).map((d) => DIM_LABEL[d]),
            distM: p._distM ?? null,
          })),
        };
        const text = structured.items.length
          ? structured.items.map((x) => `${x.id} ${x.name}（${x.type}·${x.town}）分级${x.levelBonus}｜${x.dims.join('/')}${x.distM != null ? `｜${x.distM}m` : ''}`).join('\n')
          : '未匹配到资源点。';
        return reply(text, structured);
      },
    });

    // ---------------- 3) 路线规划（核心） ----------------
    agnes.registerTool({
      name: 'lishui_trail_plan',
      description: '【核心】为溧水生成个性化城郊文旅线路方案，并同时给出风险预判与结果自校验。输入出行画像（兴趣、体能、时长、游览节奏、必去/避开点等），返回时间轴行程、里程/爬升/坡度指标、加权风险评分与缓解建议、以及独立的 12 项自校验结论。全程离线、确定性可复现。',
      parameters: obj({
        ...profileProps(),
        format: str({ description: "输出详略：brief 精简（默认）或 full 完整中文说明" }),
      }),
      meta: READ_ONLY_META,
      async execute(a) {
        // replanForVerify：同一输入同一种子再解一次，比对几何哈希，把"可复现性"变成每次调用都执行的
        // 第 12 项自校验（确定性求解的代价是解一次约 1.2 s，翻倍仍在秒级）。
        const res = planTrip({ profile: buildProfile(a), doVerify: true, replanForVerify: true });
        const structured = trimPlan(res);
        const text = !res.ok
          ? `不可行：${res.route.reason || '未能在给定约束下形成有意义的行程。'}（建议放宽预算/体能档位，或把起点设在资源点附近）`
          : (a.format === 'full' ? res.narrative.markdown : briefText(res));
        return reply(text, structured);
      },
    });

    // ---------------- 4) 风险预判（独立入口） ----------------
    agnes.registerTool({
      name: 'lishui_trail_risk',
      description: '对给定出行画像下的方案做风险预判：返回 7 因子加权评分（地形坡度、气象季节、日照时段、涉水湿地、偏远程度、通行可达、体能匹配）、关键证据（最大坡度、陡坡占比、最近水域、离步道最远距离、日落余量）与分级缓解建议。若只想评估风险而不需要完整行程解读，用这个工具。',
      parameters: obj({ ...profileProps() }),
      meta: READ_ONLY_META,
      async execute(a) {
        const res = planTrip({ profile: buildProfile(a), doVerify: false });
        if (!res.ok) {
          return reply(`不可行：${res.route.reason || '未能在给定约束下形成有意义的行程。'}`, {
            ok: false,
            reason: res.route.reason || '未能在给定约束下形成有意义的行程。',
            hint: '可尝试：放宽时间预算、改体能档位、减少必去点，或把起点设在景区/资源点附近。',
          });
        }
        const R = res.risk;
        const structured = {
          ok: true,
          risk: R,
          stops: res.route.itinerary.map((s) => ({ id: s.poiId, name: s.name, mode: s.modeLabel })),
          metrics: { totalDistanceM: res.route.metrics.totalDistanceM, totalAscentM: res.route.metrics.totalAscentM, totalMin: res.route.metrics.totalMin },
        };
        const lines = [
          `综合风险 ${R.score}/100 → ${R.level}`,
          `结论：${R.advice}`,
          '因子贡献（降序）：',
          ...R.factors.map((f) => `  ${f.label}：因子值 ${f.value}｜权重 ${f.weight}｜贡献 ${f.contribution}`),
          `关键证据：最大坡度 ${R.evidence.maxSlopeDeg}°、陡坡占比 ${(R.evidence.steepRatio * 100).toFixed(1)}%、距水域最近 ${R.evidence.minWaterDistanceM} m、离步道最远 ${R.evidence.maxDistanceToTrailM} m、预计 ${R.evidence.finishTime} 结束（日落 ${R.evidence.sunsetTime}，余量 ${R.evidence.daylightMarginMin} 分钟）`,
          '缓解建议：',
          ...R.mitigations.map((m) => `  - ${m}`),
        ];
        return reply(lines.join('\n'), structured);
      },
    });

    // ---------------- 5) 异常处置：替代点建议 ----------------
    agnes.registerTool({
      name: 'lishui_trail_alternatives',
      description: '异常处置：当某个停靠点因封闭、天气或人流不可用时，按兴趣维度相似度与距离给出可替代的同类资源点，便于快速改线。',
      parameters: obj({
        poiId: str({ description: '需要被替代的点位 ID，如 LS-31' }),
        k: int({ description: '返回候选个数，默认 3' }),
      }, ['poiId']),
      meta: READ_ONLY_META,
      async execute({ poiId, k }) {
        const out = suggestAlternatives({ poiId, k: k || 3 });
        if (!out.ok) return reply(out.error, out);
        const text = [
          `基准点：${out.base.name}（${out.base.dims.join('、')}）`,
          '替代候选：',
          ...out.alternatives.map((x) => `  ${x.id} ${x.name}（${x.type}·${x.town}）相似度 ${x.similarity}｜直线 ${x.distM} m`),
        ].join('\n');
        return reply(text, out);
      },
    });

    // ---------------- 6) 导出内容（交由 AGH 的文件工具落盘） ----------------
    agnes.registerTool({
      name: 'lishui_trail_export',
      description: '按给定画像生成方案并导出为标准 GPS 交换内容：GPX 轨迹（可直接导入两步路/Strava/Garmin）与行程 CSV。本工具只回传文本内容，不写盘；需要保存时由 Agent 使用 AGH 的文件写入能力落地为 .gpx / .csv。',
      parameters: obj({
        ...profileProps(),
        format: str({ description: "导出内容：gpx / csv / both（默认 gpx）" }),
      }),
      meta: READ_ONLY_META,
      async execute(a) {
        const res = planTrip({ profile: buildProfile(a), doVerify: true, replanForVerify: true });
        if (!res.ok) {
          return reply(`不可行：${res.route.reason || '未能在给定约束下形成有意义的行程。'}`, {
            ok: false,
            reason: res.route.reason || '未能在给定约束下形成有意义的行程。',
            hint: '可尝试：放宽时间预算、改体能档位、减少必去点，或把起点设在景区/资源点附近。',
          });
        }
        const want = a.format || 'gpx';
        const structured = {
          ok: true,
          headline: res.narrative.headline,
          gpx: (want === 'gpx' || want === 'both') ? toGpx({ P: res.profile, route: res.route, risk: res.risk, meta: res.provenance }) : null,
          csv: (want === 'csv' || want === 'both') ? toItineraryCsv({ P: res.profile, route: res.route, risk: res.risk }) : null,
        };
        const parts = [];
        if (structured.gpx) parts.push('=== GPX（建议保存为 lishui-trail.gpx）===\n' + structured.gpx);
        if (structured.csv) parts.push('=== CSV（建议保存为 lishui-trail.csv）===\n' + structured.csv);
        return reply(parts.join('\n\n'), structured);
      },
    });

    if (agnes.on) {
      try {
        agnes.on('session_start', () => {
          agnes.ctx?.log?.info?.('lishui_trail 插件已就绪：status / query / plan / risk / alternatives / export');
        });
      } catch { /* 观察型 hook 不可用时静默降级，不影响工具注册 */ }
    }
  },
};

export default lishuiTrailPlugin;
