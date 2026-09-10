# 血流联机：节奏与表现逐项对账（以单机血流为基准）

> **基准变更（2026-09-09，用户决定）**：数值基准从「经典联机（非血流）」切换为
> **单机血流**——前端 `engine.ts`（消费共享 `PACE_MS`）、`useBloodFlowGame.schedule`
> 的机器人统一 650ms、`bloodFlowWinTiming` 胡牌档位。经典 `manager.py PLAY_PACE` /
> `player.py AI_DELAYS` / `room.py turn_timeout` 列仅作机制参考。**明确不移植的经典
> 专属档位**：AI 分档思考（claim 500 / after_kong 550）、真人碰/明杠 350 缩短
> （`skipDrawPengDelay` 等）、多响抢杠 `betweenRobKongs` 450。机制差异（读秒、
> 屏障、托管、台词闸门）保留联机语义，见 §3，不做数值对齐。

## 1. 节奏点

| 单机血流连奏点 | 单机值(ms) | 经典参考(ms) | 联机实现（`BLOOD_FLOW_PACE`/房间循环） | 状态 |
|---|---|---|---|---|
| 机器人统一思考停顿 | 650（全窗口同档；LLM 座位也先等再发请求） | turn 650 / claim 500 / after_kong 550 | `aiThink`=650，`_decide_bots` 决策前统一停顿；LLM 超时预算扣除该停顿 | ✅ |
| 摸牌→出牌窗口 `afterDraw` | 450 | 无 | `afterDraw`（牌墙变短时与动作停顿**串联**叠加） | ✅ |
| 弃牌→下家 `afterDiscardToNextTurn` | 450 | 450 | `afterDiscardToNextTurn`（弃牌流水计数触发） | ✅ |
| 碰/吃后 `afterClaimPeng` | 650（**不分真人/AI**） | AI 650 / 真人 350 | `afterClaimPeng`（真人 350 缩短档已移除） | ✅ |
| 明杠后 `afterClaimGang` | 550（**不分真人/AI**） | AI 550 / 真人 350 | `afterClaimGang`（真人 350 缩短档已移除） | ✅ |
| 暗杠/补杠/乱风杠后 `afterKongSettle` | 600 | 600 | `afterKongSettle` | ✅ |
| 抢杠前 `beforeRobKong` | 650 | 650 | `beforeRobKong` | ✅ |
| 胡牌演出 `bloodFlowWinTiming(tier).duration` | 3015 / 3180 / 3480 | 无 | `_win_pause_ms` 同构档位（`winEffect*` 键） | ✅ |
| 点炮多响引言 `multiWinIntroMs` | 1500（仅 discard 来源） | 无 | `multiWinIntro`（同口径） | ✅ |
| 多响抢杠额外停顿 | **无**（单机引擎无此档） | `betweenRobKongs` 450 | 已移除 | ✅ |
| 胡→下一张交接余量 | +100 | 无 | `winHandoffMargin` | ✅ |
| 演出闸门 | transition 期间 window=null、新牌不可见 | 直推快照 | `_hold_window_until` 快照隐藏新窗口与刚摸的牌（墙数补偿）；**节奏基线跨迭代持久 + 真人提交推进的窗口不由 WS handler 广播**（2026-09-09 修复：此前真人自摸/吃胡/抢杠胡经 handler 同帧暴露新窗口，动画被下家抢跑） | ✅ |
| 开局时间线（用户指定：开局段以**经典联机**为准） | game_start 1250 / 骰 1600×2 / 翻精 1200 / 发牌音仅 4 张批、庄家跳批 260 / 开牌公告在动画内 / 650 | game_start 1250 / 骰 1900×2（音不阻塞）/ 翻精 1200 / 发牌每批音、4 张批 260 其余 150 / 开牌公告动画结束后展示 / 650 + opening_done 屏障 | `acceptRemoteView` 时间线逐项对齐经典 `openingTimeline.ts`（骰 1900×2、每批 deal.mp3、跳批 150、开牌公告后置） | ✅ |
| 锁手自动摸打 | 窗口开放 + 800 观察窗 | 无 | 共享 `lockedAutoPlayMs`（联机 opensAt=0 修正） | ✅ |
| 回合超时兜底行为 | expire：摸打/兜底弃牌、响应窗过 | 同 | 后端引擎 `expire` 同构 | ✅ |
| 真人决策读秒 | **无**（单机槽 `countdownEnabled:false`，引擎 Infinity） | `turn_timeout` 12000 | `remoteDecisionMs` 12s + didu + 超时代打 | 机制差异（保留，见 §3） |
| 吃碰后跳过摸牌 `skipDrawPengDelay` | 无此档（碰/吃不摸牌，统一 650） | 350 | — | — |
| 红中花杠后 `redKongDraw` | 血流无红中杠 | 600 | — | — |

