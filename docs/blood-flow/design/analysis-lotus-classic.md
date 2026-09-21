# 莲花广麻（`lotus-classic`）的 AI 分析记录 —— 字段口径与未做的部分

> 角色：并行开发约定里的 **A**（`docs/blood-flow/design/analysis-two-variants-work-agreement.md` §1）。
> 方案：`analysis-recording-other-variants-plan.md`（§3 P0、§5 验收、§6 坑）。
> 本轮范围：**P0（能归因）+ P1（赛后复现）** —— P1 见 §5；更早的 P0 记录见 §3/§4。
> 分支：`master`（P1 单人单会话直接在主干做，`c30925e`；P0 的原始提交在
> `feat/analysis-lotus-classic`，已随公共改动进 master）。

## 1. 一句话

莲花广麻的对局现在会把**决策前态 / 合法动作 / 选择与来源 / 执行回执 / 结算**写进与血流
**同一个分析区**（存储、容量账本、分块压缩、导出导入、列表状态、界面开关都不重做）。
引擎侧只加了一个可选 `analysis` 选项，**不接时对局路径与改动前逐字相同**。

## 2. 改动清单

| 文件 | 改动 | 归属 |
|---|---|---|
| `src/game/replay/analysis/lotusClassicAdapter.ts`（新） | 窗口 ID / 前态投影 / 合法动作规范化 / 回执判定 / 结算折算（纯函数） | A |
| `src/game/replay/analysis/lotusClassicAdapter.test.ts`（新） | 上者的单测（20 条） | A |
| `src/game/core/local/useGame.ts` | 新增 `analysis?: AnalysisRecorder \| null` + 记录接线 | A（**vibehub keep 文件，需镜像**） |
| `src/game/core/local/useGame.analysis.test.ts`（新） | 接线用例（含"记录不影响对局"硬护栏） | A |
| `tests/e2e/fixtures/analysis-lotus-classic.{html,ts}`（新） | 端到端探针 | A |
| `tests/e2e/analysis-lotus-classic.spec.ts`（新） | 上者的断言 | A |
| `src/game/llm/llmController.ts`、`src/game/llm/runtime.ts`（+测试）（新提交 `23dc5a0`） | §5 的两个可选钩子，**公共改动**（B 依赖） | A 实现，协调者带上 master |

## 3. 字段口径（与血流的差别都在这里）

### 3.1 窗口 ID：`${roundId}/window/${N}`

- `roundId` = 本场第几局（1 起，本局第一个决策窗口之前由 `state.phase === 'opening'` 计数）。
- `N` = **本局内第 N 次进入决策**的自增计数（每局清零）。
- 与血流的 `${roundId}/window/${version}` **同形**，便于"两侧同编号窗口类型对照"。
- **不用**引擎的 `ctx.requestId`：它是场次级单调计数（`core/controllers/llmContext.ts` 的
  `requestSeq`），抢杠窗口的上下文根本没有它，离线复算不可靠。B（`lotus-legacy`）独立得出同一
  结论并使用同一形状 —— 两边都由分析侧自己计数。
- 天然满足：本局内稳定（同一窗口重复渲染得到同一 ID）、跨局不重复、缺 ID 条目数为 0。
  `useGame` 用**座位代理**包住三个决策入口，所以每个窗口只开一次，不需要额外的闩锁。

### 3.2 决策前态：只露该座位自己那一份

`decisionStateOf(view, seat)` 的字段形状是**固定**的（单测断言"多一个字段就失败"）：

```
{ id, fingerprint, hand?, drawnTileIndex?, melds?, legalActions }
```

- `hand` / `drawnTileIndex` / `melds` **只在该座位就是决策者时**才写（`seat === view.seat`）；
  别的座位连字段都不出现。
- 视图里**故意**带着四家真实手牌与真实牌墙顺序（`wall`）—— 隐私护栏因此是**适配层的责任**、
  可被单测抓住（断言别家暗手与未摸牌墙一个牌面都不出现、而视图里确实有这些牌）。
