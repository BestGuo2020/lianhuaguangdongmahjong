# 「莲花麻将·翻精癞子」AI 分析记录（P0 能归因 + P1 赛后复现）

> 玩法 `lotus-legacy`；分支 `master`（原 `feat/analysis-lotus-legacy` 的成果已合入）。
> 配套：方案 `analysis-recording-other-variants-plan.md`、分工约定 `analysis-two-variants-work-agreement.md`（本文作者是 **B**）、
> P1 实施方案 `lotus-legacy-p1-reproduction-plan.md`。
> §1–§11 是 **P0**（决策归因 + LLM 接缝）；§12 是 **P1**（赛后复现：开局快照 + 权威动作日志 + 浏览器内校验器）。

## 1. 一句话

翻精癞子对局现在会把**决策前态 / 选择与来源 / 执行回执 / 模型请求 / 结算**写进与血流共用的那个本机分析区；
LLM 座位接了约定 §5 的两个钩子（真发请求记 `model`、回退记 `model-fallback`）；
记录层是纯旁路观测，同一副牌在"分析开/关"两种设置下结束分数与动作数**逐位相同**（§9 硬护栏）。
P1 之后同样的记录点还额外落下**逐局的复现数据**（环状牌墙 + 两颗骰子 + 庄家 + 当局开局分 + 权威动作序列），
使读方能拿记录**把整局重跑到同一结束状态**（§12）。

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

1. ~~**P1 赛后复现（§6）没做**~~ —— **已做，见 §12**（2026-09-22）。当时的如实标注是
   `reproductionCapable: false` + `manifest.missing` 写"复现数据（reproduction）"；现在改成
   **按记录内容逐局判定**（字段齐 ⇒ true、缺字段 ⇒ false 并点名缺什么），见 §12.4。
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

   **app-path 用例（约定 §9 于 2026-09-21 追加的必做项）已经在 `analysis-lotus-legacy.spec.ts` 里。
   协调者已经把上面那三行落进 `App.vue` 了（`lotusLegacyAnalysisSink` + `analysis.port` + `analysisSink`），
   所以它现在是**真的在验端口传递**：2026-09-22 实测整场打完 → 13 分块、
   `{"config":1,"decisionState":229,"decision":458,"responderCheckpoint":45,"settlement":5,"reproduction":5}`
   （**P1 的复现数据在真实 App 路径上也逐局落库了**：5 局 5 条），2.7 分钟通过。
   （条数每次略有浮动 —— 这条用例走真实 App、牌墙是随机的：另一次单独跑到 15 分块 / `decisionState` 257。）**

   > 另一个坑（2026-09-22 实测修正）：这条用例的"节奏压缩"原先把所有定时器压到 **≤10ms**，
   > 而 `tileAssets.ts` 给每个牌面 `fetch` 挂的是 `window.setTimeout(..., FETCH_TIMEOUT_MS)`
   > （**12 秒**）的中止定时器 —— 压到 10ms 就等于"10ms 内没回就中止"，于是 34 张牌面的请求
   > 全被 abort（`net::ERR_ABORTED`）→ 牌桌报「牌桌资源加载失败」→ `.flip-indicator` 永远不出现。
   > **这条红与本分支改动无关**：把本分支改过的两个引擎文件还原成 `HEAD` 版本后同样红，而故障路径
   > （`tileAssets.ts` 的牌面预加载 → 牌桌挂载）发生在任何对局代码之前。证据：压缩下限取
   > 50/250/1000ms 都绿、10ms 必红。已把下限改成 250ms（仍是十几倍压缩，只是不再把网络超时一起压）。

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

## 12. P1 赛后复现（2026-09-22）

方案：`lotus-legacy-p1-reproduction-plan.md`。目标一句话：**读方能拿记录把整局重跑到同一结束状态**
（§2.3：不许拿"跑通"当"复现"）。与 P0 的关系：P0 记的是"**当时决策是什么**"，P1 记的是
"**能不能把这一局重跑出来**" —— 共用同一批汇聚点（控制器外面那层包装），但落两份不同用途的数据。

### 12.1 记录了什么、在哪一刻记（字段表）

落在 `reproduction` 这一 tag 下，与血流**同一个记录类型** `AnalysisReproduction`，靠 `variant` 区分口径：

