# 莲花广麻 · 联网后端开发计划（Python FastAPI）

> 本文档基于现有前端工程（Vue 3 + TypeScript + Vite + Three.js）的代码分析，
> 制定一个可执行的联网后端开发计划。后端采用 **Python 3.11+ / FastAPI**。
>
> **核心结论**：现有 `src/game/` 下约 85% 的游戏核心逻辑是**纯函数、无框架依赖**的，
> 可以直接 1:1 翻译为 Python 复用，无需重写规则。

---

## 0. 目标与范围

| 项目 | 说明 |
|---|---|
| **目标** | 将单机版「莲花广麻」升级为多人联网麻将，后端提供房间/匹配、游戏权威校验、战绩持久化 |
| **后端技术** | Python 3.11+ / FastAPI / Uvicorn / WebSocket / Pydantic v2 |
| **并发模型** | 每房间一个 `GameManager` 实例，房间内异步串行执行，`asyncio` 驱动 |
| **数据存储** | 首版用 SQLite（内置 `sqlite3` 或 SQLAlchemy），后续可平滑迁移 Postgres |
| **客户端改动** | 前端保留全部 UI/3D/音效/动画，仅把 `useGame` 的本地引擎替换为 WebSocket 客户端 |
| **不重写** | 规则引擎、AI 决策、牌面操作、分数结算 —— 全部从 TS 翻译 |

**玩法规则要点（翻译时必须保持一致）**：
- 广东麻将变体：红中（花牌）、白板（癞子，可代任意牌）、买马 8 张（中马 = 红中 + 159）
- 东风场 4 局 / 半庄场 8 局；庄家连庄 + 本场；闲家胡时庄家付双倍
- 杠上开花、抢杠胡、四红中（天胡式结束）等特殊结算

**产品决策（已确认，2026-08）**：
- **身份模型**：先轻量——「房间码 + 昵称 + 8 位重进码」恢复座位，零注册；数据模型按可升级方式设计，后续无痛切换账号体系（用户名/密码 + JWT，ULID 玩家 ID 为锚点）
- **断线策略**：短暂等待 60s 给重连机会 → 超时后该座位由 AIPlayer 接管 → 玩家重连后全量快照恢复并归还控制权

---

## 1. 现状盘点：可直接复用的资产清单

以下均来自现有代码，标注翻译难度与对应测试：

### 1.1 数据模型 —— `src/game/types.ts` → `app/models/game.py`

直接翻译为 Pydantic 模型，作为网络协议和内部状态的基础：

| TS 定义 | Python 对应 | 说明 |
|---|---|---|
| `TileType = SuitedTile \| HonorTile` | `Literal` 联合类型 | 34 种牌：m1-9/p1-9/s1-9 + 东南西北红中发财白板 |
| `Suit` / `Rank` | `Literal['m','p','s']` / `Literal[1..9]` | 花色与点数 |
| `HonorTile` | `Literal['east','south','west','north','red','green','white']` | 字牌 |
| `MatchType` | `Literal['east','hanchan']` | 场次类型 |
| `Meld` | `Meld(BaseModel)` | 副露：type(peng/gang/angang/flower)、tile、tiles、from、added、pending |
| `GamePlayer` | `GamePlayer(BaseModel)` | 玩家状态：name/avatar/score/seat/hand/discards/melds/redCount/drawnTileIndex |
| `TableActionType` | `Literal` | peng / discard-gang / concealed-gang / added-gang / flower-gang / self-draw / robbed-kong-win |
| `ScoreDelta` / `ScoreFlowEvent` | `ScoreDelta` / `ScoreFlowEvent` | 分数流水 |
| `WinPresentation` | `WinPresentation` | 和牌展示信息 |
| `EndGameOptions` | `EndGameOptions` | 和牌选项：winTile/fourRed/kongBloom/robbedKong |

### 1.2 牌系统 —— `src/game/tiles.ts` → `app/core/tiles.py`（★ 100% 复用）

纯函数，无任何框架依赖：

- `SUITS` / `HONORS` / `TILE_TYPES`：34 种牌定义
- `TILE_META`：牌名映射（"一万"、"东风"…）—— 后端做日志/推送文案时用
- `createWall()`：生成 **136 张**牌墙（每牌 × 4）
- `shuffle()`：Fisher-Yates 洗牌（保留 `random` 参数注入，便于测试确定性）
- `sortTiles()`：按牌序整理（后端发牌/亮牌前使用）
- `isHorse()`：中马判断（red + 万/筒/条的 1/5/9）
- `tileName()`：牌名（`tileFaceFile`/`tileOrder` 为前端 3D 专用，**不必翻译**）

### 1.3 规则引擎 —— `src/game/rules.ts` → `app/core/rules.py`（★★ 最高价值，100% 复用）

这是整个游戏的心脏，全部为纯函数，**已被充分测试**（`rules.test.ts`）：