- 四家公开牌河/副露/分数不在前态里：展示回放是公开字段的唯一来源（§9.3）。
- `fingerprint` 由窗口 ID、座位、牌墙数、庄家、当前行动者、合法动作折成（状态变了就不是同一份前态）。

### 3.3 合法动作：从**引擎决策上下文**折出

口径对齐 `localTurnOrchestrator` 的 `handleAction` / `offerNextClaim` / `offerRobKong`：

| 窗口 | 合法动作 |
|---|---|
| `turn`（摸牌回合） | 每个手牌下标一条 `discard`（**带 `handIndex`**，摸切/手切语义不能丢）+ 补杠（`added-kong`，带 `meldIndex`）+ 暗杠（`concealed-kong`）+ 胡（`win`，仅当引擎判断成胡） |
| `claim`（响应弃牌） | `peng` / `gang` / `pass` |
| `rob-kong`（抢杠） | `win` / `pass` |

弃牌**不按牌种去重**：同一张牌的不同下标是不同的合法动作。
窗口内稳定 ID = `${windowId}/${下标}`（与血流同一口径），`chosen` 的 ID 一定落在该窗口的
合法动作里（单测 + e2e 都断言）。

### 3.4 来源与执行回执

- 来源：本家（`controllers[seat] === humanController`）记 `human`；其余按玩家形象记
  `local-ai → 'rule-auto'`；**LLM 座位本轮先记 `unknown`**（见 §5）。
- 回执**只认可见变化**（`choiceTookEffect`）：弃牌 ⇒ 牌河变长；吃碰杠 ⇒ 副露变多；
  胡 ⇒ 本局结束且赢家是该座位；过牌 ⇒ 以上都没变。
  观察点用引擎已有的唯一出口：`showTableAction`（鸣牌/杠/胡）与 `discardTile`（弃牌）。
  过牌没有"上桌"事件，让出一个宏任务后按状态比对判定（用的是同一套 `choiceTookEffect`）。
- **引擎改判**（例如下标越界被夹到末张）会被认成 `state-changed`，不会记成 `executed`；
  什么都没观察到就保持 `pending`。绝不因为"函数被调用过"就记 `executed`（§3.2、§10.2）。

### 3.5 结算：按分数实际变化折算

经典玩法**没有权威账本**，可靠的只有"分数变了多少"：

- 每条变化记一条 `AnalysisSettlement`：`deltas = after - before`，
  `winners`/`payers` 由正负号决定（与账本天然一致，不猜谁付谁），四家变化之和恒为 0。
- 一次结算会连写四家分数 ⇒ 用微任务合并成**一条**，否则会记出几条不守恒的半截流水。
- 本局**开局分**在"本局第一个决策窗口"取基线：开局建玩家本身会写一次分数（空 → 起始分），
  那不是结算；真的分数变化必然晚于第一个窗口。
- `kind`：本局结束的那次用 `RoundResult` 标成 `self-draw` / `win-discard` / `robbed-kong-win` / `draw`，
  局中的分数流动（杠、跟庄）记 `score-flow` —— **不猜具体杠型**（宁可粗一点，也不猜）。
- 流水首尾相接（相邻两条 `before` 与上一条 `scoresAfter` 一致）由单测与 e2e 断言。

> **P1 起有两处变化**：开局分的基线改在"进入开局阶段"那一拍取（`analysisRoundIndex === 0`
> 挡掉建玩家那次分数写入），并且局末多记一条**锚点结算**（荒庄无分数变化时也有一条
> `scoresAfter` 可与重跑逐位比对）。详见 §5.5。

### 3.6 场次与显示口径

- 场次 id 与展示回放**共用一把钥匙**（`matchId`），否则分析数据会在"按展示回放清单回收"时
  被当成悬空数据整场删掉。
- 落库状态 `complete` ⇒ 列表行用真实的 `analysisAreaLabel` 得到「**分析：完整**」。
- 中途退出（未打完整场回大厅）会写 `noteGap({ scope: 'match', reason: 'match-aborted' })`
  并结束本场；不收尾的话会话会一直是 active，下一场的 `start()` 会被守卫跳过，新对局的记录
  就挂到上一场的 matchId 上了（错场归属）。
