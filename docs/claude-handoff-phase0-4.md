# 莲花广麻 · 联网后端开发 —— 交接文档（Phase 0–4）

> 本会话完成日期：2026-08-04
> 会话起点：`docs/mahjong-backend-dev-plan.md`（开发计划）
> 目标：把现有单机麻将前端（Vue 3 + TS）的核心逻辑翻译为 Python FastAPI 后端，实现多人联网对战
> 当前进度：**Phase 0–4 全部完成**，M2 里程碑（服务端可独立跑完整对局）达成

---

## 1. 任务目标与背景

**项目**：「莲花广麻」—— 广东麻将变体（红中花牌、白板癞子、买马 8 张），现有前端为 Vue 3 + TypeScript + Three.js 单机版。

**任务**：将单机版升级为多人联网麻将，后端提供房间/匹配、游戏权威校验、战绩持久化。后端技术选型：Python 3.11+ / FastAPI / Uvicorn / WebSocket / Pydantic v2。

**核心结论**（来自开发计划文档 §0）：`src/game/` 下约 85% 的游戏核心逻辑是**纯函数、无框架依赖**，可直接 1:1 翻译为 Python 复用，无需重写规则。

**本会话交付**：完成 Phase 0（环境骨架）到 Phase 4（游戏状态机）的全部翻译与测试。翻译顺序遵循开发计划，逐个阶段：数据模型 → 牌系统 → 规则引擎 → AI 决策 → 动作执行 → 游戏状态机。

---

## 2. 已完成工作概览

| 阶段 | 内容 | 状态 |
|---|---|---|
| **Phase 0** | 后端目录结构、pyproject.toml、venv、FastAPI 骨架 + `/api/health` | ✅ |
| **Phase 1** | 数据模型（`models/game.py`）+ 牌系统（`core/tiles.py`） | ✅ 35 测试 |
| **Phase 2** | 规则引擎（`core/rules.py`，游戏心脏） | ✅ +22 = 57 测试 |
| **Phase 3** | AI 决策（`core/ai.py`）+ 动作执行（`core/actions.py`） | ✅ +18 = 75 测试 |
| **Phase 4** | 玩家控制器（`game/player.py`）+ 状态机（`game/manager.py`） | ✅ +9 = 84 测试 |

**最终测试结果**：`84 passed`，连续多次运行稳定（含随机对局模拟）。

**Python 环境**：Python 3.12.9（满足 >= 3.11 要求），venv 位于 `backend/.venv/`，使用系统 Python 创建（不是 conda）。

---

## 3. 修改 / 新建的文件（含具体内容）

### 3.1 目录结构

```
backend/
├── pyproject.toml          # 项目配置 + 依赖锁定 + pytest 配置
├── app/
│   ├── __init__.py
│   ├── main.py             # FastAPI app + /api/health
│   ├── models/__init__.py  # 空包
│   ├── models/game.py      # ★ 数据模型（Phase 1）
│   ├── core/__init__.py
│   ├── core/tiles.py       # ★ 牌系统（Phase 1）
│   ├── core/rules.py       # ★★ 规则引擎（Phase 2）
│   ├── core/ai.py          # ★ AI 决策（Phase 3）
│   ├── core/actions.py     # 动作执行（Phase 3）
│   ├── game/__init__.py
│   ├── game/player.py      # PlayerController / AIPlayer / RemotePlayer（Phase 4）
│   ├── game/manager.py     # ★ GameManager 状态机（Phase 4）
│   ├── ws/__init__.py      # 空包（Phase 5 填充）
│   ├── api/__init__.py     # 空包（Phase 6 填充）
│   └── storage/__init__.py # 空包（Phase 6 填充）
└── tests/__init__.py
    ├── test_tiles.py       # 35 用例
    ├── test_rules.py       # 22 用例
    ├── test_ai.py          # 12 用例
    ├── test_actions.py     # 6 用例
    ├── test_match.py       # 5 用例
    └── test_manager.py     # 4 用例
```

