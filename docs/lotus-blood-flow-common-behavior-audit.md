# 血流通用交互复用检查

检查日期：2026-09-05。基线为 master `1898559` 及本次按钮修复；同时存在另一轮未提交的 E14 演出改动，本文不把那些改动算作本次完成。范围为前端和 P2P 所用游戏交互，未检查后端、性能或安全。

结论：血流确实另写了若干原本应该保持一致的交互接线。牌桌、手牌组件和声音资源仍有复用，但新的响应引擎、状态投影和表现调度改变了原有行为。不能用“组件还是同一个”作为交互已对齐的验收依据。

## 已确认的差异

| 项目 | 非血流实现 | 血流现状和影响 | 状态与处理 |
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