- 响应窗口额外写一条 `responderCheckpoint`（该座位当时的手牌与摸牌下标）：展示回放的步骤流
  只含行动者视角，响应座位的手牌无法从中还原（§9.3 的已知格式缺口）。**广麻的响应窗口能看到
  该座位手牌**（决策者就是响应者），所以这类记录是齐全的，不产生 `responder-checkpoint` 缺失。

## 4. 验收证据（P0 那一轮实测）

> 下面这一节的数字与"未接线部分"都是 **P0 那一轮**的现场记录，保留原文以便对照；
> P1 的改动与实测见 §5（`parts` 里多一段 `reproduction`、`reproductionCapable` 变 `true`、
> e2e 由 3 条变 4 条）。P0 里"未接线"的两项（App.vue 那一行、`analysisSnapshotFor`）
> 里前一项已经由协调者的公共改动落地（见 §5.6 的 app-path 实测）。

命令与环境：工作树 `work/analysis-classic`（`feat/analysis-lotus-classic`，干净树）；
dev server 复用 `npx vite --port 4174 --force`，e2e 用 `E2E_PORT=4174 E2E_REUSE_ONLY=1`。

| 项 | 命令 | 结果 |
|---|---|---|
| 类型 | `pnpm typecheck` | 通过 |
| 单测 | `npx vitest run src` | 187 passed \| 1 skipped，**1891 tests passed** |
| 适配层 | `npx vitest run src/game/replay/analysis/lotusClassicAdapter.test.ts` | 20 passed |
| 接线 | `npx vitest run src/game/core/local/useGame.analysis.test.ts` | 4 passed |
| 端到端 | `npx playwright test tests/e2e/analysis-lotus-classic.spec.ts --workers=1` | 3 passed（6.7 分钟） |
| ↳ 引擎级探针 | 同上第 1 条 | 12.5s |
| ↳ **app-path 正向**（§9 追加的必做项） | 同上第 2 条 | 2.5 分钟 |
| ↳ app-path 负向 | 同上第 3 条 | 3.9 分钟 |

app-path 实测（真实 App + 真实大厅流程，锁住协调者补的 `analysis: analysis.port` 那一行）：

| | 观察 |
|---|---|
| 正向 | 第 1 局结算前后、147s / 978 次点击时由**自动刷盘**落库：blocks=6、parts=363、`rulesetId=lotus-classic`、status=`complete`、`{config:1, decisionState:117, decision:232, responderCheckpoint:10, settlement:3}` |
| 负向（`lgm_analysis_enabled=0`） | 推进 3 局 / 1476 次点击 / 216s：blocks=0、parts=0、matchId=null |
| 结论 | 那一行"既接上了、又听开关"两头都锁住 |

> 两条 app-path 用例慢（合计约 6.4 分钟），原因是**记录是缓冲写**：必须真的推进到落库点
> （自动刷盘约在 147s / 第 1~2 局前后，或整场结束）。要放进每次提交的套件还是按慢用例另跑，
> 由协调者定；`ROUNDS_TO_FLUSH` 是实测值，牌墙变快时需要往上调。
>
> 写这条用例最容易踩的坑（约定 §9.1 三个坑之外的第四个）：**一局结束要点「继续」**。
> 不点就永远停在结算面板上 —— 表现是"一直在点手牌、看起来在打"，实则第一局早已结算、
> 记录一条都没产生（实测点了 1294 次手牌才发现）。另外广麻的「返回大厅」只在**最终排名面板**上
>（`v-if="matchFinished || finalRankingLab"`），单机打完一局时那个面板上只有「查看牌桌」与「继续」，
> 所以 app-path 并不依赖"结算面板 → 返回大厅"这条路径，靠的是自动刷盘与场末收尾。

e2e 探针实测数字（东风场，固定随机序列，同一场跑两遍）：

