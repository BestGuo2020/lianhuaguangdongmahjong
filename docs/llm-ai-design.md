# 大模型 AI 接入设计规范（LLM-AI Design Spec）

> 版本：v1.1（实现前冻结候选）
> 状态：待实现；协议、兜底与安全条款已冻结，特征阈值仍需校准后再发布 v1.2
> 适用范围：莲花广麻（白板癞子）与莲花麻将（翻精癞子）两种规则的人机对局。
> 本文档是前端（TypeScript）与后端（Python）实现的**唯一规格依据**，但不直接替代类型定义；前后端必须通过 §6.4 的规范 JSON 协议和 golden fixture 对齐。任何实现变更先改本文档。

---

## 1. 目标与范围（v1.1 实现前冻结候选）

**目标**：给"人机"接入大模型做决策。采用**混合方案**——引擎枚举合法候选并计算特征（听口 / 安全度 / 牌效等），LLM 只在编号候选中做选择并输出人设吐槽；非法、超时、失败一律回退现有启发式 AI。

| 范围 | 内容 | Key 存放 |
|---|---|---|
| ✅ v1-in | 本地单机人机（广麻 + 莲花） | 前端设置页用户填写，存 localStorage，**浏览器直连供应商** |
| ✅ v1-in | 联机房间空座 AI 补位（master WebSocket 房间） | 服务端环境变量（id=default 的单提供商） |
| ✅ v1-in | 联机空座**每座位独立大模型**（服务端注册多个提供商，不同模型/风格 + 各自头像昵称） | **全在服务端**（`LLM_PROVIDER_*`），客户端只引用 provider id（见 §9.7） |

| 明确排除 | 原因 |
|---|---|
| ❌ 真人超时 / 断线 AI 代打挂 LLM | 可靠性兜底，永不依赖外部服务（`RemotePlayer._ai` 保持启发式） |
| ❌ 本地请求走后端代理 | 前端直连；CORS、HTTPS 与 Key 边界见 §9.1、§9.5。Key 只发送给用户选择的供应商，不发送到本项目后端 |
| ❌ 联机客户端携带 Key（旧「每座自带配置」） | 已废弃：key 会经过玩家自建后端，玩家与运营者信任边界混淆；统一为服务端多提供商 |
| ❌ vibehub 分支的联机开关 | 其 lobby / 联机层为独立实现（keep 清单）；该功能随 master 同步，vibehub 空座补位复用前端控制器属 v2 |

**硬约束**：

1. LLM 只能从引擎枚举的候选编号中选择，**不做任何合法性判断**；候选动作由引擎在执行前再次校验。
2. 仅“解析失败 / choice 不在白名单”允许反馈重试 1 次；超时、取消、网络错误、HTTP 错误、并发排队超时直接回退引擎建议，详见 §8.3。
3. v1 默认不把胡交给 LLM：`canHu` 命中时由引擎/控制器短路返回 `win`；`allowHuDecision` 暂不纳入 v1，若未来放开必须新增协议与测试。
4. 未激活 LLM 时，游戏行为、结果和控制器决策路径与现状等价；新增网络字段允许按向后兼容方式出现，不再承诺字节级 payload 不变。
5. 每次请求都带 `schemaVersion`、`requestId` 和 `stateVersion`；状态变化、换局、重置或房间关闭后，旧响应必须丢弃。

---

## 2. 架构与数据流

```
┌─ 控制器层（保留现有接口，新增适配器）──────────────────────┐
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
│  5. 解析 choice → 规范动作 → 自校验（前后端均强制）              │
│  6. 失败链：语义重试(1 次) → 引擎建议；网络/超时直接回退       │
└──────────────────────────────────────────────────────────┘
               │ 引擎动作（由各端适配为内部 kind / WS type）
┌──────────────▼───────────────────────────────────────────┐
│ 引擎执行层（现有，零改动）：动作应用、规则复核、动画、广播        │
└──────────────────────────────────────────────────────────┘
```

**关键点**：LLM 策略层输出的是 §6.4 定义的规范动作，再由前端/后端适配为各自现有接口。不能假设内部 `kind` 与 WS `type` 或莲花的 `meld` / `optionIndex` 结构相同；控制器、游戏循环和动画尽量不动，但动作校验与请求上下文需要接入 `requestId/stateVersion`。

**前端**（本地单机）：新增 `LlmController implements PlayerController` / `LotusLlmController implements LotusController`，内部调用统一 LLM 策略层；`requestDiscardHu`、`requestRobKong` 默认委托现有直判/启发式，不进入 LLM。失败回退现有 `AiController` / `LotusAiController` 决策。

**后端**（联机空座）：新增 `LLMPlayer(AIPlayer)`，覆盖 `request_turn` / `request_claim`，内部"引擎建议 + LLM 调用 + 自校验"；`canHu` 命中时先按 §3 的 v1 规则短路返回 `win`；抢杠胡继承现有启发式。失败回退 `super().request_*`。

---

### 2.1 规范请求与适配边界

前后端共享以下逻辑协议，具体 TypeScript/Python 类型和现有控制器接口由适配器转换：

```ts
type DecisionKind = 'turn' | 'claim' | 'discard_hu' | 'rob_kong'

interface DecisionRequest {
  schemaVersion: 1
  requestId: string
  stateVersion: string
  ruleCode: 'lotus-classic' | 'lotus-legacy'
  decision: DecisionKind
  state: CanonicalGameState   // §6.2 的 StateSnapshotV1
  candidates: Candidate[]
  engineSuggestion?: string
}

interface Candidate {
  id: string                 // 本次请求内唯一，如 A1
  label: string              // 仅用于 Prompt 展示
  action: CanonicalAction   // 规范动作，不直接等同 WS 报文
  features: CandidateFeatures
  legalityKey: string        // 引擎状态摘要，用于执行前复核
}

interface CandidateFeatures {
  ready: boolean | 'unknown'
  waits: Array<{ tile: string, remaining: number }> | 'n/a'
  effectiveRemaining: number | 'n/a'
  specialPattern: string | 'none' | 'n/a'
  safety: '高' | '中' | '低' | 'unknown' | 'n/a'
  efficiency: '优' | '中' | '差' | 'unknown' | 'n/a'
  scoreDeltaBand?: '高' | '中' | '低' | 'n/a'
  risks: string[]
}
```

`claim` 内的吃牌统一使用 `optionIndex`；前端 Lotus 控制器收到后再映射为 `ChiMeld`。`discard_hu` 和 `rob_kong` 在 v1 不调用 LLM，但仍保留在协议枚举中，避免遗漏现有控制器方法。

## 3. 决策点矩阵

