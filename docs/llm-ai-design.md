# 大模型 AI 接入设计规范（LLM-AI Design Spec）

> 版本：v1（冻结）
> 状态：待实现（P0 产出物）
> 适用范围：莲花广麻（白板癞子）与莲花麻将（翻精癞子）两种规则的人机对局。
> 本文档是前端（TypeScript）与后端（Python）实现的**唯一规格依据**，前后端实现必须与本文档一致；任何修改先改本文档。

---

## 1. 目标与范围（v1 冻结）

**目标**：给"人机"接入大模型做决策。采用**混合方案**——引擎枚举合法候选并计算特征（听口 / 安全度 / 牌效等），LLM 只在编号候选中做选择并输出人设吐槽；非法、超时、失败一律回退现有启发式 AI。

| 范围 | 内容 | Key 存放 |
|---|---|---|
| ✅ v1-in | 本地单机人机（广麻 + 莲花） | 前端设置页用户填写，存 localStorage，**浏览器直连** |
| ✅ v1-in | 联机房间空座 AI 补位（master WebSocket 房间） | 服务端环境变量 |

| 明确排除 | 原因 |
|---|---|
| ❌ 真人超时 / 断线 AI 代打挂 LLM | 可靠性兜底，永不依赖外部服务（`RemotePlayer._ai` 保持启发式） |
| ❌ 联机用户自填 provider | v2；联机统一服务端配置，key 不进房间系统 |
| ❌ 本地请求走后端代理 | 前端直连；供应商 CORS 支持见 §11.3 |
| ❌ vibehub 分支的联机开关 | 其 lobby / 联机层为独立实现（keep 清单）；该功能随 master 同步，vibehub 空座补位复用前端控制器属 v2 |

**硬约束**：

1. LLM 只能从引擎枚举的候选编号中选择，**不做任何合法性判断**；
2. 非法 / 超时 / 网络失败 → 一次反馈重试，再失败 → 回退现有启发式决策（引擎建议）；
3. 胡（自摸胡 / 点炮胡 / 抢杠胡）不进 LLM，引擎直判（配置项可开，默认关，见 §10.3）；
4. 未激活 LLM 时，行为与现状**逐字节一致**（所有新字段可选、默认关闭、mock 注入）。

---

## 2. 架构与数据流

```
┌─ 控制器层（现有，零改动）────────────────────────────────┐
│ PlayerController / LotusController（前端）  request_turn  │
│ AIPlayer / RemotePlayer（后端）            request_claim   │
└──────────────┬───────────────────────────────┬───────────┘
               │ 决策委托                        │ 兜底
┌──────────────▼───────────────────────────────▼───────────┐
│ LLM 策略层（新增）                                          │
│  1. 候选枚举：引擎规则函数 → 合法候选列表 {id, label, features} │
│  2. 引擎建议：跑一次现有启发式决策 → 标记对应候选（同时是兜底）    │
│  3. Prompt 构建：局况 + 可见局面 + 编号候选 + 输出约束          │
│  4. 调用 LLM（OpenAI 兼容 /chat/completions，纯文本 prompt）   │
│  5. 解析 choice → 自校验（后端强制；前端由引擎二次校验兜底）     │
│  6. 失败链：反馈重试(1 次) → 引擎建议 →（网络/超时直接回退）     │
└──────────────────────────────────────────────────────────┘
               │ 动作命令（与真人 WS 报文同构）
┌──────────────▼───────────────────────────────────────────┐
│ 引擎执行层（现有，零改动）：动作应用、规则复核、动画、广播        │
└──────────────────────────────────────────────────────────┘
```

**关键点**：LLM 策略层输出的动作命令与真人/启发式 AI 输出**同构**（`{"kind": "discard", "handIndex": n}` 等），因此控制器接口、游戏循环、规则校验、动画、协议全部不动。LLM 策略层以"策略注入"方式挂在现有控制器的决策函数处。

**前端**（本地单机）：新增 `LlmController implements PlayerController` / `LotusLlmController implements LotusController`，内部调用 LLM 策略层；失败回退现有 `AiController` / `LotusAiController` 决策。

