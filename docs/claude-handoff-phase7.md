# 莲花广麻 · 前端对接 —— 交接文档（Phase 7）

> 本会话完成日期：2026-08-05
> 会话起点：`docs/claude-handoff-phase6.md`（Phase 6 交接）§8「下一步建议 · Phase 7」
> 目标：把 Phase 6 的后端（REST + WS + SQLite）接上前端，实现联网麻将对局
> 当前进度：**Phase 7 全部完成** —— 前端可选「单机/联机」两种模式，联机可创建/加入房间并完整对局

---

## 1. 任务目标与背景

Phase 6 交付了后端：REST 房间生命周期 + WS 实时对局 + SQLite 战绩。但前端仍只有本地 `useGame` 引擎，无法联网。Phase 7 目标（Phase 6 交接 §8）：

1. `src/game/remoteGameClient.ts`：WS 连接 → state_snapshot 驱动 Vue 响应式状态 → 发送动作
2. `App.vue` 按 `mode: 'local' | 'remote'` 选择 `useGame` 或 `useRemoteGame`
3. 联调：真人对 AI、真人对真人（2 客户端）；注意先连 WS 再 start 的时序

**关键发现**：Phase 6 的后端只在 rejoin 时下发一次 `state_snapshot`，**回合间不下发全量状态**。客户端若只靠增量事件（table_action/score_flow/请求）重建状态，等于把整个引擎重写一遍且易漂移。因此本阶段先补上「状态变更即广播快照」的协议基础，再写客户端。

---

## 2. 已完成工作概览

| 任务 | 内容 | 状态 |
|---|---|---|
| 快照广播协议 | `GameManager` 在每个状态变更点广播 `snapshot()`；`RoomSession` per-seat 差异化下发 | ✅ |
| 快照字段补全 | `lastDiscard` / `winPresentation` / `winningPlayerIndex` 加入快照 | ✅ |
| CORS | `main.py` 允许 Vite dev origin（:4173） | ✅ |
| REST 客户端 | `src/game/remoteApi.ts`：6 个房间路由的 typed fetch 封装 | ✅ |
| 远程 composable | `src/game/useRemoteGame.ts`：与 useGame 接口兼容 + 座位旋转 + 延迟结算 + 重连 | ✅ |
| App 模式切换 | `App.vue`：facade 桥接双 composable + 联机 Lobby（创建/加入/准备/开始） | ✅ |
| 后端测试 | `tests/test_snapshot.py`：快照顺序 / 手牌隐藏 / lastDiscard / 结算字段 | ✅ 3 passed |
| 前端测试 | `src/game/useRemoteGame.test.ts`：mock WS 驱动 7 个用例 | ✅ 7 passed |
| 端到端冒烟 | Node 双 WS 客户端真实打完一场，验证协议 | ✅ 手动通过 |

**最终测试数**：后端 `98 passed`（95 原有 + 3 新增）；前端 `90 passed`（83 原有 + 7 新增）；`vue-tsc` 无错误；`npm run build` 通过。

---

## 3. 修改 / 新建的文件

```
backend/                        （独立 git 仓库，未提交）
├── app/
│   ├── main.py                 # 修改：CORSMiddleware（dev origin）
│   ├── game/
│   │   ├── manager.py          # 修改：GameEvents.snapshot + 各状态变更点广播
│   │   └── room.py             # 修改：WSEvents.snapshot / broadcast_snapshot / build_snapshot 补字段
│   └── ws/                     # 未改（凭 rejoin_code 握手逻辑不变）
└── tests/
    └── test_snapshot.py        # ★ 新建：3 个快照广播集成测试

src/
├── App.vue                     # 修改：gameMode 切换 + facade 桥接 + 联机 Lobby
├── style.css                   # 修改：联机 Lobby / 房间面板 / 断线横幅样式
└── game/
    ├── remoteApi.ts            # ★ 新建：REST 客户端（typed）
    ├── useRemoteGame.ts        # ★ 新建：主 composable（~660 行）
    └── useRemoteGame.test.ts   # ★ 新建：mock WebSocket 单测（7 用例）
```

