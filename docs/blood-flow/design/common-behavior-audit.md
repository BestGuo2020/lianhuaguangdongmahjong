# 血流通用交互复用检查

> 本文维护公共能力的职责和覆盖边界；进度只在任务表。前半为 2026-09-06 的抽取方案，后半保留 1898559 / 7ca6dbb 历史检查，不能将旧缺口当成当前状态。
> 当前入口：[文档首页](../README.md) · [当前任务](../tasks.md) · [验收记录](../acceptance.md)。


## 公共能力与 override 边界

核对日期 2026-09-06，基线 `d48c1bf`。本轮为代码审查与设计，未重跑游戏验收。`af68353` 已提取公共 `TableActionCue` 和 `winningTileFlight`；`d48c1bf` 已补倒数提示并调整读字阶段。这些不再列为尚未实施的缺口。

目标：新玩法默认使用已有公共行为，只通过明确的参数、策略或内容插槽覆盖差异。采用现有函数工厂、控制器接口与组件组合，不要求把全部游戏改造成基类继承树。以下接口名是职责建议，不代表已经存在，也不要求逐项新建文件。

### 应共享的能力清单

| 能力 / 原实现依据 | 公共默认职责 | 允许玩法 override | 不允许覆盖 / 边界 | 安排 |
|---|---|---|---|---|
| LLM 提示词与决策输入：prompt、llmController、bloodFlowRuntime | 性格指导、公共局面描述、候选特征、默认推荐、输出协议 | 规则摘要、特殊牌型范围、锁手说明、胡牌收益、合法候选与特征提供器 | 不能重写整份提示词导致公共指导丢失；未算出的特征明确未知，不能编造；旧规则摘要不能原样套血流 | 优先，G08 |
| LLM 请求编排：llmController、conditionalReasoning、client | 配置解析、条件深思、进度、统计、取消、错误回退 | 玩法候选映射、权威截止时间、当前窗口有效性、合法动作提交 | 使用共享请求服务，不再默认私设 2.8/4.5 秒替换用户预算；窗口确有更短期限时明确取交集，不能延长规则期限 | 优先，G08 |
| 玩家身份与发言：runtime、persona、bloodFlowSpeech | 座位预置、昵称/角色/音色、性格频率、短句处理、气泡生命周期 | 允许发言的事件、动作实际执行确认、局末摘要事实 | 保留普通性格表达；局内胡自由评论关闭，强制动作不额外请求；固定动作报声不与动态 TTS 双播 | 优先，E15 / G08 |
| 声音调度：animeAudioPolicy、固定 TTS 执行器、audioBridge | 主题/角色路由、播放完成、失败回退、静音、去重和离场取消 | 将玩法事件映射为公共动作事件；独立效果音的重拍时间 | 渲染组件不另发人声；等待完成与发起播放使用同一次请求，不重复播放 | 随声音链路收拢，E14 / G07 |
| 选牌与操作：lotusHuman、useBloodFlowGame、现有操作栏 | 点击音、选中保持、同窗刷新、触屏行为、吃法选择 | 是否可选、可弃索引、窗口身份、动作提交函数 | 不能自行推断合法性并藏按钮；胡/碰/杠/吃候选一次展示；手牌变化才按明确规则清选中 | 已修体验先保留，确有重复再抽，G01 / G03 |
| 三类听牌提示：gameSelectors、useBloodFlowGame | 当前听口、弃牌选项、选中牌预览的数据组织与失效处理 | 同步/异步 evaluator、合法弃牌集合、倍率字段、可见余张计算 | 不强行把 Worker 求值变同步；胡楼的多份展示引用不能重复扣实体余张；不得从对手暗手求余张 | G04，渐进抽取 |
| 倒计时与普通动作阶段：localCountdownController、useBloodFlowGame | 剩余秒数、操作开放条件、最后三秒提醒去重、停止/取消；公共动作阶段约定 | enabled、opensAt/deadlineAt、超时动作处理器；玩法引擎提供阶段事件 | 提醒与超时裁决分开；不把旧“选最后一张”塞给所有玩法；AI 思考时间不替代动画时间 | G02 / G05；当前恢复成果保留 |
| 主题动作与胡牌运动：TableActionCue、winEffectPresenter、winningTileFlight | 字形/角色资源、运动采样、光柱/粒子、减少动态效果 | actor、source/target、开始/命中/落稳时间；经过验证的标题增量 | 不复制五套主题 renderer；不调用终局或再次扣分；默认值保持普通玩法效果 | 已抽取基础，E11 / E12 / E14 回归 |
| 结算导航与容器：SettlementOverlay、BloodFlowSettlementHost | 一次自动打开、查看牌桌、恢复结算、明细返回、遮罩与焦点、主题外壳 | 结果内容、是否最终局、账本插槽、下一局/返回大厅动作 | 不强迫单胡结果使用血流账本；“关闭”不隐式重新开局；同局数据刷新不抢回弹窗 | E10，低于 LLM 与当前可玩性 |
| 开局与离场：createLotusOpening、现有计时/事件清理 | 就绪→骰子→翻精→发牌的既有单机流程；取消迟到效果与声音 | 开局数据、玩法专属亮牌步骤、完成通知 | 当前单机已共用，不再提取第二套；远端仍需保持权威确认，不能共用本地随机结果 | 单机维持；G06 与联机后置 |