**后端**（联机空座）：新增 `LLMPlayer(AIPlayer)`，仅覆盖 `request_turn` / `request_claim`，内部"引擎建议 + LLM 调用 + 自校验"，失败 `super().request_*`。

---

## 3. 决策点矩阵

| 决策点 | 候选 | LLM 参与 | 说明 |
|---|---|---|---|
| 自摸回合（广麻/莲花） | 补杠 / 暗杠 / 乱风杠 / 出牌 | ✅ | 胡由引擎先行直判，不进入 LLM 候选（默认） |
| 弃牌响应 | 过 / 杠 / 碰 / 吃(每种吃法一个) | ✅ | 点炮胡由引擎先行直判（`ctx.canHu` → win） |
| 自摸胡 / 点炮胡 / 抢杠胡 | win / pass | ❌ 引擎直判 | 现有行为不变；§10.3 配置可放开 |
| 真人超时/断线代打 | — | ❌ | 永不挂 LLM |
| AI vs AI 纯观战局 | — | ✅（空座均为 LLM） | 由房间开关自然支持 |

---

## 4. 候选动作枚举

### 4.1 回合候选（自摸后补摸 / skipDraw 出牌）

| 候选 | 生成条件（引擎） | action |
|---|---|---|
| 补杠 `added-kong` | 碰副露 + 手牌含同牌（`can_added_kong` 语义） | `{kind:'added-kong', meldIndex}` |
| 暗杠 `concealed-kong` ×N | `concealedKongs(hand)` 每个牌面一个 | `{kind:'concealed-kong', tile}` |
| 乱风杠 `wind-kong`（仅莲花） | 东南西北各 ≥1（`windKong`） | `{kind:'wind-kong'}` |
| 出牌 `discard` ×M | **按牌面去重**：同牌多张合成一个候选 | `{kind:'discard', handIndex: hand.indexOf(tile)}` |

规则：

- **按牌去重**：手牌 `3万 3万 5万` 只出候选"出 3万""出 5万"两个；执行时映射到第一张。消除"打哪张 3万"的无意义分支，大大降低 LLM 混淆率。
- **胡候选不进 LLM**：引擎先判 `isWinningHand`（广麻白板癞子 / 莲花翻精+白板替换），命中直接返回 `win`（与现有 `decideTurn` 优先级一致）。
- 候选数上限：出牌去重后一般 8~12 个 + 杠 ≤3 个，全量列入 prompt（不裁剪、不合并"其余"）。

### 4.2 弃牌响应候选

| 候选 | 生成条件（引擎） | action |
|---|---|---|
| 过 `pass` | 恒合法 | `{kind:'pass'}` |
| 杠 `gang` | `claim_capabilities.can_gang` | `{kind:'gang'}` |
| 碰 `peng` | `claim_capabilities.can_peng` | `{kind:'peng'}`（**不带 discardIndex，见 4.3**） |
| 吃 `chi` ×N（仅莲花） | `chiOptions` 每种吃法一个 | `{kind:'chi', optionIndex}` |

排序：候选按"可执行性"分组 → 杠 / 碰 / 吃 / 过；吃按 `chiOptions` 原序。编号 `A1..An` 在本次请求内唯一。

### 4.3 碰 / 吃后出牌：v1 采用两步决策

- LLM 在 claim 请求里**只回答** `pass / gang / peng / chi`，不预选碰后出的牌；
- 碰/吃成功后进入 skipDraw 回合，引擎再次发起 `request_turn`，LLM 再决策出牌（与真人路径一致，零引擎改动）；
- 现有启发式 AI 的"单次碰+出牌闭环"（discardIndex 预计算）**不用于 LLM**。代价：多一次 LLM 调用（~1.5s）与一次节奏停顿，换来 prompt 单一职责 + 手牌状态新鲜准确。一步闭环列 v2。

---

## 5. 引擎特征表（每个候选一组）

> 原则：特征由引擎计算，**档位化不出现原始分**（LLM 会对数字权重过度解读）；"听口剩余数"除外（这是资源直觉量，给数字）。

