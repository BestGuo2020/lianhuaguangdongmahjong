# 莲花广麻 · 联网后端开发 —— 交接文档（Phase 6）

> 本会话完成日期：2026-08-04
> 会话起点：`docs/claude-handoff-phase5.md`（Phase 5 交接）+ `docs/mahjong-backend-dev-plan.md` §3 Phase 6
> 目标：把 Phase 5 的内存态房间/WS 层接上 REST API 与 SQLite 持久化，交付完整的房间生命周期
> 当前进度：**Phase 6 全部完成**，M3 里程碑（实时联网 + 房间/战绩）达成

---

## 1. 任务目标与背景

Phase 5 交付了 WS 实时层，但房间生命周期由 WS 端点隐式管理（`maybe_start` 按真人到齐自动开局，`join_or_rejoin` 在 WS 握手中占座）。Phase 6 的目标（开发计划 §3 Phase 6 与 Phase 5 交接 §8）：

1. `app/api/rooms.py`：房间 CRUD（创建 / 查询 / join / leave / ready / start）
2. `app/api/matches.py`：战绩查询（单场详情 / 玩家统计）
3. `app/storage/db.py`：SQLite 持久化（rooms / matches / round_results / room_seats / players）
4. `tests/test_api.py`：房间生命周期 + 战绩落库集成测试
5. 容量支持：GameManager 2/3/4 人桌，RoomSession 去除写死的 4

**本会话交付**：以上 5 项全部完成。**最终 `95 passed`**（90 原有 + 5 新增 API；test_ws.py 适配新流程后仍 6 passed）。

---

## 2. 已完成工作概览

| 任务 | 内容 | 状态 |
|---|---|---|
| 房间生命周期 | `RoomSession` 重构：capacity 语义 + ready + 显式 start | ✅ |
| WS 认证 | `/ws/room/{id}` 改凭 rejoin_code 恢复座位（移除 nickname 占座 + maybe_start） | ✅ |
| SQLite 存储 | `app/storage/db.py`：5 张表 DDL + CRUD + 玩家统计聚合 | ✅ |
| REST 房间 | `app/api/rooms.py`：POST/GET rooms + join/leave/ready/start | ✅ |
| REST 战绩 | `app/api/matches.py`：matches 详情 / 房间历史 / 玩家统计 | ✅ |
| 落库钩子 | `RoomSession._drive` 开局/每局/终局分别写 matches/round_results/rooms | ✅ |
| 集成测试 | `tests/test_api.py` 5 用例 + `tests/test_ws.py` 适配新流程 | ✅ 11 passed |

---

## 3. 修改 / 新建的文件

```
backend/
├── app/
│   ├── main.py                 # 修改：include rooms/matches router + storage.init()
│   ├── api/
│   │   ├── rooms.py            # ★ 新建：房间 REST（6 路由）
│   │   └── matches.py          # ★ 新建：战绩 REST（3 路由）
│   ├── game/
│   │   └── room.py             # ★ 修改：capacity/ready/start/落库 + 模块级 room_registry
│   ├── storage/
│   │   └── db.py               # ★ 新建：SQLite 持久化层
│   └── ws/
│       └── game_ws.py          # 修改：rejoin_code 认证 + 移除 maybe_start
├── tests/
│   ├── conftest.py             # ★ 新建：共享 server / fresh_rooms fixture
│   ├── test_ws.py              # 修改：REST 驱动生命周期 + WS 只凭 rejoin_code
│   └── test_api.py             # ★ 新建：5 个 REST 集成测试
├── pyproject.toml              # dev 依赖加 httpx
└── data/mahjong.db             # 运行时生成（已 gitignore）
```

### 3.1 `app/game/room.py` —— RoomSession 重构（★ 核心）

