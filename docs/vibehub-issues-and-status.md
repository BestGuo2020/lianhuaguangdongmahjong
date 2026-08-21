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
- 后续局洗牌消息使用完整手牌键 `(round, honba)`；连庄时 round 不变、honba 增加，
  不能再被 `message.round <= currentRound` 误判成旧消息。

状态：**已处理主要流程，2 真人 + 2 AI 公网连续两场已验证（2026-08-19）**；异常掉线/重进期间仍需真实回归。

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
- 单局 `settled` 快照与终局快照一样每秒用新 sequence 重发；胡牌裁决已经进入
  `win-effect/revealing/settled` 后，不再被仍在收尾的旧 claim `waitingCount` 阻塞。
- `finished` 定向快照每秒用新 sequence 重发；同时房间级广播不含暗牌/牌墙的
  `match_finished` 最终分数，避免真人座位临时被 AI 接管后因无可达 peerId 而漏掉最终排名。
- 针对真实线上复现的“定向 peer 半开、Room 广播仍可用”，新增房间级 `round_settled`：
  与定向快照共用 authority epoch/sequence，只广播局号、本场、胡牌表现、结算结果和四席分数，
  不含暗牌或牌墙。客户端谁先收到就启动结算，后续每秒重发只刷新分数/序号，不重启胡牌特效。
- 胡牌表现不再等房主播完后才随 `settled` 到达：房主在 `winPresentation` 出现时立即公共广播
  `win_effect`，并以同一事件序号在 300/800ms 短时重发。客户端幂等播放一次；稍后的定向
  `settled` 快照或公共 `round_settled` 只为同一时间线补齐最终结果，因此房主端和客户端能在
  同一阶段看到胡牌特效，也不会因结果包晚到而重复播放或永久停在亮牌阶段。

状态：**selfHost 公网主要正常流程已处理；真实 VibeHub 线上仍失败**。2026-08-19 使用两个真实账号、
2 真人 + 2 AI、莲花麻将东风场复验时，第一场东2在 147 秒完成自摸结算，但只有房主进入结算弹窗；
客户端仍停在结算前牌桌和旧分数，页面显示“网络不稳定”，5 秒内没有收到/应用任何 `settled` 快照。
房主已确认后持续等待客户端，无法进入东3。房主侧虽每秒生成新 sequence 并重发定向快照，
`vibeRoomTransport` 对已绑定 `Room` 的低信号状态只更新 RTT/图标，不会请求快照、重绑 Room 或主动重进；
SDK 仍把 peer 视为 open 时，`bindHostGoneDetection` 的 peer 缺失/`reconnecting` 兜底也不会触发。
因此“半开但业务消息不达”的定向通道仍可永久卡住单局结算。公共 `win_effect` / `round_settled`
修复已完成并部署；下面的线上复验用于确认它对不同失联层级的实际覆盖范围。

部署后复验（2026-08-19）进一步确认：公共结算事实能修复单帧/定向漏包，但不能穿透
“整个房主 DataChannel 半开”的时间窗。第一场东1用时 298 秒、东2用时 277 秒，东2双端结算并在
双确认后 4226ms 进入东3；东3用时 132 秒，但只记录到房主确认，约 66 秒后才进入东4。
这说明 SDK 仍报告 peer `open` 时，定向快照、Room 公共广播和 transport ping 可能一起不达；
旧信号代码每轮 tick 先清空 RTT、无 pong 又回退为“peer open = 良好”，不会主动调用 SDK reconnect。

第一版主动心跳已部署并确认线上静态资源包含构建标记，但真实账号复验仍失败：一轮中东1用时
152 秒，双端结算、双确认后 2347ms 进入东2；东2用时 189 秒，只有房主进入结算并确认，客户端
保持旧分数/旧牌桌且显示“网络不稳定”。另一轮东1用时 208 秒后再次出现同样分叉，10 秒内客户端
仍未进入结算。这证明“每 3 秒 ping、2 秒无匹配 pong 后调用一次 `room.reconnect(hostId)`”能够发现
半开连接，却不能保证 SDK 真正替换仍被标记为 open 的旧 DataChannel；同时
`hostReconnectRequested` 会一直保持 true，原实现不会再升级恢复动作。