| 特征字段 | 含义 | 计算来源（现状） | 广麻 | 莲花 |
|---|---|---|---|---|
| `ready` | 打出后是否听牌 | `waitingTiles(打出后)` 非空 | ✅ | ✅ |
| `waits[]` | 听口明细 `{tile, remaining}` | `computeTingInfo` 逻辑（莲花已有；广麻新增简化版） | 新增 | ✅ |
| `effectiveRemaining` | 听口有效剩余总数 | Σ(4 − 可见张数)，可见 = 己手+牌河+副露 | 新增 | ✅ |
| `specialPattern` | 特殊牌型潜力 | `specialPatternScore`：十三烂/七星/十三幺/七对（莲花）；广麻无特殊牌型，标 `none` | N/A | ✅ |
| `safety` | 安全度档位（高/中/低） | 牌河出现 3/2/1 张 + 跟打上家 +12 + 1·4·7 软关系（莲花 `publicSafetyScore`）；广麻用简化版（牌河张数 + 跟打） | 新增 | ✅ |
| `efficiency` | 基础牌效档位（优/中/差） | 对子×4 + 靠张×2 + 字牌罚分（现有启发式） | ✅ | ✅ |
| `isEngineSuggestion` | 引擎建议标记（现有启发式 top-1 对应的候选） | 决策时先跑一次现有 `decideTurn`/`decideClaim` 并标记 | ✅ | ✅ |
| `risks` | 风险提示 | 补杠：该牌河中出现张数（被抢杠概率）、是否破坏听牌（莲花 `shouldTakeAddedKong` 已有）；暗杠/风杠：是否破坏听牌 | 简化 | ✅ |

档位映射约定（实现统一，前后端一致）：

- `safety`：河 0 张 = 低；1 张 = 中；≥2 张 或 与上家刚打相同 = 高（广麻简化版）；莲花按 `publicSafetyScore` 阈值 [0,8)=低、[8,20)=中、≥20=高。
- `efficiency`：原始分 0·4 档归并 —— [0,6)=差、[6,12)=中、≥12=优（占位约定，实现时按两套启发式实测校准入档，**须在本文档修订**）。

---

## 6. 状态编码

### 6.1 牌名映射（prompt 一律用中文）

| 内部 | 文本 | 内部 | 文本 |
|---|---|---|---|
| `m1`~`m9` | 1万~9万 | `east` | 东 |
| `p1`~`p9` | 1筒~9筒 | `south` | 南 |
| `s1`~`s9` | 1条~9条 | `west` | 西 |
| `red` | 红中 | `north` | 北 |
| `white` | 白板（广麻=癞子牌面） | `green` | 发 |

### 6.2 可见状态（来自 ctx，前后端同构）

```json
{
  "ruleCode": "lianhua_guangma | lotus-legacy",
  "hand": ["3万","5万","白板","东","东"],
  "melds": [{"type":"peng","tile":"5筒","tiles":["5筒","5筒","5筒"]}],
  "snapshots": {
    "self":  {"discards": ["1万","9万"]},
    "upper": {"discards": ["2筒","5筒","6万"], "melds": []},
    "opposite": {"discards": ["北","红中"]},
    "lower": {"discards": ["9条","9条"]}
  },
  "upperLastDiscard": "6万",
  "jokers": ["白板"],
  "wallCount": 41,
  "earlyRound": false,
  "lateGame": false,
  "scores": [10200, 9800, 10100, 9900],
  "seatWind": "南", "roundWind": "东", "dealerIndex": 0, "roundIndex": 1,
  "dihu": false,
  "kongBloom": false, "skipDraw": false,
  "decision": "turn | claim | chi"
}
```

- **`scores / seatWind / roundWind / dealerIndex / roundIndex / dihu` 是新增"局况"字段**：前端 core + 后端 manager 均作为**可选字段**填充（P1.1 / P2.4 任务）；莲花前端已有部分（`earlyRound` 等），缺的补上。
- `latency` 无关项（如远端暗手）一律不出现；LLM 只见该快照，不自行推断他人手牌。

### 6.3 规则摘要片段（模板按 `ruleCode` 分派，正文随规则集实现校准）

