# 「莲花麻将·翻精癞子」AI 分析记录（P0：能归因，不含赛后复现）

> 玩法 `lotus-legacy`；分支 `feat/analysis-lotus-legacy`；工作树 `work/analysis-legacy`。
> 配套：方案 `analysis-recording-other-variants-plan.md`、分工约定 `analysis-two-variants-work-agreement.md`（本文作者是 **B**）。
> 本轮范围是方案 §3 的 **P0**；§4 的赛后复现（P1）**没做**，见文末「未做的部分」。

## 1. 一句话

翻精癞子对局现在会把**决策前态 / 选择与来源 / 执行回执 / 模型请求 / 结算**写进与血流共用的那个本机分析区；
LLM 座位接了约定 §5 的两个钩子（真发请求记 `model`、回退记 `model-fallback`）；
记录层是纯旁路观测，同一副牌在"分析开/关"两种设置下结束分数与动作数**逐位相同**（§9 硬护栏）。

## 2. 接线方式：包在控制器外面，不动编排层

翻精癞子**没有**血流那种权威"窗口"对象 —— 决策窗口是编排层**调用控制器**产生的。
`lotusTurnOrchestrator.ts` 只在这五处询问某个座位：

| 控制器方法 | 触发处 | 窗口类型 |
|---|---|---|
| `requestTurn` | `createTurnRunner.beginTurn` → `buildContext` | `draw-turn` |
| `requestDiscardHu` | `offerHu`（弃牌后问点炮胡） | `claim` |
| `requestClaim` | `offerNextClaim`（碰/直杠/吃） | `claim` |
| `requestChi` | `offerChi` / `requestChi`（仅下家能吃） | `claim` |
| `requestRobKong` | `offerRobKong`（抢杠） | `rob-kong` |

这五处正好就是**全部**决策窗口，所以记录点包在控制器外面（`lotusGame.ts` 的
`wrapAnalysisController` / `installAnalysisWrappers`），一处都不用漏，也完全不必去改编排层。

- 包装是**就地替换 `controllers` 数组元素**：编排器、计时器、动作控制器都按引用捕获这个数组，
  必须在它们创建**之前**装好；设置页换 AI（`replaceAiControllers`）会换掉座位 1-3 的实例，
  所以那里要再装一次（`WeakSet` 保证不会把包装再包一层）。
- `controllers` 现在**复制一份** `suppliedControllers`：包装会写数组，绝不能写穿调用方传进来的数组。
- 人类座位那一份仍然通过 `humanController` 原实例被 UI 驱动（`lotusHuman.ts` 调的是它的
  `resolveDiscard` 等方法），包装只旁观，不影响按钮。
- 包装里的记录函数**恒为 async 且恒 await 一次**（无论开不开记录）：开/关两条路径的微任务时序
  完全一样，"记录不得影响对局"就不会被"少一个 tick"的差异污染。
- 所有记录调用都过一个 `safely()` 保护口：记录侧异常只吞掉并留痕（`scope: 'recorder'`），
  绝不抛回编排层（§9.5、§10.2 的独立失败域）。

> LLM 座位还要多一层「模型请求」的记录，走的是另一条路（约定 §5 的两个钩子），
> 所有权放在 App 侧而不是引擎侧 —— 见 §6.1。

## 3. 窗口 ID 规则（§3.1 要求"可离线复算"）

```
windowId  = `${roundId}/window/${N}`      N = 本局内第 N 次进入决策（只在真的记下窗口时自增）
roundId   = `round-${S}`                  S = 本局在整场里的序号（1 起，每局开局加一）
前态 ID   = `${windowId}/${seat}`
```

