# 莲花广麻 · VibeHub P2P 迁移设计（vibehub 分支）

> 目标：多人对战迁到 VibeHub SDK（host-authority P2P），登录后才能创建/加入房间，
> 最终删除自建 FastAPI 后端。本文是跨阶段实施的设计锚点，实现时以此为准。

## 1. 锁定决策

| 项 | 值 |
|---|---|
| 作品 slug | `B5AJupT1`（`VibeHub.init({ work: 'B5AJupT1' })`） |
| 同步模型 | host-authority（房主权威，VibeHub 对棋牌指定模型） |
| 反作弊 | 轻威慑：承诺洗牌 + 公开状态确定性复算（防做牌/改判，不防看牌） |
| 风控 | 仅保留「个人战绩」，走 `vibe.save` |
| 强制范围 | 仅 `*.lumigrav.space` 强制登录；本地/开发保持匿名 |

## 2. SDK 认证 API（已接入，见 `src/game/online/vibe/vibeClient.ts`）

```js
const vibe = await VibeHub.init({ work: 'B5AJupT1' })
const user = await vibe.login()     // { id, name, image }，token 仅驻内存
vibe.isLoggedIn(); vibe.onAuthChange(u => {}); vibe.user; vibe.logout()
```

game token 2 小时有效、SDK 自动续期、刷新页面需重新授权。`vibe.user.id` 用作联机 `playerId`。

## 3. SDK 房间模型 → 麻将房间概念 映射（Phase 1 核心）

SDK 没有「座位 / rejoinCode / ready / start」这些 REST 概念，需重新映射：

| 麻将概念 | 现状（REST） | SDK 实现 |
|---|---|---|
| 房间码 | 服务端签发 6 位码 | `roomId` 就是 6 位码；`create` = `vibe.room.join(码)` + `announce()` |
| 建房 | `POST /api/rooms` | 生成码 → `room.join(码)` → `announce({listed:true,open:true,max:4,mode,rulesetId})` |
| 加房 | `POST /api/rooms/{id}/join` | `vibe.room.join(码)`（房主可校验 `announce` 元数据） |
| 房间列表 | `GET /api/rooms/meta` | `vibe.rooms.list()` / `get()` / `quickJoin()` |
| 座位（4 席） | 服务端 `room_seats` 落库 | 房主分配：`room.onPeer` 感知进出，座位号由房主广播；AI 补空席 |
| 准备态 | `POST .../ready` | 房主收集，走 `room.state`（`set/get/on`）或广播消息 |
| 开局 | `POST .../start` | 房主判定全员就绪后广播 `round_start`（host-authority） |
| 离开 | `POST .../leave` | `room.leave()` |
| 关房 | `DELETE /api/rooms/{id}` | 房主 `room.close()` |
| 断线重连 | `rejoinCode` + WS 握手 | SDK 自动重连（`room.onPeer`）；「继续对局」改存 `roomId` 重 join |
| rejoinCode | 座位凭据 | **废除**（SDK 无此概念） |

## 4. P2P 消息协议（复用现有 wire，不重写）

`src/game/online/protocol/messages.ts` 的 `ServerMessage`（`state_snapshot`/`round_start`/
`turn_request`/`claim_request`/`rob_kong_request`/`hand_result`/`match_finished`/…）与
`dto.ts` 的 `ServerSnapshot` **原样复用**，只是从 WebSocket 改走 `room.send`/`room.onMessage`。

- 房主（host）：跑现有 TS 本地引擎（`core/local/useGame` + `variants/lotus`），把
  `LocalGameState` 序列化成 `ServerSnapshot`（暗牌脱敏：远端只见自己手牌）广播。
- 非房主（client）：维持现状——`snapshotReconciler` 收快照渲染，`requestCoordinator`/
  `remoteActionController` 发动作，几乎不改。
- AI 空席：房主端 `AiController` 代打。

## 5. 传输层要点（Phase 2，已踩到的坑）

- `room.onMessage(cb)` / `room.onPeer(cb)` **返回 `this`（Room），没有退订函数**。
  → transport 须在 `join` 之后绑定一次，不能像 WebSocket 那样反复 open/close 重绑。
- 因此 `roomSocket.ts` 的 `SocketLike`「可重开」语义要改为「join 后创建 transport」，
  `useRemoteGame` 里 `roomId && rejoinCode` 决定 URL 的逻辑替换为「已 join 的 Room 对象」。
- 消息透传：`room.send(obj)` 广播 / `room.send(obj, peerId)` 定向；`onMessage(msg, fromPeerId)`。
- 状态：`room.peers()`/`room.networkStats()` 驱动 `signalQuality`；`onPeer` 事件驱动连接状态。

## 6. 阶段状态

- [x] Phase 0 — SDK 接入 + 登录门（commit `709270e`）
- [ ] Phase 1 — 房间生命周期切 SDK（`vibeRoom.ts` + 重构 `remoteRoomLifecycle`）
- [ ] Phase 2 — 传输层切 P2P（`vibeRoomTransport.ts`，wire 复用）
- [ ] Phase 3 — 房主权威引擎（`remotePlayerController` + `hostGameRunner` + 快照序列化）
- [ ] Phase 4 — 承诺洗牌 + 公开状态复算 + 战绩走 `vibe.save`
- [ ] Phase 5 — 删后端 + 清理代理/e2e
