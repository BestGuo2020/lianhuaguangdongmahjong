# vibehub 侧适配清单（本批 master 改动）

> 用途：master 上这批改动同步到 **vibehub**（P2P 联机分支）时，逐项说明「自动生效 / 必须手工适配 / 在 P2P 结构下不适用」。
> 生成：2026-09-10。注意：vibehub 当前**落后 master 62 个提交**（`git log vibehub..master`，含整条血流联机 WS 线），所以这次同步会很大，**先看 §0 再动手**。
> 依据：同步机制见 `scripts/sync-master-to-vibehub.ps1`（`$vibehubKeep` 在第 61-104 行、`$masterOnly` 在第 108-119 行）、`docs/branch-sync-workflow.md`。

---

## 0. 三条前置决策（同步前必须定，否则会破坏 vibehub）

### 0-1【硬性】`useBloodFlowRemoteGame.ts`（+ `.test.ts`）必须在 vibehub 排除或重写

`src/game/variants/lotus/bloodFlow/useBloodFlowRemoteGame.ts` 依赖：

```
../../../online/api/httpClient      → master-only（同步时被 git rm）
../../../online/api/roomApi         → master-only
../../../online/transport/roomSocket→ master-only
```

该文件**不在** `$vibehubKeep`、也**不在** `$masterOnly`（vibehub 上目前不存在，`git grep useBloodFlowRemoteGame vibehub` 无引用）→ 一旦同步会被新增到 vibehub，而它 import 的模块在 vibehub 已被删除 → **typecheck / build / vitest 全挂**。

- **方案 A（已实施，2026-09-10）**：`scripts/sync-master-to-vibehub.ps1` 的 `$masterOnly` 已加入
  `src/game/variants/lotus/bloodFlow/useBloodFlowRemoteGame.ts` 与 `.test.ts`（含注释说明原因）。
  vibehub 走自己的 `src/game/online/vibe/bloodFlowRoom.ts`（已存在，`BLOOD_FLOW_AVAILABILITY.p2p: false` 关闭中）。
- **方案 B（备选）**：在 vibehub 自写 P2P 版（对接 `src/game/online/transport/vibeRoomTransport.ts`），与 master 的 WS 版保持同接口（`sessionStatus/roomId/remoteActions/...`），供 `App.vue` 路由。

> 完整性核对（2026-09-10）：全仓扫描 `online/api/`、`transport/roomSocket`、`session/remoteRoomLifecycle`、`useRoomAvailability`、`useWakuDemoAuth`、`online/useRemoteGame` 的引用后，**只有这两个文件的引用方会被同步**；其余引用方（`App.vue`、`components/lobby/*`、`components/account/StatsOverlay.vue`、`core/contracts/*.test.ts`）都在 `$vibehubKeep` 清单内，不受影响。

`bloodFlow/ws/authority.ts`（+test）**不需要排除**：它只依赖类型（`core/contracts/types`、`../state`、`../seatView`、`../types`），而 `useBloodFlowGame.ts` 里是 `import type { BloodFlowWsAudio, BloodFlowWsSpeech } from './ws/authority'` —— 保留它，vibehub 的 typecheck 才能过。同步后 vibehub 会多出 `bloodFlow/ws/` 目录，属预期。

### 0-2【设计】P2P 没有 WS 房间与 REST 会话，本批「房间生命周期」改动无直接对应

本批的「返回大厅=暂离 / 退出本场 / 离开房间」三动作、房主顺延、`rejoin_err` 按码区分，全部落在 **master-only** 文件里：

- `src/game/online/useRemoteGame.ts`（`rejoin_err` 分类、`roomStatus` 暴露）
- `src/game/online/session/remoteRoomLifecycle.ts`（`stepOutToLobby()` / `leaveMatch()`）

vibehub 使用自己的 `useVibeRemoteGame.ts` + `vibe/*` + `transport/selfHost/*`，因此这些改动**不会也不该**自动过去；要不要在 P2P 上也做「暂离/保留座位」，需按 §3 重新设计（建议单独一批，不要混在这次同步里）。

### 0-3【取舍】经典联机的表现修复要不要一起移植

