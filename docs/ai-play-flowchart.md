# AI 出牌逻辑流程图

> 本文档基于 codegraph 对现有代码的分析，用流程图梳理本项目（莲花广麻）的 AI 出牌逻辑。
> 所有图均为 Mermaid 语法，可在 GitHub / VS Code（安装 Markdown Preview Mermaid Support）等环境中直接渲染；
> 浏览器直接查看请打开同目录的 `ai-play-flowchart.html`。

## 0. 代码位置总览

本项目存在 **两套麻将变体**，每套都有 **前端（TypeScript）** 与 **后端（Python）** 两套实现，逻辑互为翻译：

| 变体                   | 前端控制器                                                              | 前端决策层（纯函数）                                                                                           | 后端控制器                                         | 后端决策层                                   |
| -------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | --------------------------------------------- | --------------------------------------- |
| 经典广麻 `lotus-classic` | `AiControllersrc/game/core/controllers/playerController.ts:267`    | `decideTurn` / `decideClaim` / `decideRobKong` / `chooseDiscardIndexsrc/game/core/controllers/ai.ts` | `AIPlayerbackend/app/game/player.py:108`      | `decide_turn` 等`backend/app/core/ai.py` |
| 莲花麻将 `lotus-legacy`  | `LotusAiControllersrc/game/variants/lotus/lotusControllers.ts:318` | 同名函数`src/game/variants/lotus/lotusAi.ts`                                                             | `AIPlayer`（`rules.code == 'lotus-legacy'` 分支） | `lotus_ai.py`                           |

设计原则（两端一致）：**决策与执行分离** —— 决策层是纯函数，只做「看状态 → 给动作命令」，不改任何状态、不触发表现副作用，可独立单元测试；动作的执行由引擎（前端 `useGame` / 后端 `GameManager`）完成。

**思考延迟**（前端 `playerController.ts:80` / `lotusControllers.ts:144`，后端 `player.py:91` 完全对齐）：

| 场景                  | 延迟                |
| ------------------- | ----------------- |
| 摸牌后出牌 `turn`        | 650 ms            |
| 杠后补摸再决策 `afterKong` | 550 ms            |
| 吃碰杠响应 `claim`       | 500 ms            |
| 抢杠 `requestRobKong` | 无额外延迟（引擎层面已 pace） |

## 1. 总体架构

```mermaid
flowchart LR
    Engine["对局引擎<br/>前端 turnOrchestrator / 后端 GameManager"]
    Ctrl["AI 控制器<br/>AiController / LotusAiController（前端）<br/>AIPlayer（后端）"]
    Pure["纯决策函数<br/>decideTurn / decideClaim / decideRobKong"]
    Discard["弃牌选择<br/>chooseDiscardIndex / discardQuality 评分"]

    Engine -->|"requestTurn / requestClaim / requestRobKong<br/>（传入只读上下文 ctx）"| Ctrl
    Ctrl -->|"等待思考延迟<br/>turn650 / afterKong550 / claim500"| Pure
    Pure -->|"动作命令<br/>win / added-kong / concealed-kong / wind-kong<br/>discard / peng / chi / gang / pass"| Engine
    Pure -->|"需要弃牌时"| Discard
    Discard -->|"handIndex 弃牌索引"| Pure
```

## 2. 回合出牌决策 `decideTurn`（核心流程图）

优先级链：**自摸胡 → 补杠 → 暗杠 →（莲花：乱风杠）→ 弃牌**。
杠前都会做 `isTenpai`（是否已听牌）评估：已听牌时放弃杠，避免拆散成形手牌、暴露第 4 张被抢杠。

```mermaid
flowchart TD
    Start(["AI 回合开始<br/>requestTurn(ctx)"])
    Delay["等待思考延迟<br/>turn 650ms / 杠后 550ms"]
    View["组装决策视图<br/>hand / melds / exposedMelds / kongBloom<br/>（莲花另有 jokers / visibleTiles / publicTiles / wallCount…）"]
    Hu{"自摸胡？<br/>isWinningHand(hand, exposedMelds, jokers)"}
    PengMeld{"存在碰副露<br/>且手牌有第 4 张？"}
    T1{"已听牌？<br/>isTenpai"}
    AddKong["放弃补杠<br/>（保听牌 + 避免被抢杠）"]
    Concealed{"存在暗杠？<br/>concealedKongs"}
    T2{"已听牌？"}
    WindKong{"莲花：可乱风杠？<br/>windKong(hand, jokers)"}
    T3{"已听牌？"}
    Discard(["动作：discard<br/>chooseDiscardIndex 选牌打出"])

    Start --> Delay --> View --> Hu
    Hu -- "是" --> Win(["动作：win 自摸胡"])
    Hu -- "否" --> PengMeld
    PengMeld -- "是" --> T1
    T1 -- "未听牌" --> AddKongAct(["动作：added-kong 补杠"])
    T1 -- "已听牌" --> AddKong
    PengMeld -- "否" --> Concealed
    AddKong --> Concealed
    Concealed -- "是" --> T2
    T2 -- "未听牌" --> ConKongAct(["动作：concealed-kong 暗杠"])
    T2 -- "已听牌" --> NoCon["放弃暗杠"]
    Concealed -- "否" --> WindKong
    NoCon --> WindKong
    WindKong -- "是" --> T3
    T3 -- "未听牌" --> WindKAct(["动作：wind-kong 风杠"])
    T3 -- "已听牌" --> NoWind["放弃风杠"]
    WindKong -- "否" --> Discard
    NoWind --> Discard
```