### 3.2 `backend/pyproject.toml`

```toml
[project]
name = "lianhua-guangma-backend"
version = "0.1.0"
description = "莲花广麻 · 联网麻将后端服务"
requires-python = ">=3.11"
dependencies = [
    "fastapi>=0.115.0",
    "uvicorn[standard]>=0.30.0",
    "pydantic>=2.0.0",
    "websockets>=13.0",
]

[project.optional-dependencies]
dev = [
    "pytest>=8.0",
    "pytest-asyncio>=0.24.0",
]

[tool.pytest.ini_options]
asyncio_mode = "auto"
testpaths = ["tests"]
```

**注意**：`asyncio_mode = "auto"` 使 `@pytest.mark.asyncio` 可用且 async 测试自动运行。当前**未安装 `httpx`**（`TestClient` 需要它），所以 FastAPI 的 HTTP 测试暂不可用（用 `curl` + uvicorn 手动验证过 health 端点）。

### 3.3 `app/main.py`

```python
from fastapi import FastAPI

app = FastAPI(title="莲花广麻 Backend", version="0.1.0")

@app.get("/api/health")
async def health_check():
    return {"status": "ok"}
```

### 3.4 `app/models/game.py`（从 `src/game/types.ts` 翻译）

- **牌类型**：`Suit = Literal['m','p','s']`、`SuitedTile`（27 张 m1-s9）、`HonorTile`（east/south/west/north/red/green/white）、`TileType`（34 种联合字面量）、`MatchType = Literal['east','hanchan']`
- **`Meld`**：`type`(peng/gang/angang/flower)、`tile`、`tiles`、`from_`（**别名 `from`**，`model_config={'populate_by_name': True}`）、`added`、`pending`
- **`GamePlayer`**：name/avatar/score/seat/hand/discards/melds/redCount/drawnTileIndex（**字段名保持 camelCase** 与 TS 一致）
- **`TableActionType`**、`TableActionEvent`、`ScoreDelta`、`ScoreFlowEvent`、`WinPresentation`、`EndGameOptions`

设计要点：camelCase 字段名用于 WS 消息协议兼容（§4 协议草案就是 camelCase）；`from` 因是 Python 关键字用 `from_` + alias。

### 3.5 `app/core/tiles.py`（从 `src/game/tiles.ts` 翻译，100% 复用）

关键函数：
- `SUITS` / `HONORS` / `TILE_META`（34+牌名映射，含 `back: '牌背'`）/ `TILE_TYPES`（34 种，序数牌在前字牌在后）
- `create_wall()` → 136 张（每牌 × 4）
- `shuffle(items, random=None)` → Fisher-Yates，**注入 random 可确定性测试**（默认用 `random.random`）
- `sort_tiles(tiles)` → 按 `_TILE_ORDER` 排序，返回新列表
- `tile_name(tile)` → 中文名
- `is_horse(tile)` → 红中 或 `[mps][159]`

### 3.6 `app/core/rules.py`（从 `src/game/rules.ts` 翻译，★★ 核心）

模块级常量与函数：
- `STANDARD_TILES`（34 - red - white = 32 种）、`WINNING_DRAW_TILES`（+white，不含 red）、`BASE_SCORE = 100`
- `apply_kong_score(players, kong_player_index, type_, from_index)` → 暗杠三家各付 200、明/补杠付 100，返回 `[{'playerIndex', 'amount'}, ...]`
- `apply_win_score(players, winner_index, points, payer_index, dealer_index)` → **闲家胡时庄家付双倍**，返回总得分
- `_counts_for` / `_first_remaining` / `_consume`（内部辅助）
- `_can_make_melds(counts, jokers, needed, memo)` → **记忆化递归**副露拆解。记忆化键：`f'{needed}|{jokers}|' + ''.join(counts字符串)`（与 TS 同构，非文档建议的 `tuple(sorted(...))`）
- `is_winning_hand(tiles, exposed_meld_count=0)` → 红中先过滤 → `4 - 副露数` 组副露 → jokers=白板数 → 将子三分支（2 白板/对子/单张+1 白板）
- `waiting_tiles` / `matching_count` / `concealed_kongs`（白板不可暗杠）/ `can_rob_kong`
- `meld_source_tile_index`（碰杠副露来源指向）
- `draw_horses(wall, amount=8)` → **原地 splice 墙**，返回 `{'horses', 'hits'}`
- `score_hand(...)` → 庄/无癞 ×2、四红 ×4、杠开 ×2、中马 `hits×100` 加算；返回 `{'multiplier', 'totalMultiplier', 'horsePoints', 'points', 'details'}`
- `_is_integer(x)` → 等价 JS `Number.isInteger`（含整数值 float）