| 决策点 | 候选 | LLM 参与 | 说明 |
|---|---|---|---|
| 自摸回合（广麻/莲花） | 补杠 / 暗杠 / 乱风杠 / 出牌 | ✅ | 先判 `canHu`；命中时 v1 直接 `win`，不进入 LLM 候选 |
| 弃牌响应 | 过 / 杠 / 碰 / 吃(每种吃法一个) | ✅ | 点炮胡在进入 claim LLM 前由引擎短路为 `win` |
| 自摸胡 / 点炮胡 / 抢杠胡 | win / pass | ❌ | v1 由引擎/现有启发式处理，`allowHuDecision` 不属于 v1 |
| 真人超时/断线代打 | — | ❌ | 永不挂 LLM |
| AI vs AI 纯观战局 | — | ✅（空座均为 LLM） | 由房间开关自然支持 |

---

## 4. 候选动作枚举

### 4.1 回合候选（自摸后补摸 / skipDraw 出牌）

| 候选 | 生成条件（引擎） | action |
|---|---|---|
| 补杠 `added-kong` | `skipDraw=false`、碰副露 + 手牌含同牌（`can_added_kong` 语义） | `{kind:'added-kong', meldIndex}` |
| 暗杠 `concealed-kong` ×N | `skipDraw=false`、`concealedKongs(hand)` 每个牌面一个 | `{kind:'concealed-kong', tile}` |
| 乱风杠 `wind-kong`（仅莲花） | `skipDraw=false`、东南西北各 ≥1（`windKong`） | `{kind:'wind-kong'}` |
| 出牌 `discard` ×M | **按牌面去重**：同牌多张合成一个候选 | `{kind:'discard', handIndex: hand.indexOf(tile)}` |

规则：

- **按牌去重**：手牌 `3万 3万 5万` 只出候选"出 3万""出 5万"两个；执行时映射到第一张。消除"打哪张 3万"的无意义分支，大大降低 LLM 混淆率。
- **胡候选不进 LLM**：引擎先判 `isWinningHand`（广麻白板癞子 / 莲花翻精+白板替换），命中直接返回 `win`（与现有 AI 优先级一致）。`skipDraw=true` 时不允许自摸胡和任何杠。
- 候选数不设会改变合法性的硬上限；必须全量列入 prompt。若 Prompt 超过供应商最小上下文窗口，直接回退引擎建议，不得裁剪合法候选。

### 4.2 弃牌响应候选

| 候选 | 生成条件（引擎） | action |
|---|---|---|
| 过 `pass` | 恒合法 | `{kind:'pass'}` |
| 杠 `gang` | `claim_capabilities.can_gang` | `{kind:'gang'}` |
| 碰 `peng` | `claim_capabilities.can_peng` | `{kind:'peng'}`（**不带 discardIndex，见 4.3**） |
| 吃 `chi` ×N（仅莲花） | `chiOptions` 每种吃法一个 | `{kind:'chi', optionIndex}` |

排序：候选按"可执行性"分组 → 杠 / 碰 / 吃 / 过；吃按规范化后的 `optionIndex` 升序。编号 `A1..An` 在本次请求内唯一；牌面排序使用 §6.1 的固定顺序，不能依赖 JS/Python 的集合迭代顺序。

### 4.3 碰 / 吃后出牌：v1 采用两步决策

- LLM 在 claim 请求里**只回答** `pass / gang / peng / chi`，不预选碰后出的牌；规范动作中的 `chi` 使用 `optionIndex`，由前端适配为 `ChiMeld`；
- 碰/吃成功后进入 skipDraw 回合，引擎再次发起 `request_turn`，LLM 再决策出牌（与真人路径一致，零引擎改动）；
- 现有启发式 AI 的"单次碰+出牌闭环"（discardIndex 预计算）**不用于 LLM**。代价：多一次 LLM 调用（~1.5s）与一次节奏停顿，换来 prompt 单一职责 + 手牌状态新鲜准确。一步闭环列 v2。`peng/chi` 自校验还必须确认副露后仍存在可弃牌状态。

---

## 5. 引擎特征表（每个候选一组）

> 原则：特征由引擎计算，**档位化不出现原始分**（LLM 会对数字权重过度解读）；"听口剩余数"除外（这是资源直觉量，给数字）。

| 特征字段 | 含义 | 计算来源（现状） | 广麻 | 莲花 |
|---|---|---|---|---|
| `ready` | 该候选执行后、再弃一张的结果是否听牌 | `waitingTiles(postAction)` 非空；`pass/gang` 无法计算时为 `unknown` | ✅ | ✅ |
| `waits[]` | 听口明细 `{tile, remaining}` | `computeTingInfo` 逻辑（莲花已有；广麻新增简化版） | 新增 | ✅ |
| `effectiveRemaining` | 听口有效剩余总数（估计值） | Σ(物理剩余张数)，计入己手、牌河、副露、已公开翻精/花牌等 | 新增 | ✅ |
| `specialPattern` | 特殊牌型潜力 | `specialPatternScore`：十三烂/七星/十三幺/七对（莲花）；广麻无特殊牌型，标 `none` | N/A | ✅ |
| `safety` | 安全度档位（高/中/低） | 牌河出现 3/2/1 张 + 跟打上家 +12 + 1·4·7 软关系（莲花 `publicSafetyScore`）；广麻用简化版（牌河张数 + 跟打） | 新增 | ✅ |
| `efficiency` | 相对牌效档位（优/中/差） | 候选集合内的确定性排序，不暴露原始启发式分 | ✅ | ✅ |
| `scoreDeltaBand` | 候选动作带来的即时自身收益档位 | 在克隆分数状态上调用规则集杠分/收益结算器，再按规则集阈值映射；无即时收益时为 `n/a` | ✅ | ✅ |
| `isEngineSuggestion` | 引擎建议标记（确定性 top-1 对应的候选） | 决策时先跑一次无随机的 `decideTurn`/`decideClaim` 并标记 | ✅ | ✅ |
| `risks` | 风险提示 | 补杠：该牌河中出现张数（被抢杠概率）、是否破坏听牌（莲花 `shouldTakeAddedKong` 已有）；暗杠/风杠：是否破坏听牌 | 简化 | ✅ |

`CandidateFeatures` 的字段必须允许 `unknown` / `n/a`，因为 `pass`、`gang` 和“执行后还需弃牌”的动作没有统一的 post-action 听口定义。每种规则集必须提供 golden fixture，前后端逐字段比对。

档位映射约定（实现统一，前后端一致）：

