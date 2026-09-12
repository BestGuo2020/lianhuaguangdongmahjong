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
| `src/game/variants/lotus/bloodFlow/engine.ts`（+`engine.test.ts`） | 锁手座位仍可点炮/抢杠胡但不得过胡；开杠只在本手来自摸牌时提供；超时兜底锁手必胡 | 单机与 P2P 血流立即生效（P2P 面已放行） |
| `.../useBloodFlowGame.ts` | 提交闩锁（单窗口单次提交）、模型原话气泡/音频、`roundSpeechBusy` 感言闸门、亮牌闸门、`playLlmAudio` 选项、`voiceFor` | 同上（单机立即生效） |
| `.../ws/authority.ts`（+test） | `llm_message` / `llm_audio` 路由；`continuation` / `setAuto` | vibehub 新增 `ws/` 目录，保留即可（见 §0-1） |
| `.../types.ts`、`config.ts`、`network/protocol.ts` | `roundSpeechBusy` 字段；玩家白名单加 `style`/`voiceKey`；**`BLOOD_FLOW_AVAILABILITY.p2p` 由 false 改为 true**（2026-09-10：线上双真人 + 机器人整场验收前提） | 直接同步；vibehub 在线血流规则选择随 `p2p` 放行 |
| `src/components/table/GameTableHud.vue` | 亮牌按演出闸门延后；新增 `leaveMatch` emit | vibehub 的 `App.vue` 不监听 `leaveMatch` → 无害 no-op |
| `src/components/settlement/BloodFlowSettlementHost.vue` | 按钮语义（返回房间/返回大厅=暂离/退出本场）+ 感言门控倒计时 | 同上（P2P 未接线；关闭中无影响） |
| `src/game/llm/bloodFlowRuntime.ts`（+test） | `remoteVoiceIdentity`、`createBloodFlowReactions({voice})` | 直接同步 |
| `docs/**` | 节奏/规则/生命周期文档更新 | 直接同步 |
| `tests/e2e/blood-flow.pacing.spec.ts`、`blood-flow.create-room.spec.ts`（新） | 联机 e2e | 需要 WS 后端；vibehub 上按需 `--ignore` 或加 tag |

> 同步后请务必在 vibehub 跑一次 `pnpm typecheck` + `pnpm test`：唯一风险点就是 §0-1 那个文件，跑完即可确认。

---

## 2. vibehub 保留文件的手工适配

### 2-A 可直接按小改动移植（结构一致）

> **2026-09-10 实测核对（同步后逐项验证）**：vibehub 的 P2P 协议与 host 层与 WS 不同，表内各项的「是否真需要」按下表最后一列为准。
>
> **执行决定（2026-09-10）**：vibehub 工作树的 `AGENTS.md` 明确规定「**不要**手动在 vibehub 上改这些联机层 keep 文件」，且 master 无法承载 vibehub 的专属结构 —— 因此 §2-A 各项**一律不在 vibehub 上手工改**，保留为待决策事项。它们都属于**经典 P2P 表现/协议**细节，与本次「血流 P2P 整场验收」无关，不阻塞部署。

