# 莲花广麻 · 联网后端开发 —— 交接文档（Phase 5）

> 本会话完成日期：2026-08-04
> 会话起点：`docs/claude-handoff-phase0-4.md`（Phase 0–4 交接）+ `docs/mahjong-backend-dev-plan.md` §3 Phase 5
> 目标：把 Phase 4 的 GameManager 状态机接上 WebSocket 实时层，实现多人联网对战
> 当前进度：**Phase 5 全部完成**，M3 里程碑（实时联网，前端对接前的后端核心）达成

---

## 1. 任务目标与背景

Phase 0–4 交付了完整的服务端游戏状态机（`GameManager` + `AIPlayer`，84 测试），全部为内存态、无网络层。Phase 5 的目标（来自开发计划 §3 Phase 5 与 Phase 0–4 交接 §8）：

1. WS 消息协议落地（`app/models/messages.py`）
2. 连接管理器（按房间分组广播，`app/ws/manager.py`）
3. `/ws/room/{room_id}` 端点（占座/重连/动作校验/断线处理）
4. `RemotePlayer` 接 WebSocket（挂起等待客户端动作）
5. `GameEvents` 由 `NullEvents` 换成真实广播
6. 回合超时自动代打（12s 倒计时）
7. `tests/test_ws.py`：真实 WS 客户端端到端测试

**本会话交付**：以上 7 项全部完成，新增 6 个端到端测试。**最终 `90 passed`**（84 原有 + 6 新增）。

---

## 2. 已完成工作概览

| 任务 | 内容 | 状态 |
|---|---|---|
| 消息协议 | `app/models/messages.py`：`ClientAction` 模型 + 各 kind 出站消息 builder | ✅ |
| 连接管理器 | `app/ws/manager.py`：`ConnectionManager`（seat → 出站队列 + 发送任务） | ✅ |
| RemotePlayer | `app/game/remote_player.py`：接 WS 通道 + 超时/断线 AI 代打 | ✅ |
| 房间会话 | `app/game/room.py`：`RoomSession` / `SeatState` / `WSEvents` / `build_snapshot` / `RoomRegistry` | ✅ |
| WS 端点 | `app/ws/game_ws.py`：`/ws/room/{room_id}` + 接入 `app/main.py` | ✅ |
| 真实广播 | `WSEvents` 实现 `show_table_action` / `show_score_flow` / `announce` → 房间广播 | ✅ |
| 超时代打 | `RemotePlayer` 内 `asyncio.wait_for(timeout)` → `AIPlayer` 决策；断线即时托管 | ✅ |
| 端到端测试 | `tests/test_ws.py`：6 用例（真实 uvicorn + websockets 客户端） | ✅ 6 passed |

---

## 3. 修改 / 新建的文件

```
backend/
├── app/
│   ├── main.py                 # 修改：include_router(ws_router)
│   ├── models/
│   │   └── messages.py         # ★ 新建：WS 消息协议（§4 草案落地）
│   ├── game/
│   │   ├── manager.py          # 修改：__init__ 增 player_seeds 参数
│   │   ├── player.py           # 修改：RemotePlayer 骨架 → 底部 re-export remote_player
│   │   ├── remote_player.py    # ★ 新建：真实 RemotePlayer
│   │   └── room.py             # ★ 新建：RoomSession / WSEvents / build_snapshot / Registry
│   └── ws/
│       ├── manager.py          # ★ 新建：ConnectionManager
│       └── game_ws.py          # ★ 新建：/ws/room/{room_id} 端点
└── tests/
    └── test_ws.py              # ★ 新建：6 个端到端测试
```

### 3.1 `app/models/messages.py`

- `ClientAction`（Pydantic）：`type: discard/claim/gang/hu/pass/ping` + 可选字段（`handIndex` / `action` / `kind` / `tile`）
- 出站消息 builder 函数（全部返回 dict，`kind` 为第一键）：
  - `turn_request(ctx)` / `claim_request(ctx)` / `rob_kong_request(ctx)` —— 用 `ctx.model_dump(by_alias=True)`（`from_` → `from`，与 WS 协议一致）
  - `table_action_message(event)` / `score_flow_message(deltas)` / `announcement_message(text, tone)`
  - `state_snapshot_message(**state)` / `hand_result_message(result)` / `match_finished_message(finalScores)`
  - `rejoin_ok_message(...)` / `rejoin_err_message(code)` / `error_message(code)`