§2-A 列的是「与联机层无关的真实修复」（庄家开局首回合天胡、点炮胡结算时序、回合能力门控）。按 `AGENTS.md` 的「vibehub 领先则反向移植」精神，共享文件的修复应两边一致；但 vibehub 的 `online/presentation/settlementTimeline.ts` 结构不同（`effectKey/settleIfReady/beginEffect` 队列版），**不能逐行 cherry-pick**，需要按它的结构重写或先做最小版。

---

## 1. 自动同步、无需手工动作（已核对不引用 vibehub 缺失模块）

| 文件 | 本批改动 | vibehub 影响 |
|---|---|---|
| `src/game/variants/lotus/bloodFlow/engine.ts`（+`engine.test.ts`） | 锁手座位不再进入弃牌/抢杠响应窗口（但仍可点炮/抢杠胡、不得过胡）；开杠只在本手来自摸牌时提供；超时兜底锁手必胡 | 单机血流立即生效；P2P 血流关闭中，联机路径不生效 |
| `.../useBloodFlowGame.ts` | 提交闩锁（单窗口单次提交）、模型原话气泡/音频、`roundSpeechBusy` 感言闸门、亮牌闸门、`playLlmAudio` 选项、`voiceFor` | 同上（单机立即生效） |
| `.../ws/authority.ts`（+test） | `llm_message` / `llm_audio` 路由；`continuation` / `setAuto` | vibehub 新增 `ws/` 目录，保留即可（见 §0-1） |
| `.../types.ts`、`config.ts`、`network/protocol.ts` | `roundSpeechBusy` 字段；玩家白名单加 `style`/`voiceKey` | 直接同步 |
| `src/components/table/GameTableHud.vue` | 亮牌按演出闸门延后；新增 `leaveMatch` emit | vibehub 的 `App.vue` 不监听 `leaveMatch` → 无害 no-op |
| `src/components/settlement/BloodFlowSettlementHost.vue` | 按钮语义（返回房间/返回大厅=暂离/退出本场）+ 感言门控倒计时 | 同上（P2P 未接线；关闭中无影响） |
| `src/game/llm/bloodFlowRuntime.ts`（+test） | `remoteVoiceIdentity`、`createBloodFlowReactions({voice})` | 直接同步 |
| `docs/**` | 节奏/规则/生命周期文档更新 | 直接同步 |
| `tests/e2e/blood-flow.pacing.spec.ts`、`blood-flow.create-room.spec.ts`（新） | 联机 e2e | 需要 WS 后端；vibehub 上按需 `--ignore` 或加 tag |

> 同步后请务必在 vibehub 跑一次 `pnpm typecheck` + `pnpm test`：唯一风险点就是 §0-1 那个文件，跑完即可确认。

---

## 2. vibehub 保留文件的手工适配

### 2-A 可直接按小改动移植（结构一致）

| master 文件 | 改动内容 | vibehub 现状 | 动作 |
|---|---|---|---|
| `online/orchestration/requestCoordinator.ts` | 庄家开局首回合（`turnOrigin === 'opening'`）视作「已摸牌」→ 可天胡/可风杠 | 同名保留版，已有 `state.userDrewThisTurn.value = !message.ctx.skipDraw` | 改成 `const drawnTurn = !message.ctx.skipDraw \|\| message.ctx.turnOrigin === 'opening'`，并同步后面 `players[0].drawnTileIndex` 与 `give.mp3` 的判断 |
| `online/protocol/messages.ts` | `turn_request.ctx` 增加 `turnOrigin?: string` | 同名保留版缺该字段 | 加字段 |
| `online/protocol/decoder.ts` | 校验 `isOptional(raw.ctx.turnOrigin, isString)` | 同名保留版只校验到 `canWindKong` | 加一行（不加该字段会被丢弃，天胡修复不生效） |
| `online/state/remoteGameState.ts` | 新增 `lastDiscardSound`（点炮胡要等牌名播报播完） | 同名保留版已有 `lastDiscard`，无该 ref | 加 `shallowRef<Promise<void> \| null>(null)` 并导出 |
| `online/orchestration/remoteActionController.ts` | 出牌后立刻清 `turnCanHu` / `turnCanWindKong`（避免按钮残留） | 同名保留版 | 按其结构加同一行为 |
| `online/orchestration/snapshotReconciler.ts` | `applyLastDiscard` 里产出 `lastDiscardSound` promise（走 `later` + `playSoundAndWait`） | 同名保留版已有 `applyLastDiscard` 与 `tileAudioFile` | 按其结构加；新增可选 `playSoundAndWait` 选项 |
| `online/presentation/settlementTimeline.ts` | 点炮胡：等牌名播报播完 + `DISCARD_WIN_EFFECT_DELAY` 再起胡音效；点炮牌在牌河补回直到特效启动 | 同名保留版**结构不同**（`effectKey/settleIfReady/beginEffect` 队列版） | **按 vibehub 结构重写**：最小版＝在 `beginEffect` 前 `await state.lastDiscardSound`；补回牌河逻辑可后置 |
| `online/presentation/settlementTimeline.test.ts`、`useRemoteGame.test.ts` 对应用例 | 同上 | vibehub 有自己的测试文件 | 用 vibehub 的测试风格补 1-2 个用例 |

