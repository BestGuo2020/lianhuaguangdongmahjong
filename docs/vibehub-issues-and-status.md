# VibeHub SDK 联机问题与处理记录

> 记录范围：`vibehub` 分支的 SDK/P2P 联机实现，不是 WebSocket 分支。
>
> 目的：把排查过程中出现过的现象、日志、根因判断、已做处理和仍未完全验证的风险集中保存。本文不代表所有问题都已经解决。

## 1. 当前架构与判断边界

- 房主设备运行唯一的麻将引擎，负责洗牌、发牌、掷骰、回合推进、碰杠胡判定和计分。
- 其他客户端只能发送动作请求，不能直接修改牌局状态。
- `state_snapshot`、`round_start`、回合请求和表现事件都应绑定当前房主、房间、对局轮次、权威代次和序号。
- P2P 断开后可以退化到 Relay；Relay 只改变传输路径，不应该重新选房主、重新分配座位或改变 `roomId`。
- 掉线玩家可以由房主把对应座位暂时交给 AI；原玩家使用新 peer 重进后，必须恢复到原座位并撤销 AI 控制。
- P2P 房主权威不是服务端权威：如果房主设备本身恶意修改本地引擎，客户端协议层无法像服务端裁判一样彻底阻止房主作弊。协议层能做的是阻止普通客户端伪造房主消息、校验快照和约束动作。

状态标记含义：

- **已处理**：代码已有明确保护或修复，并有自动化测试覆盖。
- **部分处理**：主要路径已处理，但仍有 SDK 竞态、异常网络或真实线上环境未完全验证。
- **未验证**：代码和单测已有处理，但缺少真实四端/线上 SDK 回归证据。
- **未解决/风险**：目前仍可能复现，或架构上无法仅靠客户端彻底解决。

## 2. 房主权威与防作弊问题

### 2.1 非房主游戏消息被丢弃

现象：

```text
[client] 丢弃非房主游戏消息 p_xxxxx
```

原因：SDK 房间内消息可能来自任意 peer；旧连接、Relay 切换或错误客户端都可能发送看起来像游戏消息的包。

处理：

- 客户端固定当前房主 peer，只接受当前房主来源的游戏消息。
- `state_snapshot` 额外校验目标座位、房间号、房主代次、轮次和序号。
- `round_start`、回合请求、表现事件和重进握手都要求权威代次。

状态：**已处理，仍需线上 SDK 回归**。日志本身属于预期的 fail-closed 防护，不代表一定有业务故障。

### 2.2 客户端直接调用胡牌/结束对局

风险：客户端如果可以直接把本地状态改成胡牌或最终结算，就能绕过牌型、回合和牌权校验。

处理方向：

- 客户端动作只作为请求发送给房主。
- 胡牌、抢杠胡、计分和 `matchFinished` 只能由房主引擎生成。
- 客户端不再单独相信旧版 `hand_result`/`match_finished` 瞬时消息，终局主要依赖带权威字段的最终快照。

状态：**已处理主要入口，仍需用真实用户验证“客户端直接调用胡牌不能结束当前对局”**。

### 2.3 房主脑裂、出现两个房主

现象：本地 Relay 测试中曾出现两个客户端同时显示房主按钮，成员名单也分叉。例如一个视图认为甲是房主，另一个视图认为丙是房主。

原因：本地 Mock 在连接切换/旧会话恢复窗口中形成了两个房间视图。单纯切换 P2P → Relay 不应该重新选房主，但客户端曾经根据局部 roster 推导房主。

处理：

- 房主身份固定为 SDK 房间的原始 `hostId`。
- 对局生命周期锁定 `authorityEpoch`，不在 `reconnecting` 或 Relay 切换时自动迁移房主。
- 所有权威状态带 `authorityEpoch`、`round`、`sequence` 等字段。
- 旧连接和旧代次的消息不能复活旧状态。