| 字段 | 口径 | 取数时刻 | 为什么必须在这里取 |
|---|---|---|---|
| `ringWall` | 环状牌墙 136 张（**牌码**） | 开局时间线 `onRoundPrepared`（骰子已掷、**发牌之前**） | 此后牌墙会被移出翻精墩 → 按开牌断点重排 → 发出去。局末读 `state.wall` 拿到的是**终局牌墙**（血流在同一个地方踩过坑） |
| `dice.first` / `dice.second` | 两对骰子（各两粒） | 同上 | 翻精方位与开牌断点都由它们推出，不能事后反推 |
| `dealer` | 当局庄家 | 同上 | 决定翻精方位（`resolveFlip`）与发牌起点（`dealInitialHands`）。重跑第 2 局以后若沿用默认 0，翻精与手牌从一开始就是另一副牌 |
| `openingScores` | 四家**当局开局分** | `beginTurn` 那一刻（见下） | 结束分数是复现的判据；`resetLocalPlayers` 只给缺省分，第 2 局以后必须注入当局开局分才对得上 |
| `postDealHands` | 四家发牌后手牌 | 同上 | **交叉校验**（§12.3），不是重跑输入 |
| `flipTile`/`jokers`/`flipSeat`/`flipStack`/`wallBreakIndex` | 翻精读数 | 同上 | 由牌墙+骰子推出的结果，重跑推出来的必须一致 |
| `commands[]` | 权威动作序列（`AnalysisCommandEntry` 同形，含 `windowId`/`windowKind`/`legalActionId`） | 与 P0 的 `chosen` 同一处 | 见 §12.2 |

"`beginTurn` 那一刻"= 每局的**第一个回合**（庄家起手）：这时发牌刚完成、还没进入第一手决策，
`state.players[].hand` 与 `score` 正是**起始状态**。局末再读它们拿到的是终局 —— 拿终局当"起始状态"
就是另一种谎（§9.5），所以快照每局只取一次、就取在这一拍。

**故意不记的**：`honba`（连庄数）。翻了代码：翻精癞子的**计分**只用到 `dealer`（`applyWinScore`），
`honba` 只进 `RoundResult` 的展示字段，不进分数；所以重跑不需要它，硬记一个用不上的字段只会误导读方。

### 12.2 权威动作日志：同源、同顺序、顺序判据是 `windowId`

- **同源**：就在 P0 记 `chosen` 的那一处（`recordAnalysisWindow` 里控制器返回之后）再落一条命令，
  用同一个 `safely(...)` 分区隔离（决策记录失败不该连带丢掉可重跑的命令序列）。
- **顺序判据 = `windowId` 末段的自增编号**（`round-N/window/M`），**不是数组下标**：窗口 ID 在开窗时就
  定下来了，而回执/写库是异步的，数组顺序不等于执行顺序。
- **载荷按引擎真实动作形状记**，一个都不许漏：
  - 回合：`discard{handIndex}` / `added-kong{meldIndex}` / `concealed-kong{tile}` / `wind-kong` / `win`；
  - 鸣牌：`pass` / `gang` / `peng` / `chi{tiles}`；抢杠是**裸字符串** `'win' | 'pass'`（`toLotusActionLike` 认它）。
  - **`peng` 的 `discardIndex` 必须记**：编排层里"碰完顺手弃牌"（`offerNextClaim` 的 `discardIndex !== undefined`
    分支）与"碰完另开一个弃牌窗口"（`offerHu` 那条路）是**两条不同的路**，漏了这个下标，重跑会以为还要再摸一张。
- **被拒的动作不进日志**：条目只在控制器真的返回之后才落，拒绝/异常路径上什么也不写（§10.2）。

### 12.3 校验器：在浏览器里跑（`reproduceLotusLegacy.ts`）

`replayLotusLegacyRound({reproduction, commands, expectedScores, tick})` —— 起一个真实 `useLotusGame`，
用记录里的牌墙/骰子/庄家/开局分重新发牌，再把记录里的命令**逐条喂回**四个座位的脚本化控制器：

