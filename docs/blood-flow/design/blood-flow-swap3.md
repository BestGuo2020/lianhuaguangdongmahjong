# 莲花麻将·血流·换三张（`lotus-blood-flow-swap3`）规则契约与实现设计

> 状态：**契约已定稿，尚未实现**（2026-09-21 由用户逐条确认）。本文件是实现的唯一口径依据；
> 实现进度只见 [tasks.md](../tasks.md)，测试证据只见 [acceptance.md](../acceptance.md)。
>
> 与现行玩法的关系：本玩法是**新增 ruleset**（`lotus-blood-flow-swap3` / `lotus-blood-flow-swap3-v1`），
> **不修改** `lotus-blood-flow-v1` 的任何口径。[rules.md](../rules.md) 第 32 行「附加规则：不加
> ……定缺、换三张……」是**对现行 `lotus-blood-flow` 的约定，继续成立**；本玩法属于新玩法的规则边界，
> 不构成对现行规则的追加，也不改变现有房间、录像、分析记录的行为。
>
> 收敛记录：初始需求为「任意花色最多 13 张与系统换牌」。经评审收敛为「同门 3 张、与玩家换、
> 强制参与、方向由骰点决定」。收敛理由：① 与系统换需要定义"按玩家意图发牌"，破坏公平性与
> P2P 房主权威下的可验证性；② 定向发牌还要新增一条权威 RNG 流，回放复现与跨语言对拍全部要重做；
> ③ 3 张同门是本玩法里唯一能同时提供**手牌微调**与**可读方向信号**的档位（四川口径）。

## 1. 玩法身份

| 项 | 值 |
|---|---|
| rulesetId | `lotus-blood-flow-swap3` |
| ruleVersion | `lotus-blood-flow-swap3-v1` |
| 显示名 | 莲花麻将·血流·换三张 |
| 底层引擎 | 与 `lotus-blood-flow` **同一份**血流引擎，用配置开关区分（不复制引擎） |
| 计分 / 番种 / 封顶 / 底分 / 局数 | 与 `lotus-blood-flow-v1` 完全一致，本玩法不改任何一条 |
| 可用面 | 单机、WS、P2P 三面同放行（与现行血流一致） |
| 老客户端行为 | 新 ruleVersion → 由现成的 `INCOMPATIBLE_RULE_VERSION`（`blood_flow_error`）在 `hello` 阶段干净拒收，不进房、不黑屏 |

## 2. 规则契约

### 2.1 主流程

```
deal()（发牌 53 张 + 翻精：jokers/flipTiles 已定）
  → openSwap3()   四家同时决策（本阶段牌墙不动）
  → resolveSwap3() 收齐 4 家后一次性环形置换
  → openTurn()    庄家（第 14 张仍在手、drawnTileIndex 仍指向它）
```

### 2.2 条目

