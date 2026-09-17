# LLM 座对照实验：下一步三项任务交接（2026-09-17）

> 本文面向**新对话/新会话**：不依赖任何对话记忆，读完即可执行。
> 前置结论与全部数据见 [`llm-vs-local-ev-2026-09-17.md`](llm-vs-local-ev-2026-09-17.md)。

## 0. 一句话背景

在**莲花麻将·血流**（2026-09-15 版番表 + 杠规则）里，用同一套本地引擎驱动 4 个座位，
把其中 1 个座位换成外接大模型（**只用 `deepseek-flash`**；`deepseek-v4-pro` 因成本已停用，见 §1），**只走官方端点**），
实测该座位**平均每局亏 225~252 点**且统计显著（t = −3.57 / −2.58）。
机制已定位：模型的同类弃牌改牌**用番型潜力换听牌速度**（潜力更低:更高 = 165:58，平均 −0.745；向听 103:2 变好）。

**本文件要做的三件事**：D（覆盖成败归因）→ ε-容忍约束 → A（LLM 当调参者）。

## 1. 测试台用法（现成可用，无需重建）

```bash
# 生成分片脚本：模型 座位数 总rounds 分片数 tag
node tmp/make-shards.mjs deepseek-flash 1 300 3 my-tag
# 可选 env：
#   SHARD_QUALITY=1     开逐次覆盖质量钩子
#   SHARD_PROGRESS=10   每 N 局写进度
#   SHARD_MAX_CALLS=N   ⛔ **硬性调用上限**（每片）；达到后不再调用模型、其余窗口回落本地 EV，
#                       结果里带 `budgetExhausted: true` 与 `calls`。**跑任何付费批次都请设它** ✓

# 启动（**必须**用 DSH 后台作业机制，别用游离 Start-Process，否则 GUI 面板看不到、也停不掉）
powershell -NoProfile -ExecutionPolicy Bypass -File tmp/run-llmab.ps1 my-tag

# 分析
node tmp/llmab-analyze.mjs my-tag                 # 单批：净分/t/胜负/覆盖率/覆盖矩阵
node tmp/llmab-compare-models.mjs tagA tagB       # 多批并排
node tmp/llmab-quality-analyze.mjs my-tag         # 覆盖质量：Δ向听/Δ进张/Δ潜力/Δ风险
node tmp/llmab-table-compare.mjs expTag baseTag   # 整桌 vs 基线（同种子逐局对齐）
```

- 座位模式（`LLM_SEATS`）：`1` 单座逐局轮换 / `2` 成对轮换 / `4` 整桌 / `0` 纯 EV 基线
- 进度：`tmp/bulk/llmab-<tag>-*.json.progress`（每 N 局一行；结果 JSON **只在整片跑完后**才写盘，中途别杀）
- 模型与端点：脚本内**断言必须**是 `https://api.deepseek.com/v1`；官方可用 id 只有 `deepseek-flash`、`deepseek-v4-pro`
  （`deepseek-v4.1-flash` 官方不认；orcaRouter 能服务但它属于**中转**，用户明令不走；GLM 本轮不用）
- ⛔ **`deepseek-v4-pro` 已停用（2026-09-17 用户决定）**：一次 300 局实测花了 **¥300+**，且**缓存零命中** ✗。
  后续所有批次**只用 `deepseek-flash`**；pro 的既有结果仅作历史结论保留，不要再跑。
- 💡 **缓存为什么打不中（已定位，代码证据；flash 与 pro 一样都打不中）**：`bloodFlowDecisionInput.ts` 的 `state` 由
  `buildPublicDecisionSnapshot()` 打头，而它的**最初几个字段就是每次都变的** `requestId`/`stateVersion` ✗
  → 每次调用的 prompt 从 byte 1 起就不同 → 前缀缓存（要求前缀逐字节相同）**永远无法命中** ✓。
  **这与模型无关** ✗（2026-09-17 用户实测：flash 同样大部分不命中）→ **不要指望换模型或等缓存降本** ✓。
  可缓存内容只有稳定前缀：system 说明（975 字符）+ `ruleSummary`（1,270 字符）≈ **2,245 / 10,159 字符 ≈ 22%** ✓
  → 把它们移到**最前**预计只能省约 **20%** 输入成本 ✓（不是 10 倍 ✗）。
- 💰 **降本杠杆表（按效力，成本决策请照此表）**：