### 3.7 `app/core/ai.py`（从 `src/game/ai.ts` 翻译）

- `decide_turn(view)` → 优先级：**自摸胡 → 补杠 → 暗杠 → 弃牌**
- `decide_claim(view)` → 能杠必杠，否则必碰（**从不返回 pass**，这是后续 bug 的根源，见 §7.4）
- `decide_rob_kong(_view)` → 永远 'win'
- `choose_discard_index(hand, random)` → 分数 = 同牌×4 + 相邻靠张×2 + 白板罚分10 + 随机抖动，**稳定排序取最小**（同分保持手牌顺序）
- `make_turn_view(player, exposed_melds, kong_bloom)`

### 3.8 `app/core/actions.py`（从 `src/game/actions.ts` 翻译）

- `ActionContext`（Protocol）：`players`、`current_player`（**带 .value 的可变 box**）、`show_table_action`、`show_score_flow`、`play_sound` —— 由 GameManager 注入
- `remove_matches(hand, tile, amount)` → 返回新列表
- `remove_last_discard(discards, tile)` → 末张匹配才 pop
- `perform_peng(ctx, player_index, tile, from_)` → 碰：移除弃牌 + 2 手牌 → peng 副露 → 轮到本家 → 广播
- `perform_discard_gang(ctx, player_index, tile, from_)` → 点杠：移除弃牌 + 3 手牌 → gang 副露 → 杠分 → 广播

### 3.9 `app/game/player.py`（从 `src/game/playerController.ts` 翻译）

- **`TurnContext` / `ClaimContext` / `RobKongContext`**（Pydantic，camelCase 字段，`from_` 别名 `from`）
- **`PlayerController`**（Protocol）：`request_turn` / `request_claim` / `request_rob_kong` / `on_discarded` / `reset`
- **`AIPlayer`**：延迟默认 `{'turn':0, 'after_kong':0, 'claim':0}`（可配置，测试加速用）；`request_claim` 里 peng 时**预计算碰后弃牌索引**（单次碰+出牌闭环）；**重要修复**：碰后无牌可打则返回 pass（见 §7.4）
- **`RemotePlayer`**：骨架，`request_*` 抛 `NotImplementedError`（Phase 5 接 WebSocket）

### 3.10 `app/game/manager.py`（从 `src/game/useGame.ts` 翻译，★ 最大最复杂文件，~720 行）

模块级：
- `MATCH_HANDS = {'east':4, 'hanchan':8}` / `MATCH_NAMES`
- `PLAYER_SEED`（北冥重生/南粤阿乐/西关十三姨/东山少爷，各 1000 分）
- `DEFAULT_PACE`（动画节奏，默认**全 0** 以加速模拟，可注入覆盖）
- **`GameEvents`**（Protocol）表现副作用接口 + **`NullEvents`**（空实现）
- `advance_match_state(*, round_, dealer, honba, match_type, result, scores=None, player_count=4)` → 纯函数，庄家连庄+本场 / 轮庄 / finished
- `resolve_win_tile(winner, options)` → 四红中 → red；否则 winTile → 刚摸的牌 → 手牌末张
- `structural_meld_count(player)` → 非 flower 副露数