- **`capacity` 语义修正**：`capacity` = 真人座位上限（2/3/4），**麻将桌固定 4 人**（`player_count = 4`），空位由 AI 补足。原实现 `player_count = capacity` 是 bug（见 §6 #1）。
- **`SeatState.ready`**：REST ready 切换准备态。
- **`join_or_rejoin(nickname)`**：REST join 占座 + 签发 rejoinCode；真人数量受 capacity 约束（超限 `ROOM_FULL`）。重进码分支委派给 `resume_by_code`。
- **`resume_by_code(rejoin_code)`**：WS 重连定位原座位；原会话在线 → `ALREADY_CONNECTED`。
- **`release_seat`**：REST leave（带 rejoinCode 身份校验），断开 controller + 清座位 + 落库删除。
- **`async def start()`**：所有已占（真人）座位 ready → 建 GameManager + `create_task(_drive())`。**必须 async**，让 game_task 创建在当前事件循环（uvicorn 循环），与 WS 处理器一致（见 §6 #2）。
- **落库钩子**：`_persist_match_start`（create_match + status=playing）/ `_persist_round`（round_results）/ `_persist_match_end`（finish_match + status=finished）。storage 为 None 时全部跳过（纯内存态，测试/单机兼容）。
- **模块级 `room_registry`**：REST/WS 共享的房间注册表。

### 3.2 `app/ws/game_ws.py` —— 仅 rejoin_code 认证

- query 只接受 `rejoin_code`（必填，缺失 → `REJOIN_CODE_REQUIRED`）
- `resume_by_code` 恢复座位 → rejoin_ok + state_snapshot
- 移除 `maybe_start` 调用 —— 开局由 REST `start` 显式触发

### 3.3 `app/storage/db.py` —— SQLite 持久化

- 5 张表（开发计划 §6.1 简化落地）：`players` / `rooms` / `matches` / `round_results` / `room_seats`
- `round_results` 用 `result_json` 单列存完整局结果（首版轻量，详查可随时拆列）
- 每次操作新建 sqlite3 连接（多连接安全）；REST 路由用同步 def（FastAPI 放线程池），`_drive` 内落库用 `asyncio.to_thread`
- 玩家统计 `get_player_stats`：room_seats.nickname → matches → round_results 聚合场次/局数/胡牌/净胜分
- ID 用 uuid4 hex（注释说明将来换 ULID）

### 3.4 `app/api/rooms.py` —— 房间 REST

| 路由 | 说明 |
|---|---|
| `POST /api/rooms` | 创建（mode/capacity），签发 6 位房间码（BASE32 去易混淆字符），落库 |
| `GET /api/rooms/{id}` | 房间详情 + 座位表（seat/nickname/ready/connected） |
| `POST /api/rooms/{id}/join` | 占座 → `{seat, rejoinCode, nickname}` |
| `POST /api/rooms/{id}/leave` | 释放座位（带 seat+rejoinCode 校验） |
| `POST /api/rooms/{id}/ready` | 切换准备态 |
| `POST /api/rooms/{id}/start` | **async**：所有已占座位 ready → 开局 |

错误响应统一 `HTTPException(detail={'code': ...})`。

### 3.5 `app/api/matches.py` —— 战绩 REST

| 路由 | 说明 |
|---|---|
| `GET /api/matches/{id}` | 单场详情（元数据 + finalScores + 各局 round_results） |
| `GET /api/rooms/{id}/matches` | 房间历史对局列表（概览） |
| `GET /api/players/{nickname}/stats` | 个人统计（场次/局数/胡牌/净胜分） |

---

## 4. 关键设计决策

1. **REST 接管生命周期，WS 只管实时游戏**：REST join 占座 + 签发 rejoinCode；WS 握手仅凭 rejoin_code 恢复座位。前端流程：`join → 连 WS → ready → start`。
2. **start 是 async 且必须绑定 uvicorn 事件循环**：REST `start` 路由用 `async def`，`await room.start()` 内 `create_task(_drive())` 因此创建在 uvicorn 循环，与 WS 处理器、ConnectionManager 队列、RemotePlayer future 同循环。**任何在别的循环调用 start 都会导致跨循环死锁**（见 §6 #2）。
3. **先连 WS 再 start**：start 后对局立即驱动；若客户端尚未连接，座位 `connected=False` → AI 代打整场，且广播时无出站队列、消息丢失。产品语义要求"玩家就绪后再开局"。
4. **capacity = 真人上限，麻将桌恒为 4 人**：空位 AI 补位。开发计划"2/3/4 人"指真人容量，对局始终 4 人桌。
5. **SQLite 首版轻量**：内置 sqlite3，`result_json` 单列；REST 同步 def + 线程池，异步钩子 to_thread，均不阻塞事件循环。
6. **测试走真实 uvicorn + httpx/websockets**：无 TestClient；`conftest.py` 提供共享 server fixture。

