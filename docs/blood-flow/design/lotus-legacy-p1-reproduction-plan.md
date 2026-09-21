# 执行方案：翻精癞子 P1「赛后复现」（§6、§10.6 口径）

> 状态：**待执行**（2026-09-21 由协调者编写；本轮只出方案 + 建分支，不动实现）。
> 前置阅读：`analysis-recording-other-variants-plan.md`（总方案）、
> `analysis-two-variants-work-agreement.md`（协作与冻结清单，**必须遵守**）、
> `analysis-lotus-legacy.md`（B 写的 P0 玩法文档：字段口径、窗口 ID、未做的部分）。
> 参考实现（血流已经把 P1 做完并线上验收过，照着抄）：
> `src/game/variants/lotus/bloodFlow/engine.ts` 的 `recordCommands` / `initialOpening` /
> `recordedCommands`、`src/game/replay/analysis/commandEntry.ts`、
> `openingFromReproduction.ts`、`replayReproduction.ts`。

## 0. 一句话目标

让翻精癞子的分析记录**能离线重跑同一局并到达同一结束状态**：把"这一局的确定性起点（牌墙+骰子）+
权威动作/过牌序列"记进分析区，并提供校验器重跑比对结束分数。
P0 已经记了"决策是什么"；P1 补的是"**能不能重放**"。

## 1. 已核实的关键事实（决定了工作量）

| 事实 | 证据 |
|---|---|
| 开局支持**确定性重跑** | `lotusGame.ts:543` 的 `startGame(mode, startOptions)` 把 `startOptions` 转交 `openingTimeline.start`；`lotusOpening.ts:56/72/113` 用 `startOptions.initialWall`（**环状牌墙 136 张**）与 `openingDice/openingSecondDice`，其余（翻精/精牌/开墙）由 `resolveFlip/resolveOpeningStack/wallBreakIndexForOpeningStack` 从牌墙+骰子确定 |
| 同一副牌确实能重跑出同一个局 | B 的硬护栏用例「同一副牌在分析开/关两种设置下，结束分数与动作数完全一致」（`tests/e2e/analysis-lotus-legacy.spec.ts:160`） |
| 记录接缝已经就位 | `analysisSink`（`lotusLegacyAdapter.ts:540` 的 `createLotusLegacyDecisionSink`）+ 引擎里的 `windowOpened/windowClosed`；动作汇聚点已经在记录（discard / meld / 结算回执 / 局末） |
| 引擎是 **Vue composable**，不是纯函数 | `useLotusGame` —— 校验器要在**浏览器页面**里跑（夹具形态），不要在 Node 里硬来 |
| 现有夹具已能把定时器压到 0ms | `tests/e2e/fixtures/analysis-lotus-legacy.ts` 注释「节奏压缩：所有定时器 0ms，整场几秒跑完」 |
| 分析记录类型是血流口径的 | `AnalysisReproduction`（`analysis/types.ts`）字段是 `initialWall`(发牌后 81)/`initialHands`/`dealerDrawnIndex`…，**与环状牌墙不是一回事** ⇒ 见 §3.1 |

## 2. 交付物（P1）

1. **开局快照**（每局一次，`openings` 落在 `AnalysisReproduction` 上）：
   - `ringWall`：**环状牌墙 136 张**（牌码）—— §6 要求"保存牌墙优先于只保存随机种子"；
   - `dice`：`first`/`second` 两对骰子（重跑必须给，否则重抽）；
   - `dealer`、`roundIndex`、`openingScores`（四家、当局开局分）；
   - **交叉校验用**（不是重跑输入，见 §3.3）：`postDealHands`（四家发牌后的手牌）、
     `flipTile`、`jokers`、`wallBreakIndex`、`flipSeat`、`flipStack`。
2. **权威动作日志**（每局一次，`commands`）：与 P0 决策记录同源、**同顺序**，
   形状直接复用 `AnalysisCommandEntry`（`commandEntry.ts`）：`{seat, kind, tile?/tiles?/handIndex/from/meldIndex?, windowId, windowKind, resolution}`；
   被拒/未生效的动作**不入列**（P0 已经做到：回执只在真的改状态时记 ✔）。