## 2. 表现事件 / 音效

| 单机 | 联机 | 状态 |
|---|---|---|
| 开局掷骰/翻精/发牌信息（`lotusOpening`） | `bf_snapshot.opening` + 客户端同形状时间线（翻精/开牌红字公告同款） | ✅ |
| 动作字（`transient.showTableAction`） | 快照 `actionEvents` → 同一 apply() 路径 | ✅ |
| 杠/胡收付分数流（`BloodFlowPresentationQueue`） | 快照 `kongEvents`/`batches` → 同一客户端演出队列（胡 cue 档位/多响 1500 字动画/杠 cue 1900/积压合并/语音闸门全共享） | ✅ |
| 摸牌音 `give.mp3` | 前端 `apply()` 窗口源变化（闸门结束时随牌出现，单机在过渡开始；感知差异极小） | ✅ |
| 弃牌音 `dapai.mp3` + 牌名播报 | 前端 `apply()` `lastDiscardAction`（牌名播报不闸门下一步，见 §3） | ✅ |
| 杠音 `gang.mp3` / 胡音 `hu/zimo` / 赢家语音 | `scheduleWinVoices` 共享（多响 1500 引言后同一拍） | ✅ |
| 无服务端公告（抢杠胡红字公告为经典玩法专属，单机血流没有） | 快照不下发 `announcement`（2026-09-09 用户确认移除）；翻精/开牌红字公告为客户端本地 transient | ✅ |
| 结算面板时机 | 引擎把 result 门在胡演出后 | 快照即发 roundResult，但面板由 `presentationBusy` 门控等演出播完 | ✅ |
| 结算亮牌时机 | 胡牌特效 + 亮牌停顿走完才 `revealHands` | `GameTableHud.tableRevealHands`：血流下按 `presentationBusy` 延后亮牌（服务端在 `engine.result` 帧即下发三家手牌，若直接跟随 `revealHands` 会在胡牌演出开始前就亮出） | ✅ |
| 局末感言 | `reactions.run` 本地模板台词 + TTS | 两模式同播（共享代码） | ✅ |
| AI 动作/弃牌台词 | LLM 座位模型实时台词 + 思考气泡；弃牌台词播完才出牌 | **服务端模型原话**：`llm_message` 气泡 + `llm_audio` 服务端 TTS（`_on_llm_message`，文本经 `compact_speech_text` + `LlmSpeechPolicy` 过滤，失败发「？」气泡）；客户端不再拼模板台词。仍无思考气泡、不闸门动作 | ✅（气泡/音频口径对齐；思考气泡仍缺） |
| 赢家胡牌台词 | 模型自己的台词（`takeWinLine` 预合成） | 联机赢家台词即模型决策原话（同上 `llm_message`/`llm_audio`）；单机仍 `takeWinLine` 预合成 | ✅ |

## 3. 机制差异（联机语义保留，不做数值对齐）