- `safety`：河 0 张 = 低；1 张 = 中；≥2 张 或 与上家刚打相同 = 高（广麻简化版）；莲花按 `publicSafetyScore` 阈值 [0,8)=低、[8,20)=中、≥20=高。
- `efficiency`：先按候选集合内的确定性排序映射为优/中/差；禁止直接使用包含随机扰动或跨规则集不可比的原始分。阈值校准完成后再发布 v1.2，并回写本文档。
- `efficiency` 的同分候选必须按以下顺序稳定 tie-break：§6.1 固定牌面顺序 → `candidates.ts` 的候选枚举顺序（§4.1/§4.2，实现中唯一的排序事实来源）→ `meldIndex` / `handIndex` / `optionIndex` 数值顺序 → 候选 ID 字典序。
- `scoreDeltaBand` 由规则集在克隆分数状态上计算：补杠使用 added-kong 结算逻辑，暗杠/乱风杠使用对应 concealed/风杠结算逻辑；当前广麻也有杠分，不能默认标记为 `n/a`。仅无即时分数收益的动作标记 `n/a`。档位阈值与 `safety`/`efficiency` 一起在 v1.2 校准后回写本文档（开放问题 #1）；v1 实现先使用杠分数值的相对档位。
- Prompt 中不写死“补杠 +6 分”等规则无关数值；若展示收益，只能使用规则集计算出的 `scoreDeltaBand`。

---

## 6. 状态编码

### 6.1 牌名映射（prompt 一律用中文）

| 内部 | 文本 | 内部 | 文本 |
|---|---|---|---|
| `m1`~`m9` | 1万~9万 | `east` | 东风 |
| `p1`~`p9` | 1筒~9筒 | `south` | 南风 |
| `s1`~`s9` | 1条~9条 | `west` | 西风 |
| `red` | 红中 | `north` | 北风 |
| `white` | 白板（广麻=癞子牌面） | `green` | 发财 |

### 6.2 可见状态（来自 ctx，前后端同构）

```json
{
  "schemaVersion": 1,
  "requestId": "turn-42-0007",
  "stateVersion": "round-2-action-118",
  "ruleCode": "lotus-legacy",
  "hand": ["3万","5万","白板","东风","东风"],
  "melds": [{"type":"peng","tile":"5筒","tiles":["5筒","5筒","5筒"]}],
  "snapshots": {
    "self":  {"discards": ["1万","9万"]},
    "upper": {"discards": ["2筒","5筒","6万"], "melds": []},
    "opposite": {"discards": ["北风","红中"]},
    "lower": {"discards": ["9条","9条"]}
  },
  "upperLastDiscard": "6万",
  "jokerTiles": ["5万"],
  "wildcardTiles": ["白板"],
  "ordinaryJokers": [],
  "wallCount": 41,
  "earlyRound": false,
  "lateGame": false,
  "scores": [1000, 1000, 1000, 1000],
  "seatWind": "南", "roundWind": "东", "dealerIndex": 0, "roundIndex": 1,
  "dihu": false,
  "kongBloom": false, "skipDraw": false,
  "decision": "turn"
}
```

- **`scores / seatWind / roundWind / dealerIndex / roundIndex / dihu` 是新增"局况"字段**：前端 core + 后端 manager 均作为**可选字段**填充（P1.1 / P2.4 任务）；缺失时必须显式为 `null` 或 `unknown`，不能让 LLM 猜测。分数统一注明单位，不能混用示例中的 10200 与当前实现的 1000 初始分。
- `latency` 无关项（如远端暗手）一律不出现；LLM 只见该快照，不自行推断他人手牌。
- `ruleCode` 线协议只允许 `lotus-classic`（广麻）和 `lotus-legacy`（翻精莲花）；后端内部 `lianhua_guangma` 只能通过显式映射进入协议。
- `jokerTiles` 表示翻精/规则配置的万能牌面；`wildcardTiles` 表示可替代牌面（当前 Lotus 默认包含白板）；`ordinaryJokers` 表示本次按普通牌面计算的精牌。三者不能合并成一个 `jokers` 字段。

### 6.3 规则摘要片段（模板按 `ruleCode` 分派，正文随规则集实现校准）

- 广麻（协议 `lotus-classic`，后端内部 `lianhua_guangma` / 前端 core `DEFAULT_RULESET`）：白板为癞子（可代任意牌）；无吃、无点炮胡；自摸胡；无特殊牌型（标准 4 面子+将）；杠上开花计番。
- 莲花（`lotus-legacy` / 前端 `LOTUS_RULESET`）：翻精癞子（翻出的第 1 张为精=万能，其余按普通牌），白板为精替代；有吃（仅上家）、点炮胡、乱风杠、抢杠胡、杠上开花；特殊牌型：七对、十三幺、十三烂、七星十三烂。
- 摘要必须包含：癞子牌面、是否可吃、点炮胡规则、特殊牌型与番型要点、当前局况（场风/座风/庄家/分数）。

### 6.4 规范动作与状态版本

规范动作使用内部牌面和索引，不直接作为 WS 消息发送：

```ts
type CanonicalAction =
  | { kind: 'win' }
  | { kind: 'added-kong'; meldIndex: number }
  | { kind: 'concealed-kong'; tile: TileType }
  | { kind: 'wind-kong' }
  | { kind: 'discard'; handIndex: number }
  | { kind: 'gang' }
  | { kind: 'peng' }
  | { kind: 'chi'; optionIndex: number }
  | { kind: 'pass' }
```

- `requestId` 对应一次具体请求；`stateVersion` 由引擎在构建上下文时生成。
- LLM 返回后必须再次确认 `requestId/stateVersion` 仍是当前请求；不匹配时丢弃响应并执行引擎建议。
- `state` 只包含当前玩家可见信息：自己的手牌、自己的副露、所有公开弃牌/副露和规则明确公开的翻精/局况；禁止序列化他人暗手或未摸牌牌墙。

---

## 7. Prompt 规格

### 7.1 通用骨架（system + user 单轮，纯文本，不依赖 function calling）

