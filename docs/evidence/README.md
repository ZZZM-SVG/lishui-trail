# 运行证据目录（docs/evidence）

本目录保存「lishui-trail 作为 AGH 插件、在真实 AGH 中由 Agnes 模型驱动」的运行证据，
对应赛项提交材料中的 **可运行作品 / 运行与验证证据 / 测试样例**。

---

## 0. 这些证据是怎么产生的（可复核）

**结论：`agh-session.json` / `agh-session.html` 与「累积会话」两份会话日志，都是 AGH 官方 CLI 的
`export` 命令直接产出的文件——由 AGH 自己的进程从会话存储里落盘，不是任何模型（Agnes 或其他）"写"出来的。**

产生路径（三步，全部发生在 AGH 进程内）：

1. **装插件** — `agh package inspect / install / trust / enable`，把 `packages/lishui-trail-plugin` 注册进 AGH
   （全过程见 `插件重装与信任记录.txt`）；
2. **跑会话** — 用 `agh -p "<中文指令>" --cwd <工作目录> --profile local-dev` 跑真实非交互会话，
   由 AGH 调度、Agnes 模型决策、本插件工具执行（主证据会话分 5 步跑，每步 1 次工具调用；
   原始输出为 `会话A-*.txt` / `会话B-*.txt`）；
3. **导出日志（关键一步，手动执行 AGH 命令）**：

```powershell
# 前置：daemon 必须带 --workspace 启动，否则 export 会稳定报 INTERNAL_ERROR (-32603)
agh daemon stop  --profile local-dev
agh daemon start --profile local-dev --workspace "<lishui-trail 绝对路径>"

# 会话键 = profile + surface + cwd 的哈希；列出本机真实存在的会话及其事件数
agh sessions list

# 导出主证据：NDJSON（原始）+ HTML（可读）
agh export agnes:local:local-dev:cli:workspace:44ddc56d6188dff7 --format agnes -o docs/evidence/agh-session.json
agh export agnes:local:local-dev:cli:workspace:44ddc56d6188dff7 --html         -o docs/evidence/agh-session.html
```

**两条会话键（均可用 `agh sessions list` 现场复核其真实存在与事件数）：**

| 会话键 | 事件数 | 用途 |
| --- | ---: | --- |
| `agnes:local:local-dev:cli:workspace:44ddc56d6188dff7` | 225 | **主证据**：干净会话，5 次本作品工具调用 + AGH 内置 2 次，0 错误 |
| `agnes:local:local-dev:cli:workspace:34ebcd857b9bb539` | 1069 | 从最初调试到修复前的完整历史，含 5 条真实错误（见 §4） |

**如何判断一份日志是真的 AGH 导出、而不是事后编造的**（评委/复核者可据此自查）：

- 每行是**一个 JSON 事件**，带 AGH 原生信封字段 `seq` / `id`(ULID) / `type` / `lane` / `v` / `actor` / `origin` / `trust` / `data`；
- 事件类型用的是 AGH 自己的词汇：`session/start`、`turn/start`、`step/start`、`request/header`、`request/sent`、
  `cost/ledger`、`tool/call`、`tool/result`、`verifier/signal`、`effect/intent`、`effect/settled`、`budget.state`、
  `x/host/session-title`、`x/core/context-breakdown` …；
- `actor.id` 是**本机 AGH 账户名**；`request/header` 与 `cost/ledger` 中的 `model` 字段全为 `agnes-3.0-flash`；
- `tool/call` 事件里带 AGH 侧写入的 `resolvedPolicy` 与 `policyHash`（只读 / 非破坏 / 封闭世界 / 可重放 / 免审批），
  这是 AGH 在调用前解析出的策略结果，**插件自身无法伪造**。

**已知的、无害的差异（复核时别误判为"被改过"）**：用同一条会话重新 `export` 一次，结果与包内这两份
**不会逐字节相同**，差异只有两处：

1. 会**多出 1 条** `x/agnes/code-mode/kernel`（`{"alive":false}` 的探活标记，本身带 `ignorable:true`）——
   会话每次被重新加载 / 导出时 AGH 都会追加一条；因此现在 `agh sessions list` 显示 225 / 1070，
   而包内落盘的是 225 / 1069。
2. 路径的**脱敏前缀**随导出时 `--workspace` 的取值而变：workspace 根写作 `<workspace>`、用户主目录写作 `~`。
   同一段路径在两次导出里可能表现为 `<workspace>\.local\...` 或 `~\WorkBuddy\...`。

> 除上述两处外，包内日志与现场重新导出的结果**逐事件一致**（已实测比对 225 条事件的
> `seq` / `type` / 正文全部相同）。