**`GameManager` 类**（关键方法）：
- `current_player` 用 **property 读写共享 box** `self._cp_box`，与 actions.py 的 `ActionContext.current_player` 保持一致
- `_table_context`（SimpleNamespace）：`players` / `current_player`(box) / `show_table_action` / `show_score_flow` / `play_sound`，在 `__init__` 创建、`_reset_players` 时更新 `players` 引用
- `start_game(mode)` → 洗牌 → 发牌（3 轮 4 张 + 1 轮 1 张，`_receive_dealt_tile` 红中花杠补摸递归）→ 排序 → 四红中判定 → `begin_turn(dealer)`
- `draw_for(player_index, from_tail)` → 摸牌；红中 → flower-gang 广播 → 尾补摸递归；四红中 → `end_game`
- `begin_turn(player_index, skip_draw, from_tail)` → 摸牌 → `request_turn` → 守卫检查 → win/added-kong/concealed-kong/discard
- `discard_tile(player_index, hand_index)` → 弃牌 → `find_claims` → `offer_next_claim` / 下一家
- `find_claims`（白板/红中不可碰杠，按距离排序）/ `offer_next_claim`（按座位询问，AI 单次碰+出牌闭环）
- `perform_concealed_kong` / `declare_added_kong` / `settle_added_kong` / `find_robbers` / `request_added_kong` / `offer_rob_kong`（抢杠）
- `take_robbed_kong_tile` / `end_game`（**同步函数**，直接 `finalize_win`）/ `finalize_win` / `end_draw` / `make_round_result`
- `next_round()`（async，调 `start_game`）/ `return_to_lobby()`

**顶层 `sys.setrecursionlimit(10000)`**（见 §7.3）。

---

## 4. 关键设计决策

1. **纯函数 1:1 翻译**：core 层全部无框架依赖，翻译保持与 TS 逐行等价（包括非最优实现，如 `_can_make_melds` 记忆化键用字符串拼接而非 `tuple(sorted(...))`）。
2. **`ActionContext` 用 Protocol + SimpleNamespace box**：`current_player` 需要可变引用（JS 值类型无法引用传递），统一为 `.value` box。命名用 **snake_case**（`current_player`），与 Python 惯例一致。
3. **camelCase 字段保留**：`GamePlayer`/`TurnContext` 等网络协议相关字段保持 camelCase，兼容 §4 WS 消息协议草案；`from` → `from_` + alias。
4. **async 递归串联整局**：TS 用定时器调度，Python 用 `await begin_turn()` 递归串联（`begin_turn → discard_tile → begin_turn`），因此需要提高 recursionlimit。
5. **PACE 动画延迟默认 0**：后端无 UI，所有动画节奏延迟注入 `pace` dict（默认全 0），测试即时完成。
6. **GameEvents 接口注入**：表现副作用（`show_table_action`/`show_score_flow`/`announce`/`play_sound`/`play_sound_and_wait`）抽象为接口，Phase 5 由 WebSocket 层实现广播，当前用 `NullEvents`。
7. **`end_game` 是同步函数**：TS 用 `later()` 调度 finalize，Python 直接同步 `finalize_win`（无动画阶段，phase 直接 `settled`）。

---

## 5. 已执行的命令与测试结果

### 5.1 环境搭建

```bash
cd d:/vueprojects/lianhua_guangma/backend
python -m venv .venv
.venv/Scripts/pip install -e ".[dev]"
```

> 说明：安装依赖时最初几次被 Claude Code 的安全分类器（`deepseek-v4-pro[1M]` 暂不可用）阻止，后来用户手动完成了依赖安装。**最终依赖已装好**。

### 5.2 运行测试

```bash
cd d:/vueprojects/lianhua_guangma/backend && .venv/Scripts/python -m pytest -v
```

**各阶段测试数演进**：
- Phase 1（tiles）：35 passed
- Phase 2（+rules）：57 passed
- Phase 3（+ai/actions）：75 passed
- Phase 4（+match/manager）：**84 passed**（连续 3 次运行稳定）