### 不能强行统一的部分

- 血流锁手、连续胡、多人响应裁决、末张续行、胡杠账本与计分保留为规则模块。可以提供统一查询接口，但不能继承旧单次胡牌后结束整局的实现。
- 普通 AI 的 `lotusAi` 核心继续共用，血流保留合法候选交集、锁手和收益取舍；不重新抽出另一个“公共”牌效引擎。
- 主题能力与玩法能力分开组合：llmAnime 决定角色/固定音声路由，血流决定连续胡调度。不得建立“血流×五主题×联机方式”的类继承组合。
- 传输方式只提供命令提交与状态输入，不能决定字体、点击反馈或报声策略；本轮不实现传输重构。

### override 的统一约定

1. **默认行为可直接使用。** 未提供覆盖时，旧玩法的实际行为保持不变；未定义与显式关闭分开表达，避免缺参等同于禁用声音/动画。
2. **只开放小范围差异。** 内容与规则由 provider 提供，视觉由主题配置/插槽提供，时间与来源由 adapter 提供。不提供一个能替换全部流程的万能 callback。
3. **公共执行顺序不被随意绕过。** 对决策先构造候选，再请求/回退，再校验有效性及合法性，普通弃牌台词沿用公共 TTS：playing 显示气泡，中点后重验窗口并提交；静音/失败放行。吃碰杠发言仍等提交确认后展示。血流可以改候选，不跳过校验或执行确认。
4. **每项副作用只有一个所有者。** 权威引擎执行动作和计分，公共声音入口播声音，公共展示层画面输出；override 不在多个入口重复执行。
5. **取消与恢复属于公共契约。** 新局、离场、主题变化取消对应迟到工作；历史恢复使用最终态，不重播旧支付/声音。不同服务保持各自生命周期，不建一个包揽所有状态的全局管理器。
6. **渐进迁移。** 优先原样提取已经工作的代码，先接普通玩法，再接血流，最后删除旧重复段。抽取后必须有至少两条实际调用链，不为未来假想玩法先造框架。
7. **共用实现也要共用行为测试。** 同一组点击保持、候选同窗、倒数去重、结算返回测试通过适配器跑两个模式；玩法差异单独断言。默认行为与每个 override 均留回归，不把所有测试绑死到内部函数名。

### 接下来如何安排

不新增第六套任务编号。已执行的表现五包继续保留；将 LLM 公共收拢明确纳入 G08，在包 5 的真实模型验收前完成，作为单独提交边界。G08 按“公共输入/提示词 → 配置与条件深思 → 发言/TTS → 行为验证”执行，禁止直接把整个旧控制器搬进血流引擎。