- **读秒与超时**：联机 12s 读秒 + didu 警示 + 超时兜底代打；单机无读秒、无超时（防挂机是联机刚需）。
- **屏障与局间过场**：开局 `opening_done` 就绪屏障（60s 兜底，同经典 `_opening_timeout`）；局间结算面板带 **10s 倒计时**、到 0 自动回执，回执即广播就绪计数——「已准备，等待其他玩家（x/y）」实时更新。**倒计时只有一份**：经典 `useRemoteContinueCountdown` 在血流下必须关闭（`enabled: !capabilities.bloodFlow`）——它不显示在血流结算面板里却仍在计时，会在结算快照到达 10s 时静默回执，表现为「可见倒计时没到 0 就进下一局」（2026-09-09 实测「倒计时到 4」的真正根因；此前记作 20s 服务端兜底抢跑，判断有误）。血流的倒计时锚点是「面板可点」＝局末演出（胡/杠 cue）**与局末感言都播完**（2026-09-10 用户要求 `roundSpeechBusy` 一并门控面板与倒计时；经典锚点是自己固定的结算时间线走完，约 6.1s/流局≈0）；服务端兜底 **45s**（覆盖最坏演出尾巴 + 感言 + 完整倒计时，仅防客户端无响应）。单机点击即走、无倒计时。
- **托管**：联机服务端 EV 代打（auto 座位不计屏障/读秒）；单机血流无托管（锁手自动摸打两模式共有）。
- **弃牌语音闸门**：单机 discard 过渡等牌名播报播完（上限再 +1500ms）；联机固定 450ms。
- **网络因素**：联机每步叠加 RTT 与 50ms 轮询粒度；读秒基于服务端墙钟，客户端时钟偏移会影响显示。
- **整场结束后的房间生命周期（已对齐经典）**：房间保留不自动解散（`start` 允许 finished 再开一场、分数复位）；**准备态保留**（2026-09-10 用户决定：一场结束后各座位仍是「已准备」，房主可直接再开一场，不必全员重新点准备；离席座位也算已准备，由 AI 代打）；结算页整场结束后「返回房间」= 复位牌桌视图回**房间大厅**。**房间限时同经典**：`ROOM_LIFETIME`（默认 60 分钟，可环境变量覆盖），非对局中到期回收、对局中不回收并在收尾时按同一 deadline 释放。
- **「返回大厅」= 暂离，不退出（2026-09-10 用户决定）**：三个动作语义分开——**返回大厅（暂离）**：不调 REST leave，只主动断开 WS（服务端按断线 AI 托管、且不计入待决策与结算屏障），保留座位/重进码/会话，本机停在房间面板（「本场进行中 · 你在暂离」+「回到牌桌」＝ WS 重进握手恢复原座位）；**退出本场**（二次确认）：回主大厅但**仍保留座位与会话**，大厅显示「继续对局（房间 X）」；**离开房间**（二次确认）：才真正 REST leave 释放座位。中途重进**不需要**放行 playing 房间的 REST join——走已有 WS `resume_by_code`。
- **房主与解散（2026-09-10 用户决定）**：房主离开座位 → 房主**顺延**给剩余座位中编号最小者（血流房补齐 `_transfer_creator`，与经典同口径；**单向不回收**，原房主重进也不拿回）；`leave_room` **不再**「非对局中房主离开即解散」，只有**全员离开**、房主显式「关闭房间」或房间限时回收才解散。`rejoin_err` 按码区分：仅 `ROOM_NOT_FOUND`/`INVALID_REJOIN_CODE` 清会话，`ALREADY_CONNECTED`/限速视为可重试（否则暂离后立刻回桌会丢「继续对局」入口）。
- **重连**：联机重连不重播开局动画；单机无此场景。
- **动作提交与竞态**：同一窗口只提交一次——`useBloodFlowGame.submittedWindowId` 闩锁：提交后 `ownActions` 对外视为空（按钮与能力立即收起），等权威快照推进窗口才解锁。联机下窗口推进后客户端因演出停顿最多 3.5s 看不到新窗口，此前连点必然打出 `STALE_ACTION`。服务端对过期/重复动作的 `STALE_ACTION`、`INVALID_ACTION` 属预期竞态：只写控制台，不写入 `sessionError`（那份错误只在大厅渲染，会一直挂到「返回大厅」才冒出来——用户看到的正是这个）；`sessionError` 在进房/返回大厅/重连成功时清空。
- **模型原话与语音（联机）**：LLM 席位决策返回的 `message` 不再丢弃——服务端按经典房间口径 `_on_llm_message`：`compact_speech_text` 归一 + `LlmSpeechPolicy` 频率过滤 → 广播 `llm_message`（气泡，带 `purpose`/`actionKind`）→ 服务端 TTS `ensure_audio` → 广播 `llm_audio`（`/api/local-tts/audio/<hash>.mp3`）。客户端 `presentRemoteModelSpeech`/`playRemoteModelAudio` 落气泡与音频（后者走与经典相同的 llm 音频队列）；**客户端不再自拼模板台词**（此前联机 LLM 台词是前端模板、且音色读本机单机设置）。llmAnime 主题按 `shouldSuppressLegacyAnimeSpeech` 抑制模型动作/赛后语音（角色固定台词接管），弃牌吐槽仍用原话。模型失败/超时只发「？」气泡、不创建 TTS。
- **座位身份与音色（联机）**：昵称/头像/二次元角色/音色由服务端供应商推导并随快照下发（`name`/`avatar`/`characterId`/`style`/`voiceKey`，对齐经典 `_seeds`）；空位 AI 用 `PLAYER_SEED` 身份（不再是引擎占位名「玩家N」+ 空头像 + 硬编码角色）。**本家二次元角色随 join 上报**（`getCharacterId` → REST join 的 `characterId`；此前漏传，服务端永远回退 deepseek，大厅选了角色也对局里不生效）。客户端按快照的 `voiceKey`/`style` 调用本机 TTS（`remoteVoiceIdentity`，非法值回退策略默认），**不再读本机单机 LLM 设置**——此前房间开了大模型，看到的却是座位默认头像/占位名，听到的也是默认音色。
- **大厅建房/入房加载态**：`sessionStatus` 与经典同口径增加 `creating`/`joining`，按钮显示「创建中…／加入中…」并禁用（防连点重复建房），失败回 `idle` 并给可读原因（`ROOM_LIMIT_REACHED`/`ROOM_FULL` → 房间已满）。此前血流模块不置这两个状态，按钮一直可点、无加载态。