### 关于本机路径与账户标识（如实说明）

本作品在**本机 Windows 环境**中真实运行，日志与本机生成的报告中天然带有机主痕迹。
我们对两类文件做了**区别处理**，以便同时兼顾「证据可核验」与「不泄露个人信息」：

- **AGH 官方导出件保持原样，未做任何修改** —— `agh-session.json`、`agh-session.html`、
  `会话历史-累积（含修复前失败）.json` / `.html`。它们是 `agh export` 的**原始产物**，
  改动一个字节就不再是原件，也就无法与现场重新导出的结果逐事件对上。其中含：
  - 部分本机目录名（用户主目录本身已被 AGH 写作 `~` / `<workspace>` 占位）；
  - `actor.id` = AGH 的**本机账户标识**（形如 `acct-…`），由 AGH 作为运行身份写入。
    它**不是密钥**，也不能用于登录任何服务。
- **本团队生成的报告与脚本做了脱敏** —— `运行环境与包状态.txt`、`console/*.txt`、
  `regression/verify_smoke.txt` 中，用户主目录统一写作 `<home>`、
  模型账户标识写作 `<agh-account-id>`、凭据引用写作 `<credential-ref>`；
  `tools/build_dataset.py` 的源表路径与 `tools/check_dem.py` 的项目根改为
  「环境变量 / 脚本位置推导」，不再硬编码任何个人路径。

> **不含任何密钥**：全目录已按 `sk-` / `Bearer` / `password` / `api_key` 等模式扫描，**零命中**。
> 报告中出现的 `authType:"api-key"` 与 `credentialRef:"secret://…"` 是 AGH 的**引用字段**
> （指向本机凭据存储），并非密钥本身；真正的密钥由 AGH 以 Windows 私有 ACL 写入本机 secrets 目录，
> **从未进入本仓库**。评测方若需核对，可用上文命令现场重导一次会话比对。

---

| 文件 | 类型 | 说明 |
| --- | --- | --- |
| `会话回放.html` | AGH 会话记录（**回放演示版**） | **录演示视频时用这个**。自包含单文件，点「▶ 播放」即按真实顺序演一遍：用户指令 → 工具调用（工具名 / 参数 / 只读与联网策略 / 耗时 / `verifier: pass`）→ 结构化返回 → Agnes 作答；支持 1×/2×/4× 与「下一步」。数据逐条取自 `agh-session.json`，**是记录回放而非实时调用**（页面角标已如实标注）。由 `.local/build_replay.mjs` 生成，重跑会话后可一键重建。 |
| `agh-session.html` | AGH 会话记录（可读版） | **建议先看这个**。自包含 HTML 报告，按轮次展开每一次工具调用的输入、结果与状态，浏览器直接打开。 |
| `agh-session.json` | AGH 会话记录（原始版） | 官方 `export --format agnes` 的 NDJSON 会话日志（每行一个事件：`request/header`、`request/sent`、`cost/ledger`、`tool/call`、`tool/result`、`verifier/signal`、`turn/end` …），可机器复核。**225 个事件 / 7 次工具调用（其中本作品工具 5 次，另有 AGH 内置 `tool_search`、`tool_describe` 各 1 次）/ 标记为错误 0 条。** |
| `会话A-工具调用轨迹.txt` / `会话A-模型回答.txt` | 会话 A 原始 **stderr / stdout** | 轨迹 = AGH 打印的工具调用链（`- tool x · ok · N ms`）；回答 = Agnes 模型的最终中文回答。画像带**自定义起点坐标**（`startLon=118.9127, startLat=31.5033`）。 |
| `会话B-工具调用轨迹.txt` / `会话B-模型回答.txt` | 会话 B 原始 **stderr / stdout** | **含异常处置**：先跑正常画像，再故意提交一个必然不可行的画像（60 分钟预算 + 两个相距很远的必去点），观察系统如何如实报告失败与改进建议。 |
| `会话-工具调用与模型清单.txt` | 全量清单 | 从 `agh-session.json` 中抽出的所有工具调用（名称 + 参数）与出现过的模型名。 |
| `自校验结果-逐次调用.txt` | 自校验明细 | 从 `agh-session.json` 里抽出每次 `lishui_trail_plan` 的 `verification` 结论（12 项逐项通过/警告/失败）。**本文件是"自校验不是口号"的直接证据。** |
| `会话历史-累积（含修复前失败）.json` / `.html` | 完整历史（**不裁剪**） | 从最初调试到修复前的**同一条累积会话**导出：1069 个事件 / 50 次工具调用，**其中 5 次被标记为错误**。保留它是为了证明失败是真实发生并被真实修掉的——见下文 §4。 |
| `会话历史-累积-工具调用与模型清单.txt` | 完整历史的清单 | 上一条日志的工具调用/模型清单。 |
| `插件重装与信任记录.txt` | 安装证据 | `disable → remove → install → trust → enable` 全过程输出，含包 integrity、capabilityHash 与最终状态。 |
| `运行环境与包状态.txt` | 环境快照 | AGH 版本、Node 版本、包状态、daemon 状态、运行时快照目录、模型账户配置（**不含密钥**）、凭据文件位置、会话键。 |
| `regression/` | 回归测试输出 | **7 个**测试套件的原始输出：`smoke` / `plugin_check` / `depth_check` / `envelope_check` / `case_matrix` / `id_consistency` / `verify_consistency`（`_verify_summary.txt` 中有逐套件退出码，全部 `exit=0`）。 |
| `console/` | 演示台自检 | 离线演示台的底图渲染自检、接口自检与预览图。 |