| 函数 | 作用 | 对应测试用例 |
|---|---|---|
| `isWinningHand(tiles, exposedMeldCount)` | 胡牌判定（白板癞子可代任意牌，递归拆解顺/刻） | `rules.test.ts` 全部胡牌用例 |
| `canMakeMelds(counts, jokers, needed, memo)` | 记忆化递归副露拆解 | 内部函数，被上者调用 |
| `waitingTiles(tiles, exposedMeldCount)` | 听牌集合计算 | 「列出听牌时可胡的牌」等 |
| `scoreHand({dealer, noJoker, fourRed, kongBloom, horseHits, robbedKong})` | 番数：庄×2、无癞×2、四红×4、杠上开花×2、中马按张加底分 | 「倍数累乘后中马按张加算」 |
| `applyWinScore(players, winnerIndex, points, payerIndex, dealerIndex)` | 胡牌结算：闲家胡时庄家付双倍 | 「闲家胡牌时庄家支付双倍」 |
| `applyKongScore(players, kongPlayerIndex, type, fromIndex)` | 杠分：暗杠每家×2，明/加杠仅放杠者付 | 「暗杠由其余三家各支付底分两倍」等 |
| `concealedKongs(tiles)` | 暗杠检测（白板不能开暗杠） | 「白板作为癞子不能开暗杠」 |
| `canRobKong(tiles, kongTile, exposedMeldCount)` | 抢杠胡判定 | 「补杠牌可触发抢杠胡判定」 |
| `drawHorses(wall, amount=8)` | 从牌墙摸马（会 `splice` 消耗墙） | 「159 与红中均算中马」 |
| `matchingCount(tiles, tile)` | 同牌计数 | — |
| `BASE_SCORE = 100` | 底分常量 | — |

**Python 翻译要点**：
- `Map<TileType, number>` → `Counter[TileType]`
- 记忆化参数 `Map` → 用 `tuple(sorted(counts.items()))` 作为 `functools.lru_cache` 的键
- `canMakeMelds` 是纯递归，直接 1:1 移植，先移植再优化

### 1.4 AI 决策层 —— `src/game/ai.ts` → `app/core/ai.py`（★ 100% 复用）

纯函数、零副作用，可在服务端驱动 AI 玩家：

- `decideTurn(view)`：优先级 **自摸胡 → 补杠 → 暗杠 → 弃牌**
- `decideClaim(view)`：能杠必杠 → 能碰必碰 → 过
- `decideRobKong(view)`：能抢必抢（预留风险权衡扩展点）
- `chooseDiscardIndex(hand, random)`：孤张启发式弃牌，白板罚分保手
- `makeTurnView(player, exposedMelds, kongBloom)`：决策快照构造

对应测试：`ai.test.ts` 全部用例（含 `random` 注入的确定性测试）。

### 1.5 动作执行层 —— `src/game/actions.ts` → `app/core/actions.py`（90% 复用）

纯牌面操作可直接翻译；仅 `ActionContext` 的表现副作用需替换：

| 函数 | 作用 | 后端替代 |
|---|---|---|
| `removeMatches(hand, tile, amount)` | 移除手牌 | 直接复用 |
| `removeLastDiscard(discards, tile)` | 消除弃牌（碰/杠后） | 直接复用 |
| `performPeng(ctx, playerIndex, tile, from)` | 碰：移除弃牌 + 2 手牌 → 副露 | `ctx.showTableAction/playSound` → WebSocket 事件广播 |
| `performDiscardGang(ctx, playerIndex, tile, from)` | 点杠：移除弃牌 + 3 手牌 → 杠副露 + 杠分 | 同上 |

### 1.6 控制器抽象 —— `src/game/playerController.ts` → `app/game/player.py`（接口 + AI 复用）

`PlayerController` 接口是「人类 vs AI 解耦」的关键抽象，联网版直接继承这一思想：

```python
class PlayerController(Protocol):
    async def request_turn(self, ctx: TurnContext) -> TurnAction: ...
    async def request_claim(self, ctx: ClaimContext) -> ClaimAction: ...
    async def request_rob_kong(self, ctx: RobKongContext) -> RobKongAction: ...
    def on_discarded(self) -> None: ...
    def reset(self) -> None: ...
```

- `TurnContext` / `ClaimContext` / `RobKongContext` → Pydantic 模型（服务端→客户端的状态快照）
- `TurnAction` / `ClaimAction` / `RobKongAction` → 客户端→服务端的动作指令（网络协议）
- `AiController` → `AIPlayer`（复用 `core/ai.py`），`request_*` 里去掉延迟、直接决策
- `HumanController` → `RemotePlayer`：`request_turn` 变为「通过 WebSocket 下发请求并 await 用户响应」

### 1.7 编排层 —— `src/game/useGame.ts` → `app/game/manager.py`（状态机逻辑复用）

`useGame` 是唯一依赖 Vue 的模块，但其**游戏流转逻辑与 Vue 解耦**，可抽取为服务端状态机：

- `MATCH_HANDS` / `MATCH_NAMES`：东风场 4 局 / 半庄场 8 局
- `advanceMatchState()`：庄家连庄 + 本场累加 / 轮庄推进 → 终局判断（对应 `match.test.ts`）
- `resolveWinTile()`：解析胡牌关键牌
- 回合流转：`beginTurn → drawFor → requestTurn → executeAction → nextTurn`
- 摸牌规则：红中 → 亮花杠 → 牌墙尾补摸（递归 `drawFor`）
- 碰/杠流：`discard → offerClaims → requestClaim → executeClaim`
- 抢杠流：`requestAddedKong → findRobbers → offerRobKong(依次询问) → settle/endGame`
- 和牌结算：`endGame → finalizeWin → drawHorses + scoreHand + applyWinScore`

**需要替换的 Vue 依赖**（约占该文件 30%）：
- `ref()/reactive()/computed()` → 普通 Python 类属性
- `later()/setTimeout/setInterval` → `asyncio.create_task` + `asyncio.sleep`
- `playSound/playSoundAndWait` → WebSocket 事件广播（`TableActionEvent` / `ScoreFlowEvent`）
- 倒计时（`startCountdown`）→ `asyncio` 超时任务，超时自动代打/过
- `HumanBridge` → 删除，改为 `RemotePlayer` 通过 WebSocket 通道

---

## 2. 目标架构

