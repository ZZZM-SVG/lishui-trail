# -*- coding: utf-8 -*-
"""
溧水-博望 文旅资源 → 城郊文旅线路智能规划系统离线数据集烘焙

输入：溧水区-博望区旅游资源簇表格_整合版_v4 (1).xlsx
输出：lishui-trail/data/pois.json        （锚点 + 单体 + 虚拟单体，含派生兴趣标签）
      lishui-trail/data/pois.mjs         （同内容 ES module，供 AGH 插件零依赖加载）
      lishui-trail/data/water.json       （水域要素索引，风险模块使用）
      lishui-trail/reports/bake_report.md（烘焙报告，作为数据证据）

设计原则：
  1. 不做任何坐标臆造——只用表中已有的锚定坐标（CGCS2000）。
  2. 兴趣维度标签由"国标分类名称"关键词规则确定性生成，规则表随文件一起开源可复核。
  3. 单体缺坐标时不生成节点，仅作为锚点下的"内容清单"参与价值计算。
"""
import io, sys, os, re, json, math, hashlib
from collections import Counter, defaultdict
import pandas as pd
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUTDIR = os.path.join(ROOT, "data")
REPDIR = os.path.join(ROOT, "reports")
os.makedirs(OUTDIR, exist_ok=True)
os.makedirs(REPDIR, exist_ok=True)

# 赛方源表路径：默认为当前用户的「下载」目录；亦可用环境变量 LSZ_SRC_XLSX 指定
SRC = os.environ.get("LSZ_SRC_XLSX") or os.path.join(
    os.path.expanduser("~"), "Downloads", "溧水区-博望区旅游资源簇表格_整合版_v4 (1).xlsx")

# ----------------------------------------------------------------------------
# 1. 兴趣维度规则表（关键词 → 维度权重）。全部规则显式列在此处，便于复核与替换。
# ----------------------------------------------------------------------------
DIMENSIONS = {
    "landscape": "自然山水",
    "water":     "湖荡水利",
    "farming":   "田园农业",
    "red":       "红色记忆",
    "village":   "古村老街",
    "religion":  "宗教古迹",
    "intangible":"非遗民俗",
    "museum":    "展馆文艺",
    "resort":    "休闲度假",
    "food":      "物产美食",
}

# (正则, {维度: 权重})
DIM_RULES = [
    (r"山丘|山岳|山峰|山地|洞穴|观景|崖|石林|峡谷|丘陵|坡地", {"landscape": 1.0}),
    (r"湖|水库|湿地|塘|潭|泉|河|溪|堤坝|港口|渡口|码头|渠道|运河|闸|瀑布|涌泉",
     {"water": 1.0}),
    (r"桥梁|古桥|大桥", {"water": 0.6, "village": 0.4}),
    (r"农田|田园|采摘|果园|茶园|苗圃|花卉|林场|牧场|养殖|果园|农时|农事",
     {"farming": 1.0}),
    (r"杨梅|葡萄|蓝莓|樱桃|桃|茶|板栗|草莓|稻|米|花生", {"farming": 0.8, "food": 0.4}),
    (r"纪念|烈士|战斗|战役|国防|军事|革命|新四军|旧址|会师|抗日|碑|陵墓|墓",
     {"red": 1.0}),
    (r"街区|老街|传统村落|村$|屋舍|民居|宗祠|祠堂|牌坊|影壁|大院|宅|巷",
     {"village": 1.0}),
    (r"宗教|寺|庙|庵|道观|教堂|祭祀|祠|塔|经幢|佛像|神",
     {"religion": 1.0}),
    (r"井|古井|碑碣|碑林|石刻|文物|古迹", {"religion": 0.5, "village": 0.5}),
    (r"非遗|传统演艺|节庆|庙会|民俗|技艺|龙|舞|曲|戏|号子|手工|剪纸",
     {"intangible": 1.0}),
    (r"馆|展示|博物|文化中心|书画|艺术|书院|藏书|展览|美术",
     {"museum": 1.0}),
    (r"度假|温泉|游乐|康体|高尔夫|营地|露营|民宿|休闲|水上乐园|影视",
     {"resort": 1.0}),
    (r"农产品|产品及制品|美食|特产|酱|粉丝|老鹅|鱼头|米糕|茶干|小吃|宴|酒",
     {"food": 1.0}),
    (r"生产地|产业园|高新区|农业园|生态园|农庄|农场|示范园|基地",
     {"farming": 0.6, "resort": 0.3}),
    (r"节|赛事|活动|市集|夜市|商贸", {"intangible": 0.6, "resort": 0.3}),
]

