# 执行方案：把 AI 分析记录扩展到非血流玩法

> 状态：**待执行**（2026-09-21 由上一轮会话编写；本轮只出方案，没有动实现）。
> 适用分支：共享文件一律在 **master** 改并提交，然后 `pnpm sync:vibehub`；联机层（`src/game/online/vibe/**`、
> `src/App.vue` 的联机接线）只能在 vibehub 上改。本文件本身是共享文档 ⇒ 走 master。
> 相关文档：设计方案 `replay-ai-analysis-recording.md`、现状与交接 `replay-analysis-reproduction-status.md`
> （§1 现状表、§9 待办、§10 纪律、§10.12 联机路径）。

## 0. 一句话目标

让「莲花广麻」（`lotus-classic`）与「莲花麻将·翻精癞子」（`lotus-legacy`）也把
**决策前态 / 候选 / 选择与来源 / 模型请求 / 结算** 写进本机分析区，并（第二阶段、可选）支持 §6 赛后复现；
与血流**共用同一个分析区**（存储、容量账本、分块压缩、导出导入、列表状态、界面开关都不重做）。

## 1. 事实基线（已在本仓库核对，可直接照用）

| 玩法 | 展示回放 | AI 分析记录 | 引擎形态 |
|---|---|---|---|
| 莲花麻将·血流 `lotus-blood-flow` | ✅ | ✅ | worker 权威 + `EngineCommand` 命令模型（`engine.ts` / `engineWorker.ts`） |
| 莲花广麻 `lotus-classic` | ✅ | ❌ | Vue 状态机（`src/game/core/local/useGame.ts`，控制器 `src/game/core/controllers/playerController.ts`） |
| 莲花麻将·翻精癞子 `lotus-legacy` | ✅ | ❌ | Vue 状态机（`src/game/variants/lotus/lotusGame.ts`，控制器 `src/game/variants/lotus/lotusControllers.ts`） |

关键事实（这几条决定了工作量）：

1. **只有血流引擎拿到了分析端口**：`src/App.vue` 里 `bloodFlowGame = useBloodFlowGame({ …, analysis: analysis.port })`
   （约 275/280 行）；`localGame = useGame({ …, recorder: replay.hooks })`（约 240）、
   `lotusGame = useLotusGame({ …, recorder: replay.hooks })`（约 252）**都没有** `analysis`。
2. **分析场次只在血流本地对局开**：`watch(() => (gameMode === 'local' && selectedRule === 'lotus-blood-flow' ? phase : null), … → analysis.start({…}))`（约 565 行）。
3. 代码事实：`analysis` 引用只出现在 `src/game/variants/lotus/bloodFlow/**`；`useGame.ts` / `lotusGame.ts` 里 **0 处**。
4. 分析模块 **13 个通用** + **6 个血流专属**：
   - 通用（**不要重写**）：`session.ts`（开关活值、代理恒存在、`start/finish`）、`storage.ts`、`idb.ts`、`codec.ts`、
     `fragments.ts`、`leases.ts`、`capacity.ts`、`capability.ts`、`export.ts`、`import.ts`、`status.ts`、
     `recorder.ts`、`types.ts`。
   - 血流专属（**每个玩法各要一份对应物**）：`bloodFlowAdapter.ts`（决策窗口/前态投影）、`decisionSink.ts`（LLM 接缝）、
     `commandEntry.ts`（权威动作条目）、`onlineReproduction.ts` + `openingFromReproduction.ts` + `replayReproduction.ts`（§6 复现）。
5. 三个玩法**都已经接好的接缝**：展示回放 `ReplayRecorderHooks`（`src/game/replay/types.ts:188`：
   `roundStart / draw / discard / tableAction / roundEnd`）。它标出的位置正好就是"动作发生的汇聚点"——
   P0 的记录可以挂在这些位置 + 控制器调用处，不必凭空找钩子。
6. 经典玩法的模型接缝：`createLocalLlmControllers` / `createLotusLlmControllers`
   （`src/game/llm/runtime.ts:160 / 184`），入参是 `LlmControllerHooks`
   （`src/game/llm/llmController.ts:67`）——它**只有** `onLlmMessage / onLlmFallback / onLlmStatus / onReset`，
   **没有**请求级生命周期、没有候选与推荐。要做 §4 的"请求内容引用"，必须给它加**可选**钩子（见 §3.2）。
7. 人类动作入口：`useGame.ts` 的 `playerActions.userDiscard/userPass/...`（228-229 行附近引用）、
   `lotusGame.ts` 的同类入口（246-247、379 行附近）——人类提交的唯一入口就在这些函数里。

## 2. 开工前要定的三件事（需要产品/用户拍板）