```
system：
  你是{ruleName}牌桌上的牌友，风格：{style}（ruleName ∈ 莲花广麻/莲花麻将）。
  你的任务只有一件事：从候选动作列表中选择一个编号。
  每次都必须提供一句非空且 ≤16 字的牌桌台词；发言频率由展示层统一控制。
  message 只能是牌桌内的自然台词，严禁提及或复述决策机制、内部标识及幕后说明。
  你绝对不能：输出候选列表之外的编号、解释思考过程、输出多个候选、评价规则合法性。

user：
  【局况】{ruleSummary}｜第{roundIndex}局｜你是{seatWind}家（庄家座位 {dealerIndex}）｜
          {decisionName}｜剩牌 {wallCount} 张｜分数 {scores}
  【你的暗手（不含副露/杠组）】{hand}
  【你的副露/杠组（已从暗手移除）】碰：7万×3；明杠：5筒×4；暗杠：东风×4；吃：3条、4条、5条
  【牌河】你：{...}｜上家：{...}｜对家：{...}｜下家：{...}
  【各家副露】...
  【上家刚打】{upperLastDiscard}（跟打通常安全）
  【已见计数】各牌剩张：{remainingMap}（只列和你手牌/听口相关的牌）
  {specialNote}   // 莲花：当前听牌/特殊牌型潜力提示；广麻：无

  {engineSuggestion}  // 对模型展示为「默认参考」，例如：默认参考选择 A1；更高优先级特征明确更好时可偏离。

  【候选动作】（必须从中选一个，编号不要写错）：
  A1 出3万  ｜打出后听牌：2万(剩3)、5万(剩2)，共7张｜安全度：低｜牌效：优
  A2 出7万  ｜听牌：否｜安全度：中｜牌效：差
  A3 补杠5筒 ｜收益档位：中｜风险：河0张，被抢概率较高
  A4 过     ｜（仅响应请求存在）

  【输出】严格 JSON，不要输出任何其他内容：
  {"choice": "A1", "message": "就你了！"}
  choice 必须是上面列出的编号；message 必须非空、≤16 字，且只能说牌桌内的话。
```

Prompt 中的玩家昵称、规则摘要和牌面都视为不可信数据，必须用明确的数据分隔符转义；不把昵称或历史文本当作指令。`message` 只作为展示文本，禁止回写动作或规则状态。

暗手与已成组牌必须分栏展示，副露保留 `peng/chi/gang/angang` 类型并翻译为“碰/吃/明杠/暗杠”。响应弃牌时明确说明：当前弃牌仍是待响应牌，不会因桌面共出现四张同牌而自动并入其他玩家已有碰组。自由台词可以误导牌路意图，但庄家身份、当前弃牌来源以及各家公开吃碰杠必须与快照一致；冲突时使用当前性格的程序兜底台词。

牌路烟雾弹不得自相矛盾：当 `choice` 选择弃牌时，`message` 不能把同一张牌说成“留着、保留、留下、不打、当宝”。控制器按弃牌动作从状态快照取出实际牌名，并同时检查“这张留着”等指代和“发财留着当宝”等点名表达；冲突时回退动作一致的程序弃牌台词。未承诺保留具体牌的情绪、吹嘘和模糊闲聊仍可保留。

杠动作与台词必须区分子类型：`gang` 是响应别人弃牌的“大明杠”，`concealed-kong` 是暗手四张相同牌的“暗杠”，`added-kong` 是碰后补第四张的“补杠”，`wind-kong` 是“乱风杠”。候选标签应直接写明杠型；台词若说出具体杠型必须与动作完全一致，仅笼统说“杠”时才允许匹配任意杠类动作。

### 7.2 输出解析（与 weqi parser 同模式，容错）

1. 先整体 `JSON.parse`；失败时用**平衡括号扫描器**提取 JSON 对象，不能用会被字符串大括号打断的简单正则。扫描器必须维护 `inString` 与 `escaped` 状态：字符串字面量内的 `{`、`}`、`\"`、`\\` 不参与括号平衡计算；
2. 校验 `choice` 必须是字符串且属于本次请求的候选 ID 白名单；忽略未知 JSON 字段；
3. `message` 缺失视为空；非字符串视为无效展示文本；按 Unicode code point 截断至 30 字，移除控制字符后再通过独立事件展示；
4. JSON 解析失败或候选白名单校验不过时，**反馈重试一次**：把上次错误和精确合法 ID 列表追加进 prompt；再失败则执行引擎建议。HTTP 错误、超时、取消、并发排队超时及 `finish_reason=length` 不进入反馈重试；截断不是“选错”，直接执行引擎建议。

### 7.3 温度、采样与流式响应

快速路径默认使用 `temperature: 0.4`、`max_tokens: 64`、`top_p: 1`、`n: 1`；供应商能力矩阵可覆盖其强制采样参数（Kimi K2.5/K2.6 非思考模式使用 `temperature: 0.6`、思考模式使用 `temperature: 1.0`，两者 `top_p` 均为 `0.95`；Kimi K3 不传 `thinking`、`temperature` 或 `top_p`）。单机浏览器客户端的所有模型调用统一发送 `stream: true` 并读取 OpenAI 兼容 SSE；联机后端当前仍保持一次性响应。解析层识别 `delta.reasoning_content`（并兼容 `delta.reasoning`、`delta.thinking`）后立即丢弃原文，只向控制器发送不带内容的进度脉冲；`delta.content` 只在内存中累积，绝不增量展示，流结束后才把完整文本交给 JSON/候选白名单/动作合法性校验。兼容端点忽略 `stream: true` 并返回 `application/json` 时自动回退原有一次性解析。

预置官方 API 与 OrcaRouter 使用独立参数方言：官方域名严格使用厂商原生枚举，`api.orcarouter.ai` 使用聚合层统一枚举，未知自定义中转只使用保守参数。Kimi K2.5/K2.6 普通局面显式关闭思考，疑难局面显式开启；Kimi K3 普通使用 `low + 128`，疑难升级 `high + 512`。GLM-5.3-Flash 始终思考：官方接口普通与疑难都保持官方允许的 `low`，预算分别为 128/1024；OrcaRouter 因实测行为与官方明显不一致，不再提供新增预设，既有配置仍按普通 `low/512`、疑难 `medium/1024` 兼容并显示警告。完整 GLM-5.3 官方疑难使用 `high`，OrcaRouter 使用 `medium`。若供应商返回 `finish_reason=length`，立即回退启发式，不追加“选错”反馈重试。

条件深思默认开启：候选评分差不超过 8、牌墙不超过 12、对手威胁达到 70、预期分差影响达到 800，或命中 2% 审计抽样时，可切换到供应商思考参数。每个AI座位每小局最多 2 次，全桌整场最多 24 次；开局 `turnOrigin=opening` 时不因“候选接近”或审计抽样升级思考，但杠收益、重大分差等强触发仍有效。可关闭思考的模型在未触发时走快速模式；`always-on` 模型始终调用，额度只限制从低强度升级，不限制普通低强度请求。统计分为“思考请求”（包括 always-on 低强度和实际返回推理流）与“升级请求”（命中触发器并消耗额度）。`always-on` 的普通 low 请求不先展示“让我想想怎么打”等思考台词，也不走该台词的 TTS；收到流式推理块后仍正常展示安全进度气泡。默认模型请求硬截止 40000ms；预置关闭 `timeoutEnabled` 后牌桌请求不设置定时中止。仅自摸/抢杠胡玩法不使用“对手防铳威胁”触发器。已开启、升级或始终思考的模型返回推理块时，按块序号生成“观察公开牌局 / 整理规则约束 / 比较可行动作 / 评估攻守节奏 / 复核选择”等客户端安全进度；生成过程不接触暗手、候选详情或供应商原始推理。每个进度脉冲直接替换气泡中的当前一句，不累积历史、不裁切、不滚动，按普通气泡宽度完整展示。等待期间按性格轮换的状态短句可走 TTS；安全进度与原始推理均不进入普通台词历史、日志、发言限流或 TTS，状态气泡在模型返回或超时前不自动消失。

