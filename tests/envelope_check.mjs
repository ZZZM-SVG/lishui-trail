// envelope_check.mjs —— 工具返回值必须通过 AGH 的 ToolResult 信封约束
//
// 这是回归测试：AGH Core（packages/core/src/effects/tool-dispatch.ts）用 isJsonValue() 校验
// 工作区工具返回的 ToolResult，undefined / NaN / Infinity / 类实例 / 环引用都会让整次调用被拒，
// 宿主回报 "E_ENVELOPE: invalid Host dispatch observation: workspace tool returned an invalid
// ToolResult"。本脚本复刻同一判据，对所有工具的多种入参逐一审计。
//
// 真实踩坑：使用自定义起点（startLon/startLat）时，合成起点缺 town → itinerary[0].town 为
// undefined → 每次带自定义起点的 lishui_trail_plan 调用都失败。
//
// 退出码 0 = 全部通过；1 = 存在违规（会打印具体路径）。

import { lishuiTrailPlugin } from '../packages/lishui-trail-plugin/index.mjs';

// ---------------------------------------------------------------- AGH 判据复刻
const TOOL_RESULT_KEYS = new Set(['content', 'isError', 'details', 'terminate', 'structured', 'deferred']);
const TOOL_TEXT_MAX_LENGTH = 1_048_576;
const MIME_MAX_LENGTH = 128;
const ARTIFACT_REF_KEYS = new Set(['sha256', 'size', 'mime']);

const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const hasOnlyKeys = (v, allowed) => Object.keys(v).every((k) => allowed.has(k));

function isArtifactRef(value) {
  if (!isRecord(value) || !hasOnlyKeys(value, ARTIFACT_REF_KEYS)) return false;
  return (
    typeof value.sha256 === 'string' && /^[0-9a-f]{64}$/.test(value.sha256) &&
    Number.isSafeInteger(value.size) && value.size >= 0 &&
    typeof value.mime === 'string' && value.mime.length <= MIME_MAX_LENGTH
  );
}

function isContentBlock(value) {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  switch (value.type) {
    case 'text':
      return (
        hasOnlyKeys(value, new Set(['type', 'text'])) &&
        typeof value.text === 'string' && value.text.length <= TOOL_TEXT_MAX_LENGTH
      );
    case 'image':
      return hasOnlyKeys(value, new Set(['type', 'ref', 'mime'])) && isArtifactRef(value.ref) &&
        typeof value.mime === 'string' && value.mime.length <= MIME_MAX_LENGTH;
    case 'ref':
      return hasOnlyKeys(value, new Set(['type', 'ref', 'mime'])) && isArtifactRef(value.ref) &&
        (value.mime === undefined || (typeof value.mime === 'string' && value.mime.length <= MIME_MAX_LENGTH));
    default:
      return false;
  }
}

function isJsonValue(value, path = '$', seen = new Set(), out = []) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return out;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) out.push(`${path}: 非有限数值（${value}）`);
    return out;
  }
  if (typeof value !== 'object') {
    out.push(`${path}: 非法类型 ${typeof value}（AGH 只接受 null/string/boolean/number/数组/纯对象）`);
    return out;
  }
  if (seen.has(value)) {
    out.push(`${path}: 环引用`);
    return out;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, i) => isJsonValue(item, `${path}[${i}]`, seen, out));
  } else if (Object.getPrototypeOf(value) !== Object.prototype) {
    out.push(`${path}: 原型为 ${Object.getPrototypeOf(value)?.constructor?.name ?? 'null'}，不是纯对象`);
  } else {
    for (const [k, v] of Object.entries(value)) isJsonValue(v, `${path}.${k}`, seen, out);
  }
  seen.delete(value);
  return out;
}

/** 返回违规列表；空数组 = 该 ToolResult 合法。 */
export function auditToolResult(result) {
  const out = [];
  if (!isRecord(result) || !hasOnlyKeys(result, TOOL_RESULT_KEYS) || !Array.isArray(result.content)) {
    out.push('$: ToolResult 顶层结构非法（需要 content 数组，且不得出现多余键）');
    return out;
  }
  if (!result.content.every(isContentBlock)) out.push('$.content: 存在非法内容块');
  if (result.isError !== undefined && typeof result.isError !== 'boolean') out.push('$.isError: 非布尔');
  if (result.terminate !== undefined && typeof result.terminate !== 'boolean') out.push('$.terminate: 非布尔');
  if (result.details !== undefined) isJsonValue(result.details, '$.details', new Set(), out);
  if (result.structured !== undefined) isJsonValue(result.structured, '$.structured', new Set(), out);
  return out;
}