| 手段 | 预计降幅 | 代价 / 前提 |
|---|---|---|
| **Gating / ε：跳过"无意义窗口"不调模型** | **最大**：调用次数按跳过比例**线性下降**（比例待任务 ε 实测） | 需实现 + 开关 + A/B；**同时缩短对局时间** ✓ |
| 生产只保留 1 个 LLM 座（而非整桌） | **4×** | 产品决策（玩法/体验取舍） |
| 再瘦身载荷（候选块占 user 的 58%：可砍 `summary` 散文、进张列表再收窄） | 再降 20~30% 输入 | 信息减少 → 需 A/B 验证行为 |
| 稳定内容前置（前缀化，仅顺序改动） | ~20% 输入 | 需小样本复测行为不变 |
| 换模型（flash↔pro） | **无效** ✗（缓存与模型无关） | — |

- 🛑 **硬性花钱上限（已实现）**：`MAX_CALLS=N`（单进程）或 `SHARD_MAX_CALLS=N`（分片批量）—— 达到上限后**不再调用模型** ✓，
  其余窗口自动回落本地 EV ✓，结果 JSON 里带 `budgetExhausted` 与 `calls` ✓。**跑任何付费批次都先设它** ✓。
  参考量级：1000 局（1 座）实测 **33,197 次调用**、每次约 4.6k token ≈ **1.5 亿输入 token** → 按官方单价自己折算上限 ✓。
- 密钥：读 `tmp/test-api-key.json` 的 `presets`（**不要**打印密钥）
- 成本量级：提示词瘦身后约 **4.6k token/次**；1000 局（1 座）≈ 47k 次调用

## 2. 已完成批次（别重复跑）

| tag | 配置 | 局数 | 每座每局净分 | t | 覆盖率 |
|---|---|---|---|---|---|
| `flash-1seat` | flash 1 座 | 1000 | −224.7 | −3.57 ✓ | 11.98% |
| `pro-1seat-300` | pro 1 座 ⛔**不再使用** | 300 | −251.5 | −2.58 ✓ | 13.98% |
| `mixed2-flash-300` | flash 2 座（2v2） | 300 | −116.0 | −1.86 ✗ | 11.83% |
| `ev-baseline` / `ev-baseline2` | 纯 EV 基线 | 1000 | —（恒 0） | — | — |
| `flash-4seat-100` | flash 整桌 | 100 | —（恒 0） | — | 12.5% |
| `quality-flash` | flash 1 座 + 质量钩子 | 200 | — | — | 12.07% |
| `quality2-flash` | 同上（含价值侧指标） | 100 | — | — | 11.88% |

原始数据：`tmp/bulk/llmab-<tag>-*.json`（每片一个 ✓）

## 3. 任务 D：覆盖成败归因（最便宜，先做）

**问题**：3,978 次覆盖的 **−225/局 是平均值**；是否存在**某一类是赚的**？若有 → "LLM 超过引擎"就有具体入口；若全为负 → 转向任务 A。

**做法**（建议顺序）：
1. 用现有钩子重跑 200~400 局（`SHARD_QUALITY=1`）——已有 Δ潜力/Δ风险/Δ向听/覆盖矩阵类别。
2. **补一层结局归属**：给每次覆盖打 `seed + roundId + step` 标记，局末回填"该座位本局是否胡/胡的番型与得分/本局净分"，再看**分档结果**：
   - 按 Δ潜力分档（≤−1 / −1~0 / ≈0 / >0）× 按 Δ风险分档 × 按窗口类型（自摸改张、点炮弃牌、过/碰/吃/杠）
   - 优先用**局内前后对比**（同一座位同一局内覆盖前后 EV 变化）以规避选择偏差（"零覆盖的局"多半是该座位已锁手/已胡，正分是选择性偏差）。
3. 交付：每类覆盖的样本数 + 平均 Δ潜力 / Δ风险 + 与局净分的关系 + **明确回答"有没有正的一类"**。

**成本**：2 片 × 200 局 ≈ 30~40 分钟。**只用 flash** ✓（pro 已因成本停用 ✓）。

## 4. 任务 ε：ε-容忍约束实验（产品代码改动，**同时是最大的降本项**）

**问题**：给模型的自由度划边界后，亏损能否归零？——**并顺带回答：能省掉多少调用**。

**做法**：
- 在 LLM 决策落地处加"允许改牌"的条件：`|EV(模型选择) − EV(本地建议)| ≤ ε`，超出则**不采用模型选择**（更省时间的做法：直接**不调用模型**，用建议 ✓）。
- 务必做成**开关**（env 或 `BLOOD_FLOW_*` config ✓），不要改死；改动只落在 AI 策略层，**不得触碰规则/计分/合法性**。
- 建议三个臂（同一批种子）：`ε=0`（等价照抄，基线）、`ε=小`（如潜力差 ≤0.1）、`ε=中`（≤0.3），每臂 **300~500 局**。
- 验收：各臂净分 ± SE、t 值，与现状 `flash-1seat`（−224.7）对比；并记录调用次数/延迟变化（ε 越小 → 调用越少 → **对局更快**）。

