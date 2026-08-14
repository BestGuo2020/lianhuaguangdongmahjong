# 莲花麻将（lotus-legacy）多人玩法缺陷修复记录

- 记录日期：2026-08-14
- 工作目录：`D:\vueprojects\lianhua_guangma`
- 背景：单机 `src/game/variants/lotus/` 为参考实现；多人后端（`backend/app/`）为服务端权威。逐项比对后修复后端硬 bug 与前端规则分歧，并对齐部分节奏。

## 0. 用户拍板的规则解释权（以调整后的后端为主）

1. **七星十三烂允许精牌替补**（精牌可替补十三烂冲突牌面；东南西北中发白七字同样允许精牌替补，不要求物理齐全）。
2. **十三幺允许精牌替补**（13 种幺九/字牌缺失时可由精牌替补凑齐，其中一种仍须成对，不要求物理齐全）。
3. **吃/碰/杠全局优先级以后端为准**：胡 > 杠 > 碰 > 吃（杠从"碰或明杠"同级中拆出、压过碰；而非单机原先的"按座位距离"）。

上述规则结论意味着 **A1、A4 的修复方向是改前端**（向后端对齐），其余 bug 修后端。

---

## 1. 已修复项（本批次）

### 后端（`backend/app/`）

| 编号 | 问题 | 修复 | 文件 |
| --- | --- | --- | --- |
| A2 | 抢杠胡牌数不守恒（被抢杠牌凭空消失，133≠134） | `take_robbed_kong_tile` 增加 `winner_index` 参数，把被抢的杠牌推入抢杠者手牌（14 张）；`end_game` 传入赢家座位；`finalize_win` 移除抢杠路径下重复补牌 | [manager.py](backend/app/game/manager.py) |
| A3 | 点炮胡赢家手牌被加成 14 张（与单机 13 张 + winTile 不一致） | `finalize_win` 不再把和牌 append 进赢家手牌，点炮胡保持 13 张，和牌由 `winTile` 单独携带用于评分 | [manager.py](backend/app/game/manager.py) |
| A5 | 听牌/流局判定把精牌/白板候选当本牌 | `waiting_tiles` 改为候选补入后按癞子处理（`is_winning_hand([*hand, tile], …, jokers)`），与单机 `waitingTiles` 一致 | [lotus_rules.py](backend/app/core/lotus_rules.py) |
| A6 | `evaluate_fans` 用 `elif not dealer` 误把"非庄"当"自摸" | 移除该错误推断；抢杠胡/杠上开花/自摸的「加计自摸」由 `score_legacy_hand` 统一计算（此通用接口本就是状态番桩） | [lotus_legacy.py](backend/app/rules/lotus_legacy.py) |
| C9 | 吃牌后停顿用错键（350ms 而非 650ms） | `offer_next_claim` 的 chi 分支 `skipDrawPengDelay` → `afterClaimPeng`，对齐单机 `PACE_MS.afterClaimPeng` | [manager.py](backend/app/game/manager.py) |
| C10 | 人类杠停顿与 AI 不分（明杠 550 / 暗杠 0） | 新增 `_is_human()`（`not isinstance(controller, AIPlayer)`）；真人明杠 350ms、真人暗杠后补 350ms 停顿，AI 保持 550/0 | [manager.py](backend/app/game/manager.py) |
| B1 | AI 副露无脑 gang>peng>chi | 新增 [lotus_ai.py](backend/app/core/lotus_ai.py) `decide_claim`：按动作后听牌质量与现状比较，不提升则 pass；`AIPlayer.request_claim` 对 lotus 路由到该决策 | [player.py](backend/app/game/player.py) |
| B2 | AI 弃牌启发式只算同牌/靠张 | 新增 `choose_discard_index`：按听口数/剩余可见张/特殊牌型分/安全度打分；`decide_turn` 对 lotus 路由到该启发式 | [ai.py](backend/app/core/ai.py) |

### 前端（`src/game/`）