### 3.1 `backend/app/game/manager.py` —— 状态变更即广播快照

- `GameEvents` Protocol 加 `def snapshot(self) -> None: ...`；`NullEvents` 加空实现
- `GameManager._broadcast_snapshot()` → `self.events.snapshot()`
- **调用点**（每次状态变更后）：`start_game`（发牌完成）/ `begin_turn`（摸牌后）/ `discard_tile`（弃牌后）/ `offer_next_claim`（碰/点杠后）/ `perform_concealed_kong` / `declare_added_kong` / `settle_added_kong` / `end_game`（结算）/ `end_draw`（流局）/ `next_round`（finished）/ `return_to_lobby`

### 3.2 `backend/app/game/room.py` —— per-seat 快照广播

- `WSEvents.snapshot()` → `self.room.broadcast_snapshot()`
- `RoomSession.broadcast_snapshot()`：对每个在座连接 `send_to_seat_nowait(seat, build_snapshot(self, seat))` —— **per-seat**：本人手牌可见、他人手牌 `null` 占位（防作弊）
- `build_snapshot` 新增：`lastDiscard`（`mgr.last_discard`）/ `winPresentation`（`mgr.win_presentation`）/ `winningPlayerIndex`

### 3.3 `src/game/remoteApi.ts` —— REST 客户端

- `API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:8000'`（`WS_BASE` 由 `http`→`ws` 派生）
- 函数：`createRoom(mode, capacity)` / `getRoom` / `joinRoom` / `leaveRoom` / `readyRoom` / `startRoom`
- 非 2xx 抛 `RemoteApiError`（`code` = 后端 detail.code）

### 3.4 `src/game/useRemoteGame.ts` —— 主 composable（★ 核心）

**返回接口与 `useGame` 完全兼容**（30+ ref/computed/函数同名同形），App.vue 模板可无缝复用。

| 关注点 | 设计 |
|---|---|
| 座位旋转 | 服务端座位是权威索引；快照应用时把本家（`mySeat`）排到 `players[0]`，`toLocal(s)= (s-mySeat+4)%4` 映射 `currentPlayer/dealer/lastDiscard.from/tableAction/scoreFlow/result/winPresentation` 等所有座位敏感字段 |
| 真源 | 客户端**不本地改牌**，只渲染快照 + 发送动作意图；快照回写自愈 |
| 请求 | `turn_request`→`phase='discard'`+12s 倒计时（归零自动弃末张）；`claim_request`/`rob_kong_request`→`phase='prompt'`（归零自动过） |
| 结算 | `settled` 快照触发赢牌动画序列（win-effect 2.6s → revealing 1.5s → settled 弹窗），流局走短翻牌 |
| 延迟队列 | 结算展示期间到达的下一局快照/请求暂存 `pendingSnapshot`/`pendingRequest`，点「继续」后落地（服务端无条件推进，客户端不能暂停） |
| 头像 | 空 `avatar` 按服务端座位补默认头像（lotus/ah-lok/shisan/young-master，跨重连稳定） |
| 重连 | WS 断开 → 1/2/4/8s 指数退避重连（带原 rejoin_code）；`rejoin_ok` 重置结算展示再恢复 |
| 播报 | 快照携带的 `announcement` 视为瞬时事件：同文案只首份触发 1.5s 自动清除（服务端把公告留在状态里，否则会永久停在牌桌上） |
| 心跳 | `onopen` 起 20s 发一次 `{type:'ping'}` |

远程会话状态（额外暴露给 App.vue）：`sessionStatus` / `wsStatus` / `sessionError` / `roomId` / `mySeat` / `nickname` / `isCreator` / `roomSeats` / `remoteActions{createRoom,joinRoom,toggleReady,startMatch,leaveRoom}`。