| # | 规则 | 口径 |
|---|---|---|
| **R1 时机** | 每小局一次：发牌 + 翻精之后、庄家第一次出牌之前。四家**同时**决策，互不可见 | 刚好接在现有开局之后，不新增阶段时序 |
| **R2 参与** | **强制参与**：每家恰好交出 3 张，没有「不换」 | 机制强度靠强制，不靠加张数 |
| **R3 合法性** | 交出的 3 张必须**同属一门**。门 = 万 / 筒 / 条 / 字（字牌整体为第 4 门）；**门内不要求同牌**（东·南·西 合法，2026-09-21 用户确认） | 门内混不同字牌是刻意保留：否则字牌门几乎不可用 |
| **R4 方向** | 四家**同一方向**：`dir = (secondDice[0] + secondDice[1]) % 3`；`0` 交下家 `(seat+1)%4`、`1` 交上家 `(seat+3)%4`、`2` 交对家 `(seat+2)%4` | 用第二次掷骰而非第一次，是为了与翻精方位（由 `firstDice` 决定）**解耦**。零新增随机源；三端都能从已有骰点推出 |
| **R5 结算** | 收齐 4 家后一次性**环形置换**（对家方向为 `A↔C`、`B↔D`）。**先全部收进缓冲，再统一发放** | 禁止边收边发，否则会读到已更新的手牌 |
| **R6 信息** | 公开：方向、本阶段已结算。**牌面不公开**：给方与收方互知这 3 张，**第三方不知** | 与四川一致；因同门约束，收方会知道给方「放弃了哪一门」，这是有意保留的信息维度 |
| **R7 手牌重整** | 置换后 `sortTilesWithJokers` 重排；**庄家第 14 张（`drawnTileIndex`）不参与交换**，换后仍在最右并保持 `drawnTileIndex`；`drawSource` 不重置 | 保住天胡判定与「摸牌来源」语义；四家口径一致（都在 13 张里换 3 张） |
| **R8 天地胡** | **保留**（现行口径不变） | 上一版「取消天地胡」的建议随机制变更**撤销**：其动机是抑制「换 13 张搏天胡」的赌法，强制 + 3 张 + 暗换之后该动机不存在 |
| **R9 超时 / 托管** | 强制参与下超时不能是「过」，必须是**确定性兜底选牌**（算法见 §2.5）。**不走 AI 策略** | 后端 AI 是「翻译版」策略（`_bot_policy` 注释明示弃牌排序口径不同），用它当兜底会把跨语言不一致引进来；兜底必须逐位可复现以参与对拍 |
| **R10 读秒** | 单机无读秒；联机默认 12s（`remoteDecisionMs`），可用 `swap3.decisionMs` 单独配置（建议 15s） | P2P 的 `pause()`/`resume()` 平移 `deadlineAt`，读秒从开局动画结束后算起 |
| **R11 精牌 / 白板** | 规则允许换出；**门归属按牌面**（翻出 5 万为精 → 它属万门）；AI 默认不换精牌 | 与现有「精牌保护」口径一致；精牌在 `deal()` 后即已知，AI 可据此保护 |
| **R12 交互边界** | 与锁手、多响、续胡、结算、排名**无交互**（发生在任何胡牌之前） | 本阶段不产生流水、不记 ledger、不改分数 |

### 2.3 可解性：不存在「凑不出 3 张同门」

> **引理**：13 张手牌分入 4 门，由鸽巢原理必有某门 ≥ ⌈13/4⌉ = **4 张** ≥ 3 张。
> 庄家 14 张同理（且排除第 14 张后仍有 13 张可选：13 张的极端分布为 4/3/3/3，
> 若被排除的摸牌张恰属那 4 张的一门，该门仍余 3 张）。

**因此引擎、协议、UI、AI、LLM 全部不需要「跳过 / 不换」分支**，只需在引擎里断言该不变量。
（这也是「字牌按第 4 门处理」这个决定的直接收益：省掉一条贯穿五层的可空路径。）

### 2.4 方向与置换（精确定义）

```
dir = (secondDice[0] + secondDice[1]) % 3          // ∈ {0,1,2}
giveTo(seat) = (seat + [1, 3, 2][dir]) % 4          // 下家 / 上家 / 对家
receiveFrom(seat) = (seat - [1, 3, 2][dir] + 8) % 4
```

- 置换是 4-循环（`dir ∈ {0,1}`）或两个 2-循环（`dir === 2`）。
- 随机源：仅 `secondDice`。三端均可从既有报文推出：WS 的 `_round_opening`、P2P 的 `NetworkOpening`、
  本地的 `state.secondDice`；引擎同时把它写进 `BloodFlowOpeningState.swap3Direction`，
  供 worker 启动参数与录像复现使用。
- 协议上复用 `SourceTileEvent.kind === 'draw'` 作为本窗口的 `source`（庄家的开局摸牌事件），
  避免为窗口来源新增枚举值。

### 2.5 超时兜底算法（必须逐位一致）

`fallbackSwap3(hand, drawnIndex, jokers)`：

1. 可选下标池 `P = { i | i ≠ drawnIndex }`（庄家排除第 14 张；其他家全手可选）。
2. 按门分组，**选张数最多的门**；并列时按门序 `万 < 筒 < 条 < 字`。
3. 该门内排序（决定"交哪 3 张"）：
   ① 该牌在手牌中的出现次数**升序**（优先交孤张）；
   ② 次数相同按牌面序号**降序**（牌面序号取 `TILE_TYPES` / 后端 `core/tiles.py` 的同源顺序，
      两个字牌门的门序与牌序必须在跨语言对拍里显式断言）；
   ③ 精牌永远排在最后（最不可能被交出）。
4. 取排序后前 3 张的下标，**升序**返回。

该算法确定性、无随机、无策略依赖，是 TS 与 Python 必须逐位一致的对拍项。

### 2.6 与既有机制的交互