### 5.3 手动验证

- **FastAPI health**：
  ```bash
  .venv/Scripts/python -m uvicorn app.main:app --port 8123 &
  curl -s http://127.0.0.1:8123/api/health   # → {"status":"ok"}
  ```
- **Pydantic 模型验证**（`Meld.from` 别名、非法牌值校验拒绝、GamePlayer 快照序列化）
- **模拟对局脚本**（临时，已清理）：
  - 东风场 4 局完整跑通，218 次 begin_turn，`match_finished=True`
  - 半庄场 8 局，`random.seed(5)` 曾复现停滞（见 §7.4），修复后 **30 次半庄场 0 停滞**

---

## 6. 失败尝试及原因（按时间顺序）

| # | 失败 | 原因 | 解决 |
|---|---|---|---|
| 1 | `test_tiles.py` 2 个断言失败 | **测试断言写错**：`random()=0.0` 时 Fisher-Yates 结果应为 `[1,2,...,9,0]` 而非逆序；中马牌应为 **10 种** 非 11 | 修正测试断言（实现与 TS 一致） |
| 2 | `test_actions.py` 4 个失败 | `actions.py` 用 `ctx.currentPlayer.value`（camelCase），但 Protocol/FakeContext 用 `current_player`（snake_case） | 统一 snake_case `current_player`；FakeContext 的 box 从 dict 改为 `SimpleNamespace(value=...)`（dict 无 `.value`） |
| 3 | `test_match.py` `advance_match_state` 缺 `scores` 参数 | TS 签名含可选 `scores?: number[]` | 补 `scores=None` 参数 |
| 4 | `GameManager` 构造 `AttributeError: no attribute 'players'` | `_table_context` 在 `self.players` 初始化**之前**引用它 | 把 `self.players = []` 移到 `_table_context` 之前 |
| 5 | 模拟对局 `RecursionError`（深度超 1000） | TS 定时器调度栈浅，Python `await` 递归串联整局，深度 O(动作数) 超默认限制 | 顶层 `sys.setrecursionlimit(10000)` |
| 6 | `finalize_win` `TypeError: int + str`（`horse_hits='hits'`） | `draw_horses` 返回 **dict** `{'horses','hits'}`，却按 TS 解构 `const {horses, hits}` 翻译成 `horses, hits = draw_horses(...)`，解出 dict 的 **key** | 改为 `horses_draw['horses']` / `horses_draw['hits']` |
| 7 | `offer_rob_kong` `TypeError: NoneType can't be used in 'await'` | `end_game` 是**同步函数**（返回 None），却 `return await self.end_game(...)` | 去掉 await（唯一一处，TS 用 later 调度） |
| 8 | `test_four_rounds_settled` 断言失败 | **测试断言设计问题**：庄家连庄时 `settled_rounds` 同局号记录多次（`[1,2,3,3,4]`） | 改为断言覆盖 `{1,2,3,4}` 且 `round >= 4` |
| 9 | `test_dealer_advances` 偶发失败 | **测试逻辑 bug**：`await next_round()` 后 `manager.result` 已是第 2 局结果，却与第 1 局的 dealer 比较 | 在 `next_round` 前记录 `first_result` |
| 10 | 半庄场偶发停滞（`phase: checking`，空转 20000 次） | **AI 无条件碰**：手牌恰只剩碰的 2 张时碰完手牌空，`discard_tile` 空手牌守卫 `return` → 停滞（TS 端同样存在此 bug，测试种子未触发） | **AIPlayer 碰后无牌可打则返回 pass**（真实麻将规则），30 次验证 0 停滞 |

---

## 7. 当前未解决的问题