---

## 1. 一次会话证明什么

会话 A（自定义起点画像）内，Agnes 模型自主完成 **5 步业务工具调用链**，首次调用全部成功：

```
- tool lishui_trail_status        · ok ·  227 ms   离线数据集与地形能力状态
- tool lishui_trail_plan          · ok · 8691 ms   个性化路线规划（自定义起点坐标）
- tool lishui_trail_risk          · ok · 4813 ms   7 因子加权风险预判
       (模型在第 4 步先调用 AGH 内置的 tool_search / tool_describe 各 1 次，用于发现并确认下一个工具)
- tool lishui_trail_alternatives  · ok ·    7 ms   异常处置：替代点建议
- tool lishui_trail_export        · ok · 7426 ms   GPX / CSV 导出内容
```

> 主证据会话为**规避 Agnes 长回合随机断连**，按「一步一次工具调用」分 5 轮跑成
> （每轮一次 `agh -p`，日志累积在同一条会话键下）。19 次 `verifier/signal` 全部 `verdict: pass`，
> 5 次 `turn/end` 全部 `reason: completed`。

`plan` / `export` 的耗时里含 `replanForVerify` 的第二次求解——"可复现性"这项检查**每次都真跑**，
不是写在文档里的承诺。

会话 B 额外覆盖了**失败路径**：同一画像下预算压到 60 分钟并要求必去两个相距很远的点时，
`lishui_trail_plan` 返回

> 不可行：在给定时间预算与体能约束下，必去点「周园、邰村老街」无法与起点构成一次可完成的行程
> （预算 60 分钟过小，或该点需长距离绕行），因此不生成方案。（建议放宽预算/体能档位，或把起点设在资源点附近）

即：**不静默返回错误答案，也不抛异常**，而是给出可解释的原因 + 可执行的改进方向，
并带 `warnings` 说明是哪几个必去点没被纳入。

> 注：会话 B 的模型回答里写着"工具没有返回结构化的 `reason` / `hint` / `warnings` 字段"——
> 那是模型**只能看到文本 `content`** 的视角（AGH 下发给模型的只有 `content`）。
> 结构化字段确实存在，见 `regression/verify_case_matrix.txt` 第 13 例：
> `reason=…必去点「周园、邰村老街」无法与起点构成一次可完成的行程…`、
> `hint=可尝试：放宽时间预算、改体能档位…`、
> `警告=必去点「周园」超出可达范围，未能纳入。 | 必去点「邰村老街」超出可达范围，未能纳入。`
> ——"文本给模型读、结构给程序用"的分工，正是 AGH 信封约束的体现。

对应到赛项要求：

- **以 AGH 为智能体运行与执行底座**：作品不以独立服务形式运行，能力全部经
  `ctx.extension().registerTool()` 注册，由 AGH 调度、校验并留痕（`tool/call` 带
  `policyHash` / `definitionFingerprint` / `executionDomain`，`tool/result` 带 `enforcement`）。
- **仅使用 Agnes 模型**：会话日志中所有 `request/header`、`request/sent`、`cost/ledger` 的
  `model` 字段均为 `agnes-3.0-flash`；`会话-工具调用与模型清单.txt` 里"出现过的模型"只有它。
- **≥1 条工具/设备调用链**：单轮内 5 次业务工具调用，构成「状态查询 → 路线规划 →
  风险预判 → 异常处置 → 导出」的完整业务链。
- **Agnes 模型参与核心任务**：自然语言画像 → 工具参数，以及结构化结果 → 中文行程说明，两处均由模型完成。
- **离线本地系统**：工具执行全程无网络（`meta.isOpenWorld=false`）；唯一走网络的是模型推理本身。