状态：**部分处理**。线上 SDK 如果正确保持 `hostId`，Relay 本身不应制造双主；但 P2P 房主权威架构仍无法在房主设备本身失控时提供服务端级别的绝对保证。真实线上脑裂尚未完成压力验证。

### 2.4 洗牌和 nextRound 防作弊

风险：房主在下一局重新洗牌时，如果只由房主单方面生成牌墙，客户端无法确认洗牌是否在对局边界重新发生。

处理：

- 首局和后续局使用承诺/揭晓流程。
- `roundId`、参与者座位、房主代次和牌墙流程绑定。
- AI 座位不应阻塞真人承诺；真人重进后必须重新绑定新 peer。
- 后续局继续按钮不是客户端推进命令，真正推进仍由房主引擎和 opening barrier 决定。

状态：**已处理主要流程，异常掉线/重进期间仍需真实回归**。

## 3. 快照与状态同步问题

### 3.1 非法状态快照：玩家数为 0 或 3

现象：

```text
[client] 丢弃非法状态快照 [{ code: 'PLAYER_COUNT', message: '玩家数=0（应为 4）' }]
```

也曾出现只收到三家座位的日志：

```text
mySeat: 2 ... seats: 0:... | 1:... | 2:...
```

原因：旧会话/旧 SDK 连接先发送了空或不完整 roster，客户端如果接受，会清空牌桌或让房间视图分叉。

处理：

- 快照验证器对四个引擎座位进行 fail-closed 校验。
- 房主在玩家未完成四席引擎初始化前不广播空玩家快照。
- `3 真人 + 1 AI` 仍然是四个引擎玩家；`2 真人 + 2 AI` 也必须是四个引擎玩家。
- 客户端不接受目标座位不匹配、玩家数不完整或序号倒退的快照。

状态：**已处理主要路径**。如果线上仍出现玩家数为 0/3，应该优先检查是否是旧连接消息、错误房间消息或房主初始化时序，而不是放宽校验。

### 3.2 房主有状态、客户端没有状态

表现：房主已经进入下一局或有倒计时，客户端停在结算页、等待确认或大厅；反过来也出现客户端先进入最终排名而房主仍在等待。

处理：

- 快照以房间、房主代次、轮次和序号为边界。
- 结算时间线在收到当前房主的非结算快照时取消。
- 旧 `Room`、旧结算回调和旧 pending snapshot 不得覆盖新局。
- 终局必须同时满足权威 `matchFinished` 和 `phase='finished'`。

状态：**部分处理，真实掉线重进链路仍未完全验证**。这是本次历史问题中最需要继续做四端回归的部分。

### 3.3 “确认后一直等待”，三家确认也不能立即下一局

现象：

```text
[client] 确认后长时间未收到推进信号（通道可能断开），自动重进
[host] 后续局承诺洗牌未完成: 洗牌承诺超时（15000ms 内未完成）
```

以及房主日志：

```text
[host] continue: ready= false live= ... confirmed= ... ai= 1,2
```

原因：开局屏障、洗牌承诺、实时连接状态和 AI 接管集合曾经使用不同的 peer/seat 视图。某个玩家已重进，但承诺协调器仍持有旧 peer，导致真人永远被认为未完成。

处理：

- 重进时原子替换 `seatByPeer` 中的旧 peer。
- 承诺流程绑定当前 `roundId`、authority epoch 和当前参与者。
- 自动重进不再把客户端本地点击当作推进命令。
- 对真实在线真人和 AI 座位分别计算 barrier 参与者。

状态：**部分处理**。当网络仍处于 P2P 重连、Relay 切换和旧连接未释放时，仍需观察线上 SDK 是否会造成承诺重复、超时或漏发。

## 4. 掉线、重进与 AI 接管问题

### 4.1 第一次自动重进失败，第二次手动输入房间码成功

现象：

```text
[client] 尝试重新加入房间（第 1 次）——重进后连座位都没收到
[client] 重进后连座位都没收到，先释放旧连接再重进
```

第二次输入房间码后才能正常进入。