- 广麻（`lianhua_guangma` / 前端 core `DEFAULT_RULESET`）：白板为癞子（可代任意牌）；无吃、无点炮胡；自摸胡；无特殊牌型（标准 4 面子+将）；杠上开花计番。
- 莲花（`lotus-legacy` / 前端 `LOTUS_RULESET`）：翻精癞子（翻出的第 1 张为精=万能，其余按普通牌），白板为精替代；有吃（仅上家）、点炮胡、乱风杠、抢杠胡、杠上开花；特殊牌型：七对、十三幺、十三烂、七星十三烂。
- 摘要必须包含：癞子牌面、是否可吃、点炮胡规则、特殊牌型与番型要点、当前局况（场风/座风/庄家/分数）。

---

## 7. Prompt 规格

### 7.1 通用骨架（system + user 单轮，纯文本，不依赖 function calling）

```
system：
  你是广东麻将桌上的牌友，风格：{style}（style ∈ 激进/稳健/话痨/高冷）。
  你的任务只有两件事：1) 从候选动作列表中选择一个编号；2) 说一句 ≤30 字的牌桌吐槽。
  你绝对不能：输出候选列表之外的编号、解释思考过程、输出多个候选、评价规则合法性。

user：
  【局况】{ruleSummary}｜第{roundIndex}局｜你是{seatWind}家（庄家{dealerName}）｜
          {decisionName}｜剩牌 {wallCount} 张｜分数 {scores}
  【你的牌】{hand}｜【你的副露】{melds}
  【牌河】你：{...}｜上家：{...}｜对家：{...}｜下家：{...}
  【各家副露】...
  【上家刚打】{upperLastDiscard}（跟打通常安全）
  【已见计数】各牌剩张：{remainingMap}（只列和你手牌/听口相关的牌）
  {specialNote}   // 莲花：当前听牌/特殊牌型潜力提示；广麻：无

  {engineSuggestion}  // 例如：引擎建议：出 3万（候选 A1）。你可以不采纳，但这是很稳的选择。

  【候选动作】（必须从中选一个，编号不要写错）：
  A1 出3万  ｜打出后听牌：2万(剩3)、5万(剩2)，共7张｜安全度：低｜牌效：优
  A2 出7万  ｜不听牌（向听1）｜安全度：中｜牌效：差
  A3 补杠5筒 ｜+6分｜风险：河0张，被抢概率较高
  A4 过     ｜（仅响应请求存在）

  【输出】严格 JSON，不要输出任何其他内容：
  {"choice": "A1", "message": "就你了！"}
  choice 必须是上面列出的编号；message 可省略（输出空字符串或省略字段）。
```

### 7.2 输出解析（与 weqi parser 同模式，容错）

1. 先整体 `JSON.parse`；失败则提取文本中第一个 `{...}` 片段再解析；
2. `choice` 非空 → 对照本次请求候选 ID 白名单；
3. `message` 缺失视为空；超 30 字截断；
4. 候选白名单校验不过 → **反馈重试一次**：把上次 `choice` 与合法编号列表追加进 prompt（"你上次选了 A9，它不在合法列表；合法：A1~A8。请重新选择"）→ 再失败 → 引擎建议。

### 7.3 温度与采样（前后端一致默认值）

`temperature: 0.4`（既有风格又可控）、`max_tokens: 64`（choice+短句足够）、`top_p: 1`、不启用 `response_format`（部分兼容端不支持，靠解析容错）。

---

## 8. 校验与回退链

### 8.1 前端（master 本地单机）

- 引擎二次校验**已存在**（`handleAction` 逐类型复核：win 验手牌、added-kong 验副露+含牌、concealed-kong 验 `concealedKongs`、discard 验 `handIndex` 范围；claim 复核 `canGang/canPeng/chiOptions`）——LLM 输出非法时走既有 fallback（丢弃/过/打最后一张），**但** LLM 控制器仍须先自校验，避免把明显错误交给引擎兜底造成"打最后一张"的体验劣化。
- 自校验规则与 §8.2 后端**完全一致**（共用本文档第 4 节枚举表）。