// ---------------------------------------------------------------- 测试矩阵
const tools = new Map();
lishuiTrailPlugin.apply({ extension: () => ({ registerTool: (t) => tools.set(t.name, t), on: undefined }) });

const familyProfile = {
  persona: 'family', fitness: 'relaxed', durationMin: 180, date: '2026-10-10',
  startTime: '09:00', loop: true, visitDepth: 'balanced',
  party: { adults: 2, children: 1 }, interestText: '亲子轻松，想看古村与非遗',
};
const customStart = { ...familyProfile, startLon: 118.9127, startLat: 31.5033 };
const farStart = { ...familyProfile, startLon: 118.5, startLat: 32.2 };
const natureDeep = {
  persona: 'nature', fitness: 'strong', durationMin: 300, date: '2026-11-15',
  startTime: '08:00', loop: true, visitDepth: 'deep', party: { adults: 2 },
  interestText: '安静的山林游览，看山水和宗教古迹',
  startLon: 118.9127, startLat: 31.5033,
};
const tinyBudget = { ...familyProfile, durationMin: 60 };
const impossible = { ...familyProfile, durationMin: 720, fitness: 'relaxed', mustVisit: ['LS-01', 'LS-38'], party: { adults: 1, elderly: 2, children: 2 } };

const cases = [
  ['lishui_trail_status', {}],
  ['lishui_trail_query', {}],
  ['lishui_trail_query', { dims: ['village', 'intangible'] }],
  ['lishui_trail_query', { dims: ['village', 'intangible'], limit: 5 }],
  ['lishui_trail_query', { keyword: '水库' }],
  ['lishui_trail_query', { town: '洪蓝街道' }],
  ['lishui_trail_query', { nearLon: 118.9127, nearLat: 31.5033, radiusM: 3000 }],
  ['lishui_trail_query', { dims: ['nope'], limit: 1 }],
  ['lishui_trail_plan', {}],
  ['lishui_trail_plan', { format: 'brief' }],
  ['lishui_trail_plan', { format: 'full' }],
  ['lishui_trail_plan', familyProfile],
  ['lishui_trail_plan', customStart],              // ← 历史失败用例
  ['lishui_trail_plan', farStart],
  ['lishui_trail_plan', natureDeep],               // ← 历史失败用例
  ['lishui_trail_plan', tinyBudget],
  ['lishui_trail_plan', impossible],
  ['lishui_trail_risk', familyProfile],
  ['lishui_trail_risk', customStart],
  ['lishui_trail_risk', natureDeep],
  ['lishui_trail_alternatives', { poiId: 'LS-28' }],
  ['lishui_trail_alternatives', { poiId: 'LS-28', k: 5 }],
  ['lishui_trail_alternatives', { poiId: 'LS-01', k: 3 }],
  ['lishui_trail_alternatives', { poiId: 'NOPE-999' }],   // 不存在的点位
  ['lishui_trail_export', { ...natureDeep, format: 'gpx' }],
  ['lishui_trail_export', { ...natureDeep, format: 'csv' }],
  ['lishui_trail_export', { ...natureDeep, format: 'both' }],
  ['lishui_trail_export', { ...customStart, format: 'both' }],
  ['lishui_trail_export', { ...impossible, format: 'gpx' }],
];

let failed = 0;
for (const [name, args] of cases) {
  const tool = tools.get(name);
  if (!tool) {
    console.log(`✗ ${name}: 未注册`);
    failed += 1;
    continue;
  }
  let result;
  try {
    result = await tool.execute(args);
  } catch (error) {
    console.log(`✗ ${name} ${JSON.stringify(args).slice(0, 60)}: execute 抛错 —— ${error.message}`);
    failed += 1;
    continue;
  }
  const violations = auditToolResult(result);
  const label = `${name} ${JSON.stringify(args).slice(0, 72)}`;
  if (violations.length === 0) {
    console.log(`✓ ${label}`);
  } else {
    failed += 1;
    console.log(`✗ ${label}`);
    for (const v of violations.slice(0, 8)) console.log(`      ${v}`);
  }
}

console.log(`\n共 ${cases.length} 例，失败 ${failed} 例`);
process.exit(failed === 0 ? 0 : 1);