**为什么 `S` 不能用 `state.round`（踩过的坑）**：连庄（庄家和牌、或荒庄庄家听牌）时
`advanceMatchState` 保持 `round` 不变、只把 `honba` 加一。拿 `state.round` 当键，连庄的两局会共用
同一个 `roundId` ⇒ 窗口 ID 跟着重复 ⇒ 录制器按 `windowId#seat` 建决策对象，会把第二局的决策
**写进第一局那条记录里**（静默串局）。展示回放正是因为这个原因用"已打局数 + 1"编号
（`replay/recorder.ts` 的 `roundIndex: rounds.length + 1`），本适配层与它同一套口径 —— 这样
§9.3 的"按 `roundIndex` 与展示回放配对"才对得上。实测：东风场一场下来打了 **5 局**（含 1 次连庄），
`roundId` 逐局递增不重复。

方案 §3.1 的草图写的是 `` `${roundId}/turn/${actionCounter}` ``，这里用 `/window/` 而不是 `/turn/`：
翻精癞子的窗口不止摸牌回合（还有碰杠吃响应与抢杠），挂 `/turn/` 是错的。末段仍是单调递增整数
（与血流 `${roundId}/window/${version}` 同形）；窗口**类型**另记在 `AnalysisDecision.windowKind` 上 ——
§11 的"两侧同编号窗口类型对照"靠的是这个字段，不是 ID 里的字面量。

## 4. 决策前态与隐私护栏（§3.2、§9.3、§10.4）

`lotusSeatView(snapshot, window, ruleset)` 把牌桌状态投影成**该座位当时可见的信息**，是纯函数：

| 字段 | 口径 |
|---|---|
| `hand` | **该座位自己的**手牌（含牌种与顺序） |
| `drawnTileIndex` | 该座位摸到的牌在手牌里的下标；未摸/跳过摸牌为 `-1`（摸切/锁手依赖它，不能事后推） |
| `melds` / `exposedMelds` | 自家副露（花牌不算结构面子，与共享 `structuralMeldCount` 同口径） |
| `jokers` / `wildcardTiles` | 本局精牌与精的替代牌面 |
| `others` | 别家**只有张数**：`hand` 恒为 `[]`，另有 `handCount` / `meldCount` / `discardCount` |
| `legalActions` | 见 §5 |

**不得出现**（单测直接断言）：别家暗手、未摸牌墙顺序、整副牌墙枚举。
落库的前态（`decisionStateOf`）字段形状是**固定的一套**
`{ id, hand, drawnTileIndex, melds, legalActions }` —— 多出任何字段都说明有人把新信息塞进了决策输入。
别家暗手既不在 `hand` 里，也不在任何其他字段里。

公开信息（四家牌河、副露、分数）**不重复记**：它们在展示回放里已经是唯一来源（§9.3）。

## 5. 合法动作与优先级

按编排层的响应优先级给出，顺序即 ID 下标：

- `draw-turn`：胡 → 补杠（碰过且手里还有同牌，带 `meldIndex`）→ 暗杠（手里 4 张）→ 风杠（东南西北各一）
  → **每张手牌一个弃牌选项**（带 `handIndex`，同牌不同位置不是同一个选项）
- `claim`：胡 → 杠 → 碰 → 吃（**仅下家**，每个 `ChiMeld` 一个选项，带组合 `meld`）→ 过
- `rob-kong`：胡 → 过（抢杠没有鸣牌选项）

判定全部用**引擎自己的规则基元**复算（`ruleset.win.isWinningHand` / `concealedKongs` / `canRobKong`、
`canChi` / `matchingCount` / `windKong`），与 `lotusControllers` / `lotusTurnOrchestrator` 同源；
吃牌额外加了一道**下家**闸（编排层是 `seat === (from + 1) % players.length`）—— 少了它记录里会出现
别家根本不能选的吃选项。