### 8.2 后端（联机空座，强制自校验——manager 对 AI 动作不复核！）

`LLMPlayer` 返回动作前必须逐类型校验（任一不合法 → 引擎建议回退）：

| action | 校验 |
|---|---|
| `win` | `ctx.canHu`（turn）/ `claimant.canHu`（claim） |
| `added-kong` | meldIndex 为整数且 `melds[i].type=='peng'` 且手牌含 `meld.tile` |
| `concealed-kong` | `tile ∈ rules.concealed_kongs(hand)` |
| `wind-kong` | `canWindKong` |
| `discard` | `handIndex` 为整数、`0 ≤ handIndex < len(hand)` |
| `gang` | `claim_capabilities.can_gang` |
| `peng` | `claim_capabilities.can_peng` |
| `chi` | `optionIndex` 为整数且 `0 ≤ optionIndex < len(chiOptions)` |
| `pass` | 恒合法 |

> 后端 manager 现有行为：turn 的 `win` 直接 `end_game`、`added-kong` 直接下标访问 `melds`、`chi` 直接 `chiOptions[optionIndex]` —— 越界会 **IndexError 崩房**；`peng` 带越界 `discardIndex` 会静默返回导致**卡死**。自校验是硬性要求，任何回退实现不得绕过。

### 8.3 失败链（前后端统一）

```
LLM 调用成功 → 解析 → 自校验通过 → 返回动作
LLM 调用成功 → 解析/校验失败 → 反馈重试(1 次) → 仍失败 → 引擎建议
LLM 调用超时(8000ms) / 网络失败 / HTTP 非 2xx / API 错误 → 引擎建议（不重试）
```

- "引擎建议"= 在候选枚举阶段同时跑一次现有启发式决策（`decideTurn`/`decideClaim`），存为 `engineSuggestion`；回退即执行它，**零额外耗时**。
- LLMPlayer 的 `request_rob_kong` 不覆盖（继承 AIPlayer：能抢必抢）。

---

## 9. 配置项

### 9.1 前端（localStorage，设置 UI 提供）

| key | 默认 | 说明 |
|---|---|---|
| `llm.enabled` | `false` | 人机是否使用大模型 |
| `llm.baseUrl` | `https://api.deepseek.com/v1` | OpenAI 兼容端点（不带 `/chat/completions`，实现时规范化） |
| `llm.apiKey` | 空 | 仅存本地浏览器；**不落日志、不上传** |
| `llm.model` | `deepseek-chat` | |
| `llm.style` | `稳健` | 激进 / 稳健 / 话痨 / 高冷 |
| `llm.timeoutMs` | `8000` | 单次请求超时 |
| `llm.allowHuDecision` | `false` | 胡决策放开给 LLM（默认引擎直判） |

### 9.2 后端（环境变量，与 ROOM_MAX 同款惯例）

| env | 默认 | 说明 |
|---|---|---|
| `LLM_ENABLED` | `false` | **默认关**：现有测试/冒烟脚本零影响 |
| `LLM_API_BASE` | 空 | |
| `LLM_API_KEY` | 空 | 服务端持有，绝不下发客户端、不写日志 |
| `LLM_MODEL` | `deepseek-chat` | |
| `LLM_TIMEOUT_S` | `8` | |
| `LLM_STYLE` | `稳健` | |
| `LLM_CONCURRENCY` | `4` | 全局 `asyncio.Semaphore` 上限 |

### 9.3 房间开关（联机）

- `POST /api/rooms` body 增加可选 `llmEnabled: bool = false`（`CreateRoomRequest`）；
- `RoomSession.llm_enabled` 保存；`_controllers()` 空座分支据此选 `LLMPlayer` 或 `AIPlayer`（**开局瞬间生效**，join 流程不动）;
- 房间详情响应带 `llmEnabled`（前端显示"🔮 AI 大模型对局"标记）；
- 服务端 `LLM_ENABLED=false` 时，请求携带 `llmEnabled=true` → 忽略并以 `false` 返回（不报错）。

### 9.4 前端创建房间 UI（master）