| | 开关关 | 开关开 |
|---|---|---|
| 打完 | ✅ 5 局 | ✅ 5 局 |
| 展示回放事件数 | 422 | **422（逐条相同）** |
| 结束分数 | `[-600, -800, 5400, 0]` | **`[-600, -800, 5400, 0]`（相同）** |
| 分析库 | 场次 0→0，分块 0 | 场次 1，记录 705 条 |

开关打开时：窗口 225、选择 225、回执 225、`parts` 形状
`{config:1, decisionState:225, decision:450, responderCheckpoint:24, settlement:5}`、
状态 `complete`、行内文案 `分析：完整`、导出包 637,738 字节且
`configReferencesClosed=true` / `includesReplay=true`。

> ⚠️ 上面这些数字是 **P0 那一轮**的实测（那时没有 `reproduction` 段）。
> P1 起 `parts` 里多一段 `reproduction`、导出包不再缺 `复现数据（reproduction）`、
> `reproductionCapable` 变成 `true`；P1 的数字见 §5。

## 5. P1 赛后复现：开局快照 + 权威动作日志 + 浏览器内校验器（2026-09-22）

方案：`lotus-legacy-p1-reproduction-plan.md`（通用方案）+ `lotus-classic-p1-reproduction-plan.md`
（差异清单）。P0 记的是"**决策是什么**"，P1 补的是"**能不能把这一局重跑出来**"。

### 5.1 一句话

一场东风场打完，分析区里每一局都有一条**完整的复现数据**；拿它的"环状牌墙 + 开局骰子 + 庄家 +
当局开局分 + 权威动作序列"在真实引擎里**离线重跑**，能到达**同一个结束状态**（结束分数逐位相同、
命令逐条被消费）。实测 5 局：命令 89/89、65/65、31/31、36/36、82/82，篡改记录后 0 命令消费。

### 5.2 字段口径（与翻精癞子的差别就是"没有翻精"）

`AnalysisReproduction`（`variant: 'lotus-classic'`）里写了这些：

| 字段 | 是什么 | 取值时刻 |
|---|---|---|
| `ringWall` | **环状牌墙 136 张**（牌码，未发牌、未按庄家拆墙） | `onRoundPrepared`：骰子掷完、牌墙按庄家拆开、**还没发牌** |
| `dice.first` | 开局掷骰两粒 | 同上（重跑必须给，否则会被重抽） |
| `dealer` | 当局庄家 | 同上（**决定发牌起点**） |
| `wallBreakIndex` | 牌山断点（由骰子 + 庄家推出） | 同上（交叉校验用） |
| `openingScores` | 当局开局分（四家） | 同上（发牌之前读，所以就是这一局的起点分） |
| `postDealHands` | 发牌后四家手牌 | `beginTurn` 那一刻（发牌完成、还没进入第一手决策） |
| `commands` | 权威动作序列（`AnalysisCommandEntry`） | 与 P0 的 `chosen` 同源同顺序（顺序判据 `windowId`） |

**没有** `flipTile` / `jokers` / `flipSeat` / `flipStack` / `dice.second` —— 广麻**没有翻精**
（`localOpeningTimeline` 里根本没有 `resolveFlip` 那一套），所以这几项就是不存在；
读取侧要能区分"玩法里没有"与"翻精没翻出来"，所以**不补空值**。

命令条目的两处玩法特有细节：

- `windowKind` 与决策记录**同一口径**（`AnalysisWindowKind`：`draw-turn`/`claim`/`rob-kong`），
  不是引擎内部的 `turn`。两套字面量混用会让校验器在第 1 个窗口就误报"类型对不上"
  （实测：`记录 turn vs 重跑 draw-turn`）；`recordedWindowKindOf` 负责折回。
- 碰带的 **`discardIndex` 必须记**：编排层把"碰完立刻弃哪张"折在碰动作里、不另开窗口
  （`localTurnOrchestrator` 的 `case 'peng'`）；漏了它重跑会走 `skipDraw` 那条分支多摸一张牌。