控制器返回的动作与候选的对应关系用**区分键**（`actionMatchKey`）匹配：弃牌看 `handIndex`、
补杠看 `meldIndex`、暗杠看 `tile`、吃看组合（排序后比）、其余看 `kind`。
对不上返回 `-1`，`chosen` 记 `legalActionId: null` —— **不把认不出来的动作硬塞进某个候选**。
控制器返回值有三套形状（动作对象 / 吃的 `ChiMeld` / 抢杠的裸字符串 `'win' | 'pass'`），
`toLotusActionLike` 统一读；碰带的 `discardIndex`（碰完弃哪张）属于**下一个**动作，不进本窗口的标识。

## 6. 选择来源（§3.4）

按**控制器类型**如实标注，不猜：

| 控制器 | `source` |
|---|---|
| `LotusHumanController` | `human` |
| `LotusAiController`（本地启发式） | `rule-auto` |
| `LotusLlmController`（接了 sink 之后） | `model` / `model-fallback`（由接缝按尝试与回退改写） |
| 其余（未接钩子的 LLM 控制器） | `unknown` |

**本阶段 LLM 座位已接 sink**（见 §6.1）：真发请求的窗口记 `model`／回退时 `model-fallback`；
控制器自己短路掉、根本没发请求的窗口仍记 `unknown` —— 这是如实的（确实没有模型参与），
不是漏记。一场本地 AI 对局的实测：`human` 98 条、`rule-auto` 306 条（决策记录条数，见 §9 的说明）；
LLM 座位的那一场：`llm` 尝试 54 条、模板 1 条、来源出现 `model` 与 `model-fallback`。

> **接 sink 时的一个口径冲突（已实现，见 §6.1）**：A 的接缝把"请求内容里逐字带来的引擎侧 `requestId`"
> 当作 `windowId`。这在翻精癞子上**不能直接照搬**：`lotusTurnOrchestrator` 只在
> `buildContext`(turn)、`offerNextClaim`(claim)、`requestChi`(chi) 三处调 `llm.meta()`，
> **胡窗口 `offerHu` → `requestDiscardHu` 的 ctx 根本没带 `...llm.meta(...)`**，没有 `requestId` 可落；
> 而且 `requestSeq` 是场次级单调计数、不是每局重来。因此本节这套自编号仍然是窗口的权威键，
> sink 要**反着对**：由接缝维护"该座位当前打开的窗口"，钩子触发时按 `seat` 找到在飞的那个窗口，
> 再把 `attemptStarted({ decisionWindowId })` 指过去 —— 不去匹配钩子里的 `requestId`。

**而且这个缺口是自洽的（读 `LotusLlmController` 核实过，`src/game/llm/llmController.ts`）**：
LLM 控制器里**恰好只有那三个能拿到 requestId 的窗口**真的会发请求 ——

| 窗口 | LLM 控制器 | 会不会有 attempt |
|---|---|---|
| `requestTurn`(347) | 先短路"必成杠上开花"的暗杠/风杠与已成胡的手牌（348–362），其余走 `decideCanonical`(363) | 有时有 |
| `requestClaim`(394) | 无选项直接 `pass`(395)、必成杠上开花直接 `gang`(396–399)，其余走 `decideCanonical`(400) | 有时有 |
| `requestChi`(420) | 走 `decideCanonical`(422) | 有时有 |
| `requestDiscardHu`(380) | **全是确定性短路**（385–391），从不进 `decideCanonical` | **永不** |
| `requestRobKong`(441) | `lotusDecideRobKong` 确定性裁决 | **永不** |

也就是说：**拿不到 requestId 的那两个窗口，正好就是永远不会有 attempt 的两个窗口** ——
不需要为它们做任何特例，按 `seat` 找在飞窗口这一套就够了。
推论（也是接线后的实测结论）：**`llm` 记录是 LLM 座位决策的严格子集** ——
上表里"有时有"的三个窗口也有各自的短路分支，短路时**根本不发请求**，那些窗口没有 `llm` 记录、
决策来源也不会是 `model`（此时记 `unknown` 是如实的：确实没有模型参与）。
反过来，**发过请求的决策必须归因到 `model` / `model-fallback`** —— e2e 的判据就落在这条上。