---

## 5. 已执行的命令与测试结果

### 5.1 测试

```bash
cd d:/vueprojects/lianhua_guangma/backend
PYTHONIOENCODING=utf-8 .venv/Scripts/python -m pytest -q
# 95 passed in ~4s（90 原有 + 5 新增 API；test_ws.py 6 个全部适配通过）
```

`tests/test_api.py` 5 用例：

| 用例 | 覆盖 |
|---|---|
| `test_create_and_get_room` | 创建（6 位码 / 4 空座）→ 查询 → 404 未知房间 |
| `test_join_leave_room` | join 返回 seat+rejoinCode → 座位表反映 → leave 释放 |
| `test_full_room_rejects_join` | capacity=2 占满后第三人 ROOM_FULL |
| `test_start_without_ready_rejected` | 未 ready → NOT_ALL_READY；ready 后 start 成功；重复 start → ALREADY_STARTED |
| `test_room_lifecycle_persists_match` | 完整生命周期 + 对局打完 + 战绩落库（matches/rounds/stats）可查询 |

`tests/test_ws.py` 6 用例（Phase 5 验收，适配新流程后全部通过）：

| 用例 | 覆盖 |
|---|---|
| `test_two_clients_complete_a_match` | 两真人完整打完东风场，座位互斥 {0,1}，分数守恒 4000 |
| `test_invalid_action_rejected` | 回合内错误动作 → INVALID_ACTION，pending 未消费 |
| `test_stale_action_rejected_before_game` | 未开局动作 → STALE_ACTION |
| `test_disconnect_takeover_and_rejoin` | 断线 AI 托管 → 对局打完；重进码恢复座位 + 快照；错误码被拒 |
| `test_turn_timeout_autoplay` | 客户端不响应 → 超时代打，第一局仍结算 |
| `test_rejoin_code_same_as_original_seat` | 重进码稳定身份：顶号被拒 / 释放后恢复原座位 |

### 5.2 手动验证

- `RoomRegistry` 独立脚本：capacity=1/2/3/4 全部 4 人桌、对局 finished（验证容量修复）。
- uvicorn + httpx 冒烟由 test_api 覆盖。

---

## 6. 失败尝试及原因（按时间顺序，均已在本次会话解决）

| # | 失败 | 原因 | 解决 |
|---|---|---|---|
| 1 | capacity=1 房间对局**死循环**（主循环被占，永不结束） | `RoomSession.player_count = capacity` 把座位数=玩家数；capacity=1 时只有 1 个玩家，`(player+1) % 1 = 0` 永远轮到自己 → 摸一出一死循环。capacity=2/3 时是 2/3 人麻将（非 4 人桌） | **麻将桌固定 4 人，capacity 只约束真人容量**，空位 AI 补足（`player_count = 4`，`join_or_rejoin` 检查真人 ≤ capacity） |
| 2 | 测试/直接调用 `room.start()` 后对局无响应、主循环卡死 | `start()` 在 pytest/调用线程（非 uvicorn 循环）里 `create_task(_drive())` → game_task 绑定错误循环；WS 处理器、ConnectionManager 队列、RemotePlayer future 都在 uvicorn 循环 → 跨循环队列/唤醒死锁 | `start()` 改 async；REST `start` 路由 `async def` → game_task 创建在 uvicorn 循环（与 WS 同循环）。**测试 start 必须走 HTTP REST** |
| 3 | 两客户端测试 40s 超时，只收到 rejoin_ok | make_ready_room 在**客户端连接前** start → 对局 AI 立即打完 4 局，广播 match_finished 时客户端无出站队列 → 消息丢失 | **先连 WS 再 start**（真实产品流程：join → 连 WS → ready → start），对局开始时客户端在线 |
| 4 | `test_api` 断言 `scoreChanges` 失败 | 落库格式是 `_map_round_result` 映射（`deltas`/`scores_after`），非原始 result 的 `scoreChanges` | 断言改为存储格式字段 |