```
客户端 (Vue 3, 保留 UI/3D/音效)         服务端 (FastAPI)
┌───────────────────────────┐        ┌──────────────────────────────────┐
│ 组件层 (App.vue, 3D 牌桌)  │        │  API 层                          │
│ 交互层 (手势/点击/倒计时)   │        │  ├─ POST /api/rooms              │ 创建/加入房间
│ 前端表现层 (音效/动画)      │        │  ├─ GET  /api/rooms/{id}          │ 房间信息
│                           │        │  └─ POST /api/rooms/{id}/ready     │ 准备
│ ┌───────────────┐         │        │  WS 层                            │
│ │ GameClient    │         │  WS   │  ├─ /ws/room/{id}                  │ 实时游戏消息
│ │ - 状态快照     │◄────────►│  JSON │  └─ /ws/match/{id}                │ 对战广播
│ │ - 动作发送     │         │        │                                     │
│ │ - 事件订阅     │         │        │  Game 层                          │
│ └───────────────┘         │        │  ├─ GameManager (房间状态机)       │
│  用 GameClient 替换        │        │  ├─ RemotePlayer (人类客户端)      │
│  useGame 本地引擎          │        │  └─ AIPlayer (复用 core/ai.py)     │
│                           │        │                                     │
│                           │        │  Core 层 (★ 全部从 TS 翻译复用)     │
│                           │        │  ├─ core/tiles.py   (牌墙/洗牌)     │
│                           │        │  ├─ core/rules.py   (胡牌/算分) ★   │
│                           │        │  ├─ core/ai.py      (AI 决策)       │
│                           │        │  └─ core/actions.py (牌面操作)      │
│                           │        │                                     │
│                           │        │  Storage 层                         │
│                           │        │  └─ SQLite: 房间/战绩/牌谱          │
└───────────────────────────┘        └──────────────────────────────────┘
```

**消息协议核心思想**：继承 `PlayerController` 抽象的「请求/响应」模式。
- 服务端向客户端发送：**状态快照 + 请求**（`turn_request` / `claim_request` / `rob_kong_request`）
- 客户端向服务端发送：**动作**（`discard` / `peng` / `gang` / `hu` / `pass` / `timeout`）
- 服务端向全房间广播：**事件**（`table_action` / `score_flow` / `announcement` / `hand_result`）

---

## 3. 开发阶段

> 每阶段均有明确的交付物与验收标准。建议按顺序执行，每阶段独立可测。

### Phase 0 —— 环境与骨架（0.5 天）

**任务**：
1. 初始化 `backend/` 目录，创建 `pyproject.toml` + venv
2. 安装依赖：`fastapi`、`uvicorn[standard]`、`pydantic>=2`、`pytest`、`pytest-asyncio`、`websockets`（客户端测试用）
3. 建立 `backend/tests/`，接入 pytest
4. 创建最小 FastAPI app + 健康检查 `/api/health`，能 `uvicorn app.main:app` 启动

**验收**：
- [ ] `uvicorn app.main:app` 启动，`GET /api/health` 返回 `{"status":"ok"}`
- [ ] `pytest` 可运行（空测试通过）
- [ ] `pyproject.toml` 锁定 Python >= 3.11

---

### Phase 1 —— 数据模型与牌系统（1 天）

**任务**：
1. `app/models/game.py`：按 §1.1 翻译全部类型（`TileType`、`Meld`、`GamePlayer`、`ScoreDelta`、`WinPresentation` 等），用 Pydantic 校验
2. `app/core/tiles.py`：按 §1.2 翻译 `createWall / shuffle / sortTiles / isHorse / TILE_TYPES / tileName`
3. 编写 `tests/test_tiles.py`：136 张牌墙、洗牌确定性（注入 random）、排序、中马判定

**验收**：
- [ ] `create_wall()` 返回 136 张，各牌恰好 4 张
- [ ] `shuffle(list, random=...)` 在注入随机源下可复现
- [ ] 牌名字典覆盖全部 34 种牌
- [ ] `pytest` 全绿

---

### Phase 2 —— 规则引擎（★ 核心，2 天）

**任务**：
1. `app/core/rules.py`：按 §1.3 翻译，**先 1:1 移植再优化**，尤其保证：
   - `is_winning_hand`：白板癞子可代任意牌；`exposed_meld_count` 减副露后按 `4 - 副露数` 组副露判断
   - `can_make_melds`：`tuple(sorted(counts.items()))` 做记忆化键
   - `score_hand`：底分 100，庄家/无癞子 ×2、四红 ×4、杠上开花 ×2，中马 `hits × 100` 加算
   - `apply_win_score` / `apply_kong_score`：庄家双倍、暗杠每家 ×2、明/加杠仅放杠者付
   - `waiting_tiles` / `can_rob_kong` / `draw_horses` / `concealed_kongs`
2. 编写 `tests/test_rules.py`：**逐条对照 `src/game/rules.test.ts`**（见 §5 测试对照表）

**验收**：
- [ ] 全部 `rules.test.ts` 用例在 Python 端有等价用例并通过
- [ ] 额外边界：白板作癞子不可开暗杠、0 副露/1 副露的胡牌判定、抢杠判定
- [ ] 可输出与 TS 端一致的 `multiplier / points / details` 计分明细

---

### Phase 3 —— AI 决策与动作执行（1.5 天）

**任务**：
1. `app/core/ai.py`：翻译 `decide_turn / decide_claim / decide_rob_kong / choose_discard_index / make_turn_view`
2. `app/core/actions.py`：翻译 `remove_matches / remove_last_discard / perform_peng / perform_discard_gang`
   - `ActionContext` 改为接口/协议：`show_table_action(type, actor, source, tile, meld_index)`、`show_score_flow(deltas)` —— 由 GameManager 注入，内部发 WebSocket 广播
