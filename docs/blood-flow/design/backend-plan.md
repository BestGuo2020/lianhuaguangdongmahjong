# 血流后端联机实现计划（2026-09-08 定稿）

范围（用户定稿）：**M1～M4 一起做**；**随机对拍纳入 M1 验收**；**不加观战**（房间沿用现有 4 人 + AI 补位、现有重连机制，不新增观战/中途迁移要求）。后端权威，前端 `BloodFlowEngine` 为唯一规格源；vibehub / P2P 原为后置项，**2026-09-10 已上线验收**（见[验收记录 2026-09-10](../../blood-flow/acceptance.md) 与 [vibehub 适配清单](../../vibehub-adaptation-checklist.md)）。

## 架构与一致性机制

- 后端在 `backend/`（独立 git 仓库，main 分支）实现血流规则、对局流程、WS 房间与补位 AI；前端 master 分支只加"WS 权威适配"（接 `useBloodFlowGame.externalAuthority`），UI/演出零改动。
- **规格源**：前端 `src/game/variants/lotus/bloodFlow/{config,engine,winBatch,ledger,roundLifecycle}.ts` 与 `patterns/` 目录；Python 按 1:1 翻译，不重做规则决策。
- **共享夹具**：`patterns/fixtures/golden.json`、`scoring.json` 是纯 JSON（输入 `WinEvaluationInput` + 期望番型/分数），后端测试直接读同一份文件（开发布局下 `backend/tests/` 相对路径读 `../src/.../fixtures/*.json`；CI 或独立部署时用同步脚本复制并注明来源与哈希）。
- **随机对拍（M1 验收项）**：同一批种子（1～N）分别在 TS 引擎与 Python 引擎跑完整局，逐笔比对每批 `deltas`、`scoresAfter`、`nextAction` 与胡记录（ordinal/source/items）；不一致即计分翻译 bug。对拍脚本放后端 `scripts/diff_pair_blood_flow.py`（调用前端 vitest 脚本产出 JSON 与后端产物比对），N 默认 200，纳入 `pnpm`/后端测试文档入口。

## M1 规则与计分层（约 45%）

新增：

| Python 文件 | 翻译自（TS） | 内容 |
|---|---|---|
| `backend/app/rules/blood_flow.py` | `config.ts` + `types.ts` | 规则集类（code=`lotus-blood-flow`）：16 番型权重与排除、事件倍率、每人封顶 64、杠分表、锁手/多响/负分不淘汰、东风 4/半庄 8、开局保底 8；双骰/翻精复用 `lotus_wall` |
| `backend/app/core/blood_flow/decompose.py` | `patterns/decompose.ts` | 可替代分解枚举（精牌替任意、白板受限）、自然分解、分解输入校验 |
| `backend/app/core/blood_flow/catalog.py` | `patterns/catalog.ts` | 番型匹配（含大小三元/四喜互斥、暗刻/明暗口径、三杠/四杠只数已声明普通杠） |
| `backend/app/core/blood_flow/score.py` | `patterns/score.ts` | M=1+Σ(w−1)、事件倍率、硬胡 H、封顶、最高合法支付与稳定分解选择 |
| `backend/app/core/blood_flow/evaluate.py` | `patterns/evaluate.ts` | `evaluate_win` / `evaluate_waits`（含任意听 34 听口检测） |
| `backend/app/core/blood_flow/win_batch.py` | `winBatch.ts` + `ledger.ts` | 多响批次：自摸三付/点炮单付/抢杠回滚、聚合向量、零和断言、scoresAfter、nextAction（墙尽结算） |

验收：

1. `golden.json` / `scoring.json` 全量用例在 Python 全绿（含硬胡十三幺点炮 320、自摸每家 640/总收 1920、硬胡清一色+碰碰胡自摸每家 200、封顶 64 等既有算例）；
2. 对拍 200 种子逐笔一致（`deltas/scoresAfter/nextAction/胡记录`）；
3. 类型/边界：绝张替代口径、精牌打出/被抢按本张、虚拟代表牌不改变实体守恒。

## M2 对局流程层（约 20%）

新增 `backend/app/game/blood_flow_manager.py`（独立于现有 `GameManager`，不复用其单胡终局路径）：

