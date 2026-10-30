# 溧水—博望文旅资源数据集烘焙报告

- 源文件：`溧水区-博望区旅游资源簇表格_整合版_v4 (1).xlsx`
- 源文件 SHA256：`424eafcd451f17e95397c1f11123e9b9e9ea594ce3c81ac4234b563814bbfd4c`
- 坐标系：CGCS2000 (EPSG:4490) / WGS84 近似

## 规模核对（与规则表『数量勾稽』一致）

| 项 | 数值 |
| --- | --- |
| anchors | 162 |
| clusters | 86 |
| discrete | 76 |
| entities | 698 |
| virtuals | 49 |
| immovable | 58 |
| excluded | 64 |
| waterFeatures | 58 |

## 兴趣维度覆盖（锚点数）

| 维度 | 中文 | 锚点数 |
| --- | --- | --- |
| resort | 休闲度假 | 106 |
| village | 古村老街 | 88 |
| farming | 田园农业 | 87 |
| intangible | 非遗民俗 | 85 |
| religion | 宗教古迹 | 72 |
| food | 物产美食 | 68 |
| water | 湖荡水利 | 53 |
| landscape | 自然山水 | 48 |
| museum | 展馆文艺 | 42 |
| red | 红色记忆 | 32 |

## 锚点类型分布

- 离散点: 76
- 旅游村: 30
- 景区: 18
- 产业园: 9
- 山岳: 7
- 街区: 7
- 片区: 6
- 湖泊: 4
- 公园: 3
- 纪念地: 2

## 镇/街道分布

- 晶桥镇: 31
- 永阳街道: 19
- 洪蓝街道: 17
- 博望镇: 17
- 石湫街道: 16
- 和凤镇: 14
- 白马镇: 13
- 新市镇: 13
- 东屏街道: 8
- 柘塘街道: 7
- 丹阳镇: 7

## 水域要素（风险模块用）

合计 58 个；前 20：
- LS-09 东屏湖 (lake) 119.130145,31.693437
- LS-15 乌飞塘村 (water_other) 118.970109,31.494924
- LS-SJH 石臼湖（溧水） (lake) 118.92474,31.51828
- LS-22 上港上庄传统村落 (water_other) 119.010971,31.54642
- LS-29 神山湖景区 (lake) 118.985821,31.548474
- LS-30 蒲塘片区 (water_other) 118.974532,31.558609
- LS-42 九塘村（李在凤） (water_other) 118.95838,31.66024
- LS-46 环山河片区 (water_other) 118.894968,31.571082
- LS-49 中山湖 (lake) 119.039964,31.648396
- LS-52 幸庄湿地公园 (water_other) 119.027863,31.620875
- LS-56 秋湖片区 (lake) 119.0868,31.57943
- BW-01 东湖村（石臼天境） (lake) 118.853253,31.500738
- BW-SJH 石臼湖（博望） (lake) 118.79,31.53
- BW-08 山河村红色教育基地 (water_other) 118.752303,31.629405
- BW-13 丹阳湖农场 (lake) 118.7118,31.54512
- BW-18 新河村 (water_other) 118.719287,31.560991
- BW-25 釜山村（花津湖） (lake) 118.700872,31.536982
- LS-L02 二塘头古井 (water_other) 119.185698,31.60143
- LS-L32 金井涌泉 (water_other) 119.10557,31.443302
- LS-L47 官塘桥 (water_other) 118.885642,31.62073

## 数据产物哈希

| 文件 | 字节 | SHA256 |
| --- | --- | --- |
| pois.json | 291175 | `050c36511de4f63e…` |
| water.json | 6075 | `5d7ccf4a935ebc77…` |
| pois.mjs | 291302 | `473864f2b10162ee…` |

## 边界框

经度 118.622396 ~ 119.185885，纬度 31.400487 ~ 31.763028

## 抽样（前 5 个锚点）

```json
[
 {
  "id": "LS-01",
  "name": "周园",
  "cluster": "簇",
  "type": "景区",
  "district": "溧水区",
  "town": "白马镇",
  "townRaw": "白马镇",
  "lon": 119.185885,
  "lat": 31.629342,
  "coordSource": "天地图",
  "coordCrs": "CGCS2000",
  "coordNote": "",
  "nEntity": 12,
  "nVirtual": 0,
  "dims": {
   "landscape": 0.5,
   "resort": 0.4,
   "museum": 1.0,
   "village": 1.0,
   "intangible": 0.8,
   "farming": 0.64,
   "food": 0.32,
   "religion": 0.8
  },
  "levelBonus": 0.45,
  "dwell": 105,
  "months": [],
  "entities": [
   {
    "code": "320117-BM-001",
    "name": "周园（白马如意文化艺术中心）",
    "cat": "独立厅、室、馆",
    "catCode": "EBC",
    "level": "国家4A级旅游景区",
    "status": "正常",
    "desc": "中国最大私人收藏馆，徽派建筑群",
    "lon": 119.1872511,
    "lat": 31.6310015
   },
   {
    "code": "320117-BM-041",
    "name": "周村（周园二期）",
    "cat": "特性屋舍",
    "catCode": "EBB",
    "level": "无认定",
    "status": "正常",
    "desc": "徽派古建筑群落二期街区",
    "lon": 119.1872511,
    "lat": 31.6310015
   },
   {
    "code": "320117-BM-069",
    "name": "周园四合院文化收藏区（御膳房/尚书房/养心斋/太和斋/保和斋/狮龙堂）",
    "cat": "特性屋舍",
    "catCode": "EBB",
    "level": "周园核心展区",
    "status": "正常",
    "desc": "六建筑组成，狮龙堂重檐歇山顶",
    "lon": null,
    "lat": null
   },
   {
    "code": "320117-BM-070",
    "name": "佛道千佛廊",
    "cat": "门廊、廊道",
    "catCode": "ECH",
    "level": "无认定",
    "status": "正常",
    "desc": "总长536米，供佛像3000余尊",
    "lon": null,
    "lat": null
   },
   {
    "code": "320117-BM-071",
    "name": "百床馆（文化艺术展示中心）",
    "cat": "独立厅、室、馆",
    "catCode": "EBC",
    "level": "无认定",
    "status": "正常",
    "desc": "121张古床，含30㎡\"床王\"",
    "lon": null,
    "lat": null
   },
   {
    "code": "320117-BM-072",
    "name": "根雕馆·茶海展示区",
    "cat": "独立厅、室、馆",
    "catCode": "EBC",
    "level": "无认定",
    "status": "正常",
    "desc": "根雕100余件、茶海30件",
    "lon": null,
    "lat": null
   },
   {
    "code": "320117-BM-073",
    "name": "周家大院（含徽派古戏台）",
    "cat": "特性屋舍",
    "catCode": "EBB",
    "level": "无认定",
    "status": "正常",
    "desc": "6000㎡七进式徽派老宅",
    "lon": null,
    "lat": null
   },
   {
    "code": "320117-BM-074",
    "name": "周氏宗祠（周园）",
    "cat": "特性屋舍",
    "catCode": "EBB",
    "level": "无认定",
    "status": "正常",
    "desc": "明末清初建筑，藏楹联匾额",
    "lon": null,
    "lat": null
   },
   {
    "code": "320117-BM-075",
    "name": "周园石雕群（十八罗汉/四大金刚）",
    "cat": "雕塑",
    "catCode": "ECE",
    "level": "无认定",
    "status": "正常",
    "desc": "大型石雕上百件，最重20余吨",
    "lon": null,
    "lat": null
   },
   {
    "code": "320117
```