3. 编写 `tests/test_ai.py`、`tests/test_actions.py`，对照 `ai.test.ts` / `actions.test.ts`

**验收**：
- [ ] AI 优先级链与 TS 一致（胡 → 补杠 → 暗杠 → 弃牌）
- [ ] `choose_discard_index` 注入 `random` 后确定性可测，孤张优先
- [ ] 碰/点杠操作后手牌、弃牌、副露、分数与 TS 语义一致

---

### Phase 4 —— 游戏状态机（★ 2 天）

**任务**：
1. `app/game/manager.py`：把 `useGame.ts` 的游戏流转翻译为 `GameManager` 类：
   - 状态：`lobby / dealing / opening / drawing / thinking / prompt / win-effect / revealing / settled / finished`
   - 核心流程方法（每条都带守卫，避免 await 期间状态变化）：
     - `start_game`：洗牌 → 掷骰 → 发牌（红中花牌补摸）→ 四红中判定 → `begin_turn`
     - `begin_turn`：摸牌（`draw_for`，红中递归补摸）→ `request_turn`
     - `execute_turn_action`：win / added-kong / concealed-kong / discard
     - `offer_claims`：弃牌后按座位顺序询问碰/杠（AI 用 `decide_claim`，人类走 WebSocket）
     - `request_added_kong` / `offer_rob_kong`：加杠后依次询问抢杠，抢到则 `end_game`
     - `end_game` / `finalize_win`：`draw_horses` + `score_hand` + `apply_win_score` + 场次推进
     - `end_draw`：流局，庄家连庄 / 本场累加
   - 超时处理：每回合 12 秒倒计时，超时自动代打（AI 决策）/ 自动过
2. `app/game/player.py`：`PlayerController` 协议 + `AIPlayer` + `RemotePlayer`
3. 编写 `tests/test_manager.py`：**对照 `useGame.test.ts` / `useGame.sim.test.ts`**，用纯 AI 对局做模拟跑通全流程（发牌→摸→出→碰/杠→胡→结算→下一局→场次结束）

**验收**：
- [ ] 4 个 `AIPlayer` 的完整对局（东风场 4 局）能自动跑完，无死锁/死循环
- [ ] 摸到红中正确亮花杠并补摸；暗杠/点杠/补杠分数正确
- [ ] 和牌后分数、中马、场次推进（庄连庄/轮庄）正确
- [ ] 流局处理正确
- [ ] 超时自动代打生效

---

### Phase 5 —— WebSocket 实时层（2 天）

**任务**：
1. `app/models/messages.py`：定义消息协议（§4 草案落地为 Pydantic 模型）
2. `app/ws/manager.py`：连接管理器（按房间分组，广播事件）
3. `app/ws/game_ws.py`：`/ws/room/{room_id}` 端点
   - 连接 → 鉴权（首版为重进码校验：房间码 + 昵称 + rejoinCode）→ 绑定座位
   - 处理 rejoin：校验重进码 → 断线座位归还 / 新绑定 → 发送全量 `state_snapshot`
   - 处理客户端动作消息：**先校验合法性再执行**（防止作弊：只能在自己的回合/提示窗口内执行）
   - 断线处理：检测连接断开 → 座位标记 disconnected → 60s 后 AIPlayer 接管 → 重连后归还
   - 把 `GameManager` 的表现副作用接到广播：
     - `show_table_action` / `show_score_flow` / `announcement` → 房间广播
     - `request_turn` / `request_claim` / `request_rob_kong` → 定向推送 + await 响应
4. `app/game/remote_player.py`：把 `RemotePlayer` 接到 WebSocket 通道（挂起 asyncio Future，等客户端动作）
5. 测试：`tests/test_ws.py`（用 `websockets` 库起真实客户端做端到端：两人连上可完成一局）

**验收**：
- [ ] 两个真实 WebSocket 客户端能连入同一房间并完成一局（其余座位 AI）
- [ ] 非法动作（非自己回合出牌、过期动作）被拒绝并返回错误码
- [ ] 断线处理：掉线 60s 后 AIPlayer 接管对局继续；同浏览器自动重连 / 换浏览器重进码 rejoin 均能恢复原座位与控制权
- [ ] 重进码错误 / 顶号尝试被拒绝并限速
- [ ] 服务端崩溃不丢房间状态（至少内存态，掉线恢复保留手牌）

---

### Phase 6 —— REST API 与房间管理（1 天）

**任务**：
1. `app/api/rooms.py`：房间 CRUD
   - `POST /api/rooms`：创建房间（人数 2/3/4、模式 east/hanchan、是否带 AI 补位）
   - `GET /api/rooms/{id}`：房间信息 + 座位 + 准备状态
   - `POST /api/rooms/{id}/join` / `leave` / `ready` / `start`
2. `app/api/matches.py`：战绩查询
   - `GET /api/matches/{id}`：单局明细（胡牌、分数、中马、牌谱）
   - `GET /api/players/{id}/stats`：个人胜率/场次统计（首版可简化）
3. `app/storage/`：SQLite 持久化（房间表、对局表、结算表、牌谱 JSON）
4. 测试：`tests/test_api.py`

**验收**：
- [ ] 房间生命周期完整：创建 → 加入 → 准备 → 开局 → 结算 → 战绩落库
- [ ] 对局结束后可查询历史战绩与牌谱
- [ ] 并发创建/加入房间无竞态（房间 ID 唯一，座位互斥）

---

### Phase 7 —— 前端对接（2-3 天，与 Phase 5 并行）

