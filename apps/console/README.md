# 离线演示台（本地控制台）

**在线版**：<https://lishui-tour-planner.app.workbuddy.host/>（内容与本机启动的完全一致）

双击仓库根目录的 `start.cmd` 即可使用；或手动执行：

```bash
node apps/console/server.mjs --open
```

- 地址：`http://127.0.0.1:8763`（被占用时自动向后顺延，`PORT` 环境变量可指定）
- 环境：Node.js ≥ 22，无任何第三方依赖
- 监听地址默认 `127.0.0.1`；如需对外提供（例如部署到单端口沙箱），以 `HOST=0.0.0.0 PORT=<端口> node apps/console/server.mjs` 启动

## 这是什么

一个**纯本地、纯离线**的可视化页面，用来"看见" `lishui-trail` AGH 插件的能力：

| 区块 | 内容 |
| --- | --- |
| 中间地图 | 由 `data/dem.bin`（2149×1511 @30 m 高程栅格）实时渲染的晕渲底图 + OSM 水系/路网；滚轮缩放、拖拽平移 |

> 底图把 30 m 栅格**按 2 倍上采样**到 4298×3022（`cellMetersApprox ≈ 15 m`）再渲染，
> 那只是**为了让晕渲和等高线看起来平滑**的显示倍率；地形分析（坡度、Tobler 时间、A\* 代价）
> 一律用原始的 30 m 栅格——30 m 已是 SRTM 的高程信息上限，向更细格网插值不会增加信息（见
> `docs/数据来源核对.md` §9）。
| 左侧表单 | 人群预设（6 类）、10 维兴趣权重、体能/节奏/时长/日期/同行人员/种子、必去与避开点、自定义起点（地图点选） |
| 右侧结果 | 时间轴行程、里程/爬升/坡度指标、七因子风险雷达、12 项结果自校验、求解质量对照（贪心/随机基线）、地形剖面、GPX/CSV 下载 |

## 合规边界（对评审很重要）

1. **本页不做任何模型调用**，也不接入任何模型 API；
2. 规划、风险、自校验全部**直接复用** `packages/lishui-trail-plugin/lib/` 下与 AGH 插件**同一份**求解器模块（`planTrip` / `suggestAlternatives` / `toGpx`）；
3. 因此页面上算出的每个结果，都能被 AGH 会话中的 `lishui_trail_plan` 等工具以相同输入**逐字节复现**（同种子几何哈希一致）；
4. 模型驱动的完整智能体闭环（Agnes 模型 → AGH → 工具）见 `docs/evidence/` 中的真实 AGH 会话记录。

## HTTP 接口

| 路由 | 说明 |
| --- | --- |
| `GET /` | 演示台页面 |
| `GET /api/meta` | 数据集状态、投影参数、人群/体能预设 |
| `GET /api/pois` | 162 个文旅锚点（含维度标签与单体摘要） |
| `GET /api/basemap.png` | 服务端实时渲染的离线底图（DEM 晕渲 + 水域 + 路网，2149×1511 @30 m 源数据，约 1.3 MB） |
| `POST /api/plan` | 路线规划（含风险、12 项自校验、同种子复算），入参即插件画像 |
| `POST /api/alternatives` | 停靠点异常处置：同类替代点推荐 |
| `POST /api/export` | 导出 GPX / 行程 CSV |

## 文件

```
apps/console/
  server.mjs    本地 HTTP 服务（Node 内置 http，默认仅监听 127.0.0.1；HOST=0.0.0.0 可对外）
  basemap.mjs   底图渲染：DEM 山体晕渲 + OSM 水域/路网 → 调色板索引 PNG
                （用 Node 内置 zlib 手写 PNG 编码器，零依赖生成真 PNG）
  index.html    前端单页（内联 CSS/JS，零外链、零 CDN）
```