| 机制 | 口径 |
|---|---|
| 精牌 / 白板受限替代 | 不参与门判定以外的任何特殊处理；`jokers` 在换牌前已确定 |
| 天胡（庄家开局自摸）/ 地胡（庄家首打点炮） | 保留；判定基于**换牌后**的手牌 + 原第 14 张 |
| 锁手 / 多响 / 抢杠 / 杠收付 / 墙尽结算 | 完全不受影响（换牌阶段只可能在所有胡牌之前） |
| 开局闸门 | 单机在开局动画后启动引擎；WS 走 `_wait_for_openings` 屏障后 `_play_round` 计时；P2P 走 `backend.pause()` → `releaseOpening()` → `resume()`（deadline 平移） |
| 托管 / 自动代打 | 本阶段无「代打」概念：超时即 §2.5 兜底；托管座同样只走兜底 |
| 录像 / 分析 | 换牌命令（含 `indices`）、方向、置换结果都要可复现（见 §4 D） |

## 3. 设计后果（实现成本据此估算）

1. **牌墙完全不动**：136 守恒、局长度、摸牌次数、`takeLotusTailTile` 的尾墩奇偶、回放复现、
   跨语言对拍**全部不需要新逻辑**。与「与系统换」相比，省掉的是整块牌墙/RNG 风险面。
2. **LLM 候选天然收敛到 ≤ 4**（"交哪一门"），比「任意换 13 张」容易一个量级；
   且强制参与 → 候选里**不允许出现 pass**。
3. **新增一个公开信息维度**：收方知道给方放弃了哪一门。AI 可用（§4 A 与 §7 的可选负项，默认关）。
4. **门分布会趋同**：全员把不要的那门交出去 → 换牌后各家持牌门分布集中，染手成功率上升、
   牌河集中度与点炮风险可能上升。仿真必须观察该指标（§6）。

## 4. 实现改动清单

### A. TS 引擎（权威逻辑本体）

| 文件 | 改动 |
|---|---|
| `bloodFlow/state.ts` | `BloodFlowAction` += `{ kind: 'swap3'; indices: number[] }`；`EngineWindow.kind` += `'swap3'`；`BloodFlowOpeningState` += `swap3Direction?: 0 \| 1 \| 2` |
| `bloodFlow/engine.ts` | ① 构造器按配置分流 `openSwap3()` / `openTurn()`；② `deal()` 派生并记录方向；③ 新增 `openSwap3()` / `resolveSwap3()` / `fallbackSwap3Indices()`；④ `expire()` 加 `'swap3'` 分支（走 §2.5）；⑤ `assertConservation()` 的「庄家 14 张」判定纳入 `'swap3'`，**并新增断言：本窗口期牌墙长度与内容不变**；⑥ `publicState()` += `swap3: { direction, resolved }`；⑦ 断言 §2.3 可解性 |
| `bloodFlow/claimWindow.ts` | `acceptWindowDecision` 增加可选谓词参数 `allow?`（`swap3` 窗口由引擎传入同门 + 恰好 3 张 + 下标合法 + 排除摸牌张的校验）；导出 `isAllowedDecision()` 供 P2P 权威复用 |
| `bloodFlow/seatView.ts` | 本席私有段 `swap3?: { pick: 3; suits: readonly Suit[]; options: readonly number[] }`；结算后本席私有段 `swap3Result?: { given: TileType[]; toSeat: Seat; taken: TileType[]; fromSeat: Seat }`。`visibleTiles` 不变（不产生公开可见牌） |
| `bloodFlow/config.ts` | 新增 `BLOOD_FLOW_SWAP3_CONFIG`（与 `BLOOD_FLOW_CONFIG` 同源 spread + 新 `id`/`version` + `swap3: { enabled, pick: 3, decisionMs }`）；引入 `BLOOD_FLOW_RULES: Record<ruleVersion, config>` 版本表，`BLOOD_FLOW_CONFIG` 保留为默认导出 |
| `bloodFlow/ai.ts` | 新增 `planSwap3(view, config)`：对 4 门各取「该门最该交的 3 张」（复用 `lotusDiscardCandidates` 的价值排序 + 精牌保护），选损失最小的门；`mode: 'off'` 回退 §2.5 兜底以支持对照臂。`decideBloodFlowActionEv` 识别 `window.kind === 'swap3'` 时直接调用 |
| `bloodFlow/simulation.ts` | 模拟策略加入换牌决策（供 §6 三臂 A/B） |