| master 文件 | 改动内容 | vibehub 现状 | 动作 |
|---|---|---|---|
| `online/orchestration/requestCoordinator.ts` | 庄家开局首回合（`turnOrigin === 'opening'`）视作「已摸牌」→ 可天胡/可风杠 | 同名保留版有 `skipDraw`，**但没有 `turnOrigin`** | **待定**：vibehub 的 P2P 协议里不存在该字段（`git grep turnOrigin` 仅命中 `core/local/*` 与 `llm/*`）。要真生效需 host 侧（`host/lotusRemotePlayerController.ts` 构造 turn_request 时带上 `localTurnOrchestrator` 已有的 turnOrigin）+ 协议 + 客机三处一起改，属**新功能移植**，与本次血流验收无关 → 单独一批 |
| `online/protocol/messages.ts` | `turn_request.ctx` 增加 `turnOrigin?: string` | 同上 | 同上（随 turnOrigin 一批） |
| `online/protocol/decoder.ts` | 校验 `isOptional(raw.ctx.turnOrigin, isString)` | 同上 | 同上 |
| `online/state/remoteGameState.ts` | 新增 `lastDiscardSound`（点炮胡要等牌名播报播完） | 保留版无该 ref，但 **`core/local/localGameState.ts` 与 `shared/runtime/tileFlowExecutor.ts` 在 vibehub 上已有 `lastDiscardSound`** | **待决策**：需手改 vibehub 保留文件（state + reconciler + settlementTimeline 三处，见下面两行） |
| `online/orchestration/remoteActionController.ts` | 出牌后立刻清 `turnCanHu` / `turnCanWindKong` | 保留版已在 `requestCoordinator` 的弃牌/过牌/回合切换处清（L119-120、L149-150） | **无需动作**（已具备等价行为） |
| `online/orchestration/snapshotReconciler.ts` | `applyLastDiscard` 里产出 `lastDiscardSound` promise（`later` + `playSoundAndWait`） | 同名保留版已有 `applyLastDiscard` + `tileAudioFile`，无 promise；`useVibeRemoteGame` 已有 `playSoundAndWait` 选项可直传 | **待决策**（随 state 一起） |
| `online/presentation/settlementTimeline.ts` | 点炮胡等牌名播报播完再起胡音效 + 点炮牌补回牌河 | 结构不同（`effectKey/settleIfReady/beginEffect` 队列版），`beginEffect` 直接落 `win-effect`；`shared/settlement/settlementTimeline.ts` 已有 `lastDiscardSound?` 可选入参 | **待决策**：最小版＝`beginEffect` 里先 `await state.lastDiscardSound` 再落 `win-effect`；补回牌河逻辑后置 |
| `online/presentation/settlementTimeline.test.ts`、`useRemoteGame.test.ts` 对应用例 | 同上 | vibehub 有自己的测试文件 | 按 vibehub 测试风格补 1-2 个用例 |

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

## 4. 同步操作步骤（2026-09-10 已执行）

1. ✅ 在 master 提交本批改动（8 笔：血流规则 / 联机协议与表现 / 血流联机 / 房间生命周期 / 同步工作流 / p2p 放行 / 同步脚本 / 清单核对；后端 3 笔另提交）。
2. ✅ `$masterOnly` 已加入 `bloodFlow/useBloodFlowRemoteGame.ts`（+`.test.ts`）与 `online/presentation/useRemoteContinueCountdown.test.ts`（keep 目录内 master 新增文件的泄漏修复），并同步更新 `docs/branch-sync-workflow.md`。
3. ✅ `pnpm sync:vibehub` ×3（`d513270` → `52fdeaf` → `0acbab7`）：master-only 全部删除、keep 文件保持 vibehub 版、P2P 在制品完好；同步前把 vibehub 的未提交在制品以 WIP 提交保住（补丁备份 `work/vibehub-theme11v/tmp/vibehub-wip-*.patch`）。
4. ✅ vibehub 工作树 `pnpm typecheck` + `pnpm test`（见 §5 实测结果）。
5. ⏸ §2-A 手工移植：按执行决定不做（保留待决策）。
6. ⏭ §3 P2P 语义改动（暂离/退出本场在 P2P 上的对应）：单独一批，未开始。

---

## 5. 验收清单（vibehub）—— 2026-09-10 同步后实测结果

- [x] `pnpm typecheck` 通过（首轮因 keep 目录泄漏的 `useRemoteContinueCountdown.test.ts` 失败 → 已纳入 `$masterOnly`，改后通过）
- [x] `pnpm test` 全绿（首轮 1 文件 4 用例失败，同因；最终 1390 passed / 2 skipped）
- [ ] 本地大厅流程手测：建房 / 加入 / 准备 / 开始 / 离开 / 关闭（P2P 路径）
- [x] **血流 P2P 已放行**（`BLOOD_FLOW_AVAILABILITY.p2p === true`，本批刻意打开，用于线上整场验收）
- [ ] §2-A 移植：按上面的执行决定**不做**（vibehub AGENTS 禁止手改 keep 文件），保留待决策
- [x] `git log vibehub..master` 清空（最终 vibehub `b769810`）