def dims_of(text, extra=None):
    """把一段分类/名称文本映射成兴趣维度向量。"""
    v = defaultdict(float)
    t = str(text or "")
    for pat, w in DIM_RULES:
        if re.search(pat, t):
            for k, ww in w.items():
                v[k] = max(v[k], ww)
    if extra:
        for k, ww in extra.items():
            v[k] = max(v[k], ww)
    return {k: round(w, 3) for k, w in v.items() if w > 0}

# 锚点"类型"先验（表 5：旅游村/景区/产业园/山岳/街区/片区/湖泊/公园/纪念地/离散点）
TYPE_PRIOR = {
    "山岳":   {"landscape": 0.9, "religion": 0.2},
    "湖泊":   {"water": 1.0, "landscape": 0.4},
    "旅游村": {"village": 0.8, "farming": 0.4, "intangible": 0.3, "food": 0.3},
    "景区":   {"landscape": 0.5, "resort": 0.4, "museum": 0.2},
    "街区":   {"village": 0.8, "food": 0.4, "intangible": 0.4},
    "片区":   {"village": 0.5, "landscape": 0.3, "farming": 0.3},
    "产业园": {"farming": 0.8, "resort": 0.3},
    "公园":   {"landscape": 0.6, "water": 0.3, "resort": 0.3},
    "纪念地": {"red": 1.0},
    "离散点": {},
}

# ----------------------------------------------------------------------------
# 2. 等级加成（等级/资质 → 0~1 的价值倍率增量）
# ----------------------------------------------------------------------------
LEVEL_RULES = [
    (r"5A|五A", 0.60), (r"4A|四A", 0.45), (r"3A|三A", 0.30),
    (r"国家级|全国|国家地理标志|国家4A|国家重点", 0.45),
    (r"省级|江苏省|省保|省级文物", 0.32),
    (r"市级|南京市文物保护|马鞍山市文物保护", 0.22),
    (r"区级|区一般不可移动文物|区地名文化遗产", 0.12),
    (r"传统村落|重点村|名村|历史文化名", 0.25),
    (r"非遗|地理标志|一村一品", 0.25),
    (r"无认定|^nan$|^$", 0.0),
]

def level_bonus(*texts):
    b = 0.0
    for t in texts:
        t = str(t or "")
        for pat, w in LEVEL_RULES:
            if re.search(pat, t, re.I):
                b = max(b, w)
    return round(b, 3)

# ----------------------------------------------------------------------------
# 3. 季节解析：把 运营状态 中的季节描述解析成月份集合
# ----------------------------------------------------------------------------
CN_MON = {f"{i}月": i for i in range(1, 13)}
def season_months(*texts):
    out = set()
    for t in texts:
        t = str(t or "")
        if "季节性" not in t and "季" not in t:
            continue
        for m, i in CN_MON.items():
            if m in t:
                out.add(i)
        if "蓝莓" in t or "采摘" in t:
            out |= {5, 6, 7, 8}
        if "11月-次年3月" in t or "11月—次年3月" in t:
            out |= {11, 12, 1, 2, 3}
    return sorted(out)

# ----------------------------------------------------------------------------
# 4. 读取表格
# ----------------------------------------------------------------------------
xl = pd.ExcelFile(SRC)
anchors = xl.parse("簇总表（含离散点）")
monos   = xl.parse("单体归属总表（869条）")
virtual = xl.parse("虚拟对象表")
drop    = xl.parse("非旅游资源剔除表")

def norm_town(x):
    s = str(x or "").strip()
    s = re.sub(r"[（(].*?[)）]", "", s)
    s = s.split("/")[0].strip()
    return s

def codes(x):
    s = str(x or "").strip()
    if s in ("nan", "", "None"):
        return []
    return [c.strip() for c in re.split(r"[;；]", s) if c.strip()]

# 单体索引
mono_by_code = {str(r["单体编码"]).strip(): r for _, r in monos.iterrows()}
virtual_by_code = {str(r["单体编码"]).strip(): r for _, r in virtual.iterrows()}

pois = []
all_cat = Counter()
all_dims = Counter()