选牌、听牌、倒数、结算等已经可用的部分不集中推倒重做：后续确有修改需求时，先在公共能力中修复，再通过小范围 override 保留差异。实质重复且有双模式测试的部分可逐项抽取；纯风格统一不阻塞当前体验交付。具体进度只更新 tasks.md 的对应 E/G 行。

## 历史检查：1898559 / 7ca6dbb

检查日期：2026-09-05。基线为 master `1898559` 及本次按钮修复；同时存在另一轮未提交的 E14 演出改动，本文不把那些改动算作本次完成。范围为前端和 P2P 所用游戏交互，未检查后端、性能或安全。以下缺口与同步说明仅保留当时记录，现行状态和当前联机后置范围以 tasks.md 为准。

结论：血流确实另写了若干原本应该保持一致的交互接线。牌桌、手牌组件和声音资源仍有复用，但新的响应引擎、状态投影和表现调度改变了原有行为。不能用“组件还是同一个”作为交互已对齐的验收依据。

## 已确认的差异

| 项目 | 非血流实现 | 血流现状和影响 | 检查时状态与处理 |
|---|---|---|---|
| 吃碰杠胡响应 | `LotusHumanController.requestDiscardHu` 用 `response`，一次提供胡、碰、杠、吃、过；裁决按优先级处理 | 原 `openWinClaims` 只提供胡/过，再开 `openMeldClaims`；投影还传了只显示胡/过的 `hu` 类型 | **本次已修**：普通弃牌一个响应窗口，投影复用 `response`，保留多响及胡优先。没有新写按钮组件 |
| 普通动作节奏 | `lotusTurnOrchestrator` / `turnRunner` 使用公共 `PACE_MS`，区分弃牌后、碰后、杠后、抢杠前的停顿 | 血流 `discard` / `claimMeld` / `performKong` 同步走到下一状态；`schedule` 的 650ms 是机器人决策延迟，不能等同于公共动作表现节奏。人工操作和快速快照不受这段延迟保护 | **仍需恢复**。保留权威引擎的规则职责，普通动作由共享表现调度消费事件，复用原节奏；不能在引擎里调用旧 `endGame` |
| 手牌间隙、动画连续性 | 摸牌保留在最右端，吃碰后使用公共手牌布局；3D 插值按既有轨迹播放 | 开局排序后标记可能指向中间，快照重建实例曾打断插值 | **上一轮 `1898559` 已修这两点**：标记牌移到末尾，重建保留在播轨迹。普通动作的前后阶段衔接仍属于上一项，不能宣称整个节奏问题已经解决 |
| 选牌状态和反馈 | `createLotusHuman.selectTile` 检查本家回合并播放 `click.mp3`，选中状态持续到操作清理 | 血流 `selectTile` 仅赋值；`apply` 每次快照都将 `selectedIndex` 置为 -1，即使仍是同一窗口、同一手牌 | **已确认代码差异，尚未修复**。共享选牌反馈；按回合/手牌变化清理，而不是每份快照清理。补重复快照下选牌不跳回的交互验收 |
| 听牌提示 | 公共 selector 区分“当前听口”“打哪张可听”“选中牌打出后的听口”，返回对应弃牌 | 血流 `userTingOptions` 恒为 `[]`，`userCurrentWaits` 与 `userDiscardWaits` 共用一个值，`discard` 恒为 null；吃碰后的未选牌状态可能直接不计算 | **功能缺口，尚未修复**。保留血流番型计算器，在同一提示数据契约下提供三类信息；锁手仅允许对合法摸切牌提供弃牌预览 |
| 倒计时 | `createLocalCountdownController` 保留最后 3 秒 `didu.ogg` 提示；旧单机默认 12 秒 | 血流重新按权威 deadline 计算数字，没有接倒数提示音；配置为单机 15 秒、远端 25 秒 | **提示音漏接；时长单独核对产品决策**。权威截止时间有必要保留，但显示和提醒应共享。按窗口去重提示音，不能每次快照重播，也不能直接复制旧本地超时出牌逻辑到 P2P |
| P2P 开局演出 | 既有 `openingTimeline` 处理牌桌就绪、开局声完成、两次骰子、翻精、发牌和收尾停顿 | 血流 `acceptRemoteView` 内又手写一段开局；骰子等待为 1600ms，末尾缺原有 650ms 收尾；也没有等 `game_start` 播完或共享的牌桌就绪入口 | **重复实现，尚未收拢**。从既有时间线抽共享的开局演出，适配权威快照输入；保留 P2P 开局确认和缓冲快照行为。单机已复用 `createLotusOpening` |
| LLM 普通发言、气泡 | 既有 `llmController` / `decisionSpeech` / runtime 接动作短句、发言策略及 TTS | `bloodFlowDecisionPrompt` 要求所有动作不发言，`createBloodFlowDecisions` 忽略全部 message；HUD 的血流分支也仅在结束后显示 `roundBubbles`。只改提示词仍恢复不了气泡 | **明确偏离用户要求，尚未修复**。在 llm / llmAnime 恢复普通摸打、吃碰杠的既有发言策略；胡牌事件不发自由感言；全桌感言仍只在对局结束后 |
| LLM 决策外围 | 共用候选、条件推理、请求及人设相关编排 | 血流复用底层请求客户端，但另写候选标签、决策预算与调用入口；未接入普通控制器的条件推理协调器 | **部分适配合理，外围存在分叉**。血流锁手/番数/多次胡牌上下文保留，模型配置、人设、条件推理与消息处理应对照公共入口，按实际功能逐项补齐，不能直接套旧单次胡牌结算回调 |
| 报声和音效调度 | 既有策略选择固定角色 TTS 或资源音频；弃牌报牌完成有独立 Promise，可供后续演出等待 | `audioBridge` 复用了 `resolveAnimeAudioPolicy`、`AnimeFixedTtsExecutor` 和已有资源映射；血流弃牌报牌另用 80ms 定时器，没有接回报牌完成等待 | **不是重新制作人声资源**。需统一事件播报适配与先后次序，保留事件去重。E14 正在修改音效和异常回退，本文不覆盖那轮改动，也未做真人听感验收 |
| 结算容器和导航 | 既有结算组件管理弹层、回桌及回到结算 | 血流另有 `BloodFlowSettlementHost`、本局汇总、最终排名、流水；关闭和回桌已使用明确 view 状态，重复快照按 roundId 去重 | **内容差异合理，外壳可共享**。关闭、遮罩、返回路径、焦点恢复可逐步提取公共壳；多次胡牌账本不能强塞进旧单次胡牌结果。此前“看不了牌桌/关不掉”的回归已有修复和浏览器用例 |