- **D1 先做哪个玩法**：建议一次只做一个（`lotus-legacy` 或 `lotus-classic`），做完一个再复制到另一个；
  两个引擎的编排不同，同时改容易互相污染。
- **D2 要不要 P1（§6 赛后复现）**：要复现就必须给经典引擎补"开局快照 + 权威动作日志"出口（见 §4），
  这是本方案里最贵的一块；只做 P0 的话**不用碰引擎内部**，风险低得多。
- **D3 开关语义**：现在是**全局**开关且只对血流生效（打开它去玩莲花广麻什么也不会发生，容易被当成"开关坏了"）。
  三选一：① 开关文案/旁边标注"目前支持：血流"（最小）；② 做能力探测（列表里每行状态已经能表达）；
  ③ 每个玩法独立开关（最复杂，不推荐）。

## 3. P0：能归因（不含复现）——每个玩法一套

### 3.1 新增 `<Variant>Adapter.ts`（放 `src/game/replay/analysis/`）

职责与血流 `bloodFlowAdapter.ts` 对齐，导出四个纯函数：

```ts
// 决策窗口：谁、什么时候、有哪些合法动作
export function decisionWindowOf(state: VariantTableState): {
  windowId: string          // 见下方"窗口 ID 规则"
  kind: 'turn' | 'claim' | 'win' | 'other'
  seat: number              // 绝对座位（不是本机视角的旋转座位）
  legalActions: AnalysisLegalAction[]
} | null

// 决策前态：**只含该座位当时可见的信息**（§10.4 隐私护栏）
export function decisionStateOf(state: VariantTableState, seat: number): AnalysisDecisionState

// 窗口内稳定候选 ID：与 legalActions 一一对应（血流的等价物是 `${windowId}/${下标}`）
export function legalActionId(windowId: string, index: number): string

// 把玩法自己的结算模型折成分析区的结算引用（§5）
export function settlementsFromResult(result: RoundResult, state: VariantTableState): AnalysisSettlement[]
```

要点：

- **窗口 ID 规则（必须可离线复算）**：经典玩法没有权威版本号。建议
  `` `${roundId}/turn/${actionCounter}` ``，`actionCounter` 是"本局内第 N 次进入决策"的自增计数
  （**不要用时间戳、不要用渲染帧号**）；同一局内稳定、且能从记录/回放侧复算出来，否则 §11 的
  "两侧同编号窗口类型对照"和 P1 的重放都无从对齐（血流踩过：漏传 `windowId` 会让条目被排到序列末尾）。
- **隐私护栏**：`decisionStateOf` 只放该座位自己的手牌/副露 + 四家公开牌河、副露、分数 + 局/庄 + 剩余牌数；
  **不得**出现别家暗手、未摸牌墙顺序（血流的 d 用例就是"字段形状 + 遮蔽"两条断言，照抄）。
- 参考实现：`src/game/replay/analysis/bloodFlowAdapter.ts`（`choiceTookEffect` / `windowKindOf` / `seatLegalActions` 的语义都可平移）。

### 3.2 记录时序（挂在两个位置）

| 时机 | 调用 | 判据 |
|---|---|---|
| 进入某座位的决策 | `recorder.windowOpened({ windowId, seat, windowKind, roundIndex, authorityEpoch, stateVersion, state, openedAt })` | 每个窗口每座位**只记一次**（用 `Map<windowId/seat>` 兜住重复渲染） |
| 作出选择 | `recorder.chosen({ windowId, seat, source, legalActionId, at })` | `source`：人类 = `human`；本地 AI = `rule-auto`；模型 = `model`（回退时 `model-fallback`，由 sink 修正） |
| 动作真的执行了 | `recorder.receipt({ windowId, seat, status, detail })` | 经典玩法没有权威回执 ⇒ 用"动作是否真的改了状态"判定（`executed` / `state-changed`），**不要**因为"函数被调用过"就记 `executed` |
| 模型请求 | `recorder.attemptStarted(...)` / `attemptFinished(...)` | 见下方钩子扩展 |
| 每次结算 | `recorder.settlement(...)` | 从 `RoundResult` 折算，见 3.1 |
| 中途退出 / 异常 | `recorder.noteGap({ scope, reason })` | 与血流同口径（`match-aborted` 等） |

**模型接缝（本方案里唯一动到共享运行时的地方）**：给 `LlmControllerHooks`
（`src/game/llm/llmController.ts:67`）加**可选**钩子，例如：