**流程要求**：master 上提交 → `pnpm test` 全量 + `pnpm typecheck` → `pnpm sync:vibehub` → push。
**省钱优先**：这一项本身就是**最大的降本杠杆** —— 明显该打哪张的窗口**不调用模型**，调用次数与对局耗时同时下降 ✓。
建议先量"ε 多大时调用次数降到多少"，再谈净分是否变差 ✓。

## 4.5 任务 C′：提示词前缀化（可选，收益有限，先算再动）

把**稳定内容**（`ruleSummary` 1,270 字符 + 系统说明 975 字符）放到 prompt 的**最前**，volatile 的
`requestId`/`stateVersion`/牌局状态放最后 → 让前缀缓存**有可能**命中。
**预期收益上限约 20% 输入成本** ✗（可缓存前缀只有 ~1k token），**不要**指望它把成本降一个量级 ✓。

## 5. 任务 A：LLM 当调参者（长期唯一可能超过人工调参的路径）

**问题**：让模型的通用推理用在"**提假设**"而不是"做决策"。

**做法**：
1. 冻结当前参数，跑 1200 局基线：`work/blood-flow-pair-harness.test.ts`（前端/后端逐例一致性）+ `tmp/pattern-rate-bulk.test.ts`、`tmp/fan-ab.mjs`（纯本地、无 API）。
2. 让模型看：基线数据 + `docs/blood-flow/design/ai-strategy.md`（现有策略与公式）+ `docs/blood-flow/records/pattern-table-2026-09-15.md`，产出 **3~5 条可实施的改动假设**（权重/特征/门槛，别给"多思考"这种空话）。
3. 逐条实现为开关 → 1200 局 A/B → **只保留显著更好且不破坏既有指标的**。
4. 记录进 `docs/blood-flow/records/`，写清复原命令与回退开关。

**边界**：规则/计分/合法性不变；每条改动必须有回退开关；不追求"LLM 下棋更强"，只追求"它提的改动让引擎更强"。

## 6. 环境与流程陷阱（我踩过，务必避开）

- **改完先冒烟**：1~2 局验证（我曾引用未初始化变量 → 5 片全在第 25 局崩 ✗；包装脚本还空转 90 分钟 ✗）。
- **并发**：flash 5 片 OK；**pro 并发会被供应商限流** → pro 用 2~3 片。
- **后台作业**：用 DSH `run_in_background`，不要游离 `Start-Process`。
- **别中途杀分片**：结果 JSON 只在跑完写盘。
- **禁止用脚本改写源码**：PowerShell `Get-Content|Set-Content` 会毁中文（本仓库已踩两次）→ 用编辑工具。
- **命令行别传中文**（会被转码）→ 用文件或 unicode 转义（如 `grep: /[\u6d41\u884c]/`）。
- **量 prompt 体积只量 `messages`**：整个 prompt 对象含重复副本，曾让我高估 3 倍。
- **线上验收别与重并发任务同机**：我曾因此把验收浏览器压垮（`Target page, context or browser has been closed`）。

## 7. 与本三项无关但别忘的待办

- 后端镜像 `96d04ed` 需**上线重启**（WS 侧提示词瘦身）。
- **普通机器人臂线上验收需重跑**（上次因并发失败）；临时 config 已备份在 `tmp/playwright.bfk-llm.config.ts`、`tmp/playwright.bfk-plain.config.ts`（用时拷回 `work/vibehub-theme11v/`，用完删掉再 `pnpm sync:vibehub`）。
- 可选：把 pro 补到 1000 局 / 整桌补到更大样本。

## 8. 关键文件

- 测试台：`tmp/llm-vs-ev.test.ts`（驱动器 + 质量钩子）、`tmp/make-shards.mjs`、`tmp/run-llmab.ps1`
- 分析：`tmp/llmab-analyze.mjs`、`tmp/llmab-compare-models.mjs`、`tmp/llmab-quality-analyze.mjs`、`tmp/llmab-table-compare.mjs`
- 决策链路（产品侧）：`src/game/variants/lotus/bloodFlow/ai.ts`（`decideBloodFlowActionEv`、`bloodFlowOpponentRisk`）、
  `src/game/variants/lotus/bloodFlow/evContext.ts`、`patternPotentials.ts`（`patternPotentialTotal` / `patternPotentialEv`）、
  `src/game/llm/bloodFlowDecisionInput.ts`、`src/game/llm/bloodFlowRuntime.ts`、`src/game/llm/candidates.ts`
- 结论记录：`docs/blood-flow/records/llm-vs-local-ev-2026-09-17.md`