3. **校验器**（新文件，放 `src/game/replay/analysis/reproduceLotusLegacy.ts` 或与适配层同处）：
   `replayRound({ reproduction, commands, expectedScores }) → { ok, reason, finalScores, kindMismatches, metrics }`，
   判据与 `replayReproduction.ts` 一致：命令对不上就报错、命令用尽未结束就报"记录不足"、
   缺 `openingScores` 就报"不可比对"，**绝不跳过命令继续跑**。
4. **导出/能力标注**：导出的分析包里这类记录要算进 `reproductionCapable`
   （现在两个玩法如实标 `false`；做完要改成按记录实际内容判定，别一刀切）。

## 3. 逐项设计与坑

### 3.1 记录类型：扩展现有 `AnalysisReproduction`（而不是另开一套）

在 `analysis/types.ts` 的 `AnalysisReproduction` 上加**可选**字段（向后兼容，旧记录照样读）：

```ts
/** 环状牌墙（136 张，牌码）：本玩法的重跑起点，与血流的"发牌后剩余牌墙"不同口径。 */
ringWall?: string[]
/** 开局骰子（重跑必须给，否则重抽）。 */
dice?: { first?: number[]; second?: number[] }
/** 发牌后的四家手牌：**只用于交叉校验**（见 3.3），不是重跑输入。 */
postDealHands?: string[][]
/** 这份复现数据属于哪个玩法（'lotus-legacy' 等），读取侧据此选校验器。 */
variant?: string
```

⚠️ 这是**冻结文件**（约定 §3）⇒ 要么由协调者走"公共改动"提交，要么在方案里先跟协调者确认后再改。

### 3.2 快照在哪一刻取（这一条最容易取错）

**必须在"发牌完成、进入第一手决策之前"取**：`lotusGame.ts` 的 `createLotusOpening({ …, beginTurn })`
（`:526`）回调 `beginTurn` 就是那一刻。局末再读 `state.players/wall` 拿到的是终局状态，
不是复现起点（血流踩过一模一样的坑）。

取的内容来自 `state`：`wall.value`、`players[i].hand`、`players[i].score`、`dealer.value`、
`drawnTileIndex`、`flipTile.value`、`jokerTiles.value`、`wallBreakIndex.value`（骰子从 `startGame` 的
`startOptions` 或引擎自己记录的开局参数里拿）。

### 3.3 交叉校验（本方案特有，建议做）

重跑时先用 `ringWall + dice` 重新发牌，**比对 `postDealHands`**：
不一致就直接报「发牌算法变了或记录与引擎不一致」，**不要**继续跑——
否则你只是拿另一副牌跑了一遍，却会得出"复现成功/失败"的错误结论（血流在"复现数据缺字段"上吃过同类亏）。

### 3.4 动作日志：从现有汇聚点产出，不要新找钩子

P0 已经在这些位置记录了动作/回执，P1 只是在同一处**再 push 一条 `AnalysisCommandEntry`**：
`useLotusGame` 里的 discard / meld / 结算回执路径（B 的 `analysisSettleReceipt` 附近）
+ 过牌/拒胡（`chosen` 里 `kind: 'pass'` 的那些）。
**顺序判据**：仍用 `windowId`（P0 已经给每个窗口稳定 ID）—— 不要依赖数组顺序（异步回传会让顺序 ≠ 执行顺序）。

### 3.5 校验器要在浏览器里跑

`useLotusGame` 是 composable（watch/timer/音效全在 Vue 里）⇒ 校验器**在夹具页面**里跑：
新建一个「只重跑、不做表现」的实例（同 `useLotusGame`，定时器压到 0ms），
喂 `{ initialWall: ringWall, openingDice, openingSecondDice }`，然后按日志依序提交动作，
读结束分数比对。参照 `tests/e2e/fixtures/analysis-lotus-legacy.ts` 的写法。
（不要试图在 vitest/Node 里跑整套引擎：演出与定时器耦合，且 §3.5 的"0ms"是夹具层的事。）

