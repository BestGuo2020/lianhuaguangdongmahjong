# 番表变更记录：门清 / 平胡 独立化 + 鸡胡 0.5 番（2026-09-15 用户定案）

## 变更内容

| 项 | 改前 | 改后 |
|---|---|---|
| 门清平胡（`concealed-hand`，2 番） | 兜底**本体**：标准型、未副露且无其他番种时取代鸡胡；**不与任何番种叠加** | **删除该合并番种** |
| 门清（`concealed-hand`，1 番） | — | **独立番种**：只看**无副露**（不排除用精牌），**与任何番种叠加**（清一色/碰碰胡/七对/四暗刻…都吃得到） |
| 平胡（`pinghu`，1 番） | 该 id 当时是「鸡胡」的标签（无判别器） | **独立番种**：存在一种拆解 = **4 顺子 + 1 将、无刻子**；可副露；字牌也可成顺（乱风顺/三元顺，与引擎面子规则一致）；**精牌只能补顺不能补刻** |
| 鸡胡（新增 `chicken`，0.5 番） | `pinghu` 标签「鸡胡」= 无番时的兜底 1 番 | 完全没有任何计分番种时的兜底体，**0.5 番**；不与任何番种叠加 |

## 必须同时改的口径：`1 + Σ(番值−1)` → `Σ(番值)`

原公式里**「1 番」等于「不加成」**（底数本身就是 1 番），因此 1 番的门清/平胡会完全无效。改成直接求和后：

| 手牌 | 旧 | 新 |
|---|---|---|
| 鸡胡（无番，点炮） | 1 番 = 10 点 | **0.5 番 = 5 点** |
| 门清（无副露、无其他番） | 门清平胡 2 番 = 20 点 | 1 番 = 10 点 |
| 门清 + 平胡（经典兜底） | 2 番 = 20 点 | **2 番 = 20 点（与旧完全一致）** |
| 清一色 | 8 番 = 80 点 | 8 番 = 80 点（不变） |
| 门清 + 清一色 | 8 番（门清不叠加） | **9 番 = 90 点** |
| 七对 / 豪华七对 | 4 / 12 番 | 4 / 12 番（+门清则各 +1） |
| 碰碰胡 + 清一色 | 11 番 | **12 番**（多番叠加时按番值直接相加） |

## 关键约束：倍率必须是整数 → 0.5 番落在「支付减半」

协议 `isPublicWinScore` 用 `int()` 校验 `patternMultiplier / eventMultiplier / uncappedMultiplier / finalMultiplier / paymentPerPayer`。
若把 0.5 直接写进倍率，**整个快照包会被客机静默拒收**（实测：`decode=false`，整局卡死）。因此：

- 倍率取 `max(1, Σ番值) + 杠加成`（始终整数）；
- 新增 `halfPayment`（布尔）：仅当 `Σ番值 < 1`（即只有鸡胡）时为真；
- 点数 = `底分 × 最终倍率 ÷ (halfPayment ? 2 : 1)`（底分 10 → 鸡胡 5 点，自摸/硬胡翻倍后仍为整数）。

## 改动清单

- 前端：`patterns/score.ts`（口径 + `halfPayment`）、`patterns/catalog.ts`（门清叠加、平胡判别、鸡胡兜底）、`patterns/types.ts`、`bloodFlow/config.ts`（番表 31 项、四暗刻 excludes 去掉门清）、`bloodFlow/types.ts`、`bloodFlow/network/protocol.ts`（校验放行 `halfPayment` 并校验点数关系）、`bloodFlow/patternPotentials.ts`（EV 同口径）、`bloodFlow/kongValue.ts`（破坏门清的自损按 1 番）、LLM 规则摘要（`llm/bloodFlowDecisionInput.ts`）。
- 后端镜像：`core/blood_flow/{config,catalog,score,types,ai,kong_value}.py` 同步；`tests/test_blood_flow_*` 更新；`work/blood-flow-pair-harness.test.ts` 重新生成 1218 例夹具后 **前后端逐例一致**。
- 夹具：`patterns/fixtures/{golden,scoring}.json` 按新口径重算（含 `totalWon`）。

## 影响（待 A/B 复核）

- 无番小胡收益减半 → "鸡胡盖楼"动机下降；门清/平胡独立化 + 多番直接相加 → 做大牌（尤其门清大牌）收益上升。
- AI 侧：`kongValue` 的"破坏门清"自损减半（10 → 5），开杠更果断；EV 的 `firstWinFloor` 口径不变但鸡胡只值 5 点，拒胡会变多，需要用 A/B 复核和牌率与结算分。
