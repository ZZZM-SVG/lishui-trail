# -*- coding: utf-8 -*-
"""检查 dem.bin 中的异常低值分布，判断是坏瓦片还是水面。"""
import io, sys, os, json
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
import numpy as np

# 项目根目录：默认为本脚本所在 tools/ 的上一级；亦可用环境变量 LSZ_ROOT 覆盖
ROOT = os.environ.get("LSZ_ROOT") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
meta = json.load(open(os.path.join(ROOT, "data", "dem.json"), encoding="utf-8"))
dem = np.fromfile(os.path.join(ROOT, "data", "dem.bin"), dtype="<i2").reshape(meta["height"], meta["width"])
L=[]
def P(*a): L.append(" ".join(str(x) for x in a))

P("shape", dem.shape, "min", dem.min(), "max", dem.max())
for thr in [-50, -10, -5, -2, -1, 0, 1, 2, 5]:
    P(f"  cells <= {thr}: {(dem <= thr).sum()}")

neg = dem < 0
P("neg count", neg.sum())
if neg.sum():
    r, c = np.where(neg)
    P("neg rows", r.min(), r.max(), "cols", c.min(), c.max())
    P("rows with neg:", sorted(set(r.tolist()))[:50])
    P("cols with neg:", sorted(set(c.tolist()))[:50])
    # 转成经纬度
    lo = meta["originLon"] + c * meta["cellLonDeg"]
    la = meta["originLat"] - r * meta["cellLatDeg"]
    P("lon range", lo.min(), lo.max(), "lat range", la.min(), la.max())
P("sample of values around min:")
r0, c0 = np.unravel_index(int(dem.argmin()), dem.shape)
P("argmin at", r0, c0, dem[r0, c0])
P(dem[max(0,r0-4):r0+5, max(0,c0-4):c0+5])

# 检查是否有整块 0（缺失瓦片）
zero = (dem == 0)
P("exact zero cells:", zero.sum())
if zero.sum():
    rr, cc = np.where(zero)
    P("zero rows", rr.min(), rr.max(), "cols", cc.min(), cc.max())

# 低值连通块大致范围
low = dem < 3
P("cells<3:", low.sum(), "占", round(100*low.sum()/dem.size,2), "%")
open(os.path.join(ROOT,"reports","_dem_check.txt"),"w",encoding="utf-8").write("\n".join(L))
print("ok")