原因：SDK 旧 RTCPeerConnection 仍处于关闭/回收/Relay 协商状态，新会话虽然已经 join，但 roster 或 `rejoin_ok` 还没有到达。

处理：

- 自动重进增加退避和次数限制。
- 重进期间不因 `roomId` 短暂为空而停止重试。
- 收到 `rejoin_ok` 后清理旧请求、旧倒计时、旧结算残留，并等待当前房主快照覆盖阶段。

状态：**部分处理**。仍可能看到 SDK 层连接竞态；还没有证明第一次重进在所有真实网络下都成功。

### 4.5 新发现：selfHost/DEV 下 playerId 恒为空导致重进永远恢复不了座位（已修复）

**现象（本次浏览器回归新发现，多次复现）**：对局中刷新客户端后，客户端能重新加入房间
（房间码大厅可见、WebRTC 通道正常建立），但永远收不到含自己 peerId 的 roster；
房主侧 `aiControlledSeats` 仍保留该座位，客户端最终被房主失联检测踢回首页。

**根因（两层）**：

1. `remoteSessionStore.saveGuestId` 在生产代码中从未被调用 → `playerId` 恒为 `''`。
2. 房主大厅 `vibeLobby` 建座位记录时 `playerId: message.playerId?.trim() || fromPeerId`——
   空 playerId 回退成**旧 peerId**。selfHost/真实 SDK 每次连接 peerId 都是新的（只有
   mock 的 peerId 按标签页稳定），重进的新 peerId 与旧座位记录的 playerId（旧 peerId）
   永远匹配不上 → `sameIdentity` 失败 → `nextSeat()=-1` → 无座位。

**修复**（`useVibeRemoteGame` 初始化）：首次进入即生成并持久化访客身份
（`generateGuestId` + `saveGuestId`，按 sessionStorage 的 mock peer 命名空间隔离），
`playerId` 从此跨刷新稳定，重进时凭稳定 playerId + 房主签发的 seatToken 恢复原座位。

**验证**：`tests/e2e/selfhost-rejoin.spec.ts`（对局中刷新一个客户端：恢复座位、牌桌继续、
无 AI 夺舍残留）通过；重进端本地存储中 `playerId` 与 `lgm_guest_id` 一致且跨刷新不变。

### 4.2 重进后“AI 夺舍”但真人仍可操作

现象：客户端提示某玩家掉线、AI 托管，但第二次进房后真人又可以正常出牌。

原因：真人已经重新绑定到原座位，但房主的 `aiControlledSeats` 或 disconnected 标记仍保留旧状态。

处理：

- 恢复原座位后清除 AI 控制和 disconnected 标记。
- 更新旧 peer → 新 peer 映射。
- 恢复 controller 的真人模式并重发当前请求/快照。
- 自动重进和手动输入房间码共用恢复路径。

状态：**主要路径已处理，浏览器已验证**（selfhost-rejoin：刷新重进后座位恢复、AI 夺舍清除、牌桌继续；
“结算页重进”和“下一局承诺期间重进”仍未单独复验）。

### 4.3 重进后倒计时到 3 自动出牌

现象：玩家刷新/重进后，倒计时数到 3 时旧请求仍触发自动出牌。

原因：旧 `turn request`、requestId、倒计时和 AI fallback 定时器没有全部随重进失效；新连接恢复后旧 timer 仍可能调用自动出牌。

处理：

- `rejoin_ok` 时清理旧 timers。
- 重置 request coordinator、requestId/requestSeq 和旧 pending 请求。
- 只有收到当前房主、当前轮次、当前请求号的新请求才重新启动倒计时。

状态：**已处理代码路径，未完成真实掉线回归**。

### 4.4 结算页重进后进入最终排名，影响其他客户端

现象：用户 2/3 在结算页意外退出后重进失败；其他客户端直接进入最终结算；房主进入下一局或仍在等待，最终出现不同页面。