| 编号 | 问题 | 修复 | 文件 |
| --- | --- | --- | --- |
| A1 | 七星十三烂不允许精牌替补（与后端规则不一致） | `isQiXingShiSanLan` 增加 `jokers/ordinaryJokers/jokerSubstitutes` 参数并传入 `isShiSanLan`；`evaluateBasePattern` 调用处同步传入。后续按用户拍板修正为「七字同样允许精牌替补、不要求物理齐全」：前端抽出共用骨架 `hasShiSanLanShape`，七星判定在精牌填完后要求最终 14 张含七字；后端 `is_thirteen_lan` 增加 `require_seven_honors`，`evaluate_pattern` 以该标志判定七星 | [lotusRules.ts](src/game/variants/lotus/lotusRules.ts) |
| A4 | 吃/碰/杠按座位距离而非"碰杠>吃" | `findClaims` 排序改为「杠(1) > 碰(2) > 吃(3)，同级按距离」，对齐后端 `find_claims` | [lotusTurnOrchestrator.ts](src/game/variants/lotus/lotusTurnOrchestrator.ts) |
| C2 | 点炮胡误播"自摸"音效 | 联机结算时间线 `robbedKong ? hu : zimo` → `discardWin \|\| robbedKong ? hu : zimo` | [settlementTimeline.ts](src/game/online/presentation/settlementTimeline.ts) |
| C4 | 翻精墩空位/指示牌从第 0 帧就露出 | `start()`/`captureSnapshot()` 不再提前写 `flipTile/flipStack`，改在 `run()` 翻精阶段写入 | [openingTimeline.ts](src/game/online/presentation/openingTimeline.ts) |
| C5 | "翻精"播报缺失且用原始牌码 | 服务端移除 `round_start` 阶段的「翻精」公告（[manager.py](backend/app/game/manager.py)）；客户端在翻精阶段用 `tileName()` 中文牌名播报 | [openingTimeline.ts](src/game/online/presentation/openingTimeline.ts) |
| C7 | 首骰值在 start 阶段就显示 | `diceValues` 在 `start()` 复位为 [1,1]，骰子阶段才写入 `firstDice` | [openingTimeline.ts](src/game/online/presentation/openingTimeline.ts) |
| C8 | 缺"开牌→庄家出牌"650ms 停顿 | `run()` 发牌结束后补 650ms 停顿再 `send(opening_done)` | [openingTimeline.ts](src/game/online/presentation/openingTimeline.ts) |
| C11 | 流局多出 600ms revealing 停顿 | draw 分支直接 `settled` + `revealHands=true`，去掉 revealing + 600ms | [settlementTimeline.ts](src/game/online/presentation/settlementTimeline.ts) |

### 测试补充

- 后端 `tests/test_lotus_legacy.py`：新增/改写
  - `test_lotus_robbed_kong_win_conserves_the_robbed_tile`（设置 pending gang 副露，断言杠降碰 + 被抢牌入赢家手牌 14 张）。
  - `test_lotus_discard_win_uses_the_physical_discard_tile` 增补断言（赢家手牌保持 13 张）。
  - `test_lotus_waiting_tiles_reports_joker_face_as_wait`（精牌面本身是听口）。
- 前端 `src/game/variants/lotus/lotusRules.test.ts`：新增「七星十三烂：精牌可替补冲突牌面」用例。
- 前端 `src/game/online/presentation/openingTimeline.test.ts`：新增 `announcement` 状态；改写「首骰在骰子阶段展示」「翻精阶段播报『翻精』」等断言，captureSnapshot 不再提前写 `flipTile/flipStack`。
- 前端 `src/game/online/useRemoteGame.test.ts`：开局序列相关用例按「骰子复位 → 骰子阶段展示 → 发牌 → 650ms 停顿」的新节奏调整推进时长与骰子值断言。
- 前端 `src/game/online/presentation/settlementTimeline.test.ts`：draw 用例改为「流局立即 settled，无 600ms revealing 停顿」。
- 后端 `tests/test_manager.py`：新增 `test_is_human_distinguishes_remote_from_ai`（真人 vs AI 补位的杠停顿区分依据）。
- 后端 `tests/test_lotus_ai.py`：新增「能杠必杠」「碰牌破坏听牌则 pass」「白板癞子保手」三个策略 AI 用例。

---

## 2. 验证结果

- 后端 `pytest tests/`：**202 passed**。
- 前端 `vitest run`：**45 文件 / 339 tests 全部通过**。
- `npm run typecheck`（vue-tsc --noEmit）：**通过**。

> 未重跑 e2e（Playwright 冒烟）——本批次为纯逻辑/规则层改动，由单测 + 类型检查覆盖；e2e 需起 dev server + 浏览器，留作后续联调。

