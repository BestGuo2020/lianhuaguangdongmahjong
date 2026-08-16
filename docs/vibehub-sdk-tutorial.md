# VibeHub SDK 多人麻将接入教程

> 以「莲花广麻」Web 麻将为例，从一个双窗口消息 Demo 开始，逐步实现房间、座位、快照同步、回合操作、刷新重连、掉线接管和网络状态显示。
>
> 本教程讨论的是“无自建游戏服务端”的方案：VibeHub 负责房间、登录以及 P2P/Relay 消息通道；每个房间由房主浏览器运行权威游戏引擎。

## 这篇教程适合谁

你最好已经了解：

- Vue 3 和 TypeScript 基础。
- Promise、事件回调和定时器。
- 前端状态管理和组件渲染。
- 回合制游戏的基本概念。

不要求提前掌握 WebRTC。P2P、Relay、`peerId` 和重连行为会在对应章节解释。

这不是麻将规则教程，也不是 VibeHub SDK API 的完整参考文档。文中的代码以莲花广麻当前实现为背景；示例代码为了说明流程有所简化，实际字段和类型请以项目源码为准。

## 阅读路线

```text
双窗口消息 Demo
    ↓
房间和大厅
    ↓
房主权威架构
    ↓
快照同步
    ↓
回合操作
    ↓
重连和掉线
    ↓
测试、排障和架构迁移
```

如果你只想了解整体设计，可以先读第 1、2、3、5 章；如果要修改代码，建议按顺序阅读。

## 目录