## 6. 线上整场验收结果（2026-09-10，部署 `vibehubcli update --slug B5AJupT1`）

两账号取自 `tmp/online_test`（账号1/账号2 分别作房主与客机），规则「莲花麻将·血流」、东风场、2 真人 + 2 机器人，各打满一场（东1～东4）：

| 场景 | 房间 | 耗时 | 结果 |
|---|---|---|---|
| 2 真人 + 2 **普通机器人** | `Q4C645` | 4.2 分钟 | ✅ 双端逐局结算一致、终局排名一致、总分 8000 守恒（玩家4 3550 / 玩家3 1550 / 客人 1480 / 房主 1420） |
| 2 真人 + 2 **大模型机器人** | `9HUUY2` | 6.3 分钟 | ✅ 同上（大肥鱼 4000 / 大肥鱼 1730 / 客人 1470 / 房主 800） |

用例在 vibehub 分支（仅存在于 vibehub，不被同步覆盖）：`tests/e2e/online-two-accounts-two-east-matches.spec.ts` 末尾的「线上两账号完成莲花麻将·血流东风场」两条测试；取证落盘在 `tmp/bf-online-evidence/`（双端截图 + stall 诊断 JSON）。部署产物与已验证提交一致（重新发布时「跳过 234 个未变化文件 / 需要上传 0 个文件」）。

验收过程中修掉的 P2P 问题（vibehub `07150c2` / `9dbc445` / `ce46cdb` + master `72fc54f`）：

1. **大帧静默发送失败**：SDK 单包超限时可靠发送链只打一条 `[VibeHub] 联机消息加密失败: 消息未发送`；血流的结算帧是全场最大的一帧 → 客机收不到 → 判「房主无法恢复」整场中断。修法：`sendChunked`（净化 + 4KB 分片）并覆盖**所有** P2P 发送路径（含血流 authority 的定向发送）。
2. **分片只在一侧重组**：血流房间直接订阅 SDK 的 `room.onMessage`（不经传输层），分片包在那里被当未知包丢弃 → 「客机计数在涨、视图却没有 `roundResult`」。修法：把重组抽成模块级幂等函数 `unwrapChunk`，传输层与房间两侧共用。
3. **房主 peer 被冻结**：`hostPeer` 在 attach 时取一次、replica 又把它冻结在构造时 → 对端 id 变化后客机把所有帧判成「非房主」拒收。修法：按实时 `hostId` 解析并同步给 replica（master `72fc54f` + vibehub `9dbc445`）。
4. **收帧停滞不自愈**：客机原先只在视图 paused 时重握手 → 改为停滞 3s 即主动重握手请求权威快照。

## 7. 联机验收策略（2026-09-10 决定：本地 mock 不再承担联机断言）

本地 `mockVibeHub` **不具备 VibeHub SDK 的真实环境**，因此只保留**确定性逻辑/流程**覆盖，联机行为一律线上验收：

| 保留在本地（mock/单测） | 移到线上（部署后双账号 spec） |
|---|---|
| 承诺洗牌 + 权威 worker 整场：`tests/e2e/blood-flow.room.spec.ts` ✅ 36s | 房间面板/roster、准备与开局、断线与恢复 |
| 大厅/主题/刷新恢复：`tests/e2e/blood-flow.lobby.spec.ts` ✅ 42s | 传输（单包上限、分片、中继切换、peer id 漂移） |
| 协议与 replica 纯逻辑：`src/game/variants/lotus/bloodFlow/network/network.test.ts` ✅ 7 项 | 结算同步与局间屏障、失联判定与自愈 |
| 单机（含 LLM）：`blood-flow.local.spec.ts`、`blood-flow.llm.spec.ts` ✅ | ——（单机与分支无关，本地即可） |