---

## 2.1 房间联调（2026-08-14 新增）

- 新增 [smoke_lotus_legacy.py](backend/scripts/smoke_lotus_legacy.py)：headless WS 双客户端打完整 `lotus-legacy` 东风场（全新后端 :8010，不占用户 8000/4173），校验翻精牌、牌墙 ≤134、分数守恒 8000。
- **联调结果**：房间 R83F4D 完整打完 4 局（634 份快照），翻精牌正常、`finalScores` 总和 8000（4×2000）守恒 → **通过**。
- **联调中发现并修复一个 bug**：`_shi_san_lan_defects`（后端 [lotus_ai.py](backend/app/core/lotus_ai.py)）与前端 [lotusRules.ts](src/game/variants/lotus/lotusRules.ts) 的 `hasShiSanLanSpacing`、[lotusAi.ts](src/game/variants/lotus/lotusAi.ts) 的 `shiSanLanDefects` 用 `startsWith('s')` 误把字牌 `south` 当数牌（后端 `int('o')` 直接崩溃，前端则产生 NaN 掩蔽间距缺陷）。改为「2 字符 + 首字为花色」精确匹配。
- **Playwright e2e**（`tests/e2e/remote-lotus-legacy.smoke.spec.ts`）：在后端 CORS `allow_origins` 补充 `127.0.0.1:4174`/`localhost:4174` 后，用独立端口 `E2E_PORT=4174 E2E_BACKEND_PORT=8010` 双浏览器跑通 → **1 passed（1.4m）**，覆盖「建房→双客户端加入→准备→开局→翻精指示牌→opening_done→权威快照一致」完整链路。
- **测试环境的既有抖动**：`test_snapshot.py::test_lotus_legacy_two_clients_share_authoritative_opening` 在全量套件下偶发 WS 握手超时（单独/文件内跑均通过），属 uvicorn 事件循环在长套件下的时序问题，与本批逻辑改动无关。

---

## 2.2 联调后回归修复（2026-08-14 用户反馈）

- **吃按钮消失**：后端 [lotus_rules.py](backend/app/core/lotus_rules.py) `chi_options` 返回 `{tile, tiles}` 缺 `kind`，前端解码器 [decoder.ts](src/game/online/protocol/decoder.ts) 校验要求 `kind ∈ sequence|wind|dragon` → 含吃选项的 `claim_request` 整条被丢弃。已给后端三处吃面子补 `kind`（`sequence`/`wind`/`dragon`），对齐前端 `ChiMeld`。
- **开局牌山少两张**：C4 把 `flipStack` 也延迟到翻精阶段，导致翻精墩两张牌在开局阶段不渲染（3D 牌山从 136 掉到 134）。修复三处：① [openingTimeline.ts](src/game/online/presentation/openingTimeline.ts) 开局即写 `flipStack`（只延迟指示牌 `flipTile`）；② [tableTilePresenter.ts](src/components/table/three/tableTilePresenter.ts) `addFlipIndicator` 翻精前渲染「底层牌 + 顶层占位牌」两张背朝上牌，翻精后顶层才翻成指示牌；③ [MahjongTable3D.vue](src/components/MahjongTable3D.vue) 的 rebuild watcher 增补 `flipStack/flipTile/wallBreakIndex` 依赖，翻精阶段能触发重建。
- **第二次掷骰动画消失（只剩声音）**：远程 `run()` 第二次掷骰未把 `openingStage` 切回 `'dice'`，而 `dicePresenter` 只在 `openingStage==='dice'` 时可见/起势，翻精阶段骰子被隐藏 → 只播 `dice.mp3` 无动画。已在第二次掷骰前补 `state.openingStage.value = 'dice'`（对齐单机 lotusOpening）。
- **听牌提示缺失/算错**：远程 `createPlayerSelectors` 用 `DEFAULT_RULESET`（经典无精）算听口，莲花麻将动态精未传入。已让 [playerSelectors.ts](src/game/core/selectors/playerSelectors.ts) 支持响应式 `getRuleset/getJokers/getWildcards` getter，[useRemoteGame.ts](src/game/online/useRemoteGame.ts) 在 lotus 时传入 `LOTUS_RULESET + jokerTiles/wildcardTiles`，听口按精牌/白板计算。
- **吃牌无音效**：[transientEventPresenter.ts](src/game/online/presentation/transientEventPresenter.ts) 的 `ACTION_SOUNDS` 漏了 `chi` 映射，补上 `chi: 'chi.mp3'`。
- **精牌未排最左侧**：后端 [tiles.py](backend/app/core/tiles.py) 只用 `sort_tiles`（自然序）整理手牌，莲花麻将的精牌没前置。新增 `sort_tiles_with_jokers`，并在 [manager.py](backend/app/game/manager.py) 用 `_sort_hand`（lotus 时按精牌前置）替换 `start_game`/`discard_tile` 两处排序。