第二版线上复验仍发现问题：页面确实加载了第二版标记，但首次漏 pong 就调用 SDK
`room.reconnect(hostId)`，触发 `setRemoteDescription` 在 closed `RTCPeerConnection` 上的竞态；
房主随后把真人座位转 AI，客户端没有结算确认就被推进到下一局。因此单次 SDK reconnect 不能作为
可靠恢复动作。

第三版部署后的真实账号复验（2026-08-19）仍复现一次结算分叉：第 1 场东1用时 22 秒，双端胡牌
特效/结算/确认正常，536ms 进入东2；东2用时 227 秒，双端正常，4003ms 进入东3；东3用时
131 秒且双端都播放胡牌特效，但只有房主出现结算并确认，客户端 20 秒内始终没有结算弹窗。
客户端同时记录 SDK `relay answer InvalidStateError: setRemoteDescription ... signalingState is closed`。

第四版心跳方案已撤销：项目约束禁止用周期轮询同步游戏实时状态。进一步审计发现生产路径原本还存在
200ms `broadcastAll()` 快照扫描、500ms `round_start` 重发、3s transport ping、5s 房主/座位 presence
检查和 15s 大厅 ping；这些周期网络机制已全部移除，不能通过改成递归 `setTimeout` 规避约束。

当前改为纯事件驱动：引擎状态 watcher 在事实变化时通过 VibeHub `room.send` 发送一次；SDK
`onPeer(reconnecting/relay/join/connecting/leave)` 驱动连接状态和恢复，恢复事件到达时定向补发当前
`round_start`、快照和挂起请求；可靠业务 `room.send` 同步失败时立即完整重进。另有两种不发送网络包的
一次性看门狗：收到 `win_effect` 后 8 秒仍没有结算事实则完整重进；牌局进行中收到可信房主消息后重置
30 秒静默计时，超时完整重进。大厅首次 `hello` 只保留一次 2 秒有界重试，不再持续心跳。

生产 SDK 初始化入口也已移除 selfHost/WebSocket 测试传输；生产 bundle 审计确认不含 `selfHost`、
`WebSocket`、`__transport_ping`、`lobby_ping` 和旧心跳标记。全量前端测试 65 文件 / 530 项、类型检查、
生产构建、`git diff --check` 均通过。**待用户部署事件驱动版本后，使用真实 VibeHub 两账号从新房间
完成两个东风场。**

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

2026-08-19 的 2 真人 + 2 AI 公网复验又确认了两个更具体的竞态：

1. `round_shuffle_start` 只带 round，客户端用 `message.round <= currentRound` 拒绝旧消息；
   连庄同 round、只增加 honba，合法洗牌因此被永久拒绝。
2. 客户端确认后的 20 秒看门狗只认 `round_start`，不认已经收到的承诺洗牌/重试也是推进，
   会在房主正常进行 15 秒承诺重试时主动断开旧连接，反过来放大故障。

处理：

- 重进时原子替换 `seatByPeer` 中的旧 peer。
- 承诺流程绑定当前 `roundId`、authority epoch 和当前参与者。
- 自动重进不再把客户端本地点击当作推进命令。
- 对真实在线真人和 AI 座位分别计算 barrier 参与者。
- `round_shuffle_start` 新增 honba 并按 `(round,honba)` 门禁；收到可信洗牌开始后，
  客户端将看门狗延长到可覆盖最多四轮 15 秒重试的 90 秒窗口，每个新 roundId 重置窗口。

状态：**selfHost 公网两场曾通过，真实 VibeHub 线上未通过**。本次真实账号复验已确认
“网络不稳定/疑似半开连接叠加结算”会让客户端缺失结算弹窗，房主等待确认，属于会直接拖慢或阻断牌局的现存问题。

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

2026-08-19 公网复验又发现：稳定 `settled` 快照原先只发送一次；此外点炮/抢杠竞争响应
可能在结算阶段仍留下短暂的 `waitingCount > 0`，旧广播守卫会把结算快照全部压住。
现已让单局结算每秒可靠重发，并允许表现/结算/终局阶段绕过旧 pending 守卫。

状态：**主要应用路径已完成真实浏览器验证**。`tests/e2e/selfhost-settlement-rejoin.spec.ts`
使用公网 2 真人 + 2 AI，在东1结算层刷新客端，确认恢复同一结算、不误入最终排名，
双方确认后进入下一手（房间 `PF8627`，1 passed / 3.3m）。第一次自动重进被人为阻断、
第二次再成功的 SDK 极端竞态仍属于专项网络故障注入范围。

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