**任务**：
1. 新建 `src/game/remoteGameClient.ts`（或重构 `useGame` 为可插拔后端）：
   - 实现与 `useGame` 相同的对外 API 签名（`phase/players/wallCount/currentPlayer/result/...` + `userDiscard/userPeng/userGang/userHu/userPass/nextRound/...`），使 `App.vue` 改动最小
   - 内部：WebSocket 连接 → 服务端状态快照 → 驱动 Vue 响应式状态 → 发送动作
   - 复用 `HumanController` / `HumanBridge` 的形态，把 `activateTurn/activateClaim/activateRobKong/deactivate` 接到 WebSocket 消息
2. 保留本地模式：`useGame` 增加 `mode: 'local' | 'remote'`（或独立 `useRemoteGame`），本地单机可继续玩
3. 音效/动画/3D 全部保留，仅事件来源从本地引擎改为服务器推送
4. 联调：真人对 AI、真人对真人（2 客户端）

**验收**：
- [ ] 前端本地模式回归通过（现有测试不改坏）
- [ ] 远程模式下 UI 与本地模式一致：摸牌/出牌/碰杠/抢杠/胡牌动画、倒计时、分数流水
- [ ] 断线重连后 UI 状态与服务端一致（重新拉取快照）
- [ ] 输入防重：客户端在非自己回合时禁用操作按钮

---

### Phase 8 —— 打磨与部署（1 天）

**任务**：
1. 鉴权：重进码机制（房间码 + 昵称 + 8 位 rejoinCode，校验限速）；预留升级为账号体系（用户名/密码 + JWT，ULID 玩家 ID 为锚点），`room_seats.rejoin_code` 结构保持不变
2. 托管：断线玩家由 `AIPlayer` 托管，重连后归还
3. 反作弊加固：服务端权威校验每步动作；客户端仅发意图，不信任客户端计算
4. 性能：单个 Uvicorn worker 可承载的房间数基准（`GameManager` 为 CPU 轻量状态机，瓶颈在 WS 连接数）
5. （暂时跳过）Dockerfile + docker-compose（app + 可选 nginx）
6. 端到端冒烟：本地起后端，前端 `vite preview` 联调完整东风场

**验收**：
- [ ] （暂时跳过）Docker 一键启动
- [ ] 压测：模拟 N 个房间并发，单 worker 无崩溃、响应延迟在阈值内
- [ ] 断线托管/重连恢复全链路验证

---

## 4. WebSocket 消息协议草案

> 服务端权威，所有客户端动作为「意图」，由服务端校验后执行。

### 4.1 客户端 → 服务端（`client_action`）

```jsonc
// 出牌
{ "type": "discard",   "handIndex": 3 }
// 碰 / 杠 / 过（响应弃牌提示）
{ "type": "claim",     "action": "peng" | "gang" | "pass" }
// 杠（补杠 / 暗杠，响应回合提示）
{ "type": "gang",      "kind": "added" | "concealed", "tile": "east" }
// 胡（自摸 / 抢杠）
{ "type": "hu",        "kind": "self_draw" | "rob_kong" }
// 过 / 超时自动
{ "type": "pass" }
```

### 4.2 服务端 → 客户端（`server_message`）

```jsonc
// 回合请求（定向）
{ "kind": "turn_request", "ctx": { "hand": ["m1","m2","..."], "melds": [], "exposedMelds": 0, "kongBloom": false } }
// 碰/杠响应请求（定向）
{ "kind": "claim_request", "ctx": { "hand": [...], "canGang": false, "tile": "east", "from": 2 } }
// 抢杠响应请求（定向）
{ "kind": "rob_kong_request", "ctx": { "hand": [...], "exposedMelds": 1, "tile": "east", "from": 0 } }
// 全房间广播
{ "kind": "table_action", "event": { "type": "peng", "actorIndex": 1, "sourceIndex": 0, "tile": "east", "meldIndex": 0 } }
{ "kind": "score_flow",  "deltas": [{ "playerIndex": 1, "amount": 100 }] }
{ "kind": "announcement", "text": "碰", "tone": "gold" }
{ "kind": "state_snapshot", "players": [...], "wallCount": 40, "currentPlayer": 2, "round": 2, "dealer": 1, "honba": 0, "phase": "discard" }
{ "kind": "hand_result", "result": { "winnerIndex": 0, "winner": "北冥重生", "horses": [...], "hits": 2, "points": 600, ... } }
```

**消息类型与现有代码对应关系**：

| 消息 | 来源（TS） |
|---|---|
| `turn_request` | `PlayerController.requestTurn(ctx: TurnContext)` |
| `claim_request` | `PlayerController.requestClaim(ctx: ClaimContext)` |
| `rob_kong_request` | `PlayerController.requestRobKong(ctx: RobKongContext)` |
| `table_action` | `showTableAction()` 的 `TableActionEvent` |
| `score_flow` | `showScoreFlow()` 的 `ScoreFlowEvent` |
| `state_snapshot` | `useGame` 暴露的响应式状态 |
| `hand_result` | `finalizeWin()` 的 `result` |

### 4.3 重连 / 断线消息（对应产品决策：轻量重进码 + 短暂等待后 AI 托管）

**玩家侧持久化**（localStorage）：
- `{ roomId, nickname, rejoinCode, wsUrl }` —— 同浏览器重开标签页/断网后可自动重连
- 换浏览器：重新输入房间码 + 昵称 + 重进码