### 7.4 吐槽展示事件

`message` 不属于 `CanonicalAction`。解析成功后，控制器可通过可选的 `onLlmMessage({ playerIndex, text, requestId })` 事件展示；事件失败、被截断或为空都不能影响动作执行。Prompt 要求每次生成非空台词，但解析器仍容忍缺失；缺失、命中幕后词，或点名/概括未公开暗手牌名、数量、组合、向听与听口时，控制器按动作补一句确定性的自然兜底台词，再交给展示层限流，避免装饰性台词影响出牌或泄露私牌。只有本次即将打出、马上成为公开动作的牌允许在弃牌台词中点名。v1 不要求把吐槽写入回放、结算或持久化记录。

### 7.5 发言限流与播放优先级

`话痨`性格的发言频率是动作级保证：每一次摸牌后的出牌决策都必须生成并展示一句台词，不参与普通全桌冷却、座位冷却或频率抽稀，也不占用其他座位的普通发言冷却。吃、碰、杠、补杠、暗杠、乱风杠与胡牌继续按重要动作直通。该保证只改变发言频率，不放宽台词安全过滤、动作合法性或公开事实一致性校验。

LLM 调用、解析、候选白名单或动作复核失败并转交引擎时，可按同一发言频率显示单字符气泡“？”。该事件不生成 TTS：话痨摸打仍逐次显示，普通动作服从全桌/座位冷却，吃碰杠等重要回退按重要优先级直通。单候选直接采用引擎参考不视为失败，不显示问号。

除上述话痨摸打与重要动作外，普通台词仍按全桌冷却、座位冷却和性格频率抽稀。模型返回合法动作并通过发言准入后先静默合成 TTS；语音真正进入 `playing` 时同步显示气泡，播放进度达到实际时长的一半时才把动作返回引擎。上一条语音未结束时，后一条语音串行等待，但对应动作也仍处于等待状态，因此不会补播已经过期的旧局面。展示与合成前仍过滤“引擎、候选、编号、模型、系统、提示词、AI、基线”等幕后词汇；命中时由控制器换成动作对应的自然兜底台词。通过过滤的台词只保留第一句且最多 16 个 Unicode code point。

静音或音效关闭时，单机客户端必须在请求 TTS 网关之前快速退出：气泡立即出现，动作正常执行，不发起语音合成。合成失败、播放失败、取消或超过表现层总等待上限时同样以气泡兜底并放行动作，任何语音异常都不能改变已经通过合法性校验的动作。联机房间的服务端限流与事件播放仍由各自权威联机层控制，不阻塞房间状态推进。

---

## 8. 校验与回退链

### 8.1 前端（master 本地单机）

- 引擎二次校验逐类型复核：win 验手牌、added-kong 验副露+含牌、concealed-kong 验 `concealedKongs`、discard 验 `handIndex` 范围；claim 复核 `canGang/canPeng/chiOptions`。LLM 控制器仍须先自校验，非法结果统一回退 `engineSuggestion`，不得依赖“打最后一张”掩盖状态错误。
- 校验前后都确认 `requestId/stateVersion`；`skipDraw=true` 时只允许 `discard`，除非规则集明确声明其他动作合法。
- `reset()`、换局、结束和控制器替换必须取消所有未完成 fetch，并使旧响应失效。
- 自校验规则与 §8.2 后端**完全一致**（共用本文档第 4 节枚举表）。

### 8.2 后端（联机空座，强制自校验）

`LLMPlayer` 返回动作前必须逐类型校验（任一不合法 → 引擎建议回退）：

| action | 校验 |
|---|---|
| `win` | v1 只允许引擎短路产生；否则必须是当前 `canHu` |
| `added-kong` | `skipDraw=false`，meldIndex 为整数且 `melds[i].type=='peng'` 且手牌含 `meld.tile` |
| `concealed-kong` | `skipDraw=false` 且 `tile ∈ rules.concealed_kongs(hand)` |
| `wind-kong` | `skipDraw=false` 且 `canWindKong` |
| `discard` | `handIndex` 为整数、`0 ≤ handIndex < len(hand)` |
| `gang` | `claim_capabilities.can_gang` |
| `peng` | `claim_capabilities.can_peng`，且副露后仍有至少一张可弃手牌 |
| `chi` | `optionIndex` 为整数且 `0 ≤ optionIndex < len(chiOptions)` |
| `pass` | 恒合法，但 `canHu` 已在进入 LLM 前短路 |

> manager 不得直接信任 AI/LLM 动作：`meldIndex`、`optionIndex`、`handIndex` 任何越界或状态过期都必须回退引擎建议，不得抛 `IndexError`，不得因空手进入无尽 checking 状态。建议由 `validate_llm_action()` 统一实现，普通 AI 也可复用。

### 8.3 失败链（前后端统一）

```
LLM 调用成功 → 解析 → 自校验通过 → 返回动作
LLM 调用成功 → 解析/choice 校验失败 → 反馈重试(1 次) → 仍失败 → 引擎建议
LLM 调用超时 / 取消 / 网络失败 / HTTP 非 2xx / API 错误 / 并发排队超时 → 引擎建议（不重试）
```

- "引擎建议"= 在候选枚举阶段同时跑一次**无随机、确定性 tie-break** 的启发式决策（`decideTurn`/`decideClaim`），存为 `engineSuggestion`；回退即执行它，**零额外耗时**。
- 总请求预算必须明确：固定 20000ms，包含 semaphore 获取、HTTP、解析和最多一次语义重试；前后端统一采用该总预算。
- LLMPlayer 的 `request_rob_kong` 不覆盖（继承 AIPlayer：能抢必抢）。

---

## 9. 配置项

### 9.1 前端（localStorage，设置 UI 提供）

v2 结构（`llm.providers`，`configVersion: 2`）：多预置 + 按座位分配；v1（`llm.provider` 单预置）首次读取时自动迁移为"默认"预置。