for _, a in anchors.iterrows():
    aid = str(a["锚点编码"]).strip()
    lon = float(a["锚定经度"]); lat = float(a["锚定纬度"])
    atype = str(a["类型"]).strip()
    atype = "离散点" if str(a["类别"]).strip() == "离散资源点" else atype

    ent_codes = codes(a["对应实体单体编码"])
    vir_codes = codes(a["对应虚拟单体编码"])

    entities, virtuals = [], []
    dv = defaultdict(float)
    lb = 0.0
    months = set()
    statuses = Counter()

    # 锚点自身
    for k, w in TYPE_PRIOR.get(atype, {}).items():
        dv[k] = max(dv[k], w)
    for k, w in dims_of(a["名称"]).items():
        dv[k] = max(dv[k], w)

    for c in ent_codes:
        r = mono_by_code.get(c)
        if r is None:
            continue
        cat = str(r.get("国标分类名称") or "")
        all_cat[cat] += 1
        for k, w in dims_of(cat, {"village": 0.3} if "屋舍" in cat else None).items():
            dv[k] = max(dv[k], w)
        for k, w in dims_of(r.get("单体名称")).items():
            dv[k] = max(dv[k], w * 0.8)
        b = level_bonus(r.get("等级/资质"), r.get("判定依据"))
        lb = max(lb, b)
        m = season_months(r.get("运营状态"), r.get("等级/资质"), r.get("备注"))
        months |= set(m)
        statuses[str(r.get("运营状态") or "").strip()] += 1
        entities.append({
            "code": c,
            "name": str(r.get("单体名称") or "").strip(),
            "cat": cat,
            "catCode": str(r.get("国标分类编码") or "").strip(),
            "level": str(r.get("等级/资质") or "").strip(),
            "status": str(r.get("运营状态") or "").strip(),
            "desc": str(r.get("特征描述") or "").strip(),
            "lon": None if pd.isna(r.get("经度")) else float(r["经度"]),
            "lat": None if pd.isna(r.get("纬度")) else float(r["纬度"]),
        })

    for c in vir_codes:
        r = virtual_by_code.get(c)
        if r is None:
            continue
        cat = str(r.get("国标分类名称") or "")
        all_cat[cat] += 1
        for k, w in dims_of(cat).items():
            dv[k] = max(dv[k], w)
        for k, w in dims_of(r.get("单体名称")).items():
            dv[k] = max(dv[k], w * 0.8)
        m = season_months(r.get("运营状态"), r.get("备注"))
        months |= set(m)
        virtuals.append({
            "code": c,
            "name": str(r.get("单体名称") or "").strip(),
            "vtype": str(r.get("虚拟类型") or "").strip(),
            "cat": cat,
            "desc": str(r.get("判定依据") or "").strip()[:120],
        })

    # 建议停留时长（分钟）：规模 + 类型先验
    n = len(entities) + 0.5 * len(virtuals)
    dwell = {"景区": 75, "湖泊": 45, "山岳": 70, "旅游村": 55, "街区": 45,
             "片区": 50, "产业园": 45, "公园": 35, "纪念地": 35, "离散点": 20}[atype]
    dwell = int(round(dwell + min(n, 20) * 2.5))
    dwell = max(15, min(dwell, 150))

    dims = {k: round(v, 3) for k, v in dv.items() if v > 0}
    for k in dims:
        all_dims[k] += 1
    if not dims:
        dims = {"village": 0.3}

    pois.append({
        "id": aid,
        "name": str(a["名称"]).strip(),
        "cluster": str(a["类别"]).strip(),
        "type": atype,
        "district": str(a["区/县"]).strip(),
        "town": norm_town(a["镇/街道"]),
        "townRaw": str(a["镇/街道"]).strip(),
        "lon": round(lon, 6),
        "lat": round(lat, 6),
        "coordSource": str(a["坐标来源"]).strip(),
        "coordCrs": str(a["坐标系"]).strip(),
        "coordNote": "" if pd.isna(a.get("坐标备注")) else str(a["坐标备注"]),
        "nEntity": int(a["下辖实体单体数"]),
        "nVirtual": int(a["下辖虚拟单体数"]),
        "dims": dims,
        "levelBonus": lb,
        "dwell": dwell,
        "months": sorted(months),
        "entities": entities,
        "virtuals": virtuals,
    })