### 6.2 新发现：dealing 快照提前落地导致四端都跳过开局动画（已修复）

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

### 6.3 已复验：骰子、翻精、牌山断点与发牌动画（用户报告"牌山瞬移"）

**现象（用户实玩报告）**：莲花麻将开局打第一骰时，看到的骰子数字是 5 点，自己（庄家）面前
明明有牌山，但翻精指示牌（或视觉上的"牌山"）出现在下家（右墙段）。

**代码与真实浏览器复验结论（2026-08-19）**：

1. **规则层面无 bug**：莲花麻将一骰 = **两枚骰子求和** `S = d1 + d2`
   （`lotusOpening.ts` 第一骰 `[roll(), roll()]`，与 `docs/lianhua-mahjonggame-legacy-rules.md`
   第 30-37 行、南昌麻将传统规则一致：5/9→自身、2/6/10→下家、3/7/11→对家、4/8/12→上家）。
   翻精方位 = `(dealer + S − 1) % 4`。用户看到的"5 点"极可能是**单颗骰子面值**，
   另一颗为 1（S=6→下家）或 5（S=10→下家）——总和才是方位依据。
   纯函数枚举验证（`src/game/variants/lotus/lotusWall.verify.test.ts`）：
   `[5,1]→下家(墩56)`、`[5,5]→下家(墩60)`、`[5,4]→庄家(墩8)`、`[2,3]/[1,4]→庄家(墩4)`。

2. **规则坐标换算正确，但远端动画时间线存在一个已修复的断点应用 bug**：按牌（tile 内容）逐一对比"立牌山(136)→翻精后(134)→开门后(134)"
   三阶段在 4 个 localSeat 视角下的物理张位，随机 200 组骰子全部一致
   （`lotusWall.verify.test.ts`「按牌对比，各视角」）；`wallPhysicalIndex` 跳过翻精墩、
   `wallBreakIndexForOpeningStack`、`resolveFlipStack` 旋转均已验证等价。但远端
   `openingTimeline` 曾在收到权威断点后又被 `round_start` 重置为 0，直到发牌完成后
   flush 快照才纠正，肉眼表现就是发牌结束时牌山突然跳位；翻精前 LCD 也提前显示 134。
   现已改为：start/一骰保持 136 和断点 0 → flip 显示 134 → 二骰结束进入 deal 时
   应用权威断点并按发牌批次递减（实测示例：断点 0→100，牌数 136→134→130…）。

3. **视觉上"指示牌出现在下家墙段"本身是规则正确行为**：翻精墩就在目标方位玩家的
   墙段里（`flipStack = seatSegmentStart(flipSeat) + (S−1)`），指示牌从该墙段翻出，
   墙本身不动。

**仍需用户口径确认的点**：

- 用户当时两颗骰子的**实际面值**（是否 5+1 或 5+5）。
- 用户看到的"牌山在下家"具体指：翻精指示牌位置 / 二骰投掷者（翻精方位玩家）动画 /
  发牌起点（开门墩）位置——三者都是规则正确的"在目标方位"，但若用户预期
  "5 点=自己面前"，则属于规则认知差异而非 bug。
- 若后续复现仍存疑，可用 `scripts/verify-wall-live.mjs`（读取 Vue 实例
  diceValues/flipStack/wallBreakIndex 时间线 + 翻精截图）实机取证。

状态：**动画 bug 已修复并完成双端 WebM/逐帧验证**。`tests/e2e/selfhost-opening-visual.spec.ts`
确认双方完整经历 `start → 一骰 → flip → 二骰 → deal`，一骰/二骰投掷方、翻精牌、
牌山断点和发牌批次一致；“单颗 5 点是否应指向本家”仍属于规则口径确认。

### 6.4 慢 3G 下牌山未加载，解除限速后牌山消失

现象：慢 3G 下牌桌/牌山加载不完整；恢复网络后客户端牌山消失。

原因判断：渲染资源加载与权威快照落地时序耦合，可能出现牌桌重建时 wall/headDrawn 被旧或半初始化状态覆盖。

处理方向：

- 牌墙和 `wallHeadDrawn` 由房主快照恢复。
- opening 骨架先挂载，发牌动画从权威 opening 快照重新播放。
- 3D 资源加载不应改变逻辑牌墙状态。