### 3.2 `app/ws/manager.py` —— ConnectionManager（单房间）

每个在位座位一条**出站队列** + 一个**后台发送任务**（发送任务在 WS 处理器内跑，负责真正的 `send_json`）。广播 = `put_nowait` 入队到所有在位座位队列。这样慢/断客户端**不阻塞游戏主循环**（游戏循环只做 O(1) 入队）。

```python
class ConnectionManager:
    def register(seat, queue, sender_task) / unregister(seat)
    def broadcast(message: dict) -> None        # 同步 put_nowait，unbounded 队列不会失败
    async def send_to_seat(seat, message)       # await 入队；座位不在位则丢弃
    def is_connected(seat) -> bool
```

### 3.3 `app/game/remote_player.py` —— RemotePlayer（★ 核心）

`PlayerController` 协议的人类实现：

```python
class RemotePlayer:
    def __init__(self, seat, conn, timeout=12.0):   # conn 为 ConnectionManager
    def set_connected(connected) -> None            # 断开即把 pending 请求改为 AI 代打
    async def request_turn(ctx) -> dict             # 下发 turn_request → await 动作
    async def request_claim(ctx) -> dict
    async def request_rob_kong(ctx) -> str
    def handle_action(message) -> (ok, err)         # WS 层投递客户端动作
```

- **请求/响应**：`request_*` 用 `conn.send_to_seat` 下发请求消息，然后 `asyncio.wait_for(asyncio.get_event_loop().create_future(), self.timeout)` 挂起。
- **超时代打**：`wait_for` 超时 → `self._fallback()` 调 `AIPlayer` 的同名方法（复用 AI 决策，含「碰后无牌可打 → pass」修复）。
- **断线托管**：`set_connected(False)` → `_disconnect_pending()` 向 pending future `set_result(_DISCONNECTED)` 哨兵 → `_wait` 收到哨兵走 AI 代打（**不 cancel future**，避免 CancelledError 与游戏任务自身取消混淆）。
- **动作校验**：按 `_pending_kind`（turn/claim/rob_kong）白名单校验；`discard` 需 `handIndex`；`gang.added` 由 `_last_ctx.melds` 反查碰副露索引（客户端只发牌，服务端定位）；过期/非法动作返回 `STALE_ACTION` / `INVALID_ACTION`，且**不消费 pending**（非法动作后仍可补合法动作）。

### 3.4 `app/game/room.py` —— 房间会话（★ 组织者）

- **`SeatState`**：seat / nickname / rejoin_code（8 位 `XXXX-XXXX`）/ controller / connected_at
- **`WSEvents`**（GameEvents 真实实现）：`show_table_action` → `{'kind':'table_action','event':{id,type,actorIndex,sourceIndex,tile,meldIndex}}`；`show_score_flow` / `announce` 同理广播；`play_sound*` 为空（音效由客户端依据事件自行播放）。
- **`build_snapshot(room, seat)`**：全量 `state_snapshot`，对请求座位**隐藏其他玩家手牌**（`hand` 置为等长 None），防作弊；`by_alias=True` 序列化。
- **`RoomSession`**：
  - `join_or_rejoin(nickname, rejoin_code)` → `(seat, is_rejoin, state)`；重进码校验失败抛 `RoomError('INVALID_REJOIN_CODE')`；原座位仍在线 → `RoomError('ALREADY_CONNECTED')`（顶号拒绝）；无空座 → `RoomError('ROOM_FULL')`
  - `maybe_start()`：真人占座达 `human_capacity` → 建 `GameManager`（`player_seeds` 用座位昵称覆盖默认种子，AI 座位保留 `PLAYER_SEED`）→ `asyncio.create_task(self._drive())`
  - `_drive()`：整场驱动循环——`start_game` → 每局 `settled` 广播 `hand_result` → `next_round` → 终局广播 `match_finished`
  - `on_connect/on_disconnect`：设置 `RemotePlayer.connected`
  - `handle_client_message(seat, msg)` → 投递给该座位控制器；`ping` 忽略
  - `close()`：取消 game_task