### 3.5 `src/App.vue` —— 模式切换 + 联机 Lobby

- `gameMode` ref + **facade 桥**：`Object.keys(localGame)` 遍历，函数成员委托调用、ref 成员包 computed 解包，解构出的名字始终指向当前模式 composable（本地/远程共用一套模板）
- Lobby 顶部加「单机对战 / 联机对战」切换；联机面板：昵称 → 创建/加入房间 → 房间码展示 + 座位表（REST 轮询 1.5s）→ 准备 → 开始
- 顶栏加房间码徽标；WS 断线显示重连横幅
- `PlayerSeat` 的 `:key` 由 `player.name` 改为 `player.seat`（远程昵称可能重复）

### 3.6 测试

- `backend/tests/test_snapshot.py`：turn_request 前必有快照 / 本人手牌可见他人隐藏 / lastDiscard 字段 / settled 快照带 result+winPresentation
- `src/game/useRemoteGame.test.ts`：`MockWebSocket` 类 + stub `window`/`fetch`/`WebSocket`，覆盖座位旋转、动作协议、赢牌序列、延迟队列、match_finished

---

## 4. 关键设计决策

1. **快照即真源，事件只做动画**：状态每次变更广播全量 `state_snapshot`（per-seat 差异化）；`table_action`/`score_flow`/`announcement` 只是瞬时表现。客户端不本地执行牌面操作 → 无状态漂移、两处引擎不重复。
2. **服务端座位 = 权威，客户端本地恒以本家为 index 0**：所有座位敏感字段在应用时统一 `toLocal` 映射一次；牌桌组件（MahjongTable3D / PlayerSeat）完全不感知服务端座位。
3. **客户端不推进场次**：服务端 `_drive` 无条件跑完一场，`nextRound()` 只清结算展示 + 落地延迟队列。这使结算弹窗可读（否则下一局快照 2s 内冲掉弹窗）。
4. **结算展示期间延迟应用快照/请求**：防止「读结果时被下一局刷走」，用户点继续再入场。
5. **creator 也要 join 自己房间**：`POST /api/rooms` 只建房间，creator 占座靠 `POST /join` 拿 `rejoinCode`，否则 WS 握手无凭据。
6. **后端 pace 保持默认 0**：AI 回合瞬间完成，现有测试速度不受影响；代价是 AI 动作体感快（见 §7 #1）。

---

## 5. 已执行的命令与测试结果

```bash
# 后端
cd backend && PYTHONIOENCODING=utf-8 .venv/Scripts/python -m pytest -q
# 98 passed in ~15s（95 原有 + 3 新增 snapshot）

# 前端
npx vue-tsc --noEmit          # 无错误
npx vitest run                # 90 passed（83 原有 + 7 新增）
npm run build                 # typecheck + vite build 通过

# 端到端冒烟（真实 uvicorn + Node 22 双 WebSocket 客户端）
# 创建房间(capacity=2) → 2 玩家 join/ready → start → 自动打完一场
# ✓ rejoin_ok / turn_request 前有快照 / 本人手牌可见他座隐藏 /
#   lastDiscard 字段 / settled 快照带 result+winPresentation / 双方收到 match_finished
```

---

## 6. 失败尝试及原因（本次会话已解决）

| # | 失败 | 原因 | 解决 |
|---|---|---|---|
| 1 | 赢牌动画卡在 win-effect 不推进 | `startWinSequence` 里先 `serial = winSequenceSerial + 1` 再调 `cancelWinSequence()`（又 +1），守卫 `winSequenceSerial !== serial` 永远为真 → 定时器回调全部提前 return | 先 `cancelWinSequence()` 再取 `serial = winSequenceSerial` |
| 2 | `test: match_finished 覆盖结算` 断言 win-effect 却拿到 revealing | 该用例 settled 快照漏了 `winPresentation` → 走流局短翻牌分支（`!wp` 判 draw） | 补上 winPresentation |
| 3 | 快照 announcement 永久停在牌桌上 | 服务端把公告保留在 `mgr.announcement` 状态随每份快照携带，客户端直接赋值不清除 | `applySnapshotAnnouncement`：同文案只首份触发 1.5s 自动清除 |
| 4 | creator 创建房间后 WS 连不上 | `createRemoteRoom` 没 join 自己房间、`enterRoom` 没传 rejoinCode，`connect()` 因缺 rejoinCode 直接 return | 创建后补 `joinRoom`；`enterRoom(id,name,mode,code)` 先存 rejoinCode 再 connect |