## 仍在复用的部分

- 牌桌、牌河、手牌及麻将牌资源：`MahjongTable3D.vue`、`GameTableHud.vue`、`MahjongTile.vue` 和 `tableTilePresenter.ts`。本次按钮修复没有修改公共 HUD 模板或样式。
- 普通吃碰杠的动作字和角色立绘：既有 `createLocalTransientEventPresenter`、`AnimeActionCue.vue`。血流胡牌立绘已进入批次演出；没有必要复制角色资源或改角色尺寸。
- 普通 AI 牌效策略：血流 `ai.ts` 调用 `lotusAi` 的 `decideTurn`、`decideClaim` 和保护精牌的候选过滤。本次仅修正同一窗口中别人可胡时，本席吃碰杠仍能走公共决策的入口。
- 洗牌、翻精、牌墙取牌辅助方法、字顺子判断、排序等仍有公共实现。血流计分、锁手、多响、后续摸牌和多次收付属于玩法职责，需要专门状态。

## 代码定位

以下链接对应本地工作区，可直接跳到实现核对。

- 响应引擎：[engine.ts](D:/vueprojects/lianhua_guangma/src/game/variants/lotus/bloodFlow/engine.ts:179)；原版响应：[lotusControllers.ts](D:/vueprojects/lianhua_guangma/src/game/variants/lotus/lotusControllers.ts:174)。
- 状态、按钮、倒计时、听牌和远端开局：[useBloodFlowGame.ts](D:/vueprojects/lianhua_guangma/src/game/variants/lotus/bloodFlow/useBloodFlowGame.ts:101)。
- 普通操作和声音：[lotusHuman.ts](D:/vueprojects/lianhua_guangma/src/game/variants/lotus/lotusHuman.ts:34)；[tileFlowExecutor.ts](D:/vueprojects/lianhua_guangma/src/game/shared/runtime/tileFlowExecutor.ts:67)。
- 原节奏参数：[localGameConfig.ts](D:/vueprojects/lianhua_guangma/src/game/core/local/localGameConfig.ts:14)；原响应调度：[lotusTurnOrchestrator.ts](D:/vueprojects/lianhua_guangma/src/game/variants/lotus/lotusTurnOrchestrator.ts:229)。
- 听牌提示契约：[gameSelectors.ts](D:/vueprojects/lianhua_guangma/src/game/shared/selectors/gameSelectors.ts:66)；倒数提醒：[localCountdownController.ts](D:/vueprojects/lianhua_guangma/src/game/core/local/localCountdownController.ts:21)。
- 原远端开局：[openingTimeline.ts](D:/vueprojects/lianhua_guangma/src/game/online/presentation/openingTimeline.ts:212)。
- 血流 LLM：[bloodFlowRuntime.ts](D:/vueprojects/lianhua_guangma/src/game/llm/bloodFlowRuntime.ts:39)；HUD 气泡过滤：[GameTableHud.vue](D:/vueprojects/lianhua_guangma/src/components/table/GameTableHud.vue:200)；普通消息处理：[llmController.ts](D:/vueprojects/lianhua_guangma/src/game/llm/llmController.ts:200)。
- 复用音频策略的适配：[audioBridge.ts](D:/vueprojects/lianhua_guangma/src/game/variants/lotus/bloodFlow/audioBridge.ts:6)；结算导航：[BloodFlowSettlementHost.vue](D:/vueprojects/lianhua_guangma/src/components/settlement/BloodFlowSettlementHost.vue:12)。