状态：**应用层慢网恢复已浏览器验证（2026-08-19）**。公网
`selfhost-slow-network-three-humans-one-ai.spec.ts` 在 3 真人 + 1 AI 开局时把一个客端限制为
400ms 延迟、约 64 KiB/s，8 秒后解除限速；三端均完成发牌，慢速端 loading 消失，
逻辑牌山与传给 3D 的牌墙持续非空（房间 `2CEZSW`，15 秒观察 `wall 110→84`，无回跳/消失）。

### 6.6 同一房间再次开局（第二场）客户端永远停在大厅（已修复）

**现象（线上双场验收连续 5 次复现）**：第一场打完、双方返回大厅后再次开局，房主端正常
进入东1局，客户端却一直停在房间大厅（准备按钮仍在），`.opening-overlay` 永不出现；
且每次都在同一位置失败。

**根因（两层，均已修复）**：

1. **权威代次门禁（主因）**：新房主引擎使用全新 `authorityEpoch`，但客户端的代次门禁
   只允许 `rejoin_ok` 切换代次——第二场所有消息（round_start/快照/回合请求）都在
   `handleMessage` 的 `acceptAuthorityEpoch` 处被「丢弃旧房主代次消息」拦截
   （客户端控制台全程复现）。`round_start` 原有的代次切换在门禁之后，永远走不到。
   **修复**：新一局首个 `round_start`（`round===1` 且客户端尚在大厅）视为新生命周期
   边界，允许切换到新代次（同时重置挂起请求）；`round=1 + lobby 相位` 双重限定
   防止旧引擎迟到消息把代次回退。
2. **轮次边界未归零**：`returnToLobby` 不重置 `state.round/honba`（末局仍为东4局·N本场），
   第二场新引擎的 `round=1` 消息会被「旧轮次」门禁丢弃（房主端第二场开局动画缺失
   即此原因）。**修复**：返回大厅时把 round/honba/dealer 与开局表现状态归零
   （保留房间会话与规则设置）。

**验证（2026-08-20 最终通过）**：`tests/e2e/online-two-accounts-two-east-matches.spec.ts`
同一房间连续两个完整东风场 **2 passed (52.7m)**，房间 `GZ2LQ6`：第一场 8 手
（东1 169s、东2 141s、东3 157s、东3·1本场 103s、东3·2本场 229s、东4 317s、
东4·1本场 79s、东4·2本场 205s），第二场 7 手（东1 166s、东2 106s、东3 212s、
东3·1本场 164s、东3·2本场 119s、东4 224s、东4·1本场 228s），全部低于 6 分钟；
双端每局结算弹窗与确认同步、胡牌特效齐全、无恢复/重进/非法快照/牌山回跳日志。
第二场成功开局并打完（此前同一位置连续 5 次失败）证明代次切换修复生效。

### 6.5 自动确认进入新一局时开局动画被静默取消（已修复并验证）

**现象（真实 VibeHub 账号专项复现，用户挑战「自动确认是否真的有效」后定位）**：
双方都不点确认、走生产默认 10 秒自动确认进入东2局时，两端都没有东2局的开局动画：
round-info 直接从「东1局结算页」跳成「东2局整副牌已就绪」；页面采样器完全没有
东2局的 start/dice/flip/deal 阶段记录，房主端也没有任何 gate 拒绝日志。

**根因（两层叠加，均在 `snapshotReconciler.apply` + `openingTimeline`）**：

1. 自动确认路径下 `round_start` 先到：`opening.start(2)` 启动 gate 等待同轮 opening 快照，
   但 `run()` 只有在 gate 拿到快照后才会把 `state.round` 从上一手（1）改成目标手（2）。
2. 同轮 opening 快照到达时：`apply()` 第 294 行 `primeSnapshot` 在动画运行中**提前 capture**
   了快照（`openingSnapshot` 置位），`isWaitingForSnapshot()` 因此翻转为 false；
3. 随后第 342 行「未来轮次」分支用**滞后的 `state.round`（=1）**比较，`2 > 1` 误判为
   「开局动画还没等到快照的未来轮快照」→ 走 `opening.cancel() + applyNow()` 直接落地：
   东2局整副牌瞬间出现，开局动画被静默取消。东1局不触发是因为 `1 > 1` 为 false。

**修复（`openingTimeline` + `snapshotReconciler`）**：

- `openingTimeline` 新增 `getTargetHand()`（round_start 的目标手），并在动画运行中
  不再提前 capture（reconciler 同一次 apply 内的 capture 分支负责喂 gate）；