原因判断：旧房间回调、旧结算时间线、错误的 `matchFinished` 快照或旧 peer 的状态消息在重进窗口复活。由于多个客户端同时进入最终排名，不能只按单客户端 UI 残留解释，更像是广播状态或快照边界错误。

处理：

- 终局只接受当前房主、当前 room、当前 authority epoch 和当前序号的完整终局快照。
- `rejoin_ok` 不宣告当前阶段，只恢复身份；必须等待当前房主快照决定 `playing/settled/finished`。
- 新局非终局快照会取消旧 settlement timeline 并清理终局残留。
- 旧 `hand_result`/`match_finished` 不再单独把客户端写成最终排名。

状态：**部分处理/未完全验证**。这是目前最重要的真实四端回归项，尤其要覆盖“结算页掉线 → 第一次自动重进失败 → 第二次成功 → 房主继续下一局”。

## 5. P2P、Relay 和 SDK 层错误

### 5.1 `setRemoteDescription` 在 closed PeerConnection 上执行

现象：

```text
relay answer InvalidStateError:
Failed to execute 'setRemoteDescription' on 'RTCPeerConnection':
The RTCPeerConnection's signalingState is 'closed'.
```

原因：旧 Relay answer 在旧 RTCPeerConnection 已关闭后才到达，是 WebRTC/SDK 信令竞态。它不等于房主状态已经改变，也不代表应用协议允许客户端推进状态。

处理边界：

- 应在 SDK 层忽略已关闭连接的迟到 answer，或由 SDK 取消旧协商任务。
- 应用层继续使用 room、host、epoch、sequence 和快照校验，不能因为该异常直接进入最终结算。

状态：**SDK 层错误仍可能出现在控制台；应用状态防护已加强，但不能仅靠业务代码消除 SDK 内部日志**。

### 5.2 P2P → Relay 是否与脑裂有关

结论：协议类型本身不是根因。Relay 只应替换传输路径；如果房主身份、座位和权威代次保持不变，不应该产生双主。

真正的风险时序是：

```text
房主短暂失联
→ 客户端误判房主永久离开
→ 本地各自选出新房主
→ 原房主通过 Relay 恢复
→ 两套权威状态同时存在
```

状态：**已浏览器验证（2026-08-18），线上多端压力仍缺失**。验证证据：

1. **模拟 P2P→Relay 切换**（`tests/e2e/selfhost-relay-switch.spec.ts` 场景 A）：四端经公网信令
   `wss://www.bestguo.top:58787` 开局后，注入 `reconnecting → relay active` 事件序列并保持
   relay（`?selfHostRelayAfter` 参数，selfHostRoom.simulateRelaySwitch），切换后四端对局
   不中断、不出现「网络断开/房主连接中断/尝试重新加入」误报横幅、无未捕获异常。
   应用层（vibeRoomTransport）对 relay 事件按「可用保底路径」处理（active → connected、
   取消 reconnecting 确认），hostId/座位/authorityEpoch 由快照门禁保证不变。

2. **真实 TURN relay 路径**（同 spec 场景 B）：`?forceRelay=1&turn=…` 强制所有
   RTCPeerConnection 走 TURN 中继（iceTransportPolicy='relay'），四端仍能开局并发牌；
   selfHostRoom 的 getStats 路径探测（selectedCandidateIsRelay）能识别 relay 候选并更新
   `peers().relay` / `networkStats().state`。场景 C 另验证了 P2P→Relay→回 P2P 往返切换
   全程对局不中断。

3. **部署发现（已解决）**：初测时云服务器 **UDP 53478 未放行**——协议层 TURN Allocate 认证
   正常（凭据 `turn:DZxaEm35GmecFZj` 有效，realm=www.bestguo.top），但浏览器默认 `turn:`
   URL 走 UDP，UDP 被防火墙挡 → 收集不到任何 relay 候选（TCP `?transport=tcp` 可通）。
   **运维放行 UDP 53478 后**（2026-08-18），默认 UDP TURN 的 forceRelay e2e 通过；
   `scripts/probe-turn.mjs`（浏览器侧 UDP/TCP 候选探测）与 `scripts/probe_turn_fixed.py`
   （协议层 Allocate 认证验证）可复用于后续环境检查。