## 收拢顺序和验收

1. **已完成：响应按钮。** 同牌吃/碰/杠/胡/过一次出现；单一吃法直接吃、多种吃法用原选择器；先提交碰仍不能抢在别人胡之前消费牌。抢杠只胡/过、锁手禁吃碰杠、末张不再开杠等边界保留。
2. **普通动作与选牌。** 先恢复摸打、吃碰杠、补牌和手牌交互的原阶段顺序。分别覆盖本家和三家、人工快速点击和 AI、P2P 重复快照；不能只看一次完整动画或只跑积分测试。
3. **听牌提示与轻反馈。** 接回三种提示、选牌声和倒数声。14/11/8/5/2 张分别验收，吃碰后未摸牌、切换选牌、锁手和重复快照都需有结果。
4. **LLM。** 从配置、候选、动作提交到气泡/TTS 逐层复用；普通发言遵循主题与频率设置，局内胡牌仍仅既有报声，结束后再感言。P2P 的感言需由已接收的公开事件驱动。
5. **P2P 开局与结算外壳。** 共享视觉时间线和按钮语义，保留各玩法的数据与联机装配。原版和血流使用同一组用户路径检查。

本次验证：全量 Vitest 101 个文件通过、1 个跳过（1103 条通过、2 条跳过）；随后补充响应边界后，engine 的 21 条全部通过。7 条浏览器用例覆盖五种按钮直接点击、多吃法选择和 844×390 触屏布局，均通过。TypeScript 检查和生产构建通过。浏览器测试走真实引擎、座位投影、`useBloodFlowGame` 及现有 HUD；不是实际 SDK 联机验收。

master 提交后仍须运行 `pnpm sync:vibehub`。工作区如有并行演出改动，遵守同步脚本的干净工作区要求，不将他人未提交文件混入本次修复。