```jsonc
// 客户端 → 服务端：携带重进码建立/恢复会话（WS 握手 query 或首条消息携带）
{ "kind": "rejoin", "roomId": "A1B2", "nickname": "北冥重生", "rejoinCode": "K7Q3-M9XP" }

// 服务端 → 客户端：重连结果
{ "kind": "rejoin_ok",  "seat": 0, "snapshot": { ...完整 state_snapshot... } }
{ "kind": "rejoin_err", "code": "INVALID_REJOIN_CODE" }
```

**断线 → 托管 → 重连归还流程**：

```
玩家断线
  ├─ 服务端标记座位 disconnected，启动 60s 倒计时
  ├─ 60s 内重连（rejoin 校验通过）→ 撤销倒计时，发送全量快照，控制权归还真人
  └─ 60s 超时 → 该座位由 AIPlayer 托管（复用 core/ai.py），对局继续
       └─ 托管中玩家 rejoin → 立即终止 AI 接管，归还控制权，推送快照 +「你已回归」

说明：
- 托管中的 AI 动作也正常广播（table_action / score_flow），只是 actor 是原玩家座位
- 断线期间若该座位被托管胡/杠，结算照常计入其名下，重连后可见
- 重进码校验失败 / 频繁重试 → 服务端限速（如 30s 内最多 5 次），防爆破顶号
```

**升级路径**（预留）：
- `room_seats.rejoin_code` 字段保留在数据结构中；将来账号体系上线后，WS 握手改为「JWT 解析出 ULID 玩家 ID → 按座位映射」，重进码逻辑可整体下线

---

## 5. 测试策略

### 5.1 单元测试（对照现有 vitest 用例逐条移植）

| 后端测试文件 | 对照 TS 测试 | 覆盖内容 |
|---|---|---|
| `tests/test_tiles.py` | （无现成） | 牌墙 136 张、洗牌、排序、中马 |
| `tests/test_rules.py` | `src/game/rules.test.ts` | 胡牌/听牌/番数/杠分/胡分/抢杠/买马/暗杠 |
| `tests/test_ai.py` | `src/game/ai.test.ts` | AI 决策优先级、弃牌启发式、抢杠 |
| `tests/test_actions.py` | `src/game/actions.test.ts` | 碰/点杠/副露/分数流水 |
| `tests/test_match.py` | `src/game/match.test.ts` | 场次推进（连庄/轮庄/终局） |
| `tests/test_manager.py` | `src/game/useGame.sim.test.ts` | 全流程模拟对局 |
| `tests/test_ws.py` | `src/game/useGame.test.ts` | WebSocket 端到端 |
| `tests/test_reconnect.py` | （新） | 断线 → 60s 托管 → 重连归还、换浏览器重进码恢复、重进码限速/错误拒绝 |
| `tests/test_api.py` | （新） | 房间/战绩 API |

**关键原则**：
1. **每个 TS 用例 → 至少一个等价 Python 用例**，保证规则翻译零漂移
2. 所有随机逻辑（洗牌、AI 弃牌）注入 `random`，测试确定性
3. `is_winning_hand` 用测试驱动先移植，再扩展边界用例

### 5.2 模拟对局（烟雾测试）

```python
# tests/test_manager.py
async def test_full_east_match():
    """4 个 AIPlayer 自动跑完东风场 4 局，验证无死锁 + 分数守恒。"""
    manager = GameManager(mode="east")
    manager.controllers = [AIPlayer() for _ in range(4)]
    await manager.start_game()
    # 手动驱动事件循环直到 match_finished
    assert manager.match_finished is True
    # 分数守恒：总和不变（庄家付双倍等只转移不创造）
    assert sum(p.score for p in manager.players) == 4000
```

### 5.3 客户端回归

- 本地模式 `useGame` 现有 vitest 测试全部保持绿色（证明重构未破坏单机玩法）

---

## 6. 目录结构（目标）

```
backend/
├── pyproject.toml
├── app/
│   ├── __init__.py
│   ├── main.py                 # FastAPI app 装配 + 路由注册 + 启动钩子
│   ├── models/
│   │   ├── __init__.py
│   │   ├── game.py             # GamePlayer / Meld / TileType / ScoreDelta / ...
│   │   └── messages.py         # WS 消息协议（§4）
│   ├── core/
│   │   ├── __init__.py
│   │   ├── tiles.py            # ★ 从 tiles.ts 翻译
│   │   ├── rules.py            # ★★ 从 rules.ts 翻译（心脏）
│   │   ├── ai.py               # ★ 从 ai.ts 翻译
│   │   └── actions.py          # 从 actions.ts 翻译
│   ├── game/
│   │   ├── __init__.py
│   │   ├── manager.py          # ★ GameManager（从 useGame.ts 状态机翻译）
│   │   ├── player.py           # PlayerController / AIPlayer / RemotePlayer
│   │   └── room.py             # 房间管理（座位/准备/开局/托管）
│   ├── ws/
│   │   ├── __init__.py
│   │   ├── manager.py          # 连接分组与广播
│   │   └── game_ws.py          # /ws/room/{id} 端点
│   ├── api/
│   │   ├── __init__.py
│   │   ├── rooms.py            # 房间 REST
│   │   └── matches.py          # 战绩 REST
│   └── storage/
│       ├── __init__.py
│       └── db.py               # SQLite 持久化
└── tests/
    ├── __init__.py
    ├── test_tiles.py
    ├── test_rules.py           # 对照 rules.test.ts
    ├── test_ai.py              # 对照 ai.test.ts
    ├── test_actions.py         # 对照 actions.test.ts
    ├── test_match.py           # 对照 match.test.ts
    ├── test_manager.py         # 模拟对局
    ├── test_ws.py              # WebSocket 端到端
    ├── test_reconnect.py       # 断线托管/重连/重进码
    └── test_api.py             # REST API
```