- **`RoomRegistry`**：内存房间表（`create/get/remove/clear`），Phase 6 由 REST 层接管。

### 3.5 `app/ws/game_ws.py` —— `/ws/room/{room_id}` 端点

```python
@router.websocket('/ws/room/{room_id}')
async def game_ws(websocket, room_id):
    # 1. accept + query 参数（nickname 必填，rejoin_code 可选）
    # 2. room = rooms.get(room_id)；缺房间 / 缺昵称 / join 失败 → rejoin_err + close
    # 3. 建出站队列 + asyncio.create_task(_sender(queue, websocket))，conn.register(seat)
    # 4. on_connect(seat) → 发送 rejoin_ok（含 rejoinCode）+ state_snapshot
    # 5. room.maybe_start()
    # 6. receive 循环：handle_client_message → 不通过则回 {'kind':'error','code':...}
    # 7. 断线 finally：on_disconnect + unregister + sender.cancel()
```

`_sender` 后台任务从队列取消息 `send_json`，连接断开即静默结束。

### 3.6 `app/game/manager.py` / `player.py`（小改）

- `GameManager.__init__` 增 `player_seeds=None` 参数，存 `self.seeds`；`_reset_players` 改用 `enumerate(self.seeds)`。默认行为不变（`player_seeds or PLAYER_SEED`），原有 84 测试零改动通过。
- `player.py` 删除 RemotePlayer 骨架，文件底部 `try: from app.game.remote_player import RemotePlayer` 延迟导入并 re-export（避免与 remote_player 的上行 import 成环）。

---

## 4. 关键设计决策

1. **出站队列 + 后台发送任务**：广播/请求只入队，慢/断客户端不阻塞游戏主循环（游戏循环内同步 `put_nowait`，与 `GameEvents` 的同步接口无缝衔接）。
2. **RoomSession 拥有 game_task**：游戏驱动循环是独立任务，不依附于任何单个 WS 连接——某客户端断开不影响对局继续；房间关闭才取消。
3. **断线即时托管而非等 60s**：开发计划写「60s 后 AI 接管」，但若断线玩家轮到其回合，游戏不能等 60s。实现为**断开即 AI 代打**（功能等价），座位仍归 RemotePlayer 持有，重连即归还控制权。60s 仅作为产品文案/座位释放参考。
4. **`_DISCONNECTED` 哨兵而非 cancel**：断线时向 pending future `set_result(哨兵)`，`_wait` 收到哨兵走 AI 代打。避免 `future.cancel()` 抛 `CancelledError` 与「游戏任务自身被取消」难以区分的问题。
5. **`player_seeds` 参数**：联网房间的玩家名来自客户端昵称，`_reset_players` 用注入种子；默认回落到 `PLAYER_SEED`，单机/测试行为不变。
6. **测试用真实 uvicorn + websockets 客户端**：环境无 `httpx`（TestClient 不可用），且开发计划明确要求「用 websockets 库起真实客户端做端到端」。后台线程起 `uvicorn.Server(port=0)`，客户端走真实 TCP loopback。

---

## 5. 已执行的命令与测试结果

### 5.1 测试

```bash
cd d:/vueprojects/lianhua_guangma/backend
PYTHONIOENCODING=utf-8 .venv/Scripts/python -m pytest -q
# 90 passed in ~2s（84 原有 + 6 新增 WS）
```

`tests/test_ws.py` 6 用例：