---

## 7. 当前未解决的问题 / 备注

1. **start 后未等待真人全部连接**：当前 start 后对局立即驱动，晚连 WS 的玩家会错过前几个回合（由 AI 代打，之后接管）。产品上可接受（断线托管同语义），但如需"开局等待"，Phase 7/8 可在 `start()` 加「等所有已占座位 connected」的 gate。
2. **`ALREADY_CONNECTED` 可探测重进码有效性**：Phase 8 应加重进码限速（30s 内 5 次，开发计划 §7 风险表）。
3. **60s 断线等待语义简化**：仍为"断开即 AI 代打"，无产品层座位释放/等待重连提示（Phase 5 遗留）。
4. **SQLite 并发**：单 worker 下多连接安全；将来多 worker 需 WAL + 写锁协调。
5. **`recursionlimit` 隐患**：`sys.setrecursionlimit(10000)` 仍在 manager.py；AI 对局是同步 async 递归（一口气跑完），start 后 event loop 会被对局占住直到整场结束（首版 4 局 ~2s 可接受）。长局/大量房间时建议改显式事件循环。
6. **`GET /api/players/{nickname}/stats` 用昵称做路径参数**：昵称含特殊字符需 URL 编码；长期建议换 player_id（ULID，开发计划 §6.1）。
7. **数据文件 `backend/data/mahjong.db`**：import 时 `storage.init()` 自动建表，已加入 `.gitignore`。

---

## 8. 下一步建议

### Phase 7 —— 前端对接（依赖 Phase 6，可并行）

1. 新建 `src/game/remoteGameClient.ts`：WebSocket 连接 → state_snapshot 驱动 Vue 响应式状态 → 发送动作。REST join/ready/start 流程与后端协议已定型。
2. `App.vue` 按 `mode: 'local' | 'remote'` 选择 `useGame` 或 `useRemoteGame`。
3. 联调：真人对 AI、真人对真人（2 客户端）。**注意先连 WS 再 start 的时序**。

### 其他建议

- 补 `tests/test_reconnect.py`（开发计划 §5.1）：断线 60s 托管 / 换浏览器重进码恢复 / 重进码限速（需 Phase 8 限速先落地）。
- 战绩查询补充：按玩家查历史对局列表（当前仅房间维度 + 玩家聚合统计）。
- REST 补 `DELETE /api/rooms/{id}`（关闭房间）。

---

## 9. 关键错误信息与复现

### 9.1 capacity=1 对局死循环（§6 #1）

**现象**：capacity=1 房间 start 后主循环被占住，`asyncio.sleep` 都不返回。

**根因**：`player_count = capacity`，容量 1 时 `(player_index + 1) % 1 == 0`，弃牌后永远轮到自己，摸一出一，手牌恒 14、弃牌无限增长。

**复现**：`RoomRegistry().create('X', capacity=1)` → join 1 人 → ready → `await room.start()` → 观察 `mgr.players` 仅 1 人。

**修复**：`player_count` 固定 4，capacity 仅限真人。

### 9.2 跨事件循环死锁（§6 #2）

**现象**：测试里 `await room.start()` 后客户端连 WS 无响应。

**根因**：game_task 绑定 pytest 循环，WS 处理器在 uvicorn 循环；ConnectionManager 队列 / RemotePlayer future 绑定 uvicorn 循环，跨循环唤醒不生效。

**修复**：`start()` 改 async，REST 路由 async def 触发；测试用 `httpx` 调 `POST /api/rooms/{id}/start`。**教训：async 任务必须与它交互的 IO 资源同事件循环。**