### 6.1 存储表结构（DDL）

> 首版 SQLite；表结构按关系模型设计，将来迁 Postgres 仅改连接。

```sql
-- 玩家（长期身份；轻量阶段：昵称注册即创建一行，供战绩统计）
CREATE TABLE players (
  id          TEXT PRIMARY KEY,            -- ULID（时间有序 + 不可猜）
  nickname    TEXT NOT NULL,
  avatar      TEXT NOT NULL DEFAULT '',
  created_at  DATETIME NOT NULL DEFAULT (datetime('now')),
  updated_at  DATETIME NOT NULL DEFAULT (datetime('now'))
);
-- 业务唯一键：同名昵称唯一（首版可放宽/加后缀区分）
CREATE UNIQUE INDEX idx_players_nickname ON players(nickname);

-- 房间（进行中 + 最近历史）
CREATE TABLE rooms (
  id          TEXT PRIMARY KEY,            -- 6 位房间码（BASE32，可显示）
  mode        TEXT NOT NULL CHECK (mode IN ('east','hanchan')),
  capacity    INTEGER NOT NULL DEFAULT 4,  -- 2/3/4
  status      TEXT NOT NULL DEFAULT 'lobby', -- lobby/playing/finished
  created_at  DATETIME NOT NULL DEFAULT (datetime('now')),
  finished_at DATETIME
);

-- 对局（一场东风/半庄 = 一个 match）
CREATE TABLE matches (
  id           TEXT PRIMARY KEY,           -- ULID
  room_id      TEXT NOT NULL REFERENCES rooms(id),
  mode         TEXT NOT NULL,
  start_at     DATETIME NOT NULL,
  end_at       DATETIME,
  final_scores TEXT NOT NULL               -- JSON: [{playerId, name, seat, score, rank}]
);

-- 局结果（每局结算一行，来自 finalizeWin() 的 result）
CREATE TABLE round_results (
  id           TEXT PRIMARY KEY,
  match_id     TEXT NOT NULL REFERENCES matches(id),
  round        INTEGER NOT NULL,           -- 1..N 局号
  dealer       INTEGER NOT NULL,
  honba        INTEGER NOT NULL DEFAULT 0,
  winner_index INTEGER,                     -- NULL = 流局
  win_tile     TEXT,
  points       INTEGER,                     -- scoreHand().points
  multiplier   INTEGER,                     -- scoreHand().multiplier
  total_multiplier INTEGER,
  horse_hits   INTEGER NOT NULL DEFAULT 0,
  horses       TEXT NOT NULL,               -- JSON: 中马牌数组
  deltas       TEXT NOT NULL,               -- JSON: [{playerIndex, amount}]（ScoreDelta[]）
  scores_after TEXT NOT NULL,               -- JSON: 结算后各家分数
  opts         TEXT NOT NULL DEFAULT '{}'   -- EndGameOptions 序列化（robbedKong/fourRed/kongBloom）
);

-- 牌谱（可选，反作弊/回放）
CREATE TABLE replays (
  id         TEXT PRIMARY KEY,
  match_id   TEXT NOT NULL REFERENCES matches(id),
  wall       TEXT NOT NULL,                 -- JSON: 初始牌墙顺序（136 张）
  actions    TEXT NOT NULL,                 -- JSON: 完整动作序列 [{seat, type, tile, ts}]
  created_at DATETIME NOT NULL DEFAULT (datetime('now'))
);

-- 座位/重进码（房间进行中时维护；轻量身份的核心表）
CREATE TABLE room_seats (
  room_id         TEXT NOT NULL REFERENCES rooms(id),
  seat            INTEGER NOT NULL,        -- 0..3，对应 GamePlayer.seat
  player_id       TEXT NOT NULL REFERENCES players(id),
  nickname        TEXT NOT NULL,
  rejoin_code     TEXT NOT NULL,           -- 8 位随机，仅本人可见；校验失败限速
  disconnected_at DATETIME,                -- 断线时间，用于 60s 托管倒计时
  PRIMARY KEY (room_id, seat),
  UNIQUE (room_id, player_id)
);

-- 索引
CREATE INDEX idx_matches_room ON matches(room_id);
CREATE INDEX idx_round_results_match ON round_results(match_id);
CREATE INDEX idx_room_seats_player ON room_seats(player_id);
```

**ID 唯一性两层保证**：
1. **生成熵**：ULID 122-bit 随机（48 位毫秒时间戳 + 80 位随机），碰撞概率可忽略；玩家 ID 离线生成，无 DB 往返
2. **数据库约束**：`PRIMARY KEY` / `UNIQUE` 是唯一性唯一权威；生成逻辑只降低「撞约束」概率。若捕获到 `IntegrityError` → 重新生成 ID → 重试

**认证与 ID 分离**：
- 玩家 ID（`players.id`）= 公开身份锚点，仅作主键/战绩关联，**不可当认证凭据**
- 会话凭据 = `room_seats.rejoin_code`（房间内）+ 将来的 JWT（跨端）——两者都是「只有本人知道」的短期凭证，与 ID 解耦

---

## 7. 风险与依赖