---

## 7. 当前未解决的问题 / 备注

1. **AI 动作无节奏（pace=0）**：联网房间沿用默认 pace=0，AI 回合瞬间完成，真人之间的 AI 动作快成残影。真人对真人节奏正常（人类回合即节奏）。Phase 8 可给 REST 创建的房间注入一套可配 pace（如 400ms），但要保证现有全 AI 测试不拖慢 —— 建议 pace 仅对有连接的房间生效或按房间可配。
2. **无对局中途退出按钮**：联机对局中只能打完或刷新；断线后靠 AI 托管 + 重连恢复。Phase 8 可加「退出对局」按钮（释放座位 + 关闭 WS）。
3. **服务器信任客户端的 hu 意图**：`RemotePlayer._validate` 对 `type:'hu'` 直接放行，`end_game` 不校验手牌是否成胡 —— 诚实客户端只在 `isWinningHand` 时显示胡按钮，但作弊客户端可假胡。Phase 8 应在服务端校验手牌。
4. **昵称重复**：两名玩家可用相同昵称，座位面板/牌桌用 `seat` 做 key 已规避渲染问题，但结算/排名显示仍会混淆。可加昵称查重或强制唯一。
5. **远程房间场次固定 east**：联机 Lobby 未暴露场次选择（默认东风场）。Phase 8 可加。
6. **断线期间服务端 AI 代打**：玩家重连后 `rejoin_ok` + 快照恢复，被代打的回合不补玩（与 Phase 5/6 断线语义一致）。
7. **`pendingRequest` 可能过期**：结算展示期间若轮到本家而超时，服务器已 AI 代打，点「继续」后落地的旧 turn_request 会被服务器回 STALE_ACTION（客户端静默忽略，下份快照自愈）。可接受。
8. **SQLite 多 worker / WAL**：单 worker 下安全；多 worker 部署需 WAL + 写锁（Phase 6 遗留）。
9. **bundle 已超 500kB**：three.js 主导，vite build 有 chunk 警告（历史遗留，非本次引入）。

---

## 8. 下一步建议

### Phase 8 —— 联网打磨（依赖 Phase 7）

1. **服务端胡牌校验**：`RemotePlayer` 收到 `hu` 时用 `is_winning_hand` 校验当前手牌，防止假胡（§7 #3）。
2. **房间 pace 配置**：REST 创建房间时注入可配 `pace`（仅影响动画节奏，不影响逻辑），提升 AI 动作可读性（§7 #1）。
3. **中途退出 + 重进码限速**：对局中「退出房间」按钮；重进码 30s 内 5 次限速（Phase 6 §7 遗留 + 开发计划 §7 风险表）。
4. **联机 Lobby 增强**：场次选择、昵称查重、创建者离房后房主转移、房间关闭（`DELETE /api/rooms/{id}`）。
5. **战绩页**：前端加「历史战绩 / 个人统计」入口（`GET /api/matches/{id}`、`/api/players/{nickname}/stats` 已就绪）。
6. **测试补充**：`tests/test_reconnect.py`（断线 60s 托管 / 换浏览器重进码恢复 / 限速）；前端 mock WS 补齐重连用例。

### 手动联调流程（真人对真人）