---

## 3. 未修复项（按优先级归类，附原因）

### 3.1 属于多人机制、非 bug（不建议"对齐单机"）

- **C1 回合计时 12 秒 + 自动出牌**：多人局必须有超时防挂机（服务端 `remote_player.py` 12s 代打 + 前端倒计时）。单机无倒计时是其独有特性，不应搬到多人。若要调整体感，可考虑加长到 15/20s 或取消"自动打最后一张"，属产品决策，未动。
- **C3 结算后 10s 自动继续 + 每局完整开局重播**：多人需等所有在线真人确认（`room.py` 结算确认屏障），是防止"一人跳局"的既有设计。
- **C12 开局就绪屏障 60s**：`openingDelayStart/openingDelay` 常量已是死代码，实际由 `wait_for_opening`（客户端 `opening_done`）门控；`_opening_timeout=60` 是兜底防卡死。

### 3.2 表现层/节奏打磨（本批已修 C4/C5/C7/C8/C10/C11，剩余）

- **C6 "开牌"播报时机**：服务端 [manager.py](backend/app/game/manager.py) 的「开牌」公告仍在 `round_start` 阶段广播（被客户端 opening 丢弃后，经首回合快照 reconcile 展示，时机≈首回合开始）。单机在开局末尾播报。差异仅约一个网络往返，暂保留服务端实现；若要更精确可改为客户端在发牌结束后播报（需处理 flush 清公告的边角）。

### 3.3 AI 策略（本批已移植 B1/B2）

- **B1 副露决策、B2 弃牌启发式已移植**到 [lotus_ai.py](backend/app/core/lotus_ai.py)，并在 `player.py`/`ai.py` 对 lotus 路由。剩余无。

### 3.4 次要（本批已处理）

- **D1 第二次掷骰者（flipSeat）**：联机端已打通——后端在 `round_start` 下发 `flipSeat`，前端 `openingTimeline.run()` 据此在二次掷骰前切换 `diceThrowerIndex`（表现层已正确，无需改动；仅 `LotusRoundState` 未显式记录该字段，属可选完整性项）。
- **D2 自动托管 `pickDiscard` 用经典 waitingTiles**：已修——[remoteActionController.ts](src/game/online/orchestration/remoteActionController.ts) 的 `ActionState` 增补 `rulesetId/jokerTiles`，`pickDiscard` 对 `lotus-legacy` 改用 `lotusWaitingTiles`（带精），经典仍用无精 `waitingTiles`。
- **D3 `hand_result` 兜底音效**：已修——后端莲花结算结果补发 `winType`（[manager.py](backend/app/game/manager.py) `finalize_win`），前端 `hand_result` 兜底据此播 hu/zimo（点炮/抢杠/地胡 → hu，自摸/天胡 → zimo）。动画仍用简化 reveal（兜底无 winPresentation，可接受）。

---

## 4. 交接建议的下一步顺序

1. 先跑一次真实双客户端联调，确认 A2/A3 牌数守恒与 A1 七星评分在线上无回归。
2. 单独做 3.2 的「开局 staging 对齐」批次（前端 `openingTimeline.ts` 重排 + 服务端播报时机），这是"节奏差距"最明显的剩余来源。
3. 做 3.3 的 AI 策略移植，让空座位 AI 与单机一致。
4. 最后按需处理 3.1 的产品决策（计时/继续屏障是否调参）。

## 5. 禁止事项（沿用 codex-handoff-1 约束）

- 不改动稳定规则集 ID `lotus-classic` / `lotus-legacy` 及协议字段名。
- 不把 lotus-legacy 逻辑并入 lotus-classic，不恢复单机限制。
- 不绕过规则注册表硬编码规则判断。
- 改动前先更新 `docs/lianhua-mahjonggame-legacy-rules.md` 与对应测试。