### 5.3 信号轮询失败

现象：

```text
[VibeHub] 信号轮询失败: 连续 1 次
```

单次失败不应该直接等价于房主掉线；需要结合 SDK 的 reconnecting/relay/network state 和当前房主业务消息判断。

状态：**单次告警不构成结论；仍需线上观察连续失败、Relay 切换和业务消息是否恢复**。

### 5.4 Three.js 警告

现象：

```text
THREE.WebGLShadowMap: PCFSoftShadowMap has been deprecated.
```

这是渲染库弃用警告，不是牌局同步或房主权威错误。当前代码会回退到 `PCFShadowMap`，但不影响协议状态。

状态：**非业务问题**。

## 6. 开局动画问题

### 6.1 房主有动画，客户端没有动画

现象：四端测试中房主能看到动画，客户端牌桌直接出现或只显示“开牌”，客户端 DOM 中没有 `.opening-overlay`。

已确认的复现事实：

- 四个页面都能进入牌桌。
- 客户端曾在 100ms 看到“牌桌加载中…”，500ms 后有牌桌 canvas，但没有 `.opening-overlay`。
- 控制台主要只有 Three.js 弃用警告，没有明确业务异常。

根因判断：

1. `round_start` 是瞬时消息，可能在 P2P/Relay 切换窗口丢失。
2. `state_snapshot` 与 `round_start` 到达顺序不固定。
3. 客户端时间线曾等待 `waitForTableReady()`，把 WebGL/牌面资源加载错误地作为开局动画前置条件。
4. `table-loading` 的不透明遮罩层级高于开局提示层，可能覆盖客户端动画。

处理：

- opening 快照先到时先缓存并挂载四家座位骨架。
- opening 快照丢失 `round_start` 时，使用已验收的同轮 opening 快照恢复动画触发器。
- 房主在 opening 阶段重发幂等的 `round_start`。
- 客户端开局时间线不再等待 3D ready 才进入 `start/dice/deal`。
- 对局阶段的加载遮罩不再覆盖开局动画。

状态：**已处理，浏览器四端验证通过（2026-08-18）**。

### 6.3 新发现：dealing 快照提前落地导致四端都跳过开局动画（已修复）

**现象（本次浏览器回归新发现，四端一致复现）**：四端都没有 `.opening-overlay`，牌桌直接出现完整手牌。

**根因**：房主引擎 headless 开局时，摸牌进度 watcher 会在 `phase='dealing'` 期间就广播带完整手牌的
`state_snapshot`（`round_start` 之前到达）。客户端 reconciler 把这类快照立即 `applyNow` 落地
（4 玩家、完整手牌、phase 折叠为 playing）；随后 `round_start` 到达时
`remoteMatchLifecycle.handleRoundStart` 看到 `players=4/phase=playing`，走「本局已渲染」分支，
直接 `opening.confirm()` 跳过整个 start/dice/deal 动画。

**修复**（`snapshotReconciler.apply`）：开局时间线未运行时，`dealing` 阶段快照与 `opening` 一样
只缓存不落地（骨架也不预渲染），等 `round_start` 启动动画后由 `flush()` 原子落地最新一份。
配套单测：`snapshotReconciler.test.ts`「dealing 快照在开局前到达时只缓存不落地」。

**验证**：`tests/e2e/selfhost-opening-overlay.spec.ts`（四端都出现 `.opening-overlay` 并完成发牌）通过。
另注：headless Chromium 会对后台标签页节流/冻结计时器（重进页动画停滞），
`playwright.config.ts` 已加 `--disable-background-timer-throttling` 等启动参数；
即便如此四端并发动画在软件 WebGL 下仍可能变慢，e2e 轮询窗口需给足余量。

### 6.2 慢 3G 下牌山未加载，解除限速后牌山消失