| 用例 | 覆盖 |
|---|---|
| `test_two_clients_complete_a_match` | 两真人 + 两 AI 完整打完东风场；座位互斥 `{0,1}`；分数守恒 4000；`room.status=='finished'` |
| `test_invalid_action_rejected` | 回合窗口内发错误类型动作 → `INVALID_ACTION`；pending 未消费，补合法出牌对局继续 |
| `test_stale_action_rejected_before_game` | 游戏未开局（无 pending）动作 → `STALE_ACTION` |
| `test_disconnect_takeover_and_rejoin` | 断线 → AI 托管、对局打到 `finished`；正确重进码重连恢复原座位 + 快照（自己手牌完整、他人手牌隐藏）；错误码被拒 |
| `test_turn_timeout_autoplay` | 客户端全程不响应 → 每回合超时后 AI 代打，第一局仍正常结算 |
| `test_rejoin_code_same_as_original_seat` | 重进码稳定身份：原连接在线时顶号被拒 `ALREADY_CONNECTED`；释放后同码恢复原座位 |

### 5.2 手动验证（临时脚本，已清理）

- 冒烟脚本：两客户端连入 → 自动开局 → 东风场 6 局结算 → `room.status='finished'`、`match_finished=True`、分数和 4000。玩家名正确显示为客户端昵称（张三/李四）+ AI 默认名。

---

## 6. 失败尝试及原因（按时间顺序）

| # | 失败 | 原因 | 解决 |
|---|---|---|---|
| 1 | `AttributeError: module 'websockets' has no attribute 'asyncio'` | `websockets.asyncio` 子模块需显式 import 才加载 | 测试/脚本顶部加 `import websockets.asyncio.client` |
| 2 | URL 中文昵称乱码/异常 | 原始非 ASCII 字符进 URL query | `urllib.parse.quote(nickname)` |
| 3 | `'ClientConnection' object has no attribute 'closed'` | websockets 17 连接对象用 `.state`，无 `.closed` | 测试用幂等 `safe_close()`（try/except 包裹 close） |
| 4 | `assert room.manager.result is not None` 偶发失败 | `hand_result` 消息发出后 `_drive` 已 `next_round` → `start_game` 把 `manager.result` 重置为 None（**竞态**） | 改为断言**消息内容** `hr['result']['winner']`，不依赖 manager 上的瞬时状态 |
| 5 | `test_invalid_action_rejected` 卡 40s | **测试逻辑 bug**：发出合法出牌后，测试用 `read_until` 只读不回复，之后每轮到该座位都等满 5s 回合超时 | 新增 `play_until_hand` 辅助：持续回复 turn/claim 直到第一局 `hand_result`（修复后整组 6 用例 0.88s） |

---

## 7. 当前未解决的问题 / 备注

1. **60s 断线等待语义简化**：开发计划「断线等 60s → AI 接管」实现为「断开即 AI 代打」。功能上等价（对局不被卡死），但**没有产品层的座位释放/「等待重连」提示**。如需严格 60s 语义（如重连窗口倒计时广播），Phase 8 可在 WS 层补。
2. **`ALREADY_CONNECTED` 可探测重进码有效性**：对有效码但在线返回 `ALREADY_CONNECTED`、无效码返回 `INVALID_REJOIN_CODE`，可被爆破探明码有效性。当前 8 位随机码 + 低价值场景可接受；Phase 8 应加「30s 内最多 5 次」限速（开发计划 §7 风险表）。
3. **`player_count` 固定 4**：`GameManager._reset_players` 依 `self.seeds` 长度建玩家，`RoomSession` 写死 4 人桌。2/3 人桌需扩展 GameManager（Phase 6 处理房间容量时一并做）。
4. **`httpx` 仍未安装**：FastAPI `TestClient` 不可用，WS 测试走真实 uvicorn。Phase 6 API 测试（`tests/test_api.py`）需要装 `httpx` 或继续用真实服务。
5. **recursionlimit 隐患仍在**：`sys.setrecursionlimit(10000)` 还在 `manager.py`。Phase 5 用独立 game_task 驱动，未消除递归；长期建议改显式事件循环（while + 待处理队列）。
6. **游戏启动是「真人到齐自动开局」**：无显式 ready/start 按钮（开发计划 Phase 6 的 `POST /api/rooms/{id}/start` 落地后，改由 REST 触发 `maybe_start` 语义）。

---

## 8. 下一步建议