### B. 协议与三端权威

| 文件 | 改动 |
|---|---|
| `network/protocol.ts` | `isAction` 接受 `{ kind:'swap3', indices }`（恰好 3 个、整数、去重、`< 14`）；`isSeatView` 白名单加 `swap3` / `swap3Result`；**`isSeatView` 的 `public` 严格白名单（现为 `ruleVersion/roundId/status/seats/batches/roundResult`）加 `swap3`**；`window.kind` 白名单加 `'swap3'`；版本校验改查 `BLOOD_FLOW_RULES` |
| `network/authority.ts` | 命令校验 `view.ownActions.some(sameAction)` → `isAllowedDecision()`；确认 `releaseOpening()` 后 swap3 窗口正常开放；`trimViewForDiet` 显式确认新字段不被裁掉 |
| `network/replica.ts` / `ws/authority.ts` | 整包 `structuredClone` + spread 合并 → 新字段自动透传（`mergeDietView` 需回归确认） |
| `engineWorker.ts` / `workerClient.ts` | `start` / `bot` / `command` / `expire` 均为透传 → 预期零改动（回归确认） |
| 后端 `core/blood_flow/config.py` | 新 ruleVersion + `swap3` 配置段 |
| 后端 `game/blood_flow_engine.py` | 镜像 A 表全部；`accept_window_decision` 由「dict 全等」改为「谓词 or 全等」 |
| 后端 `game/blood_flow_room.py` | `handle_client_message` 的 `any(a == action ...)` 改谓词；`_bot_policy` / `_fallback_policy` 处理 swap3（兜底复用 §2.5）；`_step_delay_ms` + `BLOOD_FLOW_PACE` 加换牌停顿；`_seat_view` 投影 `swap3` 段与 `deadlineAt` |
| 后端注册 | `api/rooms.py`（rulesetId Literal）、`rules/registry.py`（`RULESET_IDS` + `get_rule_set`）、`ws/game_ws.py`（路由）、`game/room.py`（血流房间分流） |

### C. 前端 UI / 表现

| 文件 | 改动 |
|---|---|
| `components/table/GameTableHud.vue` | 换牌面板：按 4 门自动分组 → 点一门自动高亮该门「最该交的 3 张」→ 可手动替换；方向箭头（我是给下家/上家/对家）；「确定」；读秒。多选状态（恰好 3）替代单选 `selectedIndex` |
| `variants/lotus/bloodFlow/useBloodFlowGame.ts` | `apply()` 派生 `phase: 'swap3'`；`send({ kind:'swap3', indices })`；`capabilities.bloodFlow.swap3`（方向 / 可选门 / 可选下标 / 已选）；换牌后自动 `refreshWaits()` |
| `game/online/presentation/openingTimeline.ts`、`variants/lotus/lotusOpening.ts` | 开牌阶段之后插入换牌阶段 |
| 3D + 音频 | 交牌飞向目标座位、收牌从来源飞入（复用 `bloodFlowTileFlight` / `tableTilePresenter`）；换牌音效；固定台词（`llm` / `llmAnime` 主题走既有语音通道） |
| 玩法注册 | `core/rules/ruleVariants.ts`、`components/lobby/RuleVariantPicker.vue`、`components/RulesPanel.vue`、`App.vue`（多处 `=== 'lotus-blood-flow'` 改为「血流族」判定）、`online/session/remoteSessionStore.ts`、`online/protocol/decoder.ts`、`replay/projection.ts` |

> 表现边界：换牌表现按本项目自行设计，**不声称来自**参考视频；[presentation.md](presentation.md) 与
> [acceptance.md](../acceptance.md) 中「排除参考视频的换牌/定缺机制」是对**借鉴来源**的边界声明，不禁止本项目自研新玩法表现。

### D. 录像 / 分析 / LLM

| 文件 | 改动 |
|---|---|
| `replay/analysis/bloodFlowAdapter.ts` | `windowKindOf` 加 `'swap3'`；`normalizeAction` 处理 `indices` 数组；`chooseTookEffect` 判定手牌变化 |
| `replay/analysis/types.ts`、`replay/bloodFlowRecorder.ts` | 命令载荷加 `indices`；旁观视角记录换牌（含牌面，仅本地） |
| 后端 `llm/blood_flow_candidates.py` | 四族候选（交万 / 筒 / 条 / 字）+ 门内变体；提示词写明「强制、同门 3 张、按方向交给下家/上家/对家」；**候选不含 pass** |