### 5.3 校验器判据（`reproduceLotusClassic.ts`，与血流/翻精癞子同口径）

1. **发牌交叉校验**：先按 `ringWall + dice + dealer + openingScores` 重新发牌，逐张（**按位置**，
   不按集合）比对 `postDealHands`，再比对开牌断点。不一致 ⇒ 报
   「发牌算法变了或记录与引擎不一致」并**停止**，一条命令都不喂 —— 否则只是拿另一副牌跑了一遍。
2. **命令必须对得上重跑此刻的合法动作**（区分键与 P0 同一套），对不上就报错、**不跳过**。
3. 命令用尽而未结束 ⇒ 报"记录不足"；结束了却还有未消费的命令 ⇒ 报"记录提前结束"。
4. 缺 `openingScores` ⇒ 报"结束分数**不可比对**"，不拿跑出来的数字硬比。
5. 缺"记录侧的结束分数"⇒ 不宣称复现成功（**不许拿"跑通"当"复现"**）。
6. 记录里出现 `expire`/`auto`（血流权威端的推进口径）⇒ 如实报"无法重放"，**不静默过滤**。
7. 只认 `variant: 'lotus-classic'`：翻精癞子的记录**也**带 `ringWall`（两个玩法的重跑起点同为
   环状牌墙），只看 ringWall 分不开 ⇒ 报"不是莲花广麻的口径"，不硬套。

同一段校验器两种驱动方式：`replayLotusClassicRound.test.ts`（vitest + 假时钟，7 条，几秒）与
e2e 夹具（真实浏览器定时器）。

### 5.4 改动清单

| 文件 | 改动 |
|---|---|
| `src/game/core/local/localOpeningTimeline.ts` | 新增 `onRoundPrepared`（交出环状牌墙/骰子/庄家/断点/开局分）；`start` 接受 `dealer`/`scores` |
| `src/game/core/contracts/gamePort.ts` | `GameStartOptions` 增 `initialWall`/`openingDice`/`dealer`/`scores`/`waitForOpeningReady` |
| `src/game/core/local/useGame.ts` | 快照 + 命令日志 + 局末落库；`capabilities.openingWallBreakIndex()`；结算改为"每局一条锚点 + 局中 `score-flow`" |
| `src/game/replay/analysis/lotusClassicReproduction.ts`（新） | 纯函数：`buildLotusClassicReproduction` / 交叉校验 / 命令条目 / 匹配键 |
| `src/game/replay/analysis/reproduceLotusClassic.ts`（新） | 浏览器/夹具内的一局重跑校验器 |
| `src/game/replay/analysis/lotusActionKey.ts`（新） | 动作区分键（与翻精癞子共用一套，原先在 `lotusLegacyAdapter` 里） |
| `src/game/replay/analysis/lotusClassicAdapter.ts` | `recordedWindowKindOf`（记录口径 ↔ 引擎口径） |
| `src/game/replay/analysis/reproductionCapability.ts` | 新增 `lotusClassicDeficiencies`，判据先认 `variant` |
| `lotusClassicReproduction.test.ts` / `replayLotusClassicRound.test.ts`（新） | 16 + 7 条单测 |
| `tests/e2e/fixtures/analysis-lotus-classic.ts`、`analysis-lotus-classic.spec.ts` | 逐局固定牌墙/骰子 + 逐局重跑 + 篡改对照 |

### 5.5 结算口径的调整（P1 顺带修的一处）

P0 的结算是"分数每变一次记一条"。这在**荒庄**（`endDraw` 的罚符恰好四家相抵）时会**一条都不记**，
于是那一局没有 `scoresAfter` 可给重跑去比 —— "没记"被伪装成"缺数据"。P1 起：

- 局末在 `state.result` 那一拍记一条**锚点结算**（`deltas = 局末分 − 开局分`，`scoresAfter = 局末分`），
  与重跑的结束分数**逐位可比**；