## 6.1 LLM 记录接缝（已实现）

`createLotusLegacyDecisionSink`（同在 `lotusLegacyAdapter.ts`）：

- **所有权对调**：接缝由 **App 侧创建一次**、引擎侧登记窗口。原因是控制器在 `useLotusGame`
  **之前**就构造好了（`aiControllers` 是它的入参），钩子必须在那之前就位；反过来让端口暴露钩子
  会绕成"引擎要控制器、控制器要引擎"的循环依赖。所以接缝自己维护"该座位在飞的窗口"，
  引擎在开窗/收窗时调 `windowOpened({ seat, windowId, legalActions })` / `windowClosed(seat)`。
  App 侧因此要多两行：`createLotusLegacyDecisionSink({ recorder: analysis.port })`，
  再把 `sink.hooks` 合并进 `createLotusLlmControllers` 的 hooks、把 `sink` 传给 `useLotusGame`。
  两半必须**一起接**：只接 hooks 不传 sink，钩子会找不到在飞窗口（留痕、不落孤儿记录）。
- **候选改挂**：钩子的 ID 是它自己那套编号（`${引擎侧 requestId}/${下标}`），必须按**动作内容**
  改挂到本窗口的合法动作下标上，否则候选会指向一个不存在的合法动作。
- **取动作的那一份**：必须用钩子的 `legalActions[]`（按 `id` 对应），**不能**用 `candidate.action` ——
  后者是引擎侧的原始规范动作，**吃只有 `{kind:'chi', optionIndex}`，组合在合法动作表那一份上**。
- **变量与模板**（§4）：`promptVariables.system` 是模板正文，交给 `recorder.promptTemplate({id, content})`
  按 id 只存一次（录制器自己去重）；每次尝试只存其余变量，`user` 逐字保留。
  不拆的话模板全文会在每条尝试里各留一份副本 —— 正是 §4 说的"全文提示词重复副本"。
- **来源**：请求开始即记 `model`；回答带回 `fallback` 时改记 `model-fallback`
  （`recorder.source()` 的运行时来源优先于包装层带回的 `unknown`，§3.4）。
- **失败与回退**：`outcome` 直接映射（`invalid` → `candidate-missing`，`error` → `network-error`）；
  `usage` / `responseModel` 只在钩子真的给了值时记，拿不到就不填（**不填 0 冒充**，§3.3）。

### 两个实测踩到的坑（都已修，值得记住）

1. **`candidate.action` 里没有吃的组合**（见上）。只看它会**静默丢掉每一个吃候选** ——
   真机 e2e 才抓到（单测里手搓的数据恰好把组合放在了 `action` 上，于是"测过了"）。
2. **仓库里有两套中文牌名**：`core/rules/tiles` 的 `TILE_META[].name` 是**中文数字**（`六筒`），
   而 `llm/schema` 的 `tileName` 是**阿拉伯数字**（`6筒`）—— 而 `llmController` 用的是后者
   （`import { tileName } from './schema'`）。两边都"是显示名"，直接比就是
   `chi|七筒,八筒,六筒` vs `chi|7筒,8筒,6筒`，永远对不上。
   **修法**：匹配键一律经 `canonicalTileKey` 折回**牌码**（两套显示名都反查得回去），
   三方（控制器动作／本适配层动作／钩子上报动作）因此落在同一个键上。

## 7. 执行回执与结算折算（§3.4、§5）

**执行回执**：翻精癞子是 Vue 状态机、没有权威回执，所以只看**该座位自己的可见变化**
（`observableOf`：手牌数 / 副勒数 / 牌河数 / 分数）：

- 弃牌 ⇒ 牌河变长；碰/吃/直杠 ⇒ 副露变多或手牌变短；暗杠/风杠不留副露 ⇒ 用张数或分数兜底；
  胡 ⇒ 分数变化；过牌 ⇒ 以上**都没变**才算生效。