1. **`RemotePlayer` 未实现**：`app/game/player.py` 中只有骨架，`request_*` 抛 `NotImplementedError`。Phase 5 需用 asyncio.Future 挂起等待 WebSocket 客户端动作。
2. **超时自动代打未实现**：开发计划 Phase 4 任务含"每回合 12 秒倒计时，超时自动代打/过"，本会话将其延后到 Phase 5（WS 层，因为 AIPlayer 无延迟即时决策不需要；人类 RemotePlayer 需要）。
3. **`httpx` 未安装**：FastAPI `TestClient` 不可用（`RuntimeError: The starlette.testclient module requires the httpx2 package`）。安装 `httpx` 或 `httpx2` 后可写 API 层测试。
4. **PACE 动画延迟全 0**：`DEFAULT_PACE` 全 0，对局即时完成。若要模拟真实节奏需注入真实毫秒值。
5. **TS 端 `decideClaim` 无条件碰的 bug 仍然存在**：`src/game/ai.ts` 的 `decideClaim` 不返回 pass，且 `chooseDiscardIndex` 空手牌返回 0，TS 端同样可能在碰后空手牌时停滞（sim 测试种子未触发）。后端已在 `AIPlayer` 层修复，但 TS 端未同步。
6. **`end_game` 同步跳过动画阶段**：`win-effect`/`revealing` 阶段后端直接推进到 `settled`，前端联调时需在 WS 层补回事件节奏。
7. **`advance_match_state` 的 draw 语义**：流局时**庄位轮转**（与 TS `dealerKeepsSeat = !draw && winner===dealer` 一致），但开发计划 §Phase4 任务描述写的是"流局，庄家连庄 / 本场累加"——两者不一致，需与产品确认广东麻将流局是否连庄。**当前实现以 TS 代码为准（流局轮庄）**。

---

## 8. 下一步建议

### Phase 5 —— WebSocket 实时层（最关键，依赖 Phase 4）

1. `app/models/messages.py`：把 §4 WS 消息协议草案落地为 Pydantic 模型（`client_action` / `server_message` 各 kind）
2. `app/ws/manager.py`：连接管理器（按房间分组广播）
3. `app/ws/game_ws.py`：`/ws/room/{room_id}` 端点（鉴权/rejoin/动作校验/断线处理）
4. `app/game/remote_player.py`：`RemotePlayer` 接 WebSocket（`asyncio.Queue` / `asyncio.Future` 挂起等待）
5. 把 `GameEvents` 的 `NullEvents` 替换为真实广播实现
6. 实现超时自动代打（12s 倒计时 asyncio 任务）
7. `tests/test_ws.py`：两个真实 WS 客户端连入同一房间完成一局

### 其他建议

- 安装 `httpx` 以便 TestClient 可用
- 确认流局庄位语义（见 §7.7），若产品要求流局连庄，需改 `advance_match_state` 并同步 TS 端
- 同步修复 TS 端 `decideClaim` 的无条件碰 bug（`src/game/ai.ts` + `ai.test.ts` 补用例）
- 清理 `sys.setrecursionlimit(10000)` 的隐患：长期看建议把整局递归改为显式事件循环（while + 待处理队列），彻底消除深度问题（Phase 5 重构 GameManager 驱动时一并考虑）

---

## 9. 重要错误信息与复现步骤

### 9.1 偶发对局停滞（§6 #10，最值得记录）

**错误现象**：半庄场（8 局）随机对局中，某局打到中途 `phase` 停在 `'checking'`，外部驱动循环空转（无 await 让出），`guard` 计数到 20000 后强制退出，`match_finished=False`。

**复现**：
```python
# 临时调试脚本（已清理，逻辑如下）
import asyncio, random
from app.game.manager import GameManager
from app.game.player import AIPlayer

async def main():
    random.seed(5)  # 曾复现的种子
    mgr = GameManager(mode='hanchan', controllers=[AIPlayer() for _ in range(4)], random=random.random)
    await mgr.start_game('hanchan')
    guard = 0
    while not mgr.match_finished and guard < 20000:
        guard += 1
        if mgr.phase == 'settled':
            await mgr.next_round()
    assert mgr.match_finished  # 失败：phase='checking'

asyncio.run(main())
```