新建房间对话框增加复选"AI 用大模型补位"（仅当本地已配置 `llm.baseUrl/apiKey` 时显示可勾选；配置未完成时置灰并提示"请在设置中配置 AI"）。**该开关只影响 master 后端房间**；vibehub 分支保留现有行为（v2 再对齐）。

---

## 10. Prompt 与调用参数汇总（实现对照表）

| 项 | 值 |
|---|---|
| 端点 | `{baseUrl}/chat/completions`，`Authorization: Bearer {apiKey}` |
| 消息 | `[system(人设+约束), user(§7.1 模板)]` |
| 温度 / max_tokens | 0.4 / 64 |
| 重试 | 非法 choice 反馈重试 1 次；语言/格式不重试 |
| 超时 | 8000ms（前端 fetch AbortController / 后端 asyncio.wait_for） |
| 解析 | 整体 JSON → 提取 `{...}` → 编号白名单 |
| 成本参考 | 每决策输入 ~600~900 token、输出 ≤64；一局每 AI ~30 次决策；deepseek-chat 一局 < 0.05 元 |

---

## 11. 前端接入点（P1 任务索引）

| 任务 | 文件 | 内容 |
|---|---|---|
| 1.1 | `src/game/core/controllers/playerController.ts` + `src/game/core/local/localTurnOrchestrator.ts` | `TurnContext`/`ClaimContext` 加可选字段；orchestrator 照搬莲花 `visibleTilesFor`/`publicTilesFor`/`upperLastDiscardFor`/`earlyRoundFor`/`wallCount` 填充；局况字段（scores/seatWind/roundWind/dealer/roundIndex） |
| 1.2 | `src/game/core/controllers/`（新 `aiFeatures.ts` 或并入 llm 模块） | 广麻特征：听口明细+剩余数、安全度简化版；档位化 |
| 1.3 | `src/game/llm/`（新） | `candidates.ts`（枚举+引擎建议）、`prompt.ts`（两模板）、`client.ts`（fetch+解析+重试）、`llmController.ts`（`LlmController`+`LotusLlmController`） |
| 1.4 | `src/components/llm/`（新，**非 keep 路径**） + 人机创建入口 | 设置表单（provider/风格/开关）；人机流程接入 |
| 1.5 | 测试 | 见 §13 |

莲花侧（`src/game/variants/lotus/lotusControllers.ts` + `lotusAi.ts`）特征基本现成（`visibleTiles/publicTiles/jokers/upperLastDiscard/earlyRound/wallCount` 已在 context），仅需格式化成特征行。

---

## 12. 后端接入点（P2 任务索引）

| 任务 | 文件 | 内容 |
|---|---|---|
| 2.1 | `backend/app/llm/`（新） | 候选枚举（复用 rules 方法与 `AIPlayer` 决策为引擎建议）、prompt 构建（与前端同规格）、httpx.AsyncClient + Semaphore + 超时 |
| 2.2 | `backend/app/game/llm_player.py`（新） | `LLMPlayer(AIPlayer)`：覆盖 `request_turn/request_claim`；自校验（§8.2 表）；回退 `super()` |
| 2.3 | `backend/app/api/rooms.py` + `backend/app/game/room.py` | `llmEnabled` 字段 + 存储 + `_controllers()` 分支 + 详情返回 |
| 2.4 | `backend/app/game/manager.py` | ctx 追加局况可选字段（scores/seatWind/roundWind/dealerIndex/roundIndex/dihu） |
| 2.5 | 测试 | 见 §13 |

---

## 13. 测试规格