### Phase 6 —— REST API 与房间管理（依赖 Phase 5）

1. `app/api/rooms.py`：`POST /api/rooms`（mode / 人数 / 是否带 AI 补位）、`GET /api/rooms/{id}`（房间 + 座位 + 准备态）、`POST .../join / leave / ready / start`。**房间创建改为走 REST**（`RoomRegistry.create` 已就绪），`game_ws.py` 的 `maybe_start` 改成由 REST `start` 显式触发。
2. `app/api/matches.py`：战绩查询（单局明细 / 玩家统计）。
3. `app/storage/db.py`：SQLite 持久化（rooms / matches / round_results / replays / room_seats，DDL 已在开发计划 §6.1）。
4. `tests/test_api.py`：房间生命周期 + 战绩落库。需先装 `httpx`。
5. 容量支持：`GameManager` 支持 2/3/4 人（`_reset_players` 的 seeds 数量与座位对齐），`RoomSession` 去除写死的 4。

### 其他建议

- 前端对接（Phase 7）可并行：`useGame` 的 `HumanController` 形态与 `RemotePlayer` 对称，WS 消息协议已定型。
- Phase 8 补：重进码限速、断线 60s 提示、服务端崩溃不丢房间（目前内存态已满足「掉线恢复保留手牌」）。

---

## 9. 关键错误信息与复现

### 9.1 测试卡 40s（§6 #5）

**现象**：`test_invalid_action_rejected` 单用例 40s（其余用例 <1s）。

**根因**：合法出牌后测试用 `read_until` 只读不回复，后续每轮到该座位都触发 5s 回合超时（AI 代打）——**代码行为正确，是测试未持续代打**。

**修复**：新增 `play_until_hand`：持续 `turn→弃0 / claim→pass` 直到 `hand_result`。

### 9.2 `manager.result` 竞态（§6 #4）

**现象**：`assert room.manager.result is not None` 偶发失败。

**根因**：`_drive` 广播 `hand_result` 后立即 `next_round()` → `start_game` 把 `manager.result` 重置为 None。测试读 manager 时可能已到下一局。

**修复**：断言广播消息内容而非 manager 瞬时状态。**教训：跨异步边界不要断言中间状态对象的易变字段。**

---

## 10. WS 消息协议速查（已实现）

**客户端 → 服务端**（`type` 字段）：

```jsonc
{ "type": "discard", "handIndex": 3 }
{ "type": "claim",   "action": "peng" | "gang" | "pass" }
{ "type": "gang",    "kind": "added" | "concealed", "tile": "east" }
{ "type": "hu",      "kind": "self_draw" | "rob_kong" }
{ "type": "pass" }
{ "type": "ping" }
```

**服务端 → 客户端**（`kind` 字段）：

```jsonc
{ "kind": "turn_request",      "ctx": TurnContext(by_alias) }        // 定向
{ "kind": "claim_request",     "ctx": ClaimContext(by_alias) }       // 定向
{ "kind": "rob_kong_request",  "ctx": RobKongContext(by_alias) }     // 定向
{ "kind": "table_action",      "event": {...} }                      // 广播
{ "kind": "score_flow",        "deltas": [...] }                     // 广播
{ "kind": "announcement",      "text", "tone" }                      // 广播
{ "kind": "hand_result",       "result": {...} }                     // 广播（每局）
{ "kind": "match_finished",    "finalScores": [...], "roomId", "mode" }  // 广播
{ "kind": "state_snapshot",    ... }                                 // 定向（rejoin/开局）
{ "kind": "rejoin_ok",         "seat", "rejoin", "rejoinCode", ... } // 定向
{ "kind": "rejoin_err",        "code" }                              // 定向
{ "kind": "error",             "code" }                              // 定向
```

错误码：`INVALID_REJOIN_CODE` / `ALREADY_CONNECTED` / `ROOM_FULL` / `ROOM_NOT_FOUND` / `NICKNAME_REQUIRED` / `INVALID_ACTION` / `STALE_ACTION` / `NOT_HUMAN_SEAT` / `INTERNAL_ERROR`