- 判定不出来就是 `state-changed`，**不因为"控制器返回了"就记 `executed`**。
- 结算时机：**下一个窗口开启时**（`detail: 'window-advanced'`）与局末（`'round-end'`）。
  取"下一个窗口"而不是"同一个座位的下一个窗口"：编排层是**串行**的 —— `await` 完一个座位的控制器、
  把动作应用掉，才会去问下一个座位，所以任何新窗口开启时此前所有窗口的动作都已落定；
  等同一个座位的下一个窗口会跨越好几手，把别人的动作也算进来。
  还挂着 `pending` 的说明这一手的后续没被观察到，如实保留 `pending`，不补一个假的成功。

**结算折算**：每局一条（`settlementsFromRound`），`deltas = 局末分 − 开局分`：

- 开局分在 `phase === 'opening'` 用 **sync watch** 取（晚一拍会取到上一局结算后的值 ——
  §5 的 `openingScores` 正为此必须记）；`deltas` 求和恒等于牌流本身的守恒量，**四家之和为 0**（单测 + e2e 都断言）。
- 付款座位由 `deltas` 的负数侧决定，天然与牌桌一致；`kind` 记 `win-<winType>` / `draw`。
- 局末去重按 `state.result` 的**对象身份**（同一局的结算对象只会被折算一次，换局/换场都是新对象，
  不受"第几局"编号影响）。
- 单笔**杠分与跟庄**的逐笔流水没有单列，见「未做的部分」。

**中途退出**：`returnToLobby` 覆盖了 `matchLifecycle` 的原版 —— 没打完整场就先
`noteGap({ scope: 'match', reason: 'match-aborted' })` 并 `finish()`（刷盘 + 结束本场会话）。
不结束会话的话，下一场会被 App 的 `analysis.active()` 守卫跳过、记录挂到上一场名下（错场归属）。

## 8. 一处引擎改动：`startGame` 转发开局参数

`startGame` 之前只把 `mode` 转给 `openingTimeline.start`，**第二个参数被丢掉** ⇒ 只有这个引擎做不到
"同一副牌重跑两次"，而 §9 的硬护栏正需要它。现在转发 `startOptions`（固定牌墙 / 两颗骰子）。
现有调用方都只传一个参数，因此**行为不变**；`nextRound(startOptions)` 那条路也顺带通了
（`matchLifecycle.nextRound` 本来就转交 `startGame(undefined, startOptions)`）。
同处还做了：传了 `mode` 就是**新的一场**，本局序号与结算去重从头开始。

## 9. 验证（在哪棵树、跑了什么、看到什么数字）

工作树 `work/analysis-legacy`，分支 `feat/analysis-lotus-legacy`；基点 `bfe2708`（公共地基），
现含 `merge master` 带来的 A 的钩子提交。

```
pnpm typecheck                     # 通过
pnpm test                          # 188 passed | 1 skipped（189 文件）；1923 passed | 2 skipped（1925 用例）
npx vitest run src/game/replay/analysis/lotusLegacyAdapter.test.ts
                                   # 32 passed（投影/结算 22 + LLM 接缝 10）
E2E_PORT=4176 E2E_SKIP_WEBSERVER=1 npx playwright test tests/e2e/analysis-lotus-legacy.spec.ts --workers=1
                                   # 夹具 4 条 4 passed（37.3s）；app-path 1 条**当前为红**，见 §10 第 4 条
npx playwright test tests/e2e/lotus-legacy.smoke.spec.ts   # 1 passed（改过 lotusGame 的回归）
```

一场东风场（`?analysis=1&seed=20260921`，连庄在内打了 **5 局**）的实测读数：

```
状态 complete；记录 {"config":1,"decisionState":202,"decision":404,"responderCheckpoint":42,"settlement":5}
决策来源 {"human":98,"rule-auto":306}
结算 5 条；展示回放 5 局；动作 {"roundStart":5,"draw":155,"discard":158,"tableAction":6,"roundEnd":5}
```