- `snapshotReconciler` 的「未来轮次」判断改为与**动画目标手**比较（目标手缺失时回退
  `state.round`），只有真正晚于动画目标手的快照才取消旧动画并直接落地；
- 开局链路新增诊断日志：`opening.start / opening capture / opening gate wait /
  opening cancel / reconciler 未来轮`（不记录牌面/分数）。

**验证**：`tests/e2e/online-settlement-confirm-scenarios.spec.ts` 三场景全部通过（2026-08-20，
1 passed / 22.7m，房间 `SH3LMJ/T47AR9` 等）：

- **场景 A（双端自动确认）**：双方都不点确认，10 秒倒计时自动确认进入东2局
  （自动确认耗时 10.8s-23.7s = 倒计时 + 承诺洗牌），两端均采集到东2局完整开局时序
  `start(136/断点0) → 一骰 → 翻精(134/断点0) → 二骰 → 应用真实断点（实测 24/26/62/98/120/124）→ 分批发牌到 53/81`，
  无恢复/重进日志。
- **场景 B（仅房主确认）**：25 秒无确认窗口内屏障生效（双端未推进），客户端补点确认后
  进入下一手，两端完整开局时序。
- **场景 C（仅客户端确认）**：25 秒无确认窗口内屏障生效（房主未确认不推进），房主补点确认后
  进入下一手（东3局），两端完整开局时序。

另注（测试驱动经验）：headless 软件 WebGL 双 context 共享 CPU 时，开局动画可能慢到数十秒，
时序验证采用「探针完成态 + 采样器历史稳定」双信号并放宽尾部单张批次的采样缺失容忍；
VibeHub 大厅 roster 同步偶发失败时，客户端「离开房间→重新加入」可在不丢登录态的情况下恢复
（刷新页面会丢失 OAuth 登录态，不可用作重试手段）。

## 7. 典型复现矩阵

后续验收至少需要覆盖以下组合：

| 场景 | 期望结果 | 当前状态 |
| --- | --- | --- |
| 4 真人，正常开局 | 四端都有 start/dice/deal，随后同一轮 playing | **浏览器已验证**（selfhost-opening-overlay） |
| 3 真人 + 1 AI | 引擎仍有 4 个玩家，AI 不阻塞真人开局 | **公网慢网恢复场景已验证（2026-08-19）** |
| 2 真人 + 2 AI | 仅真人参与确认，AI 由房主托管 | **公网连续两个东风场已验证（2026-08-19）** |
| P2P 切 Relay | hostId、座位、round、epoch 不变 | **浏览器已验证**（模拟切换 + 真 TURN forceRelay，selfhost-relay-switch） |
| 对局中刷新一个客户端 | 恢复原座位，不出现旧 AI 夺舍 | **浏览器已验证**（selfhost-rejoin） |
| 结算页刷新一个客户端 | 不影响其他客户端，不误进最终排名 | **公网 2 真人 + 2 AI 已验证（selfhost-settlement-rejoin）** |
| 第一次自动重进失败，第二次成功 | 第二次仍恢复同一座位和当前阶段 | 部分处理，需真实网络复验 |
| 重进后倒计时 | 不执行旧请求的自动出牌 | 代码已处理，需实测 |
| 三家确认下一局 | 不因旧 peer/旧承诺卡住 | **浏览器已验证**（完整东风场 4 局连打，selfhost-full-match） |
| 非房主伪造快照/胡牌/终局 | 客户端丢弃，房主状态不变 | 主要入口已处理（单测覆盖） |
| 慢 3G / 资源延迟 | 逻辑牌墙不消失，动画不被 loading 遮住 | **公网限速→恢复已验证（3 真人 + 1 AI）** |

## 8. 当前验证结果

最近一次代码验证（2026-08-19 复验）：

- Vitest：65 个测试文件、**530 个测试通过**。
- `pnpm typecheck`：通过。
- `pnpm build`：通过。
- 后端 smoke：`signaling/smoke.py` 通过（信令 join/welcome/offer/answer/meta 中转正常）。

浏览器验证（本轮完成，selfHost + 真实 WebRTC）：