| key | 默认 | 说明 |
|---|---|---|
| `llm.providers` | `{configVersion:2, enabled:false, presets:[], activeId:null, seatIds:[null,null,null]}` | 全部配置载体 |
| `presets[]` | 空 | 每个预置：`{id, name, nickname?, providerType?, baseUrl, apiKey, model, style, timeoutMs, timeoutEnabled}`；`timeoutEnabled` 默认 true，false 表示牌桌请求不设超时；`providerType` 在自定义代理下仍决定供应商参数，旧配置按地址/模型迁移 |
| 座位形象 | — | 对局显示 `昵称（策略）`；头像按策略取 `img/llm/<供应商英文名>/` 四宫格裁切（左上激进/右上稳健/左下话痨/右下高冷；文件夹：deepseek/kimi/qwen/doubao/minimax/gpt/zhipu，未知=custom） |
| `activeId` | 空 | 默认预置 id；未单独指定座位的 AI 使用 |
| `seatIds` | 全空 | 座位 1-3 → 预置 id（null=跟随默认）——**支持不同座位使用不同大模型** |
| `seatStyles` | 全空 | 座位 1-3 → 风格覆盖（激进/稳健/话痨/高冷；null=跟随预置风格）——**支持不同座位不同人设** |
| 常用模板 | — | DeepSeek / Kimi 官方 Moonshot / 通义千问 / 豆包 / MiniMax / OpenAI(GPT) / 智谱官方 GLM / Claude / 自定义（中转站需手动填写） |

- `baseUrl`：OpenAI 兼容端点；规范化后只能追加一次 `/chat/completions`，拒绝包含 userinfo 的 URL；**Key 只发送给用户选择的供应商**；
- 前端必须要求 HTTPS（localhost 开发环境除外），提供"测试连接"和"清除 Key"操作；不能把 Key 拼入 URL、异常文本、埋点或 Prompt。供应商不支持 CORS 时，明确提示用户并保持启发式 AI，不尝试静默代理；
- 请求前先按 Base URL 识别官方、OrcaRouter 或未知兼容方言，再按模型能力追加参数。新增预设只提供官方 API；OrcaRouter 等中转站必须通过“自定义”手动填写。既有中转配置不会自动删除，GLM 异常中转还会显示行为差异警告。

### 9.2 后端（环境变量，与 ROOM_MAX 同款惯例）

Key 只在服务器环境变量/`backend/.env` 中；配置入口是**提供商注册表**（联机空位装配见 §9.7，能力公布见 §9.3）。

**方式 A：多提供商（推荐，联机每座位可用不同模型/风格）**：

| env | 说明 |
|---|---|
| `LLM_PROVIDER_<ID>_BASE_URL` | OpenAI 兼容根地址，如 `https://api.deepseek.com/v1` |
| `LLM_PROVIDER_<ID>_API_KEY` | 服务端持有，绝不下发客户端、不写日志 |
| `LLM_PROVIDER_<ID>_MODEL` | 模型名，如 `deepseek-chat` |
| `LLM_PROVIDER_<ID>_STYLE` | 可选；激进/稳健/话痨/高冷（非法归一稳健） |
| `LLM_PROVIDER_<ID>_NICKNAME` | 可选；缺省按 base URL 推导（DeepSeek=大肥鱼等） |
| `LLM_PROVIDER_<ID>_NAME` | 可选；展示名（缺省=id） |
| `LLM_PROVIDER_<ID>_TIMEOUT_MS` | 可选；单次预算毫秒（缺省按 `LLM_TIMEOUT_S`） |

```bash
# 示例：注册两个提供商（id = 变量名中段，小写）
LLM_PROVIDER_DEEPSEEK_BASE_URL=https://api.deepseek.com/v1
LLM_PROVIDER_DEEPSEEK_API_KEY=sk-xxx
LLM_PROVIDER_DEEPSEEK_MODEL=deepseek-chat
LLM_PROVIDER_DEEPSEEK_STYLE=稳健
LLM_PROVIDER_DEEPSEEK_NICKNAME=大肥鱼
LLM_PROVIDER_KIMI_BASE_URL=https://api.moonshot.cn/v1
LLM_PROVIDER_KIMI_API_KEY=sk-yyy
LLM_PROVIDER_KIMI_MODEL=kimi-k2
```

- 同一供应商可注册多个 id（不同风格/昵称）；字段不完整的条目跳过。
- **中转站 / 聚合 API 同此处理**：baseUrl=中转站地址、key=中转站 key、model=按中转站文档填；
  同中转站可注册多个 id（同 key 不同模型/风格/昵称）——每座位不同模型而 key 不变；
  中转站域名不会命中官方特判（DeepSeek 思考关闭 / Anthropic 头），按普通 OpenAI 兼容处理。
- 未注册任何 `LLM_PROVIDER_*` 时，自动回退**方式 B**（单提供商，`id=default`）——兼容既有部署，行为与旧版一致。

**方式 B：单提供商（兼容，id=default）**：

| env | 默认 | 说明 |
|---|---|---|
| `LLM_ENABLED` | `false` | **默认关**：现有测试/冒烟脚本零影响 |
| `LLM_API_BASE` | 空 | OpenAI 兼容根地址 |
| `LLM_API_KEY` | 空 | 服务端持有，绝不下发客户端、不写日志 |
| `LLM_MODEL` | `deepseek-chat` | |
| `LLM_STYLE` | `稳健` | 出牌风格（仅方式 B 生效；方式 A 用 `<ID>_STYLE`） |

**全局参数（两方式共用）**：

| env | 默认 | 说明 |
|---|---|---|
| `LLM_TIMEOUT_S` | `20` | 单次决策总预算，包含 semaphore 获取与最多一次语义重试 |
| `LLM_POOL_TIMEOUT_S` | `1` | 等待共享并发槽的最长时间，超时直接回退 |
| `LLM_CONCURRENCY` | `4` | 单进程 `asyncio.Semaphore` 上限，不承诺跨 worker 全局限流 |
| `LLM_MAX_REQUESTS_PER_ROOM` | `0` | 单房间请求上限，0 表示仅受服务端默认策略限制 |

**能力与公布**：注册表非空 → `llmAvailable=true`；`GET /api/rooms/meta` 公布 `llmProviders: [{id, name, model, style, nickname, avatar}]`（**不含 key**）。

### 9.3 房间开关（联机）

- `POST /api/rooms` body 增加可选 `llmEnabled: bool = false`（`CreateRoomRequest`）；
- `RoomSession.llm_enabled` 保存请求值；`_controllers()` 在开局瞬间计算 `effectiveLlmEnabled`，据此选 `LLMPlayer` 或 `AIPlayer`；
- `GET /api/rooms/meta` 或创建房间响应增加 `llmAvailable`，表示服务端提供商注册表非空（§9.2）；
- 房间详情同时返回 `llmEnabled`（用户请求值）与 `effectiveLlmEnabled`（本局实际值）；前端只展示后者；
- 服务端不可用时，请求 `llmEnabled=true` 静默降级为 `effectiveLlmEnabled=false`，但响应必须明确告知，不得依赖本地 API Key 判断服务器能力。

### 9.4 前端创建房间 UI（master）