| 风险 | 影响 | 缓解 |
|---|---|---|
| `canMakeMelds` 递归翻译错误 | 胡牌判定漂移 | 逐条对照 `rules.test.ts`，先移植后优化 |
| 状态机异步竞态 | 非法状态转换 | 每个 await 后加守卫（现有 TS 已有此模式，照搬） |
| 回合超时与断线 | 对局卡死 | 12s 超时 + 自动代打 + 断线托管 |
| 重进码被爆破顶号 | 他人接管座位 | 8 位随机码 + 校验限速（30s 内 5 次）+ 顶号后通知原会话 |
| 托管 AI 与真人决策冲突 | 真人回归后状态混乱 | 重连即归还控制权 + 全量快照重建 + 「你已回归」提示 |
| 掉线恢复时状态不同步 | 客户端与服务端不一致 | rejoin 时服务端发全量 `state_snapshot`，客户端以快照为唯一真源重建 |
| 客户端状态与服务端不一致 | 显示错乱 | 以 `state_snapshot` 为唯一真源，客户端不信任本地计算 |
| Python 3.11+ `Literal` 联合类型性能 | 细微 | 首版用 `Literal` 直译；热点处（如 `is_winning_hand`）内部用 `int` 或 `str` 编码 |
| 黑产赌狗利用房间对局赌博 | 涉赌合规风险 + 平台声誉 | 游戏内**无赌资流通载体**（不充值/不提现/无筹码，分数仅对局计分）；`player_id` 锚点 + 封禁/举报；ToS 明示禁止赌博；后续真注册实名（见 §10） |

**依赖**：Phase 4（状态机）依赖 Phase 2/3（核心层）；Phase 5（WS）依赖 Phase 4；Phase 7（前端）可并行于 Phase 5。

---

## 8. 里程碑总览

| 里程碑 | 阶段 | 交付物 | 预计工期 |
|---|---|---|---|
| M1 核心层就绪 | Phase 0-3 | tiles/rules/ai/actions + 全部单测 | 5 天 |
| M2 服务端可跑对局 | Phase 4 | GameManager + AIPlayer 完整对局 | 2 天 |
| M3 实时联网 | Phase 5-6 | WS + REST + 房间/战绩 | 3 天 |
| M4 前后端联调 | Phase 7 | 前端远程模式 + 真人对 AI/真人 | 2-3 天 |
| M5 上线 | Phase 8 | 鉴权/托管/部署 | 1 天 |

**总计约 13-14 个工作日**（单人多线程，可并行压缩）。

---

## 9. 前端对接的两种方案（供决策）

**方案 A：新增 `useRemoteGame`（推荐）**
- 保留 `useGame` 本地模式不动（单机玩法零回归风险）
- 新写一个与 `useGame` 同构 API 的 `useRemoteGame`，内部走 WebSocket
- `App.vue` 按 `mode` 选择调用哪个；改动集中在 1 个入口
- 优点：本地/远程可并存，现有测试不破坏
- 缺点：两套引擎部分逻辑重复（可抽取共享的 UI 状态计算，如 `standings/waits`）

**方案 B：重构 `useGame` 支持后端驱动**
- 把 `useGame` 改为「纯状态机 + 可插拔控制器」，本地用 `HumanController`，远程用 `RemotePlayer`
- 与后端 `PlayerController` 抽象完全对称，最干净
- 缺点：重构 `useGame` 有回归风险，需同步更新大量现有测试

> 建议先按**方案 A** 上线保底，再逐步向**方案 B** 演进，最终前后端共享同一套「控制器 + 状态机」心智模型。

---

## 10. 后续规划：账号身份与反赌博风控（实现清单 · 预排，未开工）

> 背景：① 对局中「刷新/关浏览器后可重进」需要持久凭证；② 黑产赌狗可能利用房间对局赌博。
> 结论：**注册挡不住专职赌狗**（线下结算拦不住），真正的杠杆是「游戏内无赌资流通」+「可封禁/可举报」；
> 注册只在以后为封禁追责与合规实名而上。`player_id` 从一开始就是锚点，将来升级不返工。

### P1（✅ 已完成）

1. ✅ **匿名 guest 身份 + 会话持久化**（解决「对局中可重进」，0 注册摩擦）
   - 前端：首访自动生成稳定 `guestId` 存 `localStorage`；进房后把 `{ roomId, rejoinCode, nickname, playerId }`
     持久化（`lgm_session`）；页面加载检测到未完成会话 → 大厅「继续对局」按钮，凭原 `rejoinCode`
     走 `resume_by_code` 归位（对局中 AI 托管座位可找回）；离开/关闭/`rejoin_err` 时清除会话。
   - 后端：`room_seats` 增加 `player_id` 字段（guest ID 即锚点，含旧库迁移）；join 接收并落库。
2. ✅ **bans 黑名单 + 举报**（封禁/举报）
   - 新表 `bans`（scope: player/room/device + target + 原因/操作者）与 `reports`；
   - join 与 WS 握手查禁（`join_or_rejoin` / `resume_by_code`），命中返回 `BANNED`；
   - 管理端点 `POST/DELETE /api/admin/bans/{...}`；举报端点 `POST /api/reports`（可按昵称反查 player_id）；
   - 前端：终局页每行「举报」入口（`window.prompt` 填原因）。
   - 注：首版无管理端鉴权（内部工具）；上真账号体系后再收紧。

### P2（以后）

3. **真注册（账号体系）**：手机号/账号登录 + 实名（涉合规时再上）。
   - `player_id` 已是锚点 → 老游客战绩/封禁状态无缝迁移，重进照常；
   - 对应 Phase 8 预留的「升级为账号体系，ULID 玩家 ID 为锚点」。
4. **行为风控**：短时大量建房/删房、同设备频繁换新号、聚众组织特征 → 先人工后规则。

### 设计铁律（非实现项，随时生效）

5. **游戏内无赌资流通载体**：分数仅对局计分，不买不卖不充值不提现不可转让；不做金豆/筹码等可交易虚拟货币；不做赌注显示或现金奖励排行榜。

---

*本文档基于 `src/game/` 源码分析编写，具体行号引用以 master 分支为准。*