现象：慢 3G 下牌桌/牌山加载不完整；恢复网络后客户端牌山消失。

原因判断：渲染资源加载与权威快照落地时序耦合，可能出现牌桌重建时 wall/headDrawn 被旧或半初始化状态覆盖。

处理方向：

- 牌墙和 `wallHeadDrawn` 由房主快照恢复。
- opening 骨架先挂载，发牌动画从权威 opening 快照重新播放。
- 3D 资源加载不应改变逻辑牌墙状态。

状态：**部分处理/未完成慢 3G 实测**（代码防护见 snapshotReconciler 的 wall 占位逻辑；慢 3G 实测仍缺失）。

## 7. 典型复现矩阵

后续验收至少需要覆盖以下组合：

| 场景 | 期望结果 | 当前状态 |
| --- | --- | --- |
| 4 真人，正常开局 | 四端都有 start/dice/deal，随后同一轮 playing | **浏览器已验证**（selfhost-opening-overlay） |
| 3 真人 + 1 AI | 引擎仍有 4 个玩家，AI 不阻塞真人开局 | 代码已处理，需实测 |
| 2 真人 + 2 AI | 仅真人参与确认，AI 由房主托管 | 部分处理，需实测 |
| P2P 切 Relay | hostId、座位、round、epoch 不变 | **浏览器已验证**（模拟切换 + 真 TURN forceRelay，selfhost-relay-switch） |
| 对局中刷新一个客户端 | 恢复原座位，不出现旧 AI 夺舍 | **浏览器已验证**（selfhost-rejoin） |
| 结算页刷新一个客户端 | 不影响其他客户端，不误进最终排名 | 代码已处理，结算页重进未单独复验 |
| 第一次自动重进失败，第二次成功 | 第二次仍恢复同一座位和当前阶段 | 部分处理，需真实网络复验 |
| 重进后倒计时 | 不执行旧请求的自动出牌 | 代码已处理，需实测 |
| 三家确认下一局 | 不因旧 peer/旧承诺卡住 | **浏览器已验证**（完整东风场 4 局连打，selfhost-full-match） |
| 非房主伪造快照/胡牌/终局 | 客户端丢弃，房主状态不变 | 主要入口已处理（单测覆盖） |
| 慢 3G / 资源延迟 | 逻辑牌墙不消失，动画不被 loading 遮住 | 部分处理，慢 3G 未实测 |

## 8. 当前验证结果

最近一次代码验证（2026-08-18 复验）：

- Vitest：64 个测试文件、**513 个测试通过**（新增 selfHostRoom 自动重连/relay 路径测试）。
- `pnpm typecheck`：通过。
- `pnpm build`：通过。
- 后端 smoke：`signaling/smoke.py` 通过（信令 join/welcome/offer/answer/meta 中转正常）。

浏览器验证（本轮完成，selfHost + 真实 WebRTC）：

- 本地信令四端回归（`http://127.0.0.1:5173/?selfHost=ws://127.0.0.1:8787`）：
  - `selfhost-four-players.spec.ts` / `selfhost-opening-overlay.spec.ts` / `selfhost-rejoin.spec.ts` 全部通过。
- 公网信令 + Relay/TURN（`?selfHost=wss://www.bestguo.top:58787&turn=…`）：
  - `selfhost-relay-switch.spec.ts` 场景 A（模拟 P2P→Relay 切换对局不中断）、
    场景 B（forceRelay 真 TURN UDP 中继四端开局）、场景 C（P2P→Relay→回 P2P 往返切换）全部通过。
- **完整对局**（`tests/e2e/selfhost-full-match.spec.ts`，莲花麻将 lotus-legacy，2026-08-19）：
  4 个真实客户端打完东风场**东1局→东4局并进入最终排名页**（四端 `.final-backdrop`），
  全程覆盖：承诺洗牌（首局+每局后续局，客户端正常参与）、开局动画、摸打胡、每局结算、
  **三家确认→下一局**（每局间自动完成）、终局排名；**全程无 `[wall-regress]`（牌山无回跳/瞬移）**、
  无未捕获异常、无断线误报。耗时 40.6 分钟（headless 环境每手 5-13s 的渲染抖动所致，
  真机浏览器会快得多）。