```
1. 起后端  cd backend && .venv/Scripts/python -m uvicorn app.main:app
2. 起前端  npm run dev
3. Tab A：联机对战 → 昵称 → 创建房间 → 准备 → 开始对局
4. Tab B（无痕）：联机对战 → 昵称 → 输入 Tab A 的房间码 → 加入 → 准备
5. 双方看到同一桌况，各自回合可出牌/碰/杠/胡；打完出最终排名
```

---

## 9. 关键错误信息与复现

### 9.1 赢牌动画不推进（§6 #1）

**现象**：settled 快照后 `phase` 停在 `win-effect`，2.6s 后不翻牌。

**根因**：`startWinSequence` 先 `winSequenceSerial = winSequenceSerial + 1`，随后 `cancelWinSequence()` 又自增；定时器回调守卫 `winSequenceSerial !== serial` 恒真 → 全部提前返回。

**复现**：发送 settled 快照（带 winPresentation）→ `game.phase.value` 为 'win-effect' → `vi.advanceTimersByTimeAsync(5000)` 后仍 'win-effect'。

**修复**：`startWinSequence` 开头先 `cancelWinSequence()`，再取 `const serial = winSequenceSerial`。

### 9.2 creator 建房间后 WS 无消息（§6 #4）

**现象**：创建房间成功但收不到 `rejoin_ok`，`wsStatus` 停在 connecting。

**根因**：creator 未 `POST /join` 自己房间，`rejoinCode` 为空；`connect()` 守卫 `!rejoinCode.value` 直接 return，从未建 WS。

**修复**：`createRemoteRoom` 内创建后补 `joinRoom`，`enterRoom` 先存 `rejoinCode` 再 `connect()`。

---

# 10. 实测问题修复（2026-08-05 第二会话：真人对 AI 联机体验）

> 会话起点：上文 Phase 7 前端对接完成后，用户实测反馈 4 个问题。
> 目标：修复「人机出牌无延迟 / 胡牌无声音 / 结算未确认跳局 / 公告刷屏」。
> 当前进度：**已确认问题全部修复并验证**；部分深层根因未确认（§10.4）。

## 10.1 用户反馈与根因

| # | 用户描述 | 根因（已确认/待确认） |
|---|---|---|
| 1 | 人机出牌极快，无任何延迟 | ✅ REST 房间 `pace=0`（§决策 7 遗留），AI 动作瞬间完成 |
| 2 | 胡牌时没有声音 | 🟡 主路径（settled 快照）会播 zimo/hu.mp3；`hand_result` 兜底分支不播（已修）；用户侧是否还有未覆盖场景 → 待复测 |
| 3 | 第一局胡牌后立即跳下一局，无确认 | 🟡 协议顺序正确、结算卡有「继续」；体感来源疑似 = ① 下一局「开牌」公告在结算展示期间弹出（已修）② 系统「减少动画」时赢牌序列仅 780ms 一闪而过（未确认，§10.4.1） |
| 4 | 每出一张牌都提示「xx局 · 开牌」 | ✅ 服务端 `_announce` 后 `announcement` 永不清理，随每份快照重复携带；客户端旧逻辑同文案重复展示 |

## 10.2 已修复内容

### 问题 1 —— AI 节奏注入（pace）

- `backend/app/game/manager.py`：新增 `PLAY_PACE` 常量（对齐前端 `useGame.ts` 的 `PACE_MS`：450/550/650/600/650/450/350）
- `backend/app/game/room.py`：`RoomSession.__init__` 加 `pace: Optional[dict] = None`；`start()` 传透给 `GameManager`
- `backend/app/api/rooms.py`：`create_room` 注入 `pace=PLAY_PACE`（**仅 REST 创建的房间**；测试直接构造 RoomSession 保持默认 0）
- `backend/tests/test_api.py`：整场对局测试 start 前 `room.pace = {}` 提速
- **新增** `backend/tests/test_pace.py`（3 用例：REST 注入 / 默认 None / 注入后首局时长显著变慢）

**端到端验证**（临时实例 :8100 + Node WS）：整场 4 局从 ~0.4s → **88.9s**，回合间隔 450ms~2.1s（碰/杠叠加），与前端本地体验一致。