| 层 | 用例 | 断言 |
|---|---|---|
| 前端（vitest，mock fetch） | prompt 快照（两规则各一） | 与规格一致 |
| | 解析：合法 choice | 映射成正确动作命令 |
| | 非法 choice → 反馈重试 → 引擎建议 | 调用顺序 2 次 + 回退动作 |
| | 超时（fake timers） | 直接引擎建议 |
| | 按牌去重候选（`3万 3万 5万` → 2 个候选） | 候选数与 choice→index 映射 |
| | sim 整局：`useGame.sim.test.ts` 换 LlmController（mock 固定 choice） | 完整打完，无卡死 |
| 后端（pytest，monkeypatch LLM client） | `LLMPlayer` 合法路径 | 返回动作经自校验 |
| | `added-kong` 越界 / `chi` optionIndex 越界 / `discard` 越界 | 回退引擎建议，不抛异常 |
| | 超时 / HTTP 异常 | 回退引擎建议 |
| | 集成：llmEnabled 房间 2 真人 + 2 LLM 座（mock）打满一场 | 完成且无 `IndexError` |
| 回归 | 现有全部测试（前端 vitest + 后端 pytest + 冒烟脚本） | 全绿（LLM 未激活路径逐字节不变） |

---

## 14. 验收标准（DoD）

**P1（本地单机）**：

- [ ] 设置页可配置 provider 三字段 + 风格 + 开关；配置缺失时人机禁用 LLM 并有提示；
- [ ] 选"大模型"后，广麻与莲花人机各完整打完一局，无卡死、无非法动作上桌；
- [ ] 断网 / 超时 / 供应商返回错误时自动回退启发式，玩家无感知（除稍慢）；
- [ ] 浏览器直连所选供应商（CORS 实测通过），key 仅存 localStorage；
- [ ] 现有单测/模拟测试全绿；新 mock 测试覆盖三路径。

**P2（联机空座）**：

- [ ] `POST /api/rooms` 带 `llmEnabled=true` → 空座由 LLM 补位打满整场（2 真人 + 2 LLM 座）;
- [ ] LLM 宕机/超时 → 自动回退启发式，对局不卡、不崩、不出现"打最后一张"现象；
- [ ] 真人超时/断线代打仍为启发式（`RemotePlayer._ai` 未改动）;
- [ ] 服务端未配置 LLM（`LLM_ENABLED=false`）时 `llmEnabled` 静默降级为 false；
- [ ] 现有测试/冒烟脚本全绿（默认关闭零影响）。

---

## 15. 排期摘要

| 阶段 | 内容 | 工作量 |
|---|---|---|
| P0 | 本文档 | 0.5 人日（已完成） |
| P1 | 前端本地人机 | 4~5 人日 |
| P2 | 后端联机空座 | 3~4 人日（P0 后可与 P1 并行） |
| P3 | 打磨（日志/提示/README） | 0.5~1 人日 |

单人串行 8.5~11 人日；前后端并行 6~7 天。P0→P1.1→P1.2→P1.3→P1.4/1.5；P2.1→P2.2→P2.3/2.4→P2.5（与 P1.3 仅共享本文档）。

## 16. 分支同步注意事项

- 所有实现改动在 **master** 开发并提交，随后 `pnpm sync:vibehub`（脚本要求工作区干净）。
- 新文件 `src/game/llm/*`、`src/components/llm/*`、`docs/llm-ai-design.md` 均为共享文件 → 随 master 同步到 vibehub，无联机特定改造，同步无损。
- **不要改动 keep 清单文件**：`src/components/lobby/*`（开关 UI 如需放这需按清单规则先在 master 改、vibehub 保留自己的版本）。建房间开关优先放非 keep 的新组件。
- `backend/` 是独立 git 仓库，P2 改动在 `backend/` 内单独 commit。

## 17. v2 候选清单（本文档不冻结）

向听数引擎量（复用 isWinningHand 分解；唯一值得新写的引擎特征）｜联机用户自填 provider｜message 与决策解耦（异步生成吐槽）｜碰/吃一步闭环（discardIndex 预选）｜胡决策开关放开｜4×LLM vs 4×启发式 AI 后台评测（胜率/违规率）做 prompt 迭代｜多模型切换 UI｜vibehub 空座补位复用前端 LlmController。

## 18. 开放问题（实现前需确认）

1. **档位阈值校准**：§5 的 `safety`/`efficiency` 档位阈值（广麻简化版、莲花阈值）在实现时用真实对局数据校准入档后，须回写本文档；
2. **提示文案**：默认风格"稳健"的 system 措辞，P1 联调时按实际效果微调（同样回写文档）。
