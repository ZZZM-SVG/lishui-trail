// envelope.mjs —— 让工具返回值严格满足 AGH 的 ToolResult 信封约束
//
// 背景（实测）：AGH Core 在 effects/tool-dispatch.ts 里用 isJsonValue() 校验工作区工具返回的
// ToolResult。该判据要求：
//   * 数字必须有限（Number.isFinite），NaN / Infinity 一律判非法；
//   * 对象必须是"纯对象"（Object.getPrototypeOf(v) === Object.prototype），类实例判非法；
//   * 不能出现环引用；
//   * 除 null / string / boolean / number / 数组 / 纯对象之外的类型（含 undefined）一律判非法。
//
// 只要 structured 里任何一个叶子是 undefined，整个 ToolResult 都会被拒，宿主回报
//   E_ENVELOPE: invalid Host dispatch observation: workspace tool returned an invalid ToolResult
// 模型侧表现为"工具调用失败"，而不是"某字段缺失"。真实踩坑案例：自定义起点生成的合成起点对象
// 缺 town 字段，导致 itinerary[0].town === undefined。
//
// 因此所有工具出口统一经过 toJsonValue()：丢弃 undefined 属性、把非有限数值降级为 null、
// 把非纯对象摊平成纯对象，并在遇到环时截断。这样"缺字段"最多是信息缺失，绝不会变成信封非法。

/** 把任意 JS 值归一化成严格合法的 JSON 值；undefined 属性被丢弃，数组空洞补 null。 */
export function toJsonValue(value, seen = new Set()) {
  if (value === null) return null;
  const t = typeof value;
  if (t === 'string' || t === 'boolean') return value;
  if (t === 'number') return Number.isFinite(value) ? value : null;
  // undefined / function / symbol / bigint：JSON 无法表达，统一降级为 null（对象属性则由上层丢弃）
  if (t !== 'object') return null;
  if (seen.has(value)) return null; // 环引用：截断而不是抛错
  seen.add(value);
  let out;
  if (Array.isArray(value)) {
    out = value.map((item) => (item === undefined ? null : toJsonValue(item, seen)));
  } else {
    out = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue; // 关键：丢字段，而不是留一个非法的 undefined
      out[k] = toJsonValue(v, seen);
    }
  }
  seen.delete(value);
  return out;
}

/**
 * 统一的工具返回构造器：文本 + 已净化的 structured。
 * 所有 registerTool 的 execute 都必须走这里，避免任何出口绕过信封约束。
 */
export function reply(text, structured) {
  return {
    content: [{ type: 'text', text: typeof text === 'string' ? text : String(text ?? '') }],
    ...(structured === undefined ? {} : { structured: toJsonValue(structured) }),
  };
}