### 问题 4 —— 公告按服务端 id 去重

- 后端：`_announce` 传 `id` 给 `events.announce`；`WSEvents.announce` 广播带 `id`；`announcement_message()` 同步
- 前端 `useRemoteGame.ts`：`applySnapshotAnnouncement` 与 `handleAnnouncement` 均按 `announcement.id` 去重，同一公告只展示一次（1.5s 自动清除）；`resetAll()` 重置
- **新增** 2 个前端测试

> ⚠️ 非 bug：服务端 `_id_counter` 被 `last_discard.id` 与公告**共享**（每弃一张牌 +1），公告 id 会跳跃（如 [1, 27, 109, 150]）。单调递增即可保证去重正确。

### 问题 2/3 —— 结算期间的公告 + 兜底音效

- 前端 `handleAnnouncement`：**结算展示期间到达的公告消息直接忽略**——下一局「开牌」不再盖住赢牌动画/结算窗；点「继续」后随下一局快照自然展示一次
- 前端 `hand_result` 兜底分支（快照丢失边缘）：补 `playSound('zimo.mp3')`，与主路径对齐
- **新增** 3 个前端测试（结算期间公告 / 普通胡 zimo / 抢杠胡 hu / 兜底音效）

## 10.3 修改文件与测试结果

```
backend/app/game/manager.py       # PLAY_PACE + announce id 参数
backend/app/game/room.py          # WSEvents.announce 带 id + RoomSession.pace + start 传透
backend/app/api/rooms.py          # create_room 注入 pace=PLAY_PACE
backend/app/models/messages.py    # announcement_message 加 id
backend/tests/test_api.py         # 整场对局测试 room.pace = {} 提速
backend/tests/test_pace.py        # ★ 新增
src/game/useRemoteGame.ts         # 公告 id 去重 + 结算期间忽略公告 + 兜底音效
src/game/useRemoteGame.test.ts    # connectGame(options) + 5 个新用例
```

- 后端 pytest：**101 passed**（98 + 3 新）
- 前端 vitest：**96 passed**（91 + 5 新）
- `vue-tsc --noEmit`：无错误

## 10.4 未确认问题（留待复测）

### 10.4.1 「跳局」是否含减少动画因素
若系统开启「减少动画」（Windows/浏览器 prefers-reduced-motion），远程赢牌序列 = 420+360 = **780ms 一闪而过**。公告修复后若仍感"跳局"，优先怀疑此项。**待办**：确认用户系统设置；若体验差，给远程赢牌加最小时长（如 reveal 下限 1s）。

### 10.4.2 赢牌音效是否对齐本地双音效
本地胡牌播 `zimo/hu.mp3` + 320ms 后 `hu_effect_sound.mp3`；远程只播主音。主音两条路径都会播；效果音对齐与否 → 复测后决定。

### 10.4.3 浏览器 autoplay 策略
`playEffect` 对被拦截的播放静默失败。若只有胡牌无声而其他音效正常，则与此无关；若全部无声，检查自动播放。

## 10.5 生效方式与复测清单

1. **必须重启后端**（旧进程仍在跑旧代码）：
   ```
   cd backend && PYTHONIOENCODING=utf-8 .venv/Scripts/python -m uvicorn app.main:app
   ```
2. 前端 Vite 热更新自动生效。
3. 复测：AI 有节奏不瞬移 / 胡牌有音效 / 赢牌动画+结算卡、点「继续」才进下一局 / 「开牌」公告每局只出现一次。

## 10.6 环境备忘

- **vitest 需在非沙箱 shell 运行**：沙箱下全部用例报 "Vitest failed to find the runner"（tinypool worker 通信被阻断），`dangerouslyDisableSandbox` 后可正常。
- 临时验证脚本（verify-pace.mjs / repro-settle.mjs）已删除；如需复现用时序断言见 `backend/tests/test_pace.py`。