LLM 座位那一场（`?analysis=1&llm=1&seed=…`，座位 1 用真实 `LotusLlmController` + 打桩 fetch）：

```
llm 尝试 54 条；promptTemplate 1 条；来源出现 model 与 model-fallback
发过请求的决策里没有一条来源不是模型侧（attemptDecisionsWithoutModelSource = 0）
落库的 promptVariables.user === 发给模型的 messages.user
```

> `decision` 404 条 = 202 条决策 × 2：录制器在 `chosen` 与 `receipt` **各推一份** decision
> （内容不同、`windowId` 相同）。去重后的决策数是 202，与前态数一致。
> `responderCheckpoint` 是录制器给 `claim` 窗口写的独立检查点（§9.3 的已知格式缺口），顺带就有了。

硬护栏（同一 `seed`，开/关两次各跑一场）：

```
分数 off=-1200,-600,7500,2300   on=-1200,-600,7500,2300
动作 off={"roundStart":5,"draw":155,"discard":158,"tableAction":6,"roundEnd":5}   on=同上
随机流抽取 off=1552   on=1552
```

`rngDraws` 相等这条是**前提性断言**：两次必须消耗同样多次 `Math.random`，否则比的是两副不同的牌。
翻精癞子对局期间的随机只有"AI 弃牌平局判定"一处（`LotusAiController.requestTurn` 调 `decideTurn`
时没透传构造参数里的 `random`，那条注入路径是死的），牌墙与两颗骰子由查询参数钉死；
记录层一次随机都不抽 —— 这正是本特性的硬护栏。

## 10. 未做的部分（如实列出）

1. **P1 赛后复现（§6）没做**：没有开局快照与权威命令日志，导出包会如实标
   `reproductionCapable: false`、`manifest.missing` 里写明缺"复现数据（reproduction）"。**不谎称可复现。**
2. **LLM 座位已接 sink**（§6.1），但**采样/思考开关没记**：钩子不暴露 temperature 这类参数，
   所以 `AnalysisLlmAttempt.sampling` 只写 `{}`（留空，不编）。要补得先扩钩子。
3. **逐笔杠分/跟庄流水没单列**：结算只到"每局一条 + 四家 delta"。牌桌的 `showScoreFlow` 能给出逐笔
   `{ playerIndex, amount }`，但它不带"是跟庄还是杠"的原因字段，硬记会得到一堆无法归因的 `score-flow`。
4. **`App.vue` 不由本分支改**：`src/App.vue` 在约定 §3 的冻结清单里，由**协调者**走「公共改动」提交。
   本分支的 P0 与 LLM 接缝在真实 App 上生效需要**三处**（都在 App.vue）：
   ① `useLotusGame({ analysis: analysis.port })`；② `createLotusLegacyDecisionSink({ recorder: analysis.port })`
   并把 `sink.hooks` 合并进 `createLotusLlmControllers` 的 hooks；③ 把 `sink` 作为 `analysisSink` 传给 `useLotusGame`。
   ②③ 必须成对（只给 hooks 不给 sink ⇒ 钩子找不到在飞窗口）。
   本文件的 e2e 走 `tests/e2e/fixtures/analysis-lotus-legacy.{html,ts}`，按与 App **同一套接线**
   （会话 + 稳定代理 + 展示回放共用场次 id + 接缝）直接挂载真实 `useLotusGame`，
   记录链路完全同源（含 `?llm=1` 那条真实 LLM 控制器用例）；差的只有"大厅列表行内状态"那一层 UI ——
   用例断言的是它读的那个**落库状态**（`matches.status === 'complete'`）。

   **app-path 用例（约定 §9 于 2026-09-21 追加的必做项）已经在 `analysis-lotus-legacy.spec.ts` 里，
   但在上面那三行落地之前它是红的 —— 这是有意的**：它锁的就是那一行，失败信息直接点明根因与待办。
   已用**临时补丁**（改 App.vue，不进任何提交）验证过：加上端口那一行后它 23.5s 通过
   （推进 5 局、8 分块、`rulesetId` 为 `lotus-legacy`，决策/前态/结算都有记录）。
   顺序：协调者合并本分支 → 补那三行 → 该用例转绿。

   > 一个**假阳性陷阱**（这条用例第一版就踩了）：只断言"有分块 / `rulesetId` 对"是**不够**的 ——
   > 没有端口那一行时，App 的 `analysis.start()` 仍会写下**配置**那一条（公共地基的能力表让
   > `lotus-legacy` 开局），于是上述断言全部成立，但一条决策都没有（正是「未记录到任何数据」的状态）。
   > 判据必须落在**决策/前态/结算**这些 tag 的计数上。