### 3.6 与"记录不影响对局"的硬护栏共存

P1 只增加记录与新 API，**不得改变对局行为**：现有硬护栏用例
（开/关两种设置下结束分数、动作数、随机流抽取逐位相同）必须继续通过。

## 4. 验收标准（DoD）

**单测**（vitest）：

- [ ] 快照字段口径：`ringWall` 136 张、四种牌各 4 张、全为牌码；`openingScores` 四家且与当局开局一致；
- [ ] 交叉校验：把 `postDealHands` 改一张 ⇒ 校验器报"发牌/记录不一致"，**不**继续跑；
- [ ] 动作日志形状：与 `AnalysisCommandEntry` 同型、`windowId` 齐全、被拒动作不出现；
- [ ] 记录类型向后兼容：没有新字段的旧记录仍能被读取（导出/导入路径不炸）。

**e2e**（`tests/e2e/analysis-lotus-legacy.spec.ts` 追加一条）：

- [ ] **整局重跑到同一结束状态**：真实引擎打一局 → 从分析库读回 `reproduction` →
      在夹具里用 `ringWall + dice` 重跑 → 断言：命令全消费、结束分数与记录一致、
      窗口序列无错位（参照血流的 `kindMismatches`）；
- [ ] 开关关掉时**不写复现数据**（零成本）；
- [ ] 保持既有 5 条用例全绿（含 app-path）。
- [ ] 慢用例（若单局重跑超过 ~2 分钟）按 `E2E_SLOW=1` 门控（约定 §9.2 的同一口径）。

**导出/能力**：

- [ ] 导出包里 `reproductionCapable` 按记录内容判定：有完整复现数据 ⇒ true，缺 ⇒ false 并给出缺什么。

## 5. 协作与流程（沿用既有约定，别另起一套）

- 分支 `feat/repro-lotus-legacy`，工作树 `work/repro-legacy`，dev server **端口 4178**
  （A=4174、B=4176、协调者 master=4175、vibehub=4177 —— 起服务后先自查端口归属，见约定 §8）；
- **冻结清单**照旧（约定 §3）：`src/App.vue`、`src/game/llm/*`、
  `analysis/{session,storage,recorder,status,types,codec,export,import}.ts`；
  本方案需要动 `types.ts`（§3.1）与 `export.ts`（能力判定）⇒ **先请协调者提"公共改动"提交**；
- `src/game/variants/lotus/lotusGame.ts` 与 `src/game/core/local/useGame.ts` 都是 **vibehub keep 文件**：
  本分支改 `lotusGame.ts` ⇒ 协调者合并后要再做一次 vibehub 镜像（手法见约定 §6.1：三方合并 + 行尾陷阱）；
- 做完向协调者交接：**分支名 + 期望合并的 sha + 门控结果（在哪棵树跑的、跑了什么、观察到什么数字）**；
- 开工第一步 `git merge master`（拿最新约定与公共改动）。

## 6. 建议的执行顺序（最小可验证切片）

1. 快照（`beginTurn` 处取 + 写进记录）+ 单测（字段口径）——**先只做这一半**，跑一次 e2e 确认记录里有 `ringWall/dice`；
2. 动作日志（复用现有汇聚点）+ 单测（形状与顺序）；
3. 校验器（浏览器夹具）+ e2e「整局重跑到同一结束状态」；
4. 公共改动（`types.ts`/`export.ts` 的能力判定）与协调者对接；
5. 文档（在 `analysis-lotus-legacy.md` 里补 P1 一节）+ 交接。

## 7. 明确不做

- 不做跨局复现（P1 是本局粒度；整场重跑留给以后）；
- 不做反事实搜索/自动改招（§8 的"暂不做"）；
- 不把复现数据混进展示回放（§9.3：展示回放是公开口径的唯一来源，分析区不得重存公开字段）。