## 2. 会话日志中的关键事件（可检索）

| 事件类型 | 说明 |
| --- | --- |
| `request/header` + `request/sent` | 每次推理请求：`model`、`derived_hash`、`tool_schema_hash`、`transforms` |
| `cost/ledger` | 每次推理的 token 用量与上游响应 id（Cloudflare 网关的 `x-request-id`） |
| `tool/call` | 工具名、`args`、`resolvedPolicy`（只读/非破坏/并发安全/封闭世界/可重放/免审批）、`policyHash` |
| `tool/result` | 结构化结果与 `content` 文本、`enforcement` |
| `verifier/signal` | AGH 对该次工具调用与整个步骤的校验结论（`verdict: pass`） |

## 3. 复现步骤

见 `docs/AGH接入说明.md`：§2 安装信任启用、§3.1 非交互写入 Agnes 凭据、§4.2 非交互跑会话、
§4.3 导出记录、§6.3 改代码后的重装流程（`.local/reinstall.mjs`）。

**Windows 上必须按 §6.1 带 `NODE_OPTIONS` 预加载补丁**，否则 daemon 无法启动；
改了插件源码后必须按 §6.3 走 `disable → remove → install → trust → enable`，否则运行时会继续使用旧快照；
**导出前必须按 §4.3 用带 `--workspace` 的 daemon**，否则 `export` 会稳定报 `INTERNAL_ERROR (-32603)`。

归位与自检（改完插件重跑会话后按序跑；这些是**本机工作副本**里的便捷脚本，因 `.local/` 含 API Key
与机器路径，提交 ZIP 时按 `docs/提交材料清单.md` §二 已删除——手工等价命令见
`docs/AGH接入说明.md` §4.2 / §4.3 / §6.3）：

```powershell
$env:AGH_HOME = "<AGH_HOME>"
$env:NODE_OPTIONS = "--import=file:///<绝对路径>/lishui-trail/.local/rmpatch.mjs"
node .local/reinstall.mjs            # 改过源码时先跑，保证运行时快照换新
node .local/run_steps.mjs            # 分 5 步跑主证据会话（B 轮加 STEPS_ONLY=6）
node .local/refresh_evidence.mjs     # 会话原始输出 / 重装记录 / 清单 / 环境状态一次性归位
node .local/evidence_audit.mjs       # 各文档"声称的数字"与本目录真实日志逐项对账（exit=0 才算过）
```

## 4. 关于日志里的失败与模型的错误归因（如实说明，不掩盖）

`会话历史-累积（含修复前失败）.json` 是**完整历史**（1069 个事件、50 次工具调用、其中 5 次被标记为错误），
对应会话键 `agnes:local:local-dev:cli:workspace:34ebcd857b9bb539`（与主证据的 `…:44ddc56d6188dff7`
一样，都可用 `agh sessions list` 现场复核其真实存在与事件数），
包含早期几轮里 `lishui_trail_plan` 的失败记录。这不是遮掩，而是本作品最值得一说的一段工程过程。
（主证据 `agh-session.json` 则是**修复之后**新开的一条干净会话：5 次工具调用、0 条错误。）

> **版本说明**：该累积历史产生于「徒步 → 旅游」定位调整**之前**，因此里面还留着当时的提示词与
> 数据集名（"文旅徒步资源数据集"）等旧措辞。日志按原样保留，**不做回改**——它是过程记录，不是当前版本。
> 当前版本的措辞与命名以主证据 `agh-session.json` 及 `data/pois.json` 的 `meta.name` 为准。

### 4.1 已修复的真实缺陷：`E_ENVELOPE`

- **现象**：`lishui_trail_plan` 只要传自定义起点坐标（`startLon`/`startLat`）就**整次调用失败**，报
  `E_ENVELOPE: invalid Host dispatch observation: workspace tool returned an invalid ToolResult`；
  用已知资源点作起点则正常。
- **定位**：AGH Core 的 `isJsonValue` 把 `undefined` 判为非法 JSON 值 → `structured` 里只要有一个
  `undefined` 叶子，整个 `ToolResult` 就被拒。真实原因是合成起点对象缺 `town`，
  即 `structured.itinerary[0].town === undefined`。
- **修复**：① 给自定义起点补 `town`；② 新增 `lib/envelope.mjs`，所有工具出口统一净化返回值
  （丢 `undefined`、非有限数值降级为 `null`、非纯对象摊平、环引用截断）。
- **回归**：`tests/envelope_check.mjs` 以 AGH 的同一判据审计 6 个工具 × 29 组入参，全部通过。