- 开局：双骰、翻精、发牌、庄家 14 张摸牌位（复用 `lotus_wall` + 现有 pace/事件外壳）；
- turn 窗口：胡/杠/弃；锁手后仅摸打（只能打新摸牌）；
- claim 窗口：吃碰杠胡过同窗，收齐决定后**胡优先、允许多响**，杠>碰>吃次序；
- 抢杠窗口：仅胡/过；被抢后原碰保留、不收杠分、不补牌；
- 杠收付即时结算（直杠 1B/补杠 3×B/暗杠风杠 3×2B）；
- 首胡锁手（winCount/recordIds）、胡后续行（赢家下家摸牌）、末张多响完成整批才结算；
- **牌墙耗尽才结算**：轮庄、场次计数、局末净胜排名、负分继续、返回大厅/续局路径复用现有房间外壳；
- 每窗口每席一次决定；过水不加跨窗口限制。

验收：注入牌墙与骰子打完整局（单元 + 管理器级）；136 张守恒、零和、锁手/多响/连续胡/墙尽结算全断言；与前端引擎同种子行为一致（对拍脚本复用）。

## M3 协议与房间接入（约 15%）

- `backend/app/rules/registry.py` 注册第三规则集；`backend/app/api/rooms.py` 的 `rulesetId` Literal 加 `lotus-blood-flow`；房间表沿用 `ruleset_id` 列（已通用）。
- WS：沿用现有 `game_ws.py` 信封与 `room.py` 队列；血流房间路由到 `blood_flow_manager`。快照结构对照前端 `bloodFlow/network/protocol.ts` + `seatView.ts`：`window{id/version/kind/source/options/decisions}`、`ownActions/ownScore/waitingSeats`、`public{seats{winCount,locked,firstWinSequence,recordIds},batches,roundResult}`、`kongEvents`、`continuation`、`paced transition`。前端协议校验器（`isBloodFlowSeatView` 风格）直接作为后端快照的验收断言。
- 前端（master 分支）：`src/game/online/transport/roomSocket.ts` 增加血流权威适配（send(command)/nextRound/leave/openingDone + `acceptRemoteView(view, meta)`，meta 含 opening/round/mode/dealer）；`BLOOD_FLOW_AVAILABILITY` 加 WS flag（真实联机验收后才放行生产开关，同 E06 口径）。

验收：仿 `backend/scripts/smoke_lotus_legacy.py` 写血流双客户端 WS 冒烟（wakudemo 登录会话环境）；前端既有「cannot enter a WS room」被登录闸门挡住的用例一并复测。

## M4 AI 与 LLM 补位（约 10%，与 M1-M3 同批交付）

- 补位 AI：翻译前端贪婪 EV 策略（`patternPotentials` + `evContext` + `decideBloodFlowActionEv` 到 `backend/app/core/blood_flow/ai.py`；含改张/首胡门槛/抢杠比较/锁手自动）；无 LLM 主题房间可直接开局。
- LLM：`backend/app/llm/candidates.py`、`validation.py` 增加血流候选构建与合法性（对齐前端 `bloodFlowDecisionInput` 的 EV 特征与"可覆盖、要理由"口径）；复用既有 LLM 玩家、预算、条件深思与台词管线（血流局末专属台词在 `bloodFlowRoundLines.ts`，后端决策台词路径沿用，不新增模型请求通道）。

验收：补位 AI 与前端 EV 决策同种子行为一致（对拍）；LLM 固定输入四条（改张任意听/早局拒胡/抢杠过/抢杠胡）选择合法。

## M5 回归与收口

- 后端：`backend/.venv/Scripts/python.exe -m pytest tests -q` 全绿（新增 `tests/test_blood_flow_rules.py`、`test_blood_flow_manager.py`、`test_blood_flow_ws.py`、`test_blood_flow_ai.py`）；后端独立 git 提交（main 分支）。
- 前端：master 分支提交 WS 适配与测试；`pnpm test`、`pnpm build`；血流关键 e2e 回归。
- 文档：tasks.md / acceptance.md 记录两仓库提交与验收证据。（原「不跑 `pnpm sync:vibehub`（P2P 后置）」已于 2026-09-10 作废：P2P 上线验收，当日运行 9 次同步并部署 `B5AJupT1`。）

## 风险与降级

- **分解器正确性**：最大风险；以黄金 JSON + 200 种子对拍兜底，任何不一致先修计分再进流程。
- **LLM 时延**：沿用预算/窗口/回退机制，LLM 不可用时补位 AI 兜底，房间不卡死。
- **登录闸门环境**：WS 冒烟需要 wakudemo 会话；无会话时先跑本地直连管理器测试，冒烟单列待办。

## 交付顺序

M1（规则+对拍）→ M2（流程）→ M3（房间/WS/前端适配）→ M4（AI/LLM）→ M5（回归收口）。每阶段完成各自验收后再进入下一阶段；后端每阶段独立提交，前端改动只在 master 提交。
