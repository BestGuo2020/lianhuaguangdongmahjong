# 血流联机 vs 经典联机（非血流）：节奏与表现逐项对账

目标：多人联机血流以「多人联机莲花麻将（非血流）」为基准对齐。本清单穷举经典
`manager.py PLAY_PACE` / `player.py AI_DELAYS` / `room.py turn_timeout` 的全部节奏点
与表现事件，逐项标注血流实现位置与状态。✅=已对齐；—=经典专属、血流规则不适用。

## 1. 节奏点

| 经典节奏点 | 经典值(ms) | 血流实现 | 状态 |
|---|---|---|---|
| AI 出牌思考 `AI_DELAYS.turn` | 650 | `BLOOD_FLOW_PACE.aiThinkTurn` | ✅ |
| AI 碰/杠/抢响应 `AI_DELAYS.claim` | 500 | `aiThinkClaim` | ✅ |
| AI 杠后补摸再出 `AI_DELAYS.after_kong` | 550 | `aiThinkKong`（`engine.kong_bloom` 判定） | ✅ |
| 弃牌→下家 `afterDiscardToNextTurn` | 450 | `afterDiscardToNextTurn`（弃牌流水计数触发） | ✅ |
| 碰后 `afterClaimPeng` | 650 | `afterClaimPeng` | ✅ |
| 吃后 `afterClaimPeng` | 650 | `afterClaimPeng`（chi 同档） | ✅ |
| 明杠后（AI）`afterClaimGang` | 550 | `afterClaimGang` | ✅ |
| 明杠后（真人） | 350 | `afterClaimGangHuman` | ✅ |
| 暗杠/补杠/乱风杠后 `afterKongSettle` | 600 | `afterKongSettle` | ✅ |
| 抢杠前 `beforeRobKong` | 650 | `beforeRobKong` | ✅ |
| 抢杠之间 `betweenRobKongs` | 450 | —（血流多响一次性结算，无逐家抢杠） | — |
| 吃碰后跳过摸牌 `skipDrawPengDelay` | 350 | —（经典引擎 `begin_turn` 默认摸牌，碰/吃需 `skip_draw=True` 跳过；350ms 是人类碰后到出牌窗口的停顿。血流碰/吃不摸牌、杠才 `draw(tail)`；人类碰后真人自选牌、AI 碰后有 650 思考，无需独立档位） | — |
| 红中花杠后 `redKongDraw` | 600 | —（血流无红中杠） | — |
| 开局表现等待 `openingDelay(Start)` | 6400 | 客户端开局动画 + `opening_done` 就绪屏障 | ✅ |
| 回合超时 `turn_timeout` | 12000 | `BLOOD_FLOW_TIMING.remoteDecisionMs` | ✅ |
| 摸牌→出牌额外停顿 | 无 | 已移除不存在的 `afterDraw` | ✅ |

## 2. 表现事件 / 音效

| 经典 | 血流 | 状态 |
|---|---|---|
| `round_start`（骰/翻精/发牌信息） | `bf_snapshot.opening` + 客户端时间线 | ✅ |
| `table_action`（动作字） | 快照 `actionEvents` | ✅ |
| `score_flow`（杠/胡收付分数流） | 快照 `kongEvents`/`batches` → 前端 `BloodFlowPresentationQueue` | ✅ |
| 摸牌音 `give.mp3` | 前端 `apply()` 窗口源变化 | ✅ |
| 弃牌音 `dapai.mp3` | 前端 `apply()` `lastDiscardAction` | ✅ |
| 杠音 `gang.mp3` / 胡音 `hu/zimo` | 前端 `scheduleWinVoices`/动作表现 | ✅ |
| `announcement`（公告） | 抢杠胡红字公告随快照下发（翻精/流局仍由前端 cue 表现） | ✅ |
| `round_result` / `match_finished` / `continue_prompt` | 快照 `roundResult` / `matchFinished` + `continue` 回执 | ✅ |
| 局末感言 / AI 动作台词 | 服务端 LLM 台词未下发（唯一已知差异） | ❌ |

## 3. 已知唯一未对齐项

- **AI/LLM 席位的动作台词与局末感言**：本地由前端 `decisions.observe`/`reactions.run`
  生成；联机下 AI/LLM 在服务端，其台词（`request_llm_decision` 返回的 `message`）目前被
  丢弃，未随快照下发。补齐方式：服务端把 LLM 席位台词写入快照 `speechEvents`，前端
  `apply()` 按 actor 呈现（`presentActionSpeech`/`roundBubbles`）。

## 4. 验证

- 后端：`tests/test_blood_flow_room.py`（`test_pace_table_wired_for_real_rooms`、
  `test_step_delay_matches_local_timing`、`test_snapshot_players_carry_room_identity_and_fresh_deadline`）。
- e2e：`tests/e2e/blood-flow.remote.spec.ts`（东1局、昵称、读秒 1–12s、开局回执、弃牌流水）。