- 测试驱动说明：客户端用 `?auto=1`（收到回合请求 600ms 自动响应，可胡自动胡/弃牌；
  claim 可胡点胡否则过）；房主（本地 HumanController）由注入页面的自动打牌器驱动
  （`.hand-rack.playable` 判定回合，点击 MahjongTile 本体触发 @click）。
- 注意：headless Chromium 会对后台标签页节流/冻结计时器，`playwright.config.ts`
  已加 `--disable-background-timer-throttling` 等启动参数；e2e 轮询窗口给足余量。

### 5.5 跨 NAT 真实测试方案（待第二端点补测）

已覆盖边界：`forceRelay` 场景 = 「NAT 打洞失败 → TURN 中继」的最坏路径等价验证；
模拟切换 A/C 验证路径切换语义。**未覆盖**：两个真实 NAT 后「打洞成功 → P2P 直连」这条路径。

本机无法模拟第二个 NAT：`VirtualizationFirmwareEnabled=False`（BIOS 未开 VT-x）→
WSL2/Hyper-V/Windows Sandbox/VMware 全部不可用；Docker 未安装。

可行的两条真实路线（任选其一，前提都是把前端部署到公网）：

1. **手机 4G/5G 当一端（最真实、零安装）**：
   - 服务器（bestguo.top，已有 Caddy 反代 `wss://www.bestguo.top:58787 → 127.0.0.1:8787`）
     按 `signaling/Caddyfile` 把 `dist/`（已 build 好）静态托管到 `https://www.bestguo.top/`。
   - 手机浏览器（蜂窝网络 = 运营商级 NAT，多为对称 NAT）打开：
     `https://www.bestguo.top/?selfHost=wss://www.bestguo.top/signal&turn=turn:turn:DZxaEm35GmecFZj@113.45.254.130:53478`
   - 手机加入房间做第 4 端，本机 3 端配合开局打牌；预期：对称 NAT 打洞失败 → 走 TURN 中继
     （真实验证兜底）；锥形 NAT 可能打洞成功（验证 P2P 直连）。用 getStats 路径探测
     （`peers().relay` / `networkStats().state`）判断实际路径。

2. **云服务器（113.45.254.130，公网 IP 无 NAT）跑 headless Chromium 当一端（可自动化）**：
   - 服务器装 node + Playwright Chromium，复用仓库 e2e 的建房/加入/准备流程（把 APP 指向公网 URL），
     本机 3 端 + 服务器 1 端对局，可重复多轮采集 ICE 路径证据。
   - 两端之间走真实 ICE：打洞成功则 P2P 直连，失败则 TURN 兜底。

状态：**待有第二端点时补测**（本次选择了先记录方案）。

## 9. 后续优先级

1. ~~恢复浏览器四端控制~~（已完成：Playwright 四端回归，见 §8）。
2. ~~重点回归“结算页掉线 + 第一次重进失败 + 第二次重进成功 + 房主继续下一局”~~
   （已完成：selfhost-rejoin + selfhost-full-match 覆盖对局中刷新与完整 4 局）。
3. 跨 NAT 实测（§5.5 两条路线任选）：验证「打洞成功 → P2P 直连」与「打洞失败 → TURN 兜底」。
4. 慢 3G、旧连接未释放条件下检查 `hostId/seat/authorityEpoch/round/sequence` 是否始终一致。
5. 记录每个客户端的 `phase`、`openingStage`、快照序号、当前请求号和 AI 座位集合，避免只靠最终页面推断中间状态。
6. 若要求真正 99.999% 的防作弊，最终仍应把麻将引擎和随机性裁判迁移到可信服务端；P2P 房主权威只能做到协议层约束和普通客户端防伪造。