**根因**：`offer_next_claim` 询问 seat2 碰 `p2`，seat2 手牌只剩 2 张（都是 `p2`）。AI `decide_claim` 无条件返回 peng（`canGang=False → 'peng'`），`perform_peng` 移除 2 张后手牌为**空**。随后 `discard_tile(2, 0)` 的空手牌守卫 `if not player.hand: return` 直接返回，phase 停留在 `checking`，游戏停滞。

**修复**：`app/game/player.py` 的 `AIPlayer.request_claim` 中：
```python
if decision == 'peng':
    after_peng = remove_matches(list(ctx.hand), ctx.tile, 2)
    if not after_peng:
        return {'kind': 'pass'}  # 碰后无牌可打 → 放弃碰
    discard_index = choose_discard_index(after_peng, self._random)
    return {'kind': 'peng', 'discardIndex': discard_index}
```
修复后 **30 次半庄场 0 停滞**。

**注意**：TS 端 `src/game/ai.ts` 的 `decideClaim` / `chooseDiscardIndex` 存在同样问题（空手牌返回 0），未同步修复。

### 9.2 async 递归深度（§6 #5）

**错误现象**：模拟对局跑 1 局左右出现 `RecursionError`（Python 默认 recursionlimit 1000），堆栈反复 `begin_turn → discard_tile → begin_turn`。

**根因**：TS 端用 `later(() => beginTurn(...))` 定时器调度，调用栈恒定浅；后端 `return await self.begin_turn(...)` 是真正的 async 递归，深度 = 每局动作数 × 每动作帧数（数千层）。

**修复**：`app/game/manager.py` 顶部：
```python
import sys
sys.setrecursionlimit(10000)  # 容纳整场对局的 async 递归调用链
```

**遗留风险**：recursionlimit 是 hack。长期应改为显式事件循环（while + pending 队列）消除深度问题。

### 9.3 `draw_horses` 解包 bug（§6 #6）

```python
# 错误：dict 解包成 key
horses, hits = draw_horses(self.wall, 8)   # horses='horses', hits='hits'

# 正确
horses_draw = draw_horses(self.wall, 8)
horses = horses_draw['horses']
hits = horses_draw['hits']
```

### 9.4 `TestClient` 不可用

```python
from fastapi.testclient import TestClient
# RuntimeError: The starlette.testclient module requires the httpx2 package to be installed.
# 解决：pip install httpx2（或 httpx）
```

### 9.5 Windows 终端中文乱码

pytest 输出的中文注释在 Windows 控制台显示为乱码（GBK vs UTF-8 编码问题），**不影响功能**（pytest 内的中文断言都正确通过）。若需正常显示：`set PYTHONIOENCODING=utf-8` 或改用 IDE 终端。

---

## 10. 参照源码映射

| 后端 | 前端（TS） | 说明 |
|---|---|---|
| `models/game.py` | `src/game/types.ts` | 类型定义 |
| `core/tiles.py` | `src/game/tiles.ts` | 牌系统（`tileFaceFile`/`tileOrder` 前端 3D 专用不翻译） |
| `core/rules.py` | `src/game/rules.ts` | 规则引擎 |
| `core/ai.py` | `src/game/ai.ts` | AI 决策 |
| `core/actions.py` | `src/game/actions.ts` | 动作执行 |
| `game/player.py` | `src/game/playerController.ts` | 控制器抽象（AiController → AIPlayer） |
| `game/manager.py` | `src/game/useGame.ts` | 状态机（Vue 依赖已剥离） |
| `tests/test_tiles.py` | — | 新增 |
| `tests/test_rules.py` | `src/game/rules.test.ts` | 逐条对照 |
| `tests/test_ai.py` | `src/game/ai.test.ts` | 逐条对照 |
| `tests/test_actions.py` | `src/game/actions.test.ts` | 逐条对照 |
| `tests/test_match.py` | `src/game/match.test.ts` | 逐条对照 |
| `tests/test_manager.py` | `src/game/useGame.sim.test.ts` | 整局模拟对照 |
