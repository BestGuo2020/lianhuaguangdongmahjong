# 设计备忘：牌墙模型 / 骰子 / 动态癞子扩展

> 记录时间：2026-08-06
> 主题：牌墙在代码里怎么建模、骰子目前的作用，以及未来「骰子翻癞子」玩法要动的关键点。
> 状态：**预研讨论**，未开工。本文档回答「能不能加、改动在哪」——为将来铺路，不改变现状。

---

## 1. 现状梳理

### 1.1 牌墙模型（扁平列表）

```python
# backend/app/core/tiles.py
def create_wall() -> list[TileType]:
    return [tile for tile in TILE_TYPES for _ in range(4)]   # 34 种 × 4 = 136 张

# backend/app/game/manager.py
def _take_tile(self, from_tail: bool = False) -> Optional[TileType]:
    return self.wall.pop() if from_tail else self.wall.pop(0)
```

- 墙是一条**洗乱后的扁平列表**（136 张），有两个取牌端：
  - `pop(0)`（前端）→ 正常摸牌、发牌
  - `pop()`（尾端）→ 杠后补摸、红中花牌补摸
- 对应真实麻将：**正常摸前端（拆墙处）、杠/补花从尾端王牌取**——这条核心规则是吻合的。
- 被抽象掉的部分（不影响正确性）：
  - 无 2 层 × 17 墩的物理排列（纯视觉，3D 桌面画个样子）；
  - 无骰子决定拆墙点（牌是均匀洗乱的，拆墙在数学上等价）；
  - 无固定王牌数量（尾端即王牌，效果等价）；
  - 前端 `wallCount = len(wall)` 把尾端也算进去，真麻将的「活墙」不含王牌（观感上多算几张）。

### 1.2 骰子（当前纯装饰）

```python
# manager.py start_game
self.dice = [random.randint(1, 6), random.randint(1, 6)]
self.events.round_start(match_started, self.round, self.dealer, self.honba, self.dice)
```

- 骰子只在开局随机生成、随 `round_start` 广播给全场（保证 4 家看到的点数一致）；
- **不决定庄家**（庄家第一局固定 0，之后 `advance_match_state` 轮换）；
- **不决定发牌顺序/拆墙**（发牌顺序按 `[(dealer + offset) % 4]`）；
- 前端 `openingStage='dice'` 只用来播骰子动画 + 音效。
- 作用：还原真麻将的仪式感 + 服务端生成保证全场一致。

### 1.3 癞子规则（白板写死）

```python
# backend/app/core/rules.py
jokers = redFiltered.filter(... tile == 'white' ...)   # 白板固定为癞子
```

- 白板（white）是癞子的判定写死在 `is_winning_hand` / `can_make_melds` / `waiting_tiles`；
- 前端 `src/game/core/rules.ts` 同构硬编码，AI 决策也依赖。

---

## 2. 未来玩法目标：骰子翻癞子

> 某变体：开局掷骰子 → 决定翻牌墙哪个位置 → 翻开**顶层**那张牌 → 该牌（或下一张）成为本局癞子。

涉及两件事，难度差异很大：
1. **翻牌墙本身**（容易，改动局部）；
2. **动态癞子接入规则引擎**（关键，需要参数化重构）。

---

## 3. 实现方案：翻牌墙

### 方案 A（推荐，改动最小）：扁平列表 + 位置约定

```python
# 在 start_game 骰子生成处
dice_sum = self.dice[0] + self.dice[1]
pos = dice_sum % 剩余墩数
laizi_tile = self.wall.pop(pos * 2)     # 约定：偶数下标 = 顶层
# round_start / 快照携带 laiziTile，全场一致；翻出的牌亮在墙头，不再被摸走
```

- 不改变 `self.wall` 数据结构；
- 「顶层」通过**下标约定**表达（如偶数=顶层），够用。

### 方案 B（保真）：墙改成 2D

```python
wall = [[顶层, 底层], ...]   # 完全还原 2 层 × 17 墩的物理排列
```

- 支持更多牌墙类玩法（拆墙、海底等）更贴合；
- 改动大：`create_wall` / `_deal` / `_take_tile` / `draw_for` / 快照 `wallCount` 全要动。

**建议**：现在别动数据结构。真做这个玩法时先按方案 A；确有多玩法需求再上 B。

---

## 4. 关键重构：癞子规则参数化（真正的坎）

规则引擎现在把「白板=癞子」硬编码。动态癞子要求把癞子牌做成可配置：

```python
def is_winning_hand(tiles, exposed_meld_count=0, joker='white'):
    # joker 由开局决定传入，不再写死 'white'
```

改动面：
- 后端 `app/core/rules.py`（`is_winning_hand` / `can_make_melds` / `waiting_tiles` / `can_rob_kong`）；
- 前端 `src/game/core/rules.ts`（同构）；
- AI 决策（`ai.py` / `ai.ts`）；
- 相关测试扩展（每种癞子都要验证）。

**这是要预留的余量**：把「癞子规则」抽成配置，牌墙翻牌只是「癞子从哪来」的输入之一（也可以是固定白板 / 随机翻 / 骰子翻……）。

---

## 5. 建议与风险

| 项 | 建议 | 风险/说明 |
|---|---|---|
| 牌墙结构 | 保持扁平列表，真做玩法时用方案 A 的下标约定 | 方案 B 是一次性大改，非必需不上 |
| 骰子 | 保持装饰性，等真做动态癞子时再让骰子参与 | 目前无拆墙/定向需求 |
| 癞子规则 | **现在就值得把白板抽成 `joker` 参数**（安全的渐进重构） | 前后端 + AI + 测试同步；是动态癞子的前置 |
| 全场一致 | 翻出的癞子牌随 `round_start`/快照广播 | 参考骰子广播的先例 |

---

## 6. 决策记录

- [x] **骰子决定拆墙点（旋转版，不设王牌）已实现**（2026-08-06）：
  - 后端 `manager.py` 新增 `_break_wall_by_dice()`（`break_index = (dice_sum * 2) % len(wall)`，旋转列表），`start_game` 在骰子生成后调用；
  - 前端本地 `useGame.ts` 在骰子动画后、发牌前做同样旋转（本地/远程同规则）；
  - 未设王牌：整条墙仍被正常摸/杠补摸完；庄家方位偏移未做（牌已洗乱，不影响公平）。
- [ ] 「骰子翻癞子」未开工；若做，第一步先做 §4 的「癞子参数化」重构，再做 §3 的翻牌墙。