**莲花补杠特例**（`shouldTakeAddedKong`，`lotusAi.ts:111`）：牌河（publicTiles）中该牌已出现过 1 张以上时直接补杠（别家听它的概率低）；否则才用 `isTenpai` 判断。经典版无此特例，只看 `isTenpai`。

## 3. 弃牌选择 `chooseDiscardIndex`

### 3.1 经典广麻（`ai.ts:180`）

目标：优先打出「孤张」（同牌少、无相邻靠张的牌），白板（癞子）加罚分保手；若打出某张后能听牌，则重奖保留。

```mermaid
flowchart TD
    Start(["chooseDiscardIndex(hand, random, exposedMelds, ruleset)"])
    Loop["对每张候选牌打分"]
    S1["same = 同牌张数 − 1"]
    S2["neighbors = 相邻靠张数（±1 同花色）"]
    S3["penalty = 白板 ? 10 : 0"]
    S4["base = same×4 + neighbors×2 + penalty + random()"]
    S5{"打出后是 3n+1<br/>听牌态？<br/>canBeTenpai"}
    S6["discardQuality = 听口数×10<br/>听牌 → listenBonus = 1000 + score"]
    S8["listenBonus = 0"]
    S7["score = base − listenBonus"]
    Sort["按 score 升序排序"]
    Pick(["打出 score 最小的牌<br/>孤张优先 / 保住听牌"])

    Start --> Loop --> S1 --> S2 --> S3 --> S4 --> S5
    S5 -- "是" --> S6 --> S7
    S5 -- "否（散手）" --> S8 --> S7
    S7 --> Sort --> Pick
```

### 3.2 莲花麻将（`lotusAi.ts:463`）

精牌默认保留（只有手牌全是精牌时才兜底打出）；有 `exposedMelds` 时叠加 `discardQuality` 综合评分排序（见第 4 节）。

```mermaid
flowchart TD
    Start(["chooseDiscardIndex(hand, jokers, random, options)"])
    Cand["候选牌 = 非精牌<br/>（手牌全是精牌时兜底全选）"]
    Loop["对每个候选打分"]
    A1["base = same×4 + neighbors×2<br/>+ 字牌?6 + random()"]
    A2{"传入 exposedMelds？"}
    A3["quality = discardQuality(打出后)"]
    A4["排序：compareQuality 优先<br/>相同再比 base"]
    Pick(["取最佳候选打出<br/>精牌默认保留"])

    Start --> Cand --> Loop --> A1 --> A2
    A2 -- "是" --> A3 --> A4
    A2 -- "否" --> A4
    A4 --> Pick
```

## 4. 莲花弃牌综合评分 `discardQuality`（`lotusAi.ts:298`）

莲花 AI 的弃牌质量 = **进攻（听口/特殊牌型） + 防守（安全度）** 的加权组合：

```mermaid
flowchart TD
    In(["discardQuality(打出后手牌, 弃牌, …)"])
    W["听口 waits = waitingTiles(打出后)"]
    E["effectiveRemaining = Σ 每个听口的剩余张数<br/>（4 − 可见张数）"]
    SP["特殊牌型潜力 specialScore<br/>max(十三烂/七星十三烂, 十三幺, 七对子)<br/>精牌可替补缺口"]
    SAFE["安全度 safetyScore<br/>牌河该牌出现越多越安全（4/12/24 分）<br/>跟上家刚打过的牌 +12<br/>147 软提示（1/7 与已现 4 同花色）"]
    H["启发式 heuristic<br/>孤张/字牌罚分、精牌罚分 100"]
    ATK["攻击分 attackScore<br/>听牌?80 + 残局?20 + waits×10<br/>+ effective×2 + special×3"]
    NET["netScore = attackScore<br/>+ safetyScore × 权重<br/>（残局且听牌 ×4，其他 ×2）"]
    Out(["compareQuality 比较顺序：<br/>ready → netScore → effectiveRemaining<br/>→ waits 数 → specialScore → safetyScore<br/>→ heuristic"])

    In --> W --> E --> SP --> SAFE --> H --> ATK --> NET --> Out
```

要点：