- 局中的分数流动（跟庄/杠分）仍按"每变一次一条"记 `score-flow`；
- 保底一条锚点（`analysisRoundSettled` 去重，`analysisFlushScores` 的末次读数与局末分相同时不重复记）。
- `useGame.analysis.test.ts` 的"四家变化之和为 0 + 相邻两条 `before` 与上一条 `scoresAfter` 一致"
  两条判据继续通过 —— 这是这次调整没有把流水链弄断的证据。

### 5.6 验收证据（本分支实测）

环境：主工作区 master，dev server `pnpm exec vite --port 4179 --strictPort --host 127.0.0.1`
（**必须绑 127.0.0.1**：默认只监听 IPv6 时 `playwright.config.ts` 的 `http://127.0.0.1:4179`
会直接 ERR_CONNECTION_REFUSED —— 踩过一次假失败）；e2e 用 `E2E_PORT=4179 E2E_REUSE_ONLY=1`。

| 项 | 命令 | 结果 |
|---|---|---|
| 类型 | `pnpm typecheck` | 通过 |
| 单测 | `pnpm test` | 194 files passed \| 1 skipped，**1979 tests passed**（较 P1 前的基线 1956 **+23**：`lotusClassicReproduction.test.ts` 16 条 + `replayLotusClassicRound.test.ts` 7 条） |
| 快照口径 | `npx vitest run src/game/replay/analysis/lotusClassicReproduction.test.ts` | 16 passed |
| 重跑 | `npx vitest run src/game/replay/analysis/replayLotusClassicRound.test.ts` | 7 passed（含"整场 3 局、庄家非 0"那条） |
| 端到端 | `npx playwright test tests/e2e/analysis-lotus-classic.spec.ts --workers=1` | **3 passed / 1 skipped（3.6 分钟）** |
| ↳ 形状 + 硬护栏 + 零写入 | 同上第 1 条 | 30.2s |
| ↳ **P1 整局重跑** | 同上第 2 条 | 34.5s |
| ↳ app-path 正向 | 同上第 3 条 | 2.5 分钟，`tags` 里 `reproduction:2` |
| ↳ app-path 负向 | 同上第 4 条 | `E2E_SLOW=1` 才跑（慢用例门控不变） |
| 回归（翻精癞子） | `npx playwright test tests/e2e/analysis-lotus-legacy.spec.ts --workers=1` | 6 passed（5.9 分钟） |
| vibehub 镜像 | `work/vibehub-theme11v`：`pnpm typecheck` + `pnpm test` | 通过；**2100 passed / 2 skipped** |

P1 用例实测输出（东风场，固定 seed 20_260_921）：

```
复现数据 5 条；逐局 #1 ok=true 命令 89/89 窗口 89 分数 1000/1000/1000/1000
     | #2 ok=true 命令 65/65 窗口 65 分数 700/500/1900/900
     | #3 ok=true 命令 31/31 窗口 31 分数 200/0/3400/400
     | #4 ok=true 命令 36/36 窗口 36 分数 -100/1200/2800/100
     | #5 ok=true 命令 82/82 窗口 82 分数 -200/1100/3200/-100
篡改对照 ok=false 命令 0
```

### 5.7 踩过的坑（后续改这块必看）

1. **重跑必须带庄家与开局分**。第 2 局起庄家由 `advanceMatchState` 推进（和牌者当庄），
   沿用默认 0 会让发牌起点变掉 —— 第一版 e2e 就是这么红的：
   `第 2 局重跑拒绝继续：第 0 家手牌张数对不上（记录 13 张 vs 重跑 14 张）`。
   修法是给 `GameStartOptions` / `localOpeningTimeline.start` 加 `dealer`/`scores`。
2. **窗口类型两套词汇表**（`turn` vs `draw-turn`，见 §5.2）。
3. **建玩家的那一次分数写入不是结算**：第一局的分数 watch 早于开局（`clearLocalState` 与
   `resetLocalPlayers` 各写一次），不挡掉会被记成一条 `deltas=[1000,1000,1000,1000]` 的"结算"
   （实测抓到）。闸门是 `analysisRoundIndex === 0`。