依据（本轮线上实测，四类缺陷本地**全部无法复现**）：

1. **单包超限静默发送失败**——mock 进程内投递，无大小上限、无加密步骤；
2. **分片在直连 SDK 的订阅者处被丢弃**——mock 不分片，投递原对象；
3. **对端 peer id 漂移导致 replica 全量拒收**——mock 的 peer id 恒定（`mockPeer`）；
4. **收帧饥饿 → 判房主失联 → 整场中断**——mock 无 WebRTC/中继抖动、无丢帧。

另：`blood-flow.llm-host.spec.ts`（mock 版 P2P LLM 宿主）已标 `test.fixme`：其断言依赖 SDK 下发的 roster/昵称（`RoomPanel` 取 `humanAt(...).nickname`）与 LLM 座位选择器，mock 不实现，原理上不可能通过；等价覆盖由线上「2 真人 + 2 大模型机器人」整场承担（房间 9HUUY2 ✅）。

### 本地"真 SDK 匿名联机"验证结论（2026-09-12）：不可行，mock 保留

起因：希望本地跑真 SDK 以减少线上验收次数。为此加了 `VITE_VIBE_REAL=1` 开关（dev 下走真 SDK 而非 mock）与 vite 平台 API 代理，并做了一次实跑。结论：**匿名进房在 SDK 层就不被允许**，与 mock、来源校验、安全上下文都无关。

证据（`https://vibe.lumigrav.space/sdk/v3/vibehub.js`，2026-09-12 拉取）：

- `VibeSDK.prototype._fetch` 在没有 token 时**直接 reject**：`if (!this.token) { var missing = new Error("请先登录"); missing.status = 401; ... }`（L3544-3548）；
- `this.token` **只**由 `_acceptToken(token, expiresAt)` 赋值（L3500-3506），而它只被登录/授权流程调用 —— SDK 内**不存在游客/匿名签发路径**；
- 服务端同结论：直接重放 `POST https://vibe.lumigrav.space/api/sdk/rooms`（body `{"room":"…","action":"claim","peer":"…"}`），在**带平台 Origin / 带本地 Origin / 不带 Origin** 三种情况下**全部 401 `{"error":"未授权"}`**；
- `crossOriginIsolated` 只门控登录弹窗方式（`_isolatedLogin` vs `_popupLogin`），**不是**匿名联机的前置条件；
- 平台文档里的"匿名"仅指**中继节点贡献**（节点注册、绑定临时 peerId 的短期能力凭证），不含进房（见 `llms-full.txt` 关于匿名 relay 的段落）。

本地真 SDK 的两个附带发现（对将来"本地 + 真实登录"联调有用）：

- SDK 在 `localhost`/`127.0.0.1` 下用 `location.origin` 作 apiBase（`defaultApiBase()`），因此本地必须**同源代理**平台路径（`/api/sdk`、`/api/relay`、`/api/game-auth`、`/connect`、`/relay-worker.js`）；代理已配好并通过验证（`GET /api/sdk/me` 能拿到平台的 401，说明请求确实到达平台）。
- 官方 CLI **没有本地 dev/serve 命令**（`vibehub --help` 全量列出：login/whoami/metadata/deploy/update/mod/collaboration/github-setup/token/generate/list/logout/remove），所以不存在平台侧本地服务可用。

因此：`mockVibeHub` **保留**为本地默认联调环境（离线、确定性、CI 友好）；`VITE_VIBE_REAL=1` 仅保留给"本地 + 真实登录"的联调尝试（登录弹窗经代理 + 平台 cookie 是否可行**尚未验证**）。线上验收依旧是 P2P 的唯一端到端依据，触发条件收敛为：**改动触及 P2P 传输 / 房间 / roster / 重连 / 结算同步时**才必须上线跑两场；日常 AI、规则、UI 改动以本地全量 + 单机 e2e 为准。

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