## 4. 验证

- 后端 `tests/test_blood_flow_room.py + test_blood_flow_engine.py`（31 项通过，225s）：
  - `test_pace_table_wired_for_real_rooms`：节奏表键集合 + 经典专属键**不存在**断言；
  - `test_step_delay_matches_local_timing`：真人碰 650、真人明杠 550+450 串联、平胡 3015+100；
  - `test_win_pause_matches_local_engine_tiers`：3015/3180/3480 档位、点炮多响 +1500、抢杠多响无额外停顿；
  - `test_step_delay_chains_discard_pause_and_draw_pause`：弃牌 450 + 摸牌 450 串联；
  - `test_human_self_draw_win_holds_animation_gate` / `test_human_discard_win_holds_animation_gate` /
    `test_human_robbed_kong_win_holds_animation_gate`：**真人提交**的自摸/吃胡/抢杠胡——
    批次帧必须藏窗口、藏刚摸的牌，停顿结束后才重新开放（三例均断言快照不携带服务端公告）；
  - `test_continue_confirmation_broadcasts_ready_count`：continue 回执即广播就绪计数、重复回执幂等不广播、兜底 20s；
  - `test_snapshot_players_carry_room_identity_and_fresh_deadline`：读秒从窗口出现起算。
- e2e：
  - `tests/e2e/blood-flow.remote.spec.ts`（东1局、昵称、读秒 1–12s、开局回执、弃牌流水）；
  - `tests/e2e/blood-flow.pacing.spec.ts`（用户验收场景）：①1真人+3AI 打到出现胡牌，WS 帧级断言
    胡牌批次帧窗口隐藏/摸牌隐藏、下家窗口开放间隔 ≥2.6s；②2真人打到局末，断言结算倒计时 `(N)`、
    A 确认后「已准备，等待其他玩家（1/2）」且不开局、B 由 10s 倒计时自动回执、双端进入东2局。