```ts
export interface LlmControllerHooks {
  // …现有 4 个保持不变
  /** 一次真实请求开始：候选、推荐、模型与提示词引用（§3.3、§4）。不传时零成本。 */
  onDecisionRequest?(input: {
    seat: number; requestId: string; windowId: string; legalActions: AnalysisLegalAction[]
    candidates: Array<{ id: string; label?: string; summary?: string; action: unknown }>
    recommended?: { candidateId: string; note?: string }
    promptTemplateId: string; promptVariables: unknown; provider: string; model: string; sentAt: number
  }): void
  /** 一次请求结束：原话回答、解析结果、用量、失败与回退原因。 */
  onDecisionAnswer?(input: {
    requestId: string; raw: string; choice: string | null; outcome: 'success' | 'invalid' | 'timeout' | 'error'
    fallback?: { reason: string }; usage?: unknown; responseModel?: string; completedAt: number
  }): void
}
```

在 `src/game/llm/llmController.ts` 真正发请求/解析回答的地方调用这两个钩子（不传时**一个分支都不进**，
与血流 `promptTemplate` 去重存一次的思路一致）。注意：**必须逐字保存实际发给模型的变量**
（血流有单测断言"记录的变量与 `messages.user` 逐字相等"），提示词模板按 `promptTemplateId` 去重只存一次。

### 3.3 接线与开关

1. `src/App.vue`：给 `localGame` / `lotusGame` 传 `analysis: analysis.port`。
2. `src/App.vue` 的 `analysis.start(...)` 条件从"仅血流"改成**按玩法能力**：
   `const analysisCapable = computed(() => ['lotus-blood-flow', <新玩法>].includes(selectedRule.value))`，
   并把 `seatControl` 按该玩法的座位来源填（`human` / `local-ai` / `llm`；**绝对座位**，不是本机旋转座位）。
3. 关闭开关时零成本：所有 `recorder?.xxx()` 都走代理，关闭时是空转（`session.ts` 已保证）；
   **任何记录代码都不得抛错影响对局**（血流的所有写入点都套了 try/catch 或走代理）。
4. 列表状态：新玩法的场次之后应显示「分析：完整」（`match.analysisRecorded` 由 `analysis.active()` 提供）；
   没接的玩法仍是「分析：未开启」——这是**正确**文案，别去改 `status.ts` 的规则。

### 3.4 P0 的交付物

- `src/game/replay/analysis/<variant>Adapter.ts`（新）
- `src/game/replay/analysis/<variant>Adapter.test.ts`（新）
- `src/game/llm/llmController.ts` + 测试（钩子扩展）
- 对应玩法的引擎/编排接线（记录调用点，**不改对局行为**）
- `src/App.vue`（端口 + 开关条件）
- e2e：`tests/e2e/analysis-<variant>.spec.ts` + fixture（照 `tests/e2e/fixtures/analysis-probe.{html,ts}` 写）

## 4. P1（可选）：§6 赛后复现——每个玩法一套

复现需要"完整初始局面 + 权威动作序列"，经典玩法现在**都没有**：

1. **开局快照**：在该玩法"发牌完成、进入第一手"的构造点留一份不可变快照
   （牌墙剩余顺序、四家手牌、庄家第 14 张下标、骰子、翻精/癞子、开墙参数、当局开局分数）。
   血流的等价物是 `BloodFlowEngineOptions.recordCommands` 时的 `initialOpening`（**构造时**快照，不是局末读状态）。
   ⚠️ 经典玩法的随机会继续出现在后续摸牌/翻精里 ⇒ 必须存**物理牌墙**，不能只存种子（§6 原文）。
2. **权威动作日志**：在"动作应用唯一汇聚点"记录 `{ seat, kind, 载荷…, windowId }`，
   形状与 `analysis/commandEntry.ts` 的 `AnalysisCommandEntry` **保持一致**（两处共用同一个映射函数，
   血流的教训就是"两个写入方两套写法"导致假性失配）。被拒绝/未生效的动作**不入列**。
3. **离线重跑**：写 `<variant>Reproduction.ts`（参考 `replayReproduction.ts`）：
   用快照重建引擎 → 依序把日志还原成"当时的合法动作"提交 → 中途命令用尽/对不上就**如实报错**
   （不许跳过命令继续跑）→ 比对结束分数；记录缺 `openingScores` 时明确报"不可比对"。
4. **联机（若同期做）**：按血流的模式做权威端局后下发（`onlineReproduction.ts` + 中继 +
   `analysisReproduction` 房间级标志），并遵循 AGENTS.md 的**上线两场**验收。

## 5. 验收标准（照抄）

**单测**（每个 adapter 至少这几条）：