5. **vibehub 镜像：约定写错了，`lotusGame.ts` 需要手动镜像（实测更正）**。
   约定 §1 与 §6 表里都把 `src/game/variants/lotus/lotusGame.ts` 标成"共享文件、不需要镜像"，
   但同步脚本 `scripts/sync-master-to-vibehub.ps1` 的 **`$vibehubKeep` 清单第 100 行就把
   `lotusGame.ts` 列在里面**（该清单是"永远保留 vibehub 自己的版本"，脚本合并后用
   `git checkout $keepBase -- $vibehubKeep` 强制还原）。并且两边的这一份**差别很大**：
   `git diff --stat vibehub bfe2708 -- src/game/variants/lotus/lotusGame.ts` = 37 insertions /
   64 deletions（增减散布在 import、`UseLotusGameOptions`、函数体的二十多处 hunk 上），
   所以它不是"几乎一样、抄一下就行"，而是一次真正的移植。

   因此本分支对 vibehub 的影响与 A 的 `useGame.ts` **完全同类**，需要注意两点：
   1. 本节在 `lotusGame.ts` 里的记录接线（`analysis` 选项、控制器包装、结算/回执）**不会**自动
      同步到 vibehub，要**手动镜像**到 vibehub 的那一份；
   2. `tests/e2e/fixtures/analysis-lotus-legacy.{html,ts}` 与 `tests/e2e/analysis-lotus-legacy.spec.ts`
      是**新文件、不在 `$vibehubKeep` 也不在 `$masterOnly` 里 ⇒ 会被同步过去**，而它们依赖
      `useLotusGame` 的 `analysis` 选项。于是**只 sync 不镜像 ⇒ vibehub 的 `pnpm typecheck` 直接挂**
      （`analysis` 不在 `UseLotusGameOptions` 里）。
   顺序上「先镜像再 sync」不会出问题；先 sync 再镜像会让 vibehub 的中间态挂一会儿。

   两条解法（选一条，由协调者定）：
   ① 镜像时把 vibehub 那份 `lotusGame.ts` 的记录接线一起写上（推荐 —— 镜像本来就要做，写全了
      功能也在）；② 把这两个 e2e 文件加进 `$masterOnly`（它们只测本机分析链路，vibehub 不需要）
      或加进 `$vibehubKeep`。**无论哪条，`lotusGame.ts` 本身都必须镜像。**

   > 约定 §1／§6 是冻结清单里的文件，只能由协调者走「公共改动」更正；
   > 本节只记录实测事实，不改约定。

## 11. 与 A（莲花广麻）的对齐

- 两条分支**都往同一份分析区**写，共用存储/容量账本/分块压缩/导出导入/列表状态，不重做（方案 §0）。
- 两边各自一份 adapter（约定 §10：先各写一份，等两边都合并后再在 master 提「公共改动」抽取公共工具）。
  本适配层没有与 A 共用的代码。
- 唯一的公共接缝是 `LlmControllerHooks`（A 实现）+ `src/App.vue` 的引擎端口传递（协调者），
  见 §6 与「未做的部分」第 4 条。