### 2-B 不需要移植（master-only，vibehub 无对应）

- `online/useRemoteGame.ts`（`rejoin_err` 按码区分、`roomStatus`、`turnCanHu` 末回合门控所在的 shell）
- `online/session/remoteRoomLifecycle.ts`（`stepOutToLobby()` / `leaveMatch()` / `roomStatus` 刷新）
- `online/api/**`、`online/transport/roomSocket.ts`
- 上述文件的 master 测试

### 2-C 仅当 vibehub 也要「血流联机」时才需要

- `online/presentation/useRemoteContinueCountdown.ts` 的 `enabled` 开关（vibehub 版本结构相同、多一个 `manualContinue`）。双倒计时是**血流联机专属**问题；P2P 血流关闭时不需要。

---

## 3. P2P 语义映射（房主 / 暂离 / 退出 / 解散）

| master（WS 服务端房间） | vibehub（P2P host）建议 |
|---|---|
| 房主离座 → 房主顺延给下一位（单向不回收，`_transfer_creator`） | **不适用**：P2P 的「房主」= 跑对局的 host，host 走了这局无法续（vibehub 已有「房主失联检测」）。不要照搬顺延；保持「host 断开 → 提示/结束」 |
| `leave_room` 取消「非对局中房主离开即解散」，改为仅「全员离开 / 显式关闭 / 限时回收」才解散 | 部分适用：P2P 无服务端注册表。至少要同步**文案**（`RoomPanel.vue` 的「房主离开将解散房间」→「房主离开将结束房间，客机可重新加入」之类的准确说法） |
| 「返回大厅」= 暂离（座位保留、可一键回桌） | 需新设计：P2P 无 rejoinCode。可选实现＝客机暂离时**保留 P2P 座位**并停流，host 侧把该座位标记 AI 托管（`online/host/remotePlayerController.ts` 已有托管能力），回桌时重新加入同一座位 |
| 「退出本场」保留座位 + 会话，可重进原座位 | 需要 P2P 会话（`vibe/*SessionStore`）保存 roomId/seat 与「可重进」标记；重进走 P2P 重新加入，而非 REST join |
| `rejoin_err` 按码区分（终态清会话 / 竞态可重试） | 不适用（无 REST）。对应位置在 `vibeClient` / `vibeRoomTransport` 的加入与重连错误码，按其错误表决定哪些清会话、哪些重试 |
| 准备态永久保留 + 离席座位算已准备 | host 侧本地状态：需要在 host 的会话/大厅状态里实现「一场结束不清 ready」；`RoomPanel.vue` 的 `allOccupiedReady` 判定随之调整（P2P 里离席客机是否算 ready 要单独定） |
| 房间限时 60 分钟（非对局中回收） | P2P 无注册表，由 host 生命周期决定；`roomTimeLimit` 文案可保留但语义要写清（host 在线时长） |

---

## 4. 同步操作步骤（建议顺序）