这个缺陷**只在真实 AGH 环境中运行才会暴露**——离线直接调用引擎看不出问题
（`JSON.stringify` 会静默丢弃 `undefined`）。

### 4.2 系统自身的问题：失败路径说不清原因（已修复）

早期版本在预算过小时只返回一句笼统的"没有任何候选点能形成行程"，起点填错时也说不清。
现在：

- 起点落在数据集覆盖范围外 → 明确报出范围、最近资源点名称与距离；
- 必去点被预算挡在门外 → 直接点名是哪几个必去点，并给出改进建议；
- 三处失败出口（`plan` / `risk` / `export`）的结构化返回中都有 `reason` 与 `hint` 字段，
  模型可据此自动改参重试，而不是只能读文本。

对应回归：`tests/case_matrix.mjs`（15 例：正常 5 / 边界 6 / 失败 4）。

### 4.3 模型的一次错误归因（日志保留原样）

在**累积历史**（`会话历史-累积（含修复前失败）.json`）里，模型在 `seq=627` 的中文回答中声称
"工具把 `LS-31` 解释成回峰山……说明第 1 步规划与第 3 步替代候选接口在点位 ID 映射上存在不一致"。

**这是模型自己的判断失误**：同一文件 `seq=594` 的 `tool/call` 显示，它当时实际传的参数是
`{"k":3,"poiId":"LS-02"}`，而 `LS-02` 就是回峰山，工具返回完全正确。

我们保留这段原始输出，不修改日志，并补了 `tests/id_consistency.mjs` 独立核查：
行程 `poiId` → `ds.get()` → `alternatives` 基准点三者一致（162 个点位、0 个重复 ID、0 处不一致）。

**这恰好说明了留痕的价值**：模型的自然语言叙述可能与事实不符，而 AGH 的
`tool/call` 原始参数记录让任何人都能复核。评委若对某句结论存疑，直接查 NDJSON 里的 `args` 即可。

### 4.3.1 同类的叙述失准（主证据会话 step 2，日志保留原样）

主证据会话第 2 步（`lishui_trail_plan`）里，模型在中文回答中把那条唯一警告的成因写成
"该警告对应'当月平均最低温 14.2℃ 可能结冰路面'"。而工具的原始 `verification` 显示，
这条 `warn` 属于**风险阈值**项——"超过 0.9 的因子：偏远与救援(0.999)、涉水与湿滑(1)"。
（该步的 `mitigations` 里恰好也有一条气温提醒，模型把二者混在一起了。）

原始 `verification` 结论是权威且可查的（见 `自校验结果-逐次调用.txt`），
模型的散文复述只是不够精确——**工具结论 → NDJSON，模型复述 → 仅供参考**，
这条边界同样由留痕本身给出证明。

另：主证据会话里模型自拟的轮次标题写作"查询丽水**徒步**路线状态与数据说明"（"丽水"亦系"溧水"之误），
同样只是模型侧的措辞——工具返回与数据集命名均为正确的"溧水…文旅资源数据集"，不做回改。

### 4.4 自校验的零值误报（真实 AGH 运行中发现，已修复）

累积日志里还有一次失败不是模型的问题，而是**我们自己的判据写错了**：

```
[fail] 累计爬升一致性: 独立重算 0 m vs 报告 0 m（偏差 100.00%）
```

两个值都是 0 m，却报"偏差 100.00%"。根因是 `lib/verify.mjs` 里写成
`reported > 0 ? |重算−报告|/报告 : 1`——报告值为 0 时**无条件取 1**。
于是**任何累计爬升恰为 0 的平缓路线**（溧水湖荡区很常见）都会稳定误报失败。

修复方式：一致性判据改为**相对容差与绝对下限取较宽者**（里程 1% / 1 m，爬升 2% / 2 m），
报告值为 0 时只说"差 x m（绝对容差 y m）"，不再输出假精确的 100%。
并新增 `tests/verify_consistency.mjs` 双向守住：零值不得误报，**同时判据不得被放宽成"永远通过"**
（把报告爬升放大 10×、里程放大 3× 必须仍判 `fail`）；`tests/smoke.mjs` 也补了硬断言。

修复后重装插件（新 integrity）、新开一条干净会话重跑，得到本目录的主证据
`agh-session.json`：该轮 `plan` 调用的自校验为 `11/1/0`（通过 11 / 警告 1 / 失败 0），
唯一一条警告是**风险阈值**项——该画像下「偏远与救援」「涉水与湿滑」两个因子权重超过 0.9 提示线，
属预期内的如实告警而非失败。**失败项恒为 0**。逐次明细见 `自校验结果-逐次调用.txt`。
详见 `docs/AGH接入说明.md` §8.4。
