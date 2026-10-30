# -*- coding: utf-8 -*-
"""
从 OpenStreetMap（Overpass API，公开数据、免密钥）预烘焙研究区地物：
  1) 水域面/线（湖、水库、河、渠）——"涉水风险"与路径避让
  2) 可通行路径与道路——最小代价路径沿既有路网
大范围单次查询会被 Overpass 拒绝（504/500），因此按网格分块查询后合并。
输出：data/osm.json  +  reports/osm_report.md
"""
import io, sys, os, json, time, hashlib, urllib.request, urllib.parse, threading
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUTDIR = os.path.join(ROOT, "data"); REPDIR = os.path.join(ROOT, "reports")
os.makedirs(OUTDIR, exist_ok=True); os.makedirs(REPDIR, exist_ok=True)

S, W, N, E = 31.38, 118.60, 31.79, 119.28
NX, NY = 4, 3
ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.osm.jp/api/interpreter",
]

HWY = "path|footway|steps|track|bridleway|cycleway|residential|unclassified|tertiary|secondary|service"
PATH_Q = ('[out:json][timeout:120];way["highway"~"^(' + HWY + ')$"]({bbox});out geom;')
WATER_Q = ('[out:json][timeout:120];('
           'way["natural"="water"]({bbox});'
           'way["landuse"="reservoir"]({bbox});'
           'way["waterway"~"^(river|stream|canal)$"]({bbox});'
           'way["natural"="wetland"]({bbox});'
           ');out geom;')

_lock = threading.Lock()
STATS = {"requests": 0, "ok": 0, "fail": 0, "notes": []}

def run(q):
    body = urllib.parse.urlencode({"data": q}).encode()
    last = None
    for ep in ENDPOINTS:
        for attempt in range(2):
            with _lock:
                STATS["requests"] += 1
            try:
                req = urllib.request.Request(ep, data=body,
                        headers={"User-Agent": "lishui-trail-offline-bake/1.0 (hackathon research)"})
                with urllib.request.urlopen(req, timeout=180) as r:
                    js = json.loads(r.read().decode("utf-8"))
                with _lock:
                    STATS["ok"] += 1
                return js
            except Exception as e:
                last = e
                time.sleep(3 + 3 * attempt)
    with _lock:
        STATS["fail"] += 1
        STATS["notes"].append(str(last)[:120])
    return None

def coords_of(el):
    if el.get("type") == "way" and el.get("geometry"):
        return [[round(g["lon"], 6), round(g["lat"], 6)] for g in el["geometry"]]
    return []

def main():
    dlat = (N - S) / NY; dlon = (E - W) / NX
    tiles = []
    for iy in range(NY):
        for ix in range(NX):
            tiles.append((S + iy * dlat, W + ix * dlon, S + (iy + 1) * dlat, W + (ix + 1) * dlon))
    print(f"tiles: {len(tiles)} x 2 layers = {len(tiles)*2} requests")

    ways, waters = {}, {}
    for idx, (s, w, n, e) in enumerate(tiles):
        bb = f"{s:.4f},{w:.4f},{n:.4f},{e:.4f}"
        js = run(PATH_Q.format(bbox=bb))
        if js:
            for el in js.get("elements", []):
                c = coords_of(el)
                if len(c) < 2:
                    continue
                t = el.get("tags", {})
                ways[f"w{el['id']}"] = {"id": f"w{el['id']}", "cls": t.get("highway", ""),
                                        "name": t.get("name", ""), "surface": t.get("surface", ""),
                                        "coords": c}
        js = run(WATER_Q.format(bbox=bb))
        if js:
            for el in js.get("elements", []):
                c = coords_of(el)
                if len(c) < 2:
                    continue
                t = el.get("tags", {})
                kind = t.get("natural") or t.get("waterway") or t.get("landuse") or "water"
                waters[f"w{el['id']}"] = {"id": f"w{el['id']}", "kind": kind,
                                          "name": t.get("name", ""), "coords": c}
        print(f"  tile {idx+1}/{len(tiles)} {bb}: ways={len(ways)} waters={len(waters)} "
              f"(ok={STATS['ok']} fail={STATS['fail']})")

    ways = list(ways.values()); waters = list(waters.values())
    ds = {
        "meta": {
            "source": "OpenStreetMap via Overpass API",
            "license": "ODbL 1.0 (c) OpenStreetMap contributors",
            "bbox": {"south": S, "west": W, "north": N, "east": E},
            "tiles": len(tiles), "requests": STATS["requests"],
            "ok": STATS["ok"], "fail": STATS["fail"],
            "paths": len(ways), "waters": len(waters),
        },
        "paths": ways, "waters": waters,
    }
    p = os.path.join(OUTDIR, "osm.json")
    with open(p, "w", encoding="utf-8") as f:
        json.dump(ds, f, ensure_ascii=False, separators=(",", ":"))
    sha = hashlib.sha256(open(p, "rb").read()).hexdigest()

    cls = {}; wk = {}
    for x in ways: cls[x["cls"]] = cls.get(x["cls"], 0) + 1
    for x in waters: wk[x["kind"]] = wk.get(x["kind"], 0) + 1

    L = ["# OSM 地物烘焙报告", "",
         "- 数据源：OpenStreetMap / Overpass API（ODbL 1.0，© OpenStreetMap contributors）",
         f"- 范围：south={S} west={W} north={N} east={E}，分块 {NX}×{NY}={len(tiles)} 块",
         f"- 请求：{STATS['requests']} 次（成功 {STATS['ok']}，失败 {STATS['fail']}）",
         f"- 路径线段：**{len(ways)}** 条，顶点 {sum(len(x['coords']) for x in ways)} 个",
         f"- 水域要素：**{len(waters)}** 条，顶点 {sum(len(x['coords']) for x in waters)} 个",
         f"- 产物：`data/osm.json`（{os.path.getsize(p)} 字节，SHA256 `{sha[:16]}…`）",
         "", "## 路径等级分布", "", "| highway | 条数 |", "| --- | --- |"]
    for k, v in sorted(cls.items(), key=lambda x: -x[1]):
        L.append(f"| {k} | {v} |")
    L += ["", "## 水域类型分布", "", "| 类型 | 条数 |", "| --- | --- |"]
    for k, v in sorted(wk.items(), key=lambda x: -x[1]):
        L.append(f"| {k} | {v} |")
    L += ["", "## 命名水体抽样", ""]
    seen = set()
    for x in waters:
        if not x["name"] or x["name"] in seen:
            continue
        seen.add(x["name"])
        L.append(f"- {x['name']}（{x['kind']}，{len(x['coords'])} 顶点）")
        if len(seen) >= 20:
            break
    if STATS["notes"]:
        L += ["", "## 失败请求备注", ""] + [f"- {n}" for n in STATS["notes"][:10]]
    with open(os.path.join(REPDIR, "osm_report.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(L))
    print("ok paths", len(ways), "waters", len(waters), "bytes", os.path.getsize(p))

if __name__ == "__main__":
    main()