新建房间对话框增加复选"AI 用大模型补位"，仅当服务端 `llmAvailable=true` 时可勾选；本地 `llm.baseUrl/apiKey` 只控制单机人机，不控制联机房间。**该开关只影响 master 后端房间**；vibehub 分支保留现有行为（v2 再对齐）。右下角「🤖 AI 设置」按钮**仅单机模式显示**（联机 provider 由服务端配置，客户端无 key 可配）。

### 9.5 Key、隐私与日志

- 前端 Key 只允许存在带版本的 localStorage 配置中，不能进入 URL、路由、异常、埋点、Prompt、服务器日志或房间消息。
- 后端 Key 只从环境变量读取（`LLM_PROVIDER_*` 或旧全局配置），**不下发客户端、不进任何接口响应**；日志统一使用供应商、模型和错误类别，不记录 Authorization、完整请求体或完整响应体。
- 联机房间（§9.7）Key 全在服务端：客户端请求只携带 `providerId`，不接触任何密钥；`llmProviders` 字段只公布 id/名称/模型/风格/昵称/头像。
- Prompt 含有玩家手牌和局况，发送前必须获得本地用户对第三方供应商的明确授权；默认关闭 LLM。
- 展示型 `message` 必须按纯文本渲染，不能执行 HTML/Markdown，也不能改变动作或局面。

### 9.6 并发、取消与资源预算

- 后端使用进程级共享 `httpx.AsyncClient`，应用关闭时显式关闭；`LLM_CONCURRENCY` 只约束当前进程。
- semaphore 获取、HTTP 连接/读取、响应解析和最多一次语义重试共享 `LLM_TIMEOUT_S` 总预算；等待并发槽超过 `LLM_POOL_TIMEOUT_S` 直接回退。

### 9.7 服务端多提供商装配（联机，v1-in）

服务端注册（配置见 §9.2，Key 不出服务器）；客户端（房主前端）不接触 key。

- **开局** `POST /api/rooms/{id}/start` 携带 `llmSeats: [{seat, providerId}]`（`seat` 0..3 不可重复；`providerId` 须为已注册 id —— 未知/重复 → 409 `INVALID_LLM_SEATS`；大小写不敏感，归一化小写）；
- **装配**：`RoomSession` 内存保存 `{seat: providerId}` + 默认提供商（`id=default` 优先，否则注册表第一个）；`_controllers()` 空位按 `LLMPlayer(config=provider.to_config())` 逐座装配（未指定座位 → 默认提供商）；`effectiveLlmEnabled = llm_enabled && 注册表非空`；注册表为空 → 启发式 AIPlayer（静默降级）；
- **形象**：`_seeds()` 生成 `name = 昵称（策略）` 与 `avatar = img/llm/<供应商英文名>/llm-avatar-<策略>.png`（`app/llm/persona.py`，与前端 persona 规则一致；昵称缺省按 base URL 推导：DeepSeek=大肥鱼等；文件夹：deepseek/kimi/qwen/doubao/minimax/gpt/glm/claude，未知=custom）；
- **前端**：房主在房间面板为每个空位选择服务端提供商（默认=服务器默认，选项显示「昵称（风格）· 名称 模型」）；右下角「🤖 AI 设置」仅单机显示；设置面板只配置单机人机。

---

## 10. Prompt 与调用参数汇总（实现对照表）

| 项 | 值 |
|---|---|
| 端点 | `{baseUrl}/chat/completions`，`Authorization: Bearer {apiKey}` |
| 消息 | `[system(人设+约束), user(§7.1 模板)]` |
| 温度 / max_tokens | 0.4 / 64（完整 GLM-5.3 以及命中条件思考的请求为 512） |
| 重试 | 仅 JSON/choice 语义错误反馈重试 1 次；网络/HTTP/超时不重试 |
| 超时 | 所有供应商的游戏决策统一 40000ms；设置页连接测试单独为 8000ms（前端 AbortController / 后端 `asyncio.wait_for`） |
| 解析 | 整体 JSON → 平衡括号扫描 → 编号白名单 → `finish_reason` 检查 |
| 成本参考 | 只作估算，不写入功能断言；实现需提供每房间/每局请求计数，避免费用失控 |

---

## 11. 前端接入点（P1 任务索引）

| 任务 | 文件 | 内容 |
|---|---|---|
| 1.1 | `src/game/core/controllers/playerController.ts` + `src/game/core/local/localTurnOrchestrator.ts` | `TurnContext`/`ClaimContext` 增加可选局况与状态版本；orchestrator 填充公开状态；`skipDraw`/`requestId` 约束 |
| 1.2 | `src/game/llm/schema.ts` + `src/game/llm/fixtures/`（新） | 规范请求/动作/特征类型、规则 ID 映射、golden fixture；不直接复用 WS 类型 |
| 1.3 | `src/game/llm/`（新） | `candidates.ts`（枚举+确定性引擎建议）、`prompt.ts`（两规则模板）、`client.ts`（fetch+解析+取消+总预算）、`llmController.ts`（两个控制器适配器） |
| 1.4 | `src/components/llm/`（新，**非 keep 路径**） + 人机创建入口 | 设置表单、Key 清除/测试连接、localStorage 版本迁移；人机流程接入 |
| 1.5 | 测试 | 见 §13 |

莲花侧（`src/game/variants/lotus/lotusControllers.ts` + `lotusAi.ts`）特征计算基本现成，但上下文需要补齐 `jokerTiles/wildcardTiles/ordinaryJokers` 并通过适配器转换为规范协议；不能直接把现有 `jokers` 字段原样当成完整癞子状态。

---

## 12. 后端接入点（P2 任务索引）

| 任务 | 文件 | 内容 |
|---|---|---|
| 2.1 | `backend/app/llm/`（新） | 规范 schema、候选枚举、确定性引擎建议、prompt 构建、共享 `httpx.AsyncClient`、Semaphore/pool timeout/房间预算 |
| 2.2 | `backend/app/game/llm_player.py`（新） | `LLMPlayer(AIPlayer)`：覆盖 `request_turn/request_claim`；胡短路、自校验、requestId/stateVersion、失败回退 |
| 2.3 | `backend/app/game/manager.py` + `backend/app/game/player.py` | `validate_llm_action()`、skipDraw/副露后可弃牌约束、状态过期保护；统一内部动作协议 |
| 2.4 | `backend/app/api/rooms.py` + `backend/app/game/room.py` | `llmEnabled/effectiveLlmEnabled/llmAvailable` 字段、能力探测、`_controllers()` 分支 |
| 2.5 | `backend/app/game/manager.py` | ctx 追加局况可选字段（scores/seatWind/roundWind/dealerIndex/roundIndex/dihu），并按规则 ID 规范化 |
| 2.6 | 测试 | 见 §13 |