- **2 真人 + 2 AI 连续两个东风场（2026-08-19 最终复验）**：
  `tests/e2e/selfhost-two-humans-two-ai-two-matches.spec.ts` 使用公网信令
  `wss://www.bestguo.top:58787` 和指定 TURN，玩法为莲花麻将，两个真实浏览器 context + 两个 AI；
  两个独立房间 `KHFHMQ → J2CC2P` 均从东1走到东4并让双方进入最终排名，测试 **1 passed (57.5m)**。
  第一场各可见手耗时：193s、142s、315s、159s、217s、245s；第二场主要手耗时：
  125s、219s、213s、78s、244s、104s、253s、76s、105s（另有起手即时结算）。
  全部 `(round,honba)` 均不超过 360s；第二场明确覆盖 **东2局→东2局·1本场**，并多次覆盖
  东3/东4连庄。全程无自动重进、非法快照、wall-regress 或未捕获异常，双方最终排名同步。
- **开局动画双端录屏（2026-08-19）**：`tests/e2e/selfhost-opening-visual.spec.ts` 通过（1.8m），
  页面内 20ms 阶段历史和 WebM 证明双方均看到 start、一骰、翻精、二骰、发牌；逐帧核对
  牌数 136→134、翻精指示牌位置、二骰换投掷方和发牌断点一致。
- **结算页刷新重进（2026-08-19）**：公网 2 真人 + 2 AI 房间 `PF8627`，双端进入东1结算后
  刷新客端，恢复的局号/结算一致且双方均未误进最终排名；确认后进入下一手，**1 passed (3.3m)**。
- **3 真人 + 1 AI 慢网恢复（2026-08-19）**：公网房间 `2CEZSW`，一个客端在牌桌加载窗口
  以 400ms/64 KiB/s 运行 8 秒后恢复；三端发牌完成，慢速端牌山持续存在，**1 passed (1.6m)**。
- **应用层边界复验（2026-08-19）**：四真人开局、四端 opening、对局中刷新重进、
  模拟 P2P→Relay、Relay→P2P 往返和强制 UDP TURN 共 **6 passed (8.9m)**。

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
2. ~~重点回归结算页掉线重进后恢复当前结算、且房主继续下一局~~
   （已完成：`selfhost-settlement-rejoin` 公网 2 真人 + 2 AI 专项；人为阻断第一次重进的
   SDK 故障注入仍单列在 §4.1/矩阵，不再用“对局中刷新”代替“结算页刷新”证据）。
3. 跨 NAT 实测（§5.5 两条路线任选）：验证「打洞成功 → P2P 直连」与「打洞失败 → TURN 兜底」。
4. ~~慢 3G 恢复后牌山/牌桌保持~~（已完成：`selfhost-slow-network-three-humans-one-ai`）；
   旧连接未释放与人为阻断首次重进时，仍需继续检查 `hostId/seat/authorityEpoch/round/sequence`。
5. 记录每个客户端的 `phase`、`openingStage`、快照序号、当前请求号和 AI 座位集合，避免只靠最终页面推断中间状态。
6. 若要求真正 99.999% 的防作弊，最终仍应把麻将引擎和随机性裁判迁移到可信服务端；P2P 房主权威只能做到协议层约束和普通客户端防伪造。

## 11.9 11.7 复测结果（2026-08-21）

本轮使用两个真实账号对线上 VibeHub 做了短流程复测：账号 1 作为手机横屏尺寸的房主模拟，账号 2
作为客户端；玩法选择莲花麻将、东风场。新房间 `8VEHYG` 的结果如下：

- 两端均只显示两个真人，没有重复账号条目。
- 账号 2 在房主端和客户端都稳定显示为 2 号座位，未跳到 3 号座位。
- 账号 2 点击准备后，房主端正确回显“已准备”。
- 房主随后点击准备，开始按钮变为可用；点击后房主端和客户端都进入开局动画。
- 线上部署构建标记检查通过：事件驱动恢复、严格确认屏障、同步 Room 绑定、roster-ready 握手和延迟结算重放均存在，旧应用层心跳标记不存在。

同时运行当前工作区针对大厅/座位/开局屏障的单测：**5 个测试文件、39 个测试通过**，其中包含：

- 重复 `playerId` 且没有有效 `seatToken` 时不分配新座位；
- 有效 `seatToken` 续接时原子替换旧 peer；
- 准备状态以房主 roster 回显为准，并做一次有界补发；
- 房主开始请求在 roster 变化时返回可恢复错误；
- 房主牌桌未 ready 时不因旧 60 秒超时强行放行首回合。