1. 在 master 提交本批改动（同步脚本要求 master 工作区干净）。
2. ~~先改同步脚本~~ **已完成**：`$masterOnly` 已加入 `bloodFlow/useBloodFlowRemoteGame.ts`（+`.test.ts`），并同步更新了 `docs/branch-sync-workflow.md` 的 WS 专属清单。
3. 运行 `pnpm sync:vibehub`（脚本会自动先跑 `check-vibehub-ahead.ps1` 列出 vibehub 领先的共享文件）。
4. 切到 vibehub 工作区：`pnpm typecheck`、`pnpm test`。
5. 按 §2-A 手工移植共享修复（每项配一个 vitest 用例），再次 `pnpm typecheck` + `pnpm test`。
6. §3 的 P2P 语义改动**建议单独一批**，先出设计再改代码。

---

## 5. 验收清单（vibehub）

- [ ] `pnpm typecheck` 通过（重点：`useBloodFlowGame.ts` 对 `./ws/authority` 的 `import type`）
- [ ] `pnpm test` 全绿（若 §0-1 未处理，`useBloodFlowRemoteGame.test.ts` 会因 master-only 模块缺失而失败）
- [ ] 本地大厅流程手测：建房 / 加入 / 准备 / 开始 / 离开 / 关闭（P2P 路径）
- [ ] 血流 P2P 仍为关闭（`BLOOD_FLOW_AVAILABILITY.p2p === false`）
- [ ] 若移植 §2-A：`useVibeRemoteGame.test.ts`、`orchestration/userCanHu.test.ts` 等相关用例通过
- [ ] 若本次为多提交同步：确认 `git log vibehub..master` 清空

---

## 附：本批 master 改动 → vibehub 归属一览

| master 文件 | 归属 | 动作 |
|---|---|---|
| `src/game/variants/lotus/bloodFlow/engine.ts`(+test) | 自动同步 | 无 |
| `src/game/variants/lotus/bloodFlow/useBloodFlowGame.ts` | 自动同步 | 无 |
| `src/game/variants/lotus/bloodFlow/useBloodFlowRemoteGame.ts`(+test) | **需裁决** | §0-1：加入 `$masterOnly` 或写 P2P 版 |
| `src/game/variants/lotus/bloodFlow/ws/authority.ts`(+test) | 自动同步 | 保留（类型依赖） |
| `src/game/variants/lotus/bloodFlow/{types,config,network/protocol}.ts` | 自动同步 | 无 |
| `src/game/llm/bloodFlowRuntime.ts`(+test) | 自动同步 | 无 |
| `src/components/table/GameTableHud.vue` | 自动同步 | 无（`leaveMatch` 在 vibehub 无人监听，无害） |
| `src/components/settlement/BloodFlowSettlementHost.vue` | 自动同步 | 无 |
| `src/App.vue` | vibehub 保留 | §3：按 P2P 需不需要暂离再定 |
| `src/components/lobby/{LobbyView,RoomPanel}.vue` | vibehub 保留 | 至少同步文案（§3） |
| `src/components/settlement/SettlementOverlay.vue` | vibehub 保留 | 本批未改，无需动作 |
| `src/game/online/state/remoteGameState.ts` | vibehub 保留 | §2-A：加 `lastDiscardSound` |
| `src/game/online/protocol/{messages,decoder}.ts` | vibehub 保留 | §2-A：加 `turnOrigin` |
| `src/game/online/orchestration/{requestCoordinator,remoteActionController,snapshotReconciler}.ts` | vibehub 保留 | §2-A |
| `src/game/online/presentation/settlementTimeline.ts` | vibehub 保留 | §2-A：按结构重写 |
| `src/game/online/presentation/useRemoteContinueCountdown.ts` | vibehub 保留 | 暂不需要（§2-C） |
| `src/game/online/useRemoteGame.ts`(+test) | master-only | 不适用 |
| `src/game/online/session/remoteRoomLifecycle.ts`(+test) | master-only | 不适用 |
| `docs/**`、新 e2e | 自动同步 | e2e 在 vibehub 按需跳过 |