- **残局（wallCount ≤ 8）** 未听牌时更看重听口（冲牌），攻击分整体上调。
- **特殊牌型潜力**：`specialPatternScore` 只在无副露（exposedMelds = 0）时计算，有副露直接 −20；在十三烂 / 十三幺 / 七对子三个方向取最大。
- **安全度只依赖公开信息**（牌河 + 公开副露 + 上家弃牌），不读别家手牌。

## 5. 副露决策 `decideClaim`（面对他家弃牌：吃碰杠）

### 5.1 经典广麻（`ai.ts:118`）

能杠必杠；碰需评估「碰后听口质量」是否优于现状，不提升则 pass（广麻无点炮，防守价值低）。

```mermaid
flowchart TD
    Start(["decideClaim(hand, canGang, tile, exposedMelds)"])
    G{"能直杠？<br/>canGang"}
    NoTile{"无 tile？"}
    Count{"手牌中该牌 ≥ 2 张？"}
    Baseline["现状听口质量 currentTenpai（未碰）"]
    After["碰后手牌 → 最佳弃牌听口<br/>bestDiscardQuality"]
    Better{"碰后听口质量<br/>优于现状？"}

    Start --> G
    G -- "是" --> Gang(["动作：gang 杠"])
    G -- "否" --> NoTile
    NoTile -- "是" --> Peng(["动作：peng 碰"])
    NoTile -- "否" --> Count
    Count -- "否" --> Pass(["动作：pass 过"])
    Count -- "是" --> Baseline --> After --> Better
    Better -- "是" --> Peng2(["动作：peng 碰"])
    Better -- "否" --> Pass2(["动作：pass 过"])
```

### 5.2 莲花麻将（`lotusAi.ts:130`）

能杠必杠（杠后从牌尾补牌，无法凭当前 13 张准确预判听口，故杠保持最高优先级）；碰与吃必须与现状比较听牌质量，并支持**吃**（经典版不支持吃）。

```mermaid
flowchart TD
    Start(["decideClaim(hand, canPeng, canGang, chiOptions, jokers, …)"])
    G{"能直杠？<br/>canGang"}
    Base["baseline = 现状手牌质量 currentHandQuality"]
    P{"能碰？<br/>canPeng && 手牌够 2 张"}
    PQ["碰后 → bestDiscardAfterClaim<br/>得到（peng, 质量）"]
    CH{"能吃？<br/>遍历 chiOptions"}
    CQ["吃后 → bestDiscardAfterClaim<br/>得到（chi, 质量）"]
    Cand["候选集"]
    Filter["过滤：compareQuality(候选, baseline) > 0"]
    Best["取质量最佳候选<br/>（同质量碰优先于吃）"]

    Start --> G
    G -- "是" --> Gang(["动作：gang 杠"])
    G -- "否" --> Base --> P
    P -- "是" --> PQ --> Cand
    P -- "否" --> Cand
    Base --> CH
    CH -- "是" --> CQ --> Cand
    CH -- "否" --> Cand
    Cand --> Filter --> Best
    Best -- "有" --> Act(["执行 peng / chi<br/>（预计算碰/吃后弃牌索引，单次闭环）"])
    Best -- "无" --> Pass(["动作：pass 过"])
```

**两端一致的安全守卫**：碰后手牌恰好为空（只剩 2 张被碰走）时真实规则下不能碰，返回 `pass`，否则出牌阶段空手会让对局停滞（前端 `playerController.ts:316`，后端 `player.py:153`）。

## 6. 抢杠决策 `decideRobKong`

最简单的一环：**能抢必抢**，无风险权衡（两端一致，预留未来按听牌风险返回 `pass` 的扩展点）。

```mermaid
flowchart LR
    Start(["decideRobKong(view)<br/>面对他家加杠"]) --> Win(["动作：win 抢杠胡"])
```

## 7. 前后端对应关系

| 前端（TS）                                        | 后端（Python）                                                        |
| --------------------------------------------- | ----------------------------------------------------------------- |
| `AiController` / `LotusAiController`          | `AIPlayer`（`player.py`）                                           |
| `decideTurn`（`ai.ts` / `lotusAi.ts`）          | `decide_turn`（`core/ai.py:27`，lotus-legacy 转发 `core/lotus_ai.py`） |
| `decideClaim`                                 | `AIPlayer.request_claim`（含 `_request_lotus_claim`）                |
| `decideRobKong`                               | `decide_rob_kong`                                                 |
| `chooseDiscardIndex` + `discardQuality`       | `choose_discard_index` / `lotus_ai.py` 对应函数                       |
| `AI_DELAYS` / `LOTUS_AI_DELAYS` = 650/550/500 | `AI_DELAYS` = 650/550/500（`player.py:91`）                         |

> 注意：**在线联机模式**下 AI 由后端 `AIPlayer` 驱动（前端只渲染结果），本地单机模式由前端 `AiController` 驱动；两套逻辑保持一致。