**结论：11.7 的正常大厅路径已通过，但“手机房主 + 账号 2 客户端在旧 peer 尚未释放时刷新/重进”这一
特定竞态尚未完成真实手机验收，不能标记为完全关闭。** 当前工作区的相关生产改动仍处于未提交状态，
且本轮没有发布；因此不能把本地单测结果等同于线上已部署修复。下一步必须由用户部署当前改动后，
用真实手机房主和账号 2 在新房间重复 11.7：确认无重复账号、账号 2 固定 2 号位、双方准备状态一致、
开始按钮可恢复，且点击开始后两端均进入开局。

## 11.10 11.7 修复版本已发布（2026-08-21）

用户要求发布后进行手机端复测。本轮已使用官方 VibeHub CLI `update` 更新既有项目 `B5AJupT1`，
没有创建新项目、开启共创或配置 GitHub 自动部署。CLI 上传 4 个变化文件并删除 3 个旧 hash 资源，
部署成功，线上地址仍为：<https://vibe.lumigrav.space/play/M-USGs_ieQksAeOJYtHF4>。

部署后回读线上构建：

- 已包含“重复 playerId 无有效 seatToken 时拒绝新座位”的保护；
- 已包含大厅 roster 变化导致开始失败时的可恢复错误；
- 事件驱动恢复、严格真人确认屏障、同步 Room 绑定、roster-ready 握手和延迟结算重放标记均存在；
- 旧应用层心跳标记不存在；生产部署检查用例 `1 passed (19.6s)`。

当前等待用户用真实手机房主 + 账号 2 在新房间完成 11.7 人工验收。此次发布没有把该人工验收提前
标记为通过。

## 11.11 东4局全桌卡死现场与修复（2026-08-21）

现场房间 `LGC3UV` 出现“手机端仍在上一局结算、房主已进入东4发牌、全桌无法继续”。证据已保存：

- [`tmp/online-stuck-evidence-2026-08-21.json`](../tmp/online-stuck-evidence-2026-08-21.json)
- [`tmp/online-stuck-evidence-2026-08-21.png`](../tmp/online-stuck-evidence-2026-08-21.png)

关键现场状态：`round=4`、`phase=dealing`、`wallHeadDrawn=0`、无 opening overlay；此前日志显示
P2P→Relay、`rejoin_ok` 后，房主错误推进了下一局，但手机端没有完成上一局确认。

修复内容：新增 `getConfirmationSeats()`，结算确认屏障不再使用可能暂时过滤掉真人的控制器/连接视图；
恢复中或断开的真人继续参与确认，只有 `aiControlledSeats` 明确记录的座位可以跳过。新增回归测试覆盖
临时 peer 过滤不能绕过未确认真人。

验证结果：针对性测试 5 个文件 / 65 项通过，全量测试 69 个文件 / 566 项通过，类型检查和生产构建
通过；官方 CLI 已更新既有项目 `B5AJupT1`，部署后生产恢复标记检查 `1 passed (13.3s)`。

当前房间可以结束；证据已保留。修复后的真实手机复测仍需用户重新部署后的新房间验收。

## 11.12 发布后手机切网最终验收（2026-08-21）

修复重连握手降级问题后，在新房间 `SG9F8E` 进行了真实手机切网验收：

- 切网前：东1局正常 `playing`，牌山 `77 → 66`，开局完成。
- 约 `09:09:21` 手机从 Wi‑Fi 切到流量，SDK 明确记录 P2P 断开并切换 Relay，随后多次 `rejoin_ok`。
- 切网后：东1正常结算；东2正常开局并完成；东2·1本场正常开局；随后东2·2本场也完成发牌并进入结算。
- 手机没有退出房间、回到大厅、丢失座位或停留在上一局结算；房主没有提前跳过真人确认，也没有再次出现 `phase=dealing + wallHeadDrawn=0` 的永久卡死。
- 验收证据：
  - [`tmp/online-network-switch-acceptance-SG9F8E.json`](../tmp/online-network-switch-acceptance-SG9F8E.json)
  - [`tmp/online-network-switch-acceptance-SG9F8E.png`](../tmp/online-network-switch-acceptance-SG9F8E.png)

期间仍出现一次 VibeHub SDK 自身的 `RTCPeerConnection signalingState='closed'` Relay answer 错误，
但未造成业务中断；这属于 SDK 连接层噪声，当前应用已通过后续 Relay/rejoin 继续完成多局推进。

**结论：本轮发布后的手机切网现象已完成真实功能验收，不再复现“客户端回大厅/房主提前下一局/全桌卡死”。**