- **发牌后交叉校验（§3.3）**：重跑第一个窗口开窗时，把 `state.players[].hand` 与记录的 `postDealHands`
  **逐家逐张按位置**比。不一致就报「**发牌算法变了或记录与引擎不一致**」并**立刻停**，
  绝不用另一副牌把这一局跑完再宣布"复现失败"。（按位置比而不是按集合比，有单测专门锁这条：
  把首张挪到末尾、牌还是那几张，也必须判不一致。）
- **翻精读数交叉校验**：`flipTile`/`jokers`/`flipSeat`/`wallBreakIndex` 与记录比（记录里没带的项不猜、不比）。
- **命令合法性**：带 `legalActionId` 的条目必须落在**重跑此刻**的合法动作里（与 P0 的 `chosenIndex` 同一条判据）；
  唯一例外是**记录侧自己标了"当时就不合法"**的条目（P0 的 `chosenIndex = -1`、没有 `legalActionId`）：
  它们**照原样重放**但不做命中断言 —— 照原样重放才是忠实的（同样的输入 → 引擎同样的兜底分支），
  这类条目的条数如实暴露在 `metrics.commandsNotLegalAtRecordTime` 上。这是**如实**，不是放宽。
- **不许跳过、不许凑**：`unusedCommands`（记录里有、重跑没走到）与 `extraWindows`（重跑开出、记录里没有）
  都必须为 0；缺 `windowId`、窗口座位/类型对不上都直接判不通过；**缺 `openingScores` 时报"结束分数不可比对"**
  并且根本不开始跑；缺"可比的结束分数"同样不宣称成功。
- **§4「被拒动作不出现」的两个可观测形式**（都不许用过滤来达成）：
  ① **非命令口径的条目**（`resolution: 'expire' | 'auto'`，血流权威端靠超时/自动推进的概念）一旦出现，
  校验器**不重放、也不静默丢掉** —— 计入 `metrics.nonCommandEntries` 并直接判不通过
  （理由写清"翻精癞子没有靠超时推进的窗口，无法重放这些条目"）。夹具也**原样**把命令日志交进校验器，
  不在上游先过滤掉，否则"记录里混进了另一套口径"这种事会悄悄消失。
  ② 每条命令在**记录时**都必须落在当时的合法动作里（带 `legalActionId`）；`metrics.commandsNotLegalAtRecordTime`
  必须为 0（单测与 e2e 都断言这一条）。
- **观测桩不许抛**（实测踩到的坑，值得记住）：校验器挂的是**观测桩**（不落库）。引擎的
  `safely('window-open')` 会把桩里的异常吞掉，但"窗口编号自增"那一步在它后面 —— 桩一抛，
  编号就不再自增，重跑侧会开出两个都叫 `#1` 的窗口，后续全被误判成"窗口序列错位"。
  本文件第一次跑（端口少了 `flipSeat`）就是这么红的：真正的错因藏在 `gaps` 里，报出来的却是座位错位。
  桩现在自己 try/catch，并把"观测失败"变成一个停止原因。同时**给游戏端口补了 `flipSeat`**（它本来就该暴露）。

### 12.4 导出包如实声称"可复现"

`export.ts` 的 `reproductionCapable` 从 P0 的一刀切 `false` 改成**按记录内容逐局判定**
（判据在 `reproductionCapability.ts`，与校验器共用一份字段清单，避免"导出说可复现、校验器说缺字段"）：
完整 + 引用闭合 + ≥1 条复现数据 + **每条复现数据的字段都齐**。缺字段时逐局写进 `manifest.missing`
（形如「复现数据不完整（第 3 局缺少 ringWall（环状牌墙 136 张，实为 0 张）、commands（权威动作日志））」），
而不是笼统一句"缺复现数据"。

### 12.5 验证（跑了什么、看到什么数字）

**单测**（`vue-tsc --noEmit` + `vitest run src`）：全绿 **1955 passed / 2 skipped（193 个文件）**。
P1 新增两个文件：

- `lotusReproduction.test.ts`（15 条）：快照口径（136 张、每种 4 张、全是牌码）、四家开局分、
  `postDealHands` 改一张 ⇒ 报不一致并点名"第 2 家第 2 张"、命令条目形状（含 `peng.discardIndex`、
  抢杠裸字符串）、区分键、旧记录（血流口径）向后兼容。