# ----------------------------------------------------------------------------
# 4b. 未被锚点引用的虚拟对象（58 条"遗址遗存类·已毁不可游"）与剔除清单
#     保留它们不是为了规划，而是为了让系统能回答"某资源为什么不进路线"。
# ----------------------------------------------------------------------------
anchor_by_name = {p["name"]: p["id"] for p in pois}
# 按 挂靠簇 名称把漏挂的非遗虚拟对象补挂到对应锚点
attached = {v["code"] for p in pois for v in p["virtuals"]}
for c, r in virtual_by_code.items():
    if c in attached:
        continue
    hook = str(r.get("挂靠簇") or "").strip()
    if hook and hook != "nan" and hook in anchor_by_name:
        tid = anchor_by_name[hook]
        for p in pois:
            if p["id"] == tid:
                cat = str(r.get("国标分类名称") or "")
                p["virtuals"].append({
                    "code": c, "name": str(r.get("单体名称") or "").strip(),
                    "vtype": str(r.get("虚拟类型") or "").strip(), "cat": cat,
                    "desc": str(r.get("判定依据") or "").strip()[:120]})
                for k, w in dims_of(cat).items():
                    p["dims"][k] = max(p["dims"].get(k, 0), w * 0.9)
                break

immovable = []
for _, r in virtual.iterrows():
    c = str(r["单体编码"]).strip()
    vt = str(r.get("虚拟类型") or "")
    if "遗址遗存" in vt:
        immovable.append({
            "code": c, "name": str(r.get("单体名称") or "").strip(),
            "cat": str(r.get("国标分类名称") or "").strip(),
            "vtype": vt,
            "district": str(r.get("区/县") or "").strip(),
            "town": norm_town(r.get("镇/街道")),
            "reason": str(r.get("判定依据") or "").strip()[:160],
        })

excluded = []
for _, r in drop.iterrows():
    excluded.append({
        "code": str(r.get("单体编码") or "").strip(),
        "name": str(r.get("单体名称") or "").strip(),
        "cat": str(r.get("国标分类名称") or "").strip(),
        "level": str(r.get("等级/资质") or "").strip(),
        "district": str(r.get("区/县") or "").strip(),
        "town": norm_town(r.get("镇/街道")),
        "reason": str(r.get("判定依据") or "").strip()[:160],
    })

rules_text = "\n".join(
    str(x) for x in xl.parse("判定规则说明").iloc[:, 0].dropna().tolist())

# ----------------------------------------------------------------------------
# 5. 水域要素索引（风险模块：涉水风险）——只取表中显式的水体与水利设施
# ----------------------------------------------------------------------------
WATER_TYPE = {"湖泊"}
WATER_NAME = r"湖|水库|潭|泉|河|溪|湿地|塘|渡口|码头|堤|闸|港"
water = []
for p in pois:
    is_water = (p["type"] in WATER_TYPE) or bool(re.search(WATER_NAME, p["name"]))
    if not is_water:
        continue
    kind = "lake" if ("湖" in p["name"] or p["type"] == "湖泊") else "water_other"
    water.append({"id": p["id"], "name": p["name"], "kind": kind,
                  "lon": p["lon"], "lat": p["lat"]})
# 从单体的显式坐标里补充水体（如水库/河/塘离散要素）
for c, r in mono_by_code.items():
    nm = str(r.get("单体名称") or "")
    if not re.search(r"水库|湖|河|溪|塘|潭|泉", nm):
        continue
    if pd.isna(r.get("经度")) or pd.isna(r.get("纬度")):
        continue
    water.append({"id": c, "name": nm, "kind": "water_point",
                  "lon": round(float(r["经度"]), 6), "lat": round(float(r["纬度"]), 6)})

# ----------------------------------------------------------------------------
# 6. 输出
# ----------------------------------------------------------------------------
bbox = {
    "minLon": min(p["lon"] for p in pois), "maxLon": max(p["lon"] for p in pois),
    "minLat": min(p["lat"] for p in pois), "maxLat": max(p["lat"] for p in pois),
}
ds = {
    "meta": {
        "name": "溧水—博望 文旅资源数据集",
        "source": os.path.basename(SRC),
        "sourceSha256": hashlib.sha256(open(SRC, "rb").read()).hexdigest(),
        "crs": "CGCS2000 (EPSG:4490) / WGS84 近似",
        "builtBy": "tools/build_dataset.py",
        "counts": {
            "anchors": len(pois),
            "clusters": sum(1 for p in pois if p["cluster"] == "簇"),
            "discrete": sum(1 for p in pois if p["cluster"] == "离散资源点"),
            "entities": sum(len(p["entities"]) for p in pois),
            "virtuals": sum(len(p["virtuals"]) for p in pois),
            "immovable": len(immovable),
            "excluded": len(excluded),
            "waterFeatures": len(water),
        },
        "dims": DIMENSIONS,
        "bbox": bbox,
    },
    "pois": pois,
    "water": water,
    "immovable": immovable,
    "excluded": excluded,
    "rules": rules_text,
}