4. **e2e 夹具要逐局钉死牌墙与骰子**：`nextRound()` 不接受参数会退回随机开局，
   那样"重跑成功"就退化成"两次随机各跑了一局"。`matchLifecycle.nextRound(startOptions)`
   会把参数转交给 `startGame`，用它。
5. **`analysis-lotus-legacy.spec.ts` 的读数会被脏库污染**：那个夹具读**全部分块**（不按 matchId 过滤），
   库里留着上一次运行的场次时会读成两倍（实测 `reproductionParts=10` vs `roundsPlayed=5`）。
   排查结论：**不是缺陷**，在干净库上 6 条全绿；本轮没有改它（见 §7 未做项）。

## 6. 未做的部分（明确留痕，不冒充完成）

1. **整场重跑（跨局）没做**：P1 是**本局粒度**（通用方案 §7 明确不做跨局复现）。现在每局各自可重跑，
   但"从第 1 局一路重跑到场末"没有做，也没有"反事实改招"。跨局重跑还缺一样东西：
   每局的**开局分**虽然记了，但场末的"场次连续性"（连庄/进庄）没有被单独记成一串可重放的推进指令。
2. **`lotus-legacy` 那份 e2e 夹具读全库的老问题**（§5.7 第 5 条）：建议给它加 `matchId` 过滤或
   每轮开场清库；本轮为了不动不属于本次范围的用例，只留痕不修。
3. **LLM 座位还没接钩子**：`llmController.ts` 的两个可选钩子已经实现并单测（提交 `23dc5a0`），
   但广麻的 LLM 座位目前仍记 `source: 'unknown'`（§9 DoD 允许）。接 sink 时需要两件事：
   - `src/App.vue` 把 `onDecisionRequest` / `onDecisionAnswer` 传进 `createLocalLlmControllers`；
   - sink 用 `seat` 找到"该座位当前打开的窗口"，把 `attemptStarted({ decisionWindowId })` 指过去。
     **不要**拿钩子里的 `windowId` 当分析窗口号：它按契约是引擎侧请求标识
     （`context.requestId`），与分析侧自己计数的 `${roundId}/window/${N}` 是两套编号。
4. **`src/App.vue` 的 `analysisSnapshotFor` 仍是 `{ id: 'lotus-classic' }` 占位**（只记标识，
   不记规则正文/AI 配置）。P0/P1 的记录本身不依赖它，但它决定"这一手是在什么规则/AI 配置下决定的"
   能不能被回答。
5. **P1 没动 `src/App.vue`**：本轮全部改动都在引擎侧与 `src/game/replay/analysis`，
   `useGame` 的 `analysis` 端口那一行早在 P0 的公共改动里落地了。
6. **唯一还没走 UI 的断言**是回放列表行文案「分析：完整」—— 它在数据层用真实的
   `analysisAreaLabel` 判定；可以照 `analysis-human.spec.ts` 再补一条大厅列表用例。

## 7. 维护提示

- 新增决策窗口时：在 `useGame` 的座位代理里加一个入口，并在 `lotusClassicAdapter` 里补
  `windowKindOf` / `recordedWindowKindOf` 的映射与合法动作折法；**不要**在编排器里零散插桩
  （汇聚点只有控制器这一处）。
- 改前态字段前先跑 `lotusClassicAdapter.test.ts` 的"字段形状"用例 —— 它是防止顺手把整个局面
  塞进前态的守卫。
- 改复现字段前先跑 `lotusClassicReproduction.test.ts` + `replayLotusClassicRound.test.ts`：
  前者管"记录里该有什么、缺什么算不合格"，后者**真跑一局**再重跑，几秒钟就能卡住"重跑与记录分叉"。
- 重跑输入（`ringWall`/`dice`/`dealer`/`openingScores`）来自 `onRoundPrepared`，
  **不要**改成局末读 `state.wall`/`state.players` —— 那是终局状态，不是复现起点。
- 记录代码一律走代理 / 容错：任何位置抛错都只丢一条记录，绝不影响对局（§9.5）。