## 5. 不变量与验收

**引擎不变量（写成断言 + 单测）**

1. 置换前后每家手牌张数不变；`hand + 3 × melds` 口径不变。
2. 136 张总量与每种 4 份不变；**牌墙数组长度与内容逐位不变**（本口径最强的性质）。
3. 交出的 3 张同门；每家的 3 张来自 `receiveFrom(seat)`。
4. 四家全部提交前不得发放（无逐步泄漏）。
5. 可解性：任意 13 / 14 张手牌都存在合法 3 张同门解（§2.3）。
6. 庄家的 `drawnTileIndex` 在换牌后仍指向原第 14 张；`drawSource` 未被改写。

**跨语言对拍（硬性）**

- 扩 `work/blood-flow-pair-harness.test.ts`（含换牌决策与方向），与 `backend/tests/test_blood_flow_pair.py` 逐笔一致。
- 对拍必须显式覆盖 §2.5 兜底算法在**字牌门**上的门序/牌序（跨语言顺序一致性）。

**协议 / 房间**

- `network.test.ts`：非法 indices（跨门 / 非 3 张 / 重复 / 越界 / 含庄家摸牌张）全部被拒；`window.kind` 与 `public.swap3` 白名单生效。
- `backend/tests/test_blood_flow_engine.py`、`test_blood_flow_room.py`、`test_blood_flow_ws.py`。
- 前端 e2e：单机固定种子整场（含换牌阶段）。
- **AGENTS.md 强制的线上验收**：触及 P2P 传输/房间/协议 → `vibehubcli update` 部署后跑
  `tests/e2e/online-two-accounts-two-east-matches.spec.ts`（2 真人 + 2 普通机器人 / 2 真人 + 2 大模型机器人各一场），
  取证落 `tmp/bf-online-evidence/`。

## 6. 平衡与仿真口径

三臂对照（预注册种子、同种子配对、四座轮换、分数跨局结转）：

| 臂 | 换牌 |
|---|---|
| `swap3-off` | 不换（现行 `lotus-blood-flow-v1`，作为基线） |
| `swap3-3` | 同门 3 张（本契约） |
| `swap3-6` | 同门 6 张（张数上限的对照臂） |

指标：每局摸牌数（局长度）、首胡时间、胡牌次数、番种分布、封顶率、**点炮率**、
**换牌后门集中度**、分数方差。结论落 `docs/blood-flow/records/`，写明规则版本、提交、种子、
样本量、策略与局限（沿用既有记录模板的口径）。

## 7. 风险与未决项

| 项 | 说明 |
|---|---|
| 3 张可能不足以产生可测位移 | 若 `swap3-3` 三臂对比无显著位移，按 §6 结果考虑 6 张；**不从 13 张往下砍** |
| 门分布趋同 | 可能抬升染手成功率与点炮率，需仿真确认是否要调 AI 的风险定价 |
| 强制参与的手感 | 极端手牌（如 10 张字牌）下"交 3 张字牌"是唯一合理选择，策略空间窄，观感需实机确认 |
| 方向由骰点决定 | 玩家无法选择给谁；若后续要做"自选方向"需重新论证（会增加博弈与实现复杂度） |
| 未决 | 是否给 AI 加「避免给正在染该门的对手送同门牌」负项（默认关，走 A/B）；`swap3.decisionMs` 取 12s 还是 15s |

## 8. 里程碑

| 里程碑 | 交付 | 估时 |
|---|---|---|
| M1 | TS/Python 引擎 + 共享谓词校验 + 单测 + 跨语言对拍全绿（先不上 UI，用测试跑通整局） | 3–4 d |
| M2 | 本地 UI/表现（多选面板、换牌动画、方向箭头、台词）+ 单机 e2e | 2–3 d |
| M3 | AI `planSwap3` + LLM 候选 + 三臂仿真报告 | 2–3 d |
| M4 | WS 房间与规则注册 + P2P 上线两场验收 | 1–2 d |
| M5 | 录像/分析复现、`rules.md` / `tasks.md` / `acceptance.md` 补条、分支同步 | 1 d |

> 文档维护：本文件落地后，按 [README「如何维护」](../README.md) 第 1–2 条，实现开始时在 `rules.md`
> 增加本玩法的规则条目、在 `tasks.md` 增加 M1～M5 状态；证据追加到 `acceptance.md`。