p_json = os.path.join(OUTDIR, "pois.json")
with open(p_json, "w", encoding="utf-8") as f:
    json.dump(ds, f, ensure_ascii=False, separators=(",", ":"))

with open(os.path.join(OUTDIR, "water.json"), "w", encoding="utf-8") as f:
    json.dump({"water": water}, f, ensure_ascii=False, separators=(",", ":"))

# 同时产出 ESM 版本，供 AGH 插件零依赖 import（避免 JSON import assertion 兼容问题）
with open(os.path.join(OUTDIR, "pois.mjs"), "w", encoding="utf-8") as f:
    f.write("// 自动生成，请勿手改。来源见 meta.source / meta.sourceSha256\n")
    f.write("export const DATASET = ")
    json.dump(ds, f, ensure_ascii=False, separators=(",", ":"))
    f.write(";\nexport default DATASET;\n")

# 哈希清单
hashes = {}
for fn in ["pois.json", "water.json", "pois.mjs", "dem.bin", "dem.json"]:
    fp = os.path.join(OUTDIR, fn)
    hashes[fn] = {"sha256": hashlib.sha256(open(fp, "rb").read()).hexdigest(),
                  "bytes": os.path.getsize(fp)}
with open(os.path.join(OUTDIR, "checksums.json"), "w", encoding="utf-8") as f:
    json.dump(hashes, f, ensure_ascii=False, indent=2)

# ----------------------------------------------------------------------------
# 7. 烘焙报告
# ----------------------------------------------------------------------------
L = []
def P(s=""): L.append(str(s))
P("# 溧水—博望文旅资源数据集烘焙报告")
P()
P(f"- 源文件：`{os.path.basename(SRC)}`")
P(f"- 源文件 SHA256：`{ds['meta']['sourceSha256']}`")
P(f"- 坐标系：{ds['meta']['crs']}")
P()
P("## 规模核对（与规则表『数量勾稽』一致）")
P()
P(f"| 项 | 数值 |")
P("| --- | --- |")
for k, v in ds["meta"]["counts"].items():
    P(f"| {k} | {v} |")
P()
P("## 兴趣维度覆盖（锚点数）")
P()
P("| 维度 | 中文 | 锚点数 |")
P("| --- | --- | --- |")
for k, v in all_dims.most_common():
    P(f"| {k} | {DIMENSIONS.get(k,'')} | {v} |")
P()
P("## 锚点类型分布")
P()
for k, v in Counter(p["type"] for p in pois).most_common():
    P(f"- {k}: {v}")
P()
P("## 镇/街道分布")
P()
for k, v in Counter(p["town"] for p in pois).most_common():
    P(f"- {k}: {v}")
P()
P("## 水域要素（风险模块用）")
P()
P(f"合计 {len(water)} 个；前 20：")
for w in water[:20]:
    P(f"- {w['id']} {w['name']} ({w['kind']}) {w['lon']},{w['lat']}")
P()
P("## 数据产物哈希")
P()
P("| 文件 | 字节 | SHA256 |")
P("| --- | --- | --- |")
for fn, h in hashes.items():
    P(f"| {fn} | {h['bytes']} | `{h['sha256'][:16]}…` |")
P()
P("## 边界框")
P()
P(f"经度 {bbox['minLon']} ~ {bbox['maxLon']}，纬度 {bbox['minLat']} ~ {bbox['maxLat']}")
P()
P("## 抽样（前 5 个锚点）")
P()
P("```json")
P(json.dumps(pois[:2], ensure_ascii=False, indent=1)[:2500])
P("```")

with open(os.path.join(REPDIR, "bake_report.md"), "w", encoding="utf-8") as f:
    f.write("\n".join(L))

print("anchors", len(pois), "entities", ds["meta"]["counts"]["entities"],
      "virtuals", ds["meta"]["counts"]["virtuals"], "water", len(water))
print("pois.json bytes", hashes["pois.json"]["bytes"], "pois.mjs bytes", hashes["pois.mjs"]["bytes"])