- `decisionStateOf` 的**字段形状 + 遮蔽**：别家手牌为空数组 + 只给张数；不含未摸牌墙顺序（字段一多就失败）。
- 窗口 ID 稳定性：同一局面重复计算得到同一 ID；跨局不重复；缺 ID 的条目数为 0。
- `legalActionId` 与 `legalActions` 一一对应；被拒动作不产生记录。
- 结算折算：四家分数变化之和为 0；`openingScores`/`endingScores` 与当局开局分对得上。
- LLM 钩子：不传时零调用；传了则**记录的变量与发给模型的 `messages.user` 逐字相等**；模板按 id 去重只存一次；不含 API Key。

**e2e**（`pnpm test:e2e -- analysis-<variant>`，dev server 需在 4173/4174 且用 `E2E_SKIP_WEBSERVER=1` 复用）：

- 跑完整场（或一局）→ 从**分析库**（`lianhua-guangma-analysis`）读回 → 断言：
  `parts` 形状（`config/decisionState/decision/llm/settlement`）、行内状态「分析：完整」、
  导出包自包含（记录 + 被引用配置 + 展示回放）、开关关掉后**不产生任何写入**。
- 若做 P1：另加"逐局重跑到同一结束状态"（命令全消费、`kindMismatches=0`、结束分数一致）。

**联机**（若涉及联机层）：`pnpm deploy:vibehub` → 用 `tmp/online_test` 两账号跑两场
（`tests/e2e/online-two-accounts-two-east-matches.spec.ts` 的血流用例是模板；新玩法需要新用例），
证据落 `tmp/bf-online-evidence/`。

## 6. 已知的坑（本仓库这几轮踩过，别再踩）

1. **别把"主工作区当前 checkout 的内容"当 master**：主工作区可能停在别的分支上（曾把 `fix/lobby-room-sync-visibility`
   的 App.vue 提交进 master，导致 master typecheck 直接挂）。共享文件一律在**干净 master 工作树**里改：
   `git worktree add <tmp> master`（若 master 已被别的工作区检出，就用 `--detach <sha>`），用完删掉。
2. **"测试通过"要说清在哪棵树上跑的**：同一棵树里可能同时有别人已提交的改动（曾报 1892，实际干净 master 是 1852）。
3. **异步回传让记录顺序 ≠ 执行顺序**：机器人/模型动作是异步回传的，必须带可比较的窗口判据（窗口 ID + 序号），
   不能靠数组顺序（血流为此吃过一次亏）。
4. **记录不得影响对局**：所有写入走代理/容错；分析关闭或落库失败时只留痕，绝不抛错。
5. **动作只记一次**：经典玩法是 Vue 渲染驱动的，同一动作可能在多个 watch/渲染路径出现，用
   `Map<windowId/seat>` 之类的闩锁兜住重复。
6. **窗口 ID 必须可离线复算**（P1 的前提）：用计数器，不用时间。
7. **提交纪律**：`pnpm typecheck` + 相关测试通过再提交；共享改动在 master 提交后 `pnpm sync:vibehub`；
   vibehub 专有改动单独提交；文档与源码一律用编辑工具改（不要用 PowerShell 文本改写）。

## 7. 建议的第一步（最小可验证切片）

1. 选一个玩法（D1），只做 **P0 + 人类座位 + 本地 AI 座位**，LLM 座位先记 `source: 'unknown'`、不接钩子；
2. 写 adapter + 单测（遮蔽与窗口 ID 稳定性），跑通 e2e：记录形状 + 状态标签 + 导出包；
3. 再补 `LlmControllerHooks` 的两个可选钩子 + sink 接线（含"变量逐字相等"单测）；
4. 如果确实要复现（D2），单独开一轮做 §4（要动引擎，风险最高，单独排期）。

## 附：现成命令（本仓库通用）

```powershell
# 共享代码改完
pnpm typecheck
pnpm test                     # vitest（src 下）
pnpm sync:vibehub             # master → vibehub（要求 master 工作树干净）

# e2e（本地）
pnpm dev -- --port 4174 --force      # 后台起 dev server
$env:E2E_PORT='4174'; $env:E2E_SKIP_WEBSERVER='1'; npx playwright test tests/e2e/analysis-p2p.spec.ts --reporter=list

# 线上部署 + 线上验收（vibehub 工作区）
pnpm deploy:vibehub                  # = 构建 + vibehub-windows-x64.exe update --slug B5AJupT1
$env:E2E_SKIP_WEBSERVER='1'; $env:ONLINE_PHONE_ROOM='AAAAAA'
npx playwright test tests/e2e/online-two-accounts-two-east-matches.spec.ts -g "血流" --workers=1 --reporter=list
# 凭据在 tmp/online_test（CLI 在 %LOCALAPPDATA%\VibeHub\bin\vibehub-windows-x64.exe）
```