---

## 13. 测试规格

高手级疑难局面的数据建设、双盲标注、模型 A/B、超时计分与上线闸门，统一见 [《大模型麻将疑难局面评测集建设规范》](./llm-hard-scenario-evaluation.md)。本节继续约束代码级单元与集成测试。

| 层 | 用例 | 断言 |
|---|---|---|
| 前端（vitest，mock fetch） | 规范协议/Prompt golden 快照（两规则、turn/claim 各一） | `schemaVersion`、规则 ID、癞子字段、可见信息、候选顺序与 `scoreDeltaBand` 完全一致 |
| | 解析：合法 choice / 代码块 / 字符串内大括号与转义 / `finish_reason=length` | 合法映射；异常按重试规则处理 |
| | 非法 choice / JSON 解析失败 → 反馈重试 → 引擎建议 | 调用顺序 2 次 + 回退动作；HTTP 错误不重试 |
| | 超时、取消、reset、换局、状态版本过期 | 旧响应丢弃，不改变游戏状态 |
| | 按牌去重候选（`3万 3万 5万` → 2 个候选） | 候选数、稳定顺序与 choice→第一张索引映射 |
| | `skipDraw` 时候选不含杠/胡；`peng/chi` 后仍有可弃牌 | 非法动作不进入引擎执行 |
| | `useGame.sim.test.ts` / `lotusGame.sim.test.ts` 换 LlmController（mock 动态合法 choice） | 完整打完，无卡死、无状态污染 |
| 后端（pytest，monkeypatch LLM client） | `LLMPlayer` 合法路径与 `canHu` 短路 | 返回动作经自校验；胡不进入 LLM |
| | `added-kong` / `chi` / `discard` / stale state 越界 | 回退引擎建议，不抛异常、不 IndexError、不卡死 |
| | 超时 / 取消 / HTTP 401、429、5xx / pool timeout | 直接回退，不触发语义重试 |
| | 规则 ID 映射、jokerTiles/wildcardTiles、能力探测 | 前后端 fixture 一致 |
| | 集成：`llmEnabled` 房间 2 真人 + 2 LLM 座（mock）打满一场 | 完成且无非法动作；响应返回 effective 状态 |
| | Key/Prompt 日志审计、单房间请求预算、并发槽释放 | 不泄露 Key；房间关闭后无悬挂任务 |
| 回归 | 现有全部测试（前端 vitest + 后端 pytest + 冒烟脚本） | 全绿；LLM 未激活路径行为等价、旧客户端可解析新增字段 |

---

## 14. 验收标准（DoD）

**P1（本地单机）**：

- [ ] 设置页可配置 provider 三字段 + 风格 + 开关，支持连接测试、清除 Key 和配置版本迁移；配置缺失或 CORS 不可用时人机禁用 LLM 并有提示；
- [ ] 选"大模型"后，广麻与莲花人机各完整打完一局，无卡死、无非法动作上桌；
- [ ] 断网 / 超时 / 供应商返回错误时自动回退启发式，玩家无感知（除稍慢）；
- [ ] 浏览器直连所选供应商（CORS 实测通过），Key 仅存 localStorage 且不进入日志/后端；
- [ ] 胡牌短路、状态过期、请求取消、Prompt 解析和安全审计测试通过；
- [ ] 现有单测/模拟测试全绿；新 mock 测试覆盖成功、语义重试、直接回退三路径。

**P2（联机空座）**：

- [ ] `POST /api/rooms` 带 `llmEnabled=true` → 空座由 LLM 补位打满整场（2 真人 + 2 LLM 座）;
- [ ] LLM 宕机/超时/HTTP 错误/并发排队超时 → 自动回退启发式，对局不卡、不崩、不依赖"打最后一张"兜底；
- [ ] 真人超时/断线代打仍为启发式（`RemotePlayer._ai` 未改动）;
- [ ] 服务端未配置 LLM（`LLM_ENABLED=false`）时 `llmEnabled` 静默降级，并返回 `effectiveLlmEnabled=false` 与 `llmAvailable=false`；
- [ ] 现有测试/冒烟脚本全绿（默认关闭零影响）。

---

## 15. 排期摘要

| 阶段 | 内容 | 工作量 |
|---|---|---|
| P0 | 规范协议、fixture、胡短路、校验与安全条款 | 1~2 人日 |
| P1 | 前端本地人机 + 设置/连接测试 | 5~7 人日 |
| P2 | 后端联机空座 + 能力探测/并发预算 | 4~6 人日（P0 后可与 P1 并行） |
| P3 | 打磨（日志审计/提示/README/实测） | 1~2 人日 |

单人串行约 11~17 人日；前后端并行约 8~12 天。先完成 P0 协议与 fixture，再并行 P1/P2；任何特征阈值和 Prompt 文案调整必须回写本文档并更新 fixture。

## 16. 分支同步注意事项

- 所有实现改动在 **master** 开发并提交，随后 `pnpm sync:vibehub`（脚本要求工作区干净）。
- 新文件 `src/game/llm/*`、`src/components/llm/*`、`docs/llm-ai-design.md` 均为共享文件 → 随 master 同步到 vibehub。
- **房间开关若需要修改 `src/components/lobby/*`，该文件属于 keep 清单**：只在 master 实现并提交；同步到 vibehub 时保留 vibehub 自己的 lobby 版本，必须提供能力字段兼容而不是假设 UI 自动同步。
- `backend/` 是独立 git 仓库，P2 改动在 `backend/` 内单独 commit。

## 17. v2 候选清单（本文档不冻结）

向听数引擎量（复用 isWinningHand 分解）｜联机用户自填 provider｜异步生成更多展示文本｜碰/吃一步闭环（discardIndex 预选）｜胡决策开关放开｜4×LLM vs 4×启发式 AI 后台评测（胜率/违规率）做 prompt 迭代｜多模型切换 UI｜vibehub 空座补位复用前端 LlmController。

## 18. 开放问题（实现前需确认）

1. **档位阈值校准**：§5 的 `safety`/`efficiency`/`scoreDeltaBand` 先使用候选集合内相对排序/相对档位；真实对局校准后再发布 v1.2 并回写本文档。
2. **规范 fixture**：TypeScript/Python 必须各自产生同一组 canonical JSON，差异作为 CI 失败；
3. **供应商兼容矩阵**：记录 Base URL、CORS、最大上下文、错误格式和 `finish_reason` 行为；供应商不兼容时必须稳定回退；
4. **提示文案**：默认风格“稳健”的 system 措辞，P1 联调时按实际效果微调并更新 golden prompt；
5. **分数与局况单位**：确认前后端分数初始值、座风/场风和 `roundIndex` 的规范表达。