- `replayLotusRound.test.ts`（6 条）：**真跑一局再重跑**（假定时器，几秒）。本地这一条第一次跑就抓出了
  上面那个"观测桩抛异常 ⇒ 窗口编号错乱"的坑，还有四条负向：篡改发牌、缺开局分、缺可比的结束分数、
  命令日志里混进 `expire` 条目（必须报错而不是过滤掉）。

**e2e**（`tests/e2e/analysis-lotus-legacy.spec.ts`，**6 条全绿，共 4.1 分钟**；dev server 在 4178）：

| 用例 | 结果 |
|---|---|
| 记录形状/遮蔽/窗口 ID/结算守恒/导出包自包含 | 5 局；`{"config":1,"decisionState":202,"decision":404,"responderCheckpoint":42,"settlement":5,"reproduction":5}`；`reproductionCapable=true`、`missing=[]` |
| **P1 逐局重跑** | 5 局全部 `ok=true`：命令**逐条**消费 37/37、47/47、62/62、34/34、22/22，窗口数=命令数，`unused=0`、`extra=0`、`kindMismatches=0`、`nonCommandEntries=0`、`commandsNotLegalAtRecordTime=0`、`gaps=[]`；结束分数与记录**逐位相同**（如第 5 局 `-1200/-600/7500/2300`） |
| 同上：篡改对照 | 改一张 ⇒ `ok=false`、原因含「发牌算法变了或记录与引擎不一致」、**`commandsConsumed=0`**（一条都没喂） |
| 分析关掉后零写入 | 0 块、0 场次、0 记录，`reproductionParts=0` |
| 硬护栏（开/关同一副牌） | 分数 `-1200,-600,7500,2300` 两次相同；动作数相同；`rngDraws` 1552 = 1552 |
| LLM 座位接缝 | 尝试 54 条、模板 1 条 |
| app-path（真实 App） | 13 分块、`{"config":1,"decisionState":229,"decision":458,"responderCheckpoint":45,"settlement":5,"reproduction":5}` —— **真实 App 路径也逐局落了复现数据**（条数每次浮动：这条用例走真实 App、牌墙随机） |

`?replay=0` 可跳过逐局重跑（与复现无关的用例不必付这份时间）；`?analysis=0` 时一次都不跑（零成本）。

### 12.6 明确没做 / 边界

1. **天胡那一局没有复现数据**：庄家起手即胡时开局时间线直接结算、根本不进 `beginTurn`，所以取不到快照。
   这种情况**不写**这一局、只如实留痕 `noteGap({scope:'reproduction', reason:'round-without-opening-snapshot'})` ——
   拿局末状态凑一个"起始状态"就是另一种谎。（实测那 5 局都不是天胡，5 局 5 条；判据源是
   `partsByTag.reproduction === roundsPlayed`，真遇到天胡会如实少一条并留下缝。）
2. **重跑不比对逐手状态**：只比"发牌后手牌 + 翻精读数 + 窗口序列 + 命令合法性 + 结束分数"。
   中间每一手的牌河/副露没有逐步比对（血流那边也没有）—— 逐步比对属于更细的 P2 级要求。
3. **四个座位都脚本化 ⇒ 验证的不是"AI 决策复现"**：重跑时四家都由记录驱动，所以它证明的是
   "**记录足够把这一局重放出来**"，不是"AI 在同样局面下会做同样选择"（后者要求模型侧确定性，本阶段没有）。
4. **没有把重跑接进界面**：校验器目前只能在夹具/测试里调用（`replayLotusLegacyRound` 是纯函数入口）。
   界面上的"赛后复现"按钮属于后续工作。
5. **vibehub 的 `lotusGame.ts` 仍需手动镜像**（本节的快照/命令日志/落库都在那个文件里）——
   见「未做的部分」第 5 条。本轮已按那套流程镜像：master `c6a1114` → `sync:vibehub`（`5137093`，
   keep 文件被还原成 vibehub 版）→ 手动移植（3-way 基线 = 改动前的 master 版本）→ vibehub 门控
   （`vue-tsc --noEmit` 通过 + `vitest run src` = **2076 passed / 2 skipped**，含 `replayLotusRound.test.ts`）
   → vibehub 提交 `25a6a72`。