1. [准备项目并跑通 Mock](#一准备项目并跑通-mock)
2. [从消息 Demo 到麻将房间](#二从消息-demo-到麻将房间)
3. [房主权威架构](#三房主权威架构)
4. [实现大厅和座位](#四实现大厅和座位)
5. [用快照同步游戏状态](#五用快照同步游戏状态)
6. [把麻将回合接到网络消息](#六把麻将回合接到网络消息)
7. [刷新页面后的重连恢复](#七刷新页面后的重连恢复)
8. [掉线检测和 AI 接管](#八掉线检测和-ai-接管)
9. [网络信号显示](#九网络信号显示)
10. [测试和调试](#十测试和调试)
11. [常见问题排查](#十一常见问题排查)
12. [迁移到服务器架构](#十二迁移到服务器架构)
13. [附录](#十三附录)

---

## 一、准备项目并跑通 Mock

### 1.1 项目环境

当前项目要求：

- Node.js：`^20.19.0 || >=22.12.0`
- npm：`>=9.0.0`
- Vue 3、TypeScript、Vite、Vitest

安装依赖并启动开发环境：

```bash
npm install
npm run dev
```

常用检查命令：

```bash
npm run typecheck
npm test
npm run build
```

### 1.2 本地为什么使用 Mock

本地开发时，项目不会直接连接生产 VibeHub，而是使用 `BroadcastChannel` 模拟房间和对端：

```text
浏览器窗口 1（房主） ← BroadcastChannel → 浏览器窗口 2（玩家）
```

这样可以在不上线的情况下测试：

- 加入房间和发送消息。
- 座位分配和准备。
- 快照同步。
- 关闭窗口后的掉线检测。
- 重连和超时逻辑。

相关实现：

- `src/game/online/vibe/mockVibeHub.ts`
- `src/game/online/host/mockVibeRoom.ts`

### 1.3 初始化 VibeHub

项目统一从 `src/game/online/vibe/vibeClient.ts` 初始化客户端。生产域使用真实 SDK，本地开发使用 Mock：

```ts
export async function initVibeHub() {
  if (import.meta.env.DEV) {
    client = createMockVibeClient()
    return client
  }

  const instance = await window.VibeHub.init({
    work: 'B5AJupT1',
  })

  client = instance
  vibeUser.value = instance.user
  return instance
}
```

生产域需要登录：

```ts
const user = await client.login()
```

当前项目的登录状态只保存在内存中，因此刷新页面后需要重新登录。登录完成后，应用再根据本地会话信息尝试恢复房间。

### 1.4 先完成最小消息闭环

VibeHub 的基本使用可以抽象为四步：初始化、登录、加入房间、收发消息。

```ts
const client = await VibeHub.init({ work: 'B5AJupT1' })
await client.login()

const room = await client.room.join('ABC123', {
  topology: 'host',
})

room.send({
  type: 'hello',
  nickname: '玩家 A',
})

room.onMessage((message, fromPeerId) => {
  console.log('收到消息', message, fromPeerId)
})
```

先用两个浏览器窗口确认这条链路能够工作，再进入麻将协议。这样后续出现问题时，可以区分“传输层没有工作”和“麻将业务逻辑有问题”。

---

## 二、从消息 Demo 到麻将房间

### 2.1 房间的生命周期

莲花广麻的完整流程是：

```text
初始化
  → 登录
  → 创建或加入房间
  → 大厅
  → 准备
  → 开局
  → 对局
  → 结算
  → 下一局或结束
  → 离开房间
```

房间访问层位于 `src/game/online/vibe/vibeRoom.ts`，负责生成房间码、创建房间、加入房间和读取房间元数据。

### 2.2 创建房间

项目使用 6 位房间码。创建方随机生成房间码，然后尝试加入：

```ts
const room = await client.room.join(roomCode, {
  topology: 'host',
})

if (room.isHost) {
  await room.announce({
    listed: false,
    open: true,
    max: 4,
    mode: 'east',
    rulesetId: 'lotus-classic',
  })
}
```

这里的“房主”是 SDK 根据房间成员确定的最早成员，不是自有服务器选出的固定角色。

### 2.3 加入房间

```ts
const room = await client.room.join(roomId.toUpperCase(), {
  topology: 'host',
})
```

加入后要立刻判断 `room.isHost`：

- `true`：初始化房主大厅和房主游戏引擎。
- `false`：初始化客户端大厅，向房主发送 `lobby_hello`。

一个容易忽略的情况是：对局结束后，如果所有人都离开，下一位重新加入空房间的人可能再次成为房主。应用层必须能够重新走房主初始化流程。

### 2.4 P2P 和 Relay

`topology: 'host'` 表示房间采用房主拓扑。SDK 会尽量建立 P2P 直连；直连失败时切换到 Relay 中继：

```text
房主 ───── P2P / Relay ───── 玩家 1
房主 ───── P2P / Relay ───── 玩家 2
房主 ───── P2P / Relay ───── 玩家 3
```

看到类似“P2P 连接断开，切换 relay 模式”的日志，不一定表示玩家掉线。只要消息仍然能够收发，游戏就可以继续。

---

## 三、房主权威架构

### 3.1 为什么需要房主权威

麻将需要一个地方维护完整牌局：牌山、所有玩家手牌、当前回合、动作合法性和分数。如果每个客户端都自行计算，状态很容易分叉。

本项目选择由房主浏览器承担权威职责：

```text
房主浏览器
  ├─ 游戏引擎
  ├─ 完整牌局状态
  ├─ 操作合法性校验
  ├─ 快照生成和广播
  └─ AI 兜底
        │
    VibeHub Room
        │
客户端浏览器
  ├─ 快照状态
  ├─ 牌桌表现层
  └─ 操作请求
```

### 3.2 两种架构的取舍

| 维度 | 房主权威 | 服务端权威 |
|---|---|---|
| 权威状态 | 房主浏览器 | 游戏服务器 |
| 自建服务器 | 不需要 | 需要 |
| 运维成本 | 较低 | 较高 |
| 房主掉线 | 需要收尾或迁移 | 通常可继续运行 |
| 反作弊能力 | 弱，依赖诚实假设 | 强，可在服务端校验 |
| 持久化 | 需要客户端自愈 | 服务端可持久化 |
| 适合场景 | 小房间、低成本、回合制 | 大规模、强对抗、长期运营 |

这里节省的是自建游戏服务端，不是所有服务端能力。VibeHub 的登录、房间和 Relay 仍然由外部服务提供。

### 3.3 房主和客户端的职责

房主负责：

- 运行完整游戏引擎。
- 保存完整牌局状态。
- 判断客户端操作是否合法。
- 根据目标座位生成脱敏快照。
- 处理客户端掉线和 AI 接管。

客户端负责：

- 根据快照更新自己的牌桌状态。
- 显示倒计时、按钮和动画。
- 向房主发送操作请求。
- 在刷新后重新加入并恢复状态。

客户端不应该自行决定一项操作是否合法。最终判断必须回到房主权威引擎。

---

## 四、实现大厅和座位

### 4.1 大厅消息

大厅只负责房间生命周期，不负责麻将状态。

客户端发给房主：

| 消息 | 作用 |
|---|---|
| `lobby_hello` | 提交昵称和头像，申请座位 |
| `lobby_ready` | 准备或取消准备 |
| `lobby_leave` | 主动离开 |
| `lobby_ping` | 应用层心跳 |

房主发给客户端：

| 消息 | 作用 |
|---|---|
| `lobby_roster` | 广播座位表 |
| `lobby_start` | 通知开局 |
| `lobby_closed` | 通知房间解散 |

实际类型定义位于 `src/game/online/vibe/vibeLobby.ts`。

### 4.2 座位表是业务身份的来源

`peerId` 是连接身份，不是玩家永久身份。座位表至少需要记录：

```ts
interface LobbySeat {
  seat: number
  peerId: string
  nickname: string
  avatar: string
  ready: boolean
}
```

座位 0 固定给房主，其他座位按 `lobby_hello` 到达顺序分配。刷新页面后 `peerId` 会变化，恢复座位时应优先使用大厅座位表，再用昵称等业务信息兜底。

### 4.3 大厅流程

```text
客户端发送 lobby_hello
        ↓
房主分配座位
        ↓
房主广播 lobby_roster
        ↓
客户端发送 lobby_ready
        ↓
房主检查是否全部就绪
        ↓
房主广播 lobby_start
```

### 4.4 为什么 hello 需要重发

加入房间后，DataChannel 可能还没有建立。此时立即发送的第一条消息可能丢失。因此客户端在收到 roster 前，每 2 秒重发一次 `lobby_hello`：

```ts
sendHello()

helloRetry = setInterval(() => {
  if (receivedRoster) {
    clearInterval(helloRetry)
    return
  }
  sendHello()
}, 2000)
```

收到 `lobby_roster` 后停止重试。

### 4.5 本章完成标准

完成本章后，应能验证：

- 两个窗口可以加入同一个房间。
- 房主可以看到所有座位。
- 客户端可以知道自己的座位。
- 所有人准备后可以开局。
- 空房间重进时不会卡死在等待座位。

---

## 五、用快照同步游戏状态

### 5.1 为什么选择快照

如果客户端只接收“摸牌、出牌、碰、杠”等操作事件，它必须从头重放整个牌局。一旦中途丢消息，状态就会分叉。

快照方案直接发送当前状态：

```text
房主引擎状态
      ↓
按目标座位脱敏
      ↓
state_snapshot
      ↓
客户端重建牌桌
```

快照也更适合重连：客户端重新加入后，房主补发一帧当前快照即可。

### 5.2 快照的基本结构

项目使用 `ServerSnapshot` 表示对局快照。下面是简化示意，实际字段以 `src/game/online/protocol/dto.ts` 为准：

```ts
type GameSnapshot = {
  kind: 'state_snapshot'
  round: number
  currentSeat: number
  players: PlayerSnapshot[]
  discardPile: Tile[]
}
```

### 5.3 快照脱敏

房主知道所有人的手牌，但客户端只能看到自己的手牌：

```ts
export function serializeStateToSnapshot(
  game: GameState,
  targetSeat: number,
): ServerSnapshot {
  return {
    kind: 'state_snapshot',
    players: game.players.map((player, seat) =>
      desensitizePlayer(player, seat, targetSeat),
    ),
  }
}
```

对其他玩家，通常只发送牌数、公开副露和弃牌；对目标玩家，才发送自己的手牌。

### 5.4 客户端应用快照

客户端收到快照后，通过 `snapshotReconciler` 更新远端状态：

```text
收到 state_snapshot
      ↓
解析并校验消息
      ↓
更新 RemoteGameState
      ↓
刷新牌桌表现层
```

相关实现：

- `src/game/online/orchestration/snapshotReconciler.ts`
- `src/game/online/state/remoteGameState.ts`

### 5.5 变化广播和周期补发

推荐同时使用两种广播：

- 游戏状态变化时立即广播。
- 定时周期性补发，作为丢包后的兜底。

当前实现使用约 200ms 的周期作为补发参考值。具体数值需要结合消息大小、房间人数和设备性能调整。

等待客户端响应时，不应让普通周期快照覆盖客户端刚建立的倒计时或按钮状态。收到重连请求时，则要允许强制补发快照。

### 5.6 常见错误

**请求先于快照到达**：客户端收到 `turn_request` 时还没有手牌，无法出牌。恢复时必须先发 `rejoin_ok` 和快照，再重发请求。

**快照覆盖倒计时**：客户端正在等待碰、杠、胡操作时，普通快照刷新清除了提示状态。等待请求响应期间要暂停普通快照，或使用不会覆盖瞬态状态的更新方式。

**脱敏错误**：把完整牌局发送给客户端会造成隐私泄漏，也会让客户端拥有不应该拥有的信息。

---

## 六、把麻将回合接到网络消息

### 6.1 房主引擎和网络层之间的桥接

房主引擎并不需要知道网络细节。它只需要请求一个远端玩家的操作：

```text
游戏引擎 requestTurn()
        ↓
RemotePlayerController
        ↓
发送 turn_request
        ↓
客户端发送 discard
        ↓
房主校验并继续引擎
```

相关实现：

- `src/game/online/host/hostGameRunner.ts`
- `src/game/online/host/remotePlayerController.ts`
- `src/game/online/host/lotusRemotePlayerController.ts`

### 6.2 三类回合请求

房主发送：

| 消息 | 用途 |
|---|---|
| `turn_request` | 轮到玩家出牌 |
| `claim_request` | 询问碰、杠、吃、胡 |
| `rob_kong_request` | 询问抢杠胡 |

客户端响应：

```ts
{ type: 'discard', handIndex: 3 }
{ type: 'pass' }
{ type: 'claim', action: 'peng' }
{ type: 'hu' }
```

项目协议中，对局消息使用 `kind`，大厅消息使用 `type`。两者分别由协议路由层处理，不要在新增消息时随意混用。

### 6.3 客户端为什么只做粗校验

客户端可能因为快照延迟、刷新恢复或动画状态而暂时认为“现在不是我的回合”。如果客户端因此拒绝发送，房主就会一直等不到响应，最后错误触发 AI 接管。

客户端可以检查索引范围和必要字段，但动作是否合法应由房主引擎最终判断：

```ts
function discard(index: number) {
  const hand = getUserHand()
  if (index < 0 || index >= hand.length) return

  clearCountdown()
  send({ type: 'discard', handIndex: index })
}
```

### 6.4 倒计时和自动出牌

客户端收到 `turn_request` 后启动倒计时。当前方案会在剩余约 2 秒时提前触发默认出牌，避免网络延迟导致完全超时。

自动出牌同样只做最粗的参数检查，不要依赖可能已经过时的本地 `isUserTurn`。

---

## 七、刷新页面后的重连恢复

### 7.1 `peerId` 为什么不能作为永久身份

一次加入和一次刷新后的加入通常是两个连接：

```text
第一次加入：peerId = p_123
刷新后加入：peerId = p_987
```

如果直接用 `peerId` 绑定座位，刷新后就会被当成新玩家。正确做法是使用：

1. 房主维护的座位表。
2. 客户端保存的会话信息。
3. 昵称或其他业务身份作为兜底。

### 7.2 保存会话

客户端可以在本地保存最小会话信息：

```ts
{
  roomId,
  nickname,
  seat,
  savedAt,
}
```

当前项目使用 `src/game/online/session/remoteSessionStore.ts` 管理会话。会话应设置 TTL；对局结束或房间失效后，不要无限尝试加入旧房间。

主动退出时必须清除会话，否则刷新登录后，自动恢复逻辑可能再次进入旧房间。

### 7.3 正确的恢复顺序

刷新重连的关键顺序是：

```text
重新登录
    ↓
重新加入旧房间
    ↓
发送 lobby_hello
    ↓
收到 rejoin_ok，恢复 mySeat
    ↓
收到 state_snapshot，恢复手牌和牌桌
    ↓
重发挂起的 turn_request / claim_request
    ↓
从当前时刻重新启动超时计时
```

如果先发送请求、后发送快照，客户端可能收到“轮到你出牌”，却还没有手牌。

### 7.4 重发挂起请求

房主需要记录当前是否有等待响应的请求。客户端重新加入后，房主可以重发请求，但必须重新计算超时：

```ts
const seatState = restoreSeatByBusinessIdentity(message)

sendRejoinOk(seatState.seat)
sendSnapshot(seatState.seat, { force: true })

if (hasPendingRequest(seatState.seat)) {
  resendPendingRequest(seatState.seat)
  restartTimeout(seatState.seat)
}
```

不能沿用重连前的旧计时器，否则刚恢复的玩家可能立刻被误判掉线。

### 7.5 重连时的消息幂等性

重发会带来重复消息的可能。对于出牌、碰、杠、胡等操作，房主应结合请求编号、当前回合和当前状态判断消息是否已经处理过，避免重复执行。

---

## 八、掉线检测和 AI 接管

### 8.1 不要只依赖 `leave`

真实 SDK 在对端关闭页面或断网时，可能先报告 `reconnecting`，而不是立即报告 `leave`。因此应用层需要综合多个信号：

1. SDK 对端事件：`leave`、`reconnecting`、`join`。
2. 定期检查 `room.peers()` 中的连接状态。
3. 应用层心跳 `lobby_ping`。

客户端可以每 15 秒发送一次心跳；房主在一段时间没有收到任何消息后进入掉线宽限。当前实现的默认心跳超时约为 40 秒，掉线宽限约为 10 秒，具体值以 `vibeLobby.ts` 为准。

### 8.2 AI 接管流程

```text
玩家在线
    ↓ 请求无响应
等待超时
    ↓
AI 临时接管
    ↓ 玩家重新发送操作
恢复玩家控制
```

相关实现位于：

- `src/game/online/host/remotePlayerController.ts`
- `src/game/online/host/lotusRemotePlayerController.ts`

AI 是兜底，不是永久替代。房主仍可以继续向原玩家发送请求；收到玩家有效操作后，应关闭 AI 模式并恢复玩家控制。

### 8.3 房主掉线

房主掉线意味着权威引擎也可能消失。当前方案不实现主机迁移：

- 大厅阶段：客户端提示房主已关闭房间并离开。
- 对局阶段：一段时间收不到房主消息后，用当前分数结束对局展示。

如果业务要求房主掉线后继续对局，需要另行设计权威转移、完整状态交接和防重复执行机制。

### 8.4 主动解散房间

主动退出时，先广播关闭消息，再延迟离开：

```text
发送 lobby_closed
    ↓ 等待约 400ms
room.leave()
```

如果广播后立即断开，关闭消息可能还没有送达，客户端就只能看到一直重连。

---

## 九、网络信号显示

### 9.1 为什么自行测量 RTT

SDK 的 `latency` 和 `jitter` 在 Relay 模式下可能包含中继路径的额外影响，数值偏高并不一定代表游戏不可用。

因此项目使用应用层 ping-pong 测量真实消息往返时间：

```text
发送 __transport_ping
        ↓
对端立即返回 __transport_pong
        ↓
RTT = 当前时间 - ping 时间戳
```

### 9.2 RTT 到信号格

```ts
function scoreFromRtt(rtt: number): number {
  if (rtt < 150) return 3
  if (rtt < 300) return 2
  if (rtt < 500) return 1
  return 0
}
```

这些阈值是产品显示规则，不是网络质量的通用标准，应根据实际用户网络调整。

房主也需要绑定传输层信号检测。如果房主从不执行 ping-pong，信号值可能一直停留在初始的 0。

---

## 十、测试和调试

### 10.1 Mock Room

`src/game/online/host/mockVibeRoom.ts` 可以用于单元测试：

- 记录已发送消息。
- 手动注入远端消息。
- 手动触发 `join`、`leave`、`reconnecting`。
- 模拟多个连接状态。

这样可以在不依赖真实网络的情况下测试大厅和对局逻辑。

### 10.2 测试定时器

项目大量使用倒计时、重试和掉线宽限。测试时使用 Vitest fake timers：

```ts
vi.useFakeTimers()

// 推进重试、倒计时或掉线检测
vi.advanceTimersByTime(2000)
```

Mock 的 join 如果内部使用了异步 settle 定时器，应先完成 join，再启用 fake timers，避免测试初始化阶段被假时间影响。

### 10.3 建议的测试清单

- [ ] 两个窗口加入同一个房间。
- [ ] 四个座位正确分配。
- [ ] hello 丢失后可以自动重发。
- [ ] 所有人准备后可以开局。
- [ ] 快照按座位正确脱敏。
- [ ] 客户端可以响应出牌、碰、杠、胡。
- [ ] 客户端刷新后可以恢复座位和手牌。
- [ ] 重连后挂起请求会重新发送。
- [ ] 旧超时计时器不会误触发。
- [ ] 客户端关闭后可以进入 AI 接管。
- [ ] 玩家恢复后可以归还控制权。
- [ ] P2P 切换 Relay 时游戏仍能继续。
- [ ] 主动退出后不会自动重进旧房间。

### 10.4 真机调试日志

建议统一日志前缀：

- `[host]`：房主大厅和引擎日志。
- `[client]`：客户端恢复、请求和表现层日志。
- `[VibeHub]`：SDK 连接和拓扑日志。

重点观察：

- 房主收到的 `lobby_hello`。
- 当前座位表和 `peerId` 映射。
- 快照目标座位。
- 当前挂起请求和超时计时器。
- AI 接管与归还控制权的时刻。

---

## 十一、常见问题排查

### 11.1 加入和大厅问题

| 现象 | 常见原因 | 排查方式 |
|---|---|---|
| 客户端没有座位 | `lobby_hello` 丢失 | 查看 hello 重试和房主收到的消息 |
| 空房间重进后卡住 | 新加入者成为房主，但没有走 host 初始化 | 检查 `room.isHost` 分支 |
| 退出后刷新又回到旧房 | 没有清除本地会话 | 检查 `remoteSessionStore` |
| 掉线座位一直占用 | 只依赖 `leave` | 检查 `reconnecting`、`peers()` 和心跳 |

### 11.2 同步问题

| 现象 | 常见原因 | 排查方式 |
|---|---|---|
| 请求到了但没有手牌 | 请求先于快照到达 | 恢复顺序改为快照后请求 |
| 倒计时或按钮消失 | 周期快照覆盖瞬态状态 | 等待响应时暂停普通快照 |
| 客户端牌面不一致 | 快照丢失或脱敏错误 | 打印目标座位和快照摘要 |
| 同一操作执行两次 | 重发没有幂等判断 | 增加请求编号或状态校验 |

### 11.3 重连和 AI 问题

| 现象 | 常见原因 | 排查方式 |
|---|---|---|
| 刷新后座位变化 | 把 `peerId` 当成永久身份 | 使用座位表和业务身份恢复 |
| 刚重连就被 AI 接管 | 旧计时器残留 | 重连后重新计算超时 |
| 自动出牌没有发出去 | 客户端本地校验过严 | 只做粗校验，交给房主判定 |
| AI 接管后无法恢复 | 收到玩家消息时没有关闭 AI 模式 | 检查控制权归还逻辑 |

### 11.4 连接日志怎么理解

`P2P 连接断开，切换 relay 模式` 通常表示拓扑切换，不代表业务断线。

`P2P 重连超时` 则表示 SDK 长时间无法恢复对端连接。应用层仍应结合心跳和房间状态决定是否释放座位或结束对局。

---

## 十二、迁移到服务器架构

### 12.1 可以复用的部分

- 快照数据结构。
- 客户端远端状态。
- `snapshotReconciler`。
- `requestCoordinator`。
- `remoteActionController`。
- 表现层、倒计时和结算流程。
- 大部分客户端测试。

### 12.2 需要替换的部分

| 当前模块 | 服务器方案中的对应物 |
|---|---|
| `hostGameRunner.ts` | 服务端游戏房间进程 |
| `remotePlayerController.ts` | 服务端玩家会话处理器 |
| VibeHub Room | WebSocket 或其他可靠长连接 |
| 客户端座位表 | 服务端持久化座位表 |
| AI 接管和房主掉线 | 服务端托管和重连恢复 |
| 客户端诚实假设 | 服务端校验和反作弊 |

迁移的核心不是重写整个客户端，而是把“房主浏览器中的权威引擎”移动到服务端。

---

## 十三、附录

### 13.1 当前代码目录

```text
src/game/online/
├── vibe/                  # SDK 初始化、房间和 Mock
│   ├── vibeClient.ts      # 初始化、登录、生产域判断
│   ├── vibeRoom.ts        # 建房、加房、房间元数据
│   ├── vibeRoomSession.ts # 房间会话生命周期
│   ├── vibeLobby.ts       # 座位、准备、心跳、大厅协议
│   ├── mockVibeHub.ts     # BroadcastChannel Mock
│   └── vibeStats.ts       # 房间和连接统计
├── host/                  # 房主权威引擎和远端输入桥接
│   ├── hostGameRunner.ts
│   ├── localStateToSnapshot.ts
│   ├── remotePlayerController.ts
│   ├── lotusRemotePlayerController.ts
│   └── mockVibeRoom.ts
├── protocol/              # 消息 DTO、解码和映射
├── orchestration/         # 客户端协调层
│   ├── snapshotReconciler.ts
│   ├── requestCoordinator.ts
│   ├── remoteActionController.ts
│   ├── remoteLobbyController.ts
│   └── remoteMatchLifecycle.ts
├── transport/             # 连接状态、重连和 RTT
├── session/               # localStorage 会话和 TTL
├── state/                 # 客户端快照状态
├── presentation/          # 动画、结算和瞬态事件
└── antiCheat/             # 公共状态校验和洗牌承诺
```

### 13.2 消息分类

大厅消息使用 `type`：

```ts
type ClientLobbyMessage =
  | { type: 'lobby_hello'; nickname: string; avatar: string }
  | { type: 'lobby_ready'; ready: boolean }
  | { type: 'lobby_leave' }
  | { type: 'lobby_ping' }
```

对局消息使用 `kind`：

```ts
type ServerRequest =
  | { kind: 'turn_request'; ctx: TurnContext }
  | { kind: 'claim_request'; ctx: ClaimContext }
  | { kind: 'rob_kong_request'; ctx: RobKongContext }
```

完整定义位于 `src/game/online/protocol/messages.ts`、`dto.ts` 和 `decoder.ts`。

### 13.3 重要默认参数

| 参数 | 当前参考值 | 作用 |
|---|---:|---|
| hello 重试 | 2 秒 | 防止首次消息丢失 |
| 客户端心跳 | 15 秒 | 让房主知道客户端仍然存活 |
| 心跳超时 | 40 秒 | 判断客户端长期无响应 |
| 掉线宽限 | 10 秒 | 避免短暂网络抖动立即释放座位 |
| AI 请求超时 | 约 25 秒 | 无响应时临时接管 |
| 快照补发周期 | 约 200ms | 丢消息后的状态兜底 |
| 主动解散延迟 | 约 400ms | 给关闭消息留出发送时间 |

这些数值是当前实现的工程参数，不是 SDK 或网络协议的固定标准。修改时应同步更新测试和用户提示。

### 13.4 FAQ

**本地怎么联调多人？**

使用 Mock，在同一浏览器打开多个窗口。Mock 基于 `BroadcastChannel`，不同浏览器通常不会互通。

**为什么刷新后需要重新登录？**

当前 SDK token 只驻留在内存中。刷新后需要重新登录，再由应用恢复本地保存的房间会话。

**看到 P2P 切换 Relay 是不是掉线？**

不一定。这通常只是直连切换到中继。只要消息仍然正常收发，游戏可以继续。

**房主刷新后还能继续吗？**

当前方案没有主机迁移。客户端在一段时间收不到房主消息后会结束对局或离开房间；要无缝继续，需要另行实现权威转移。

**以后改成服务器架构需要全部重写吗？**

不需要。快照驱动的客户端、表现层、操作协调和多数测试可以保留，主要替换权威引擎的运行位置和传输层。

---

*本文基于「莲花广麻」当前联机实现整理。涉及 SDK 行为的内容应以项目锁定版本和实际测试结果为准。*
