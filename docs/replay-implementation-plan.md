# 对局回放（本地牌谱）实施方案

> 状态：**已实施并验收**（2026-09-15：单机三个玩法全部可录制、可回放；§11.1 记录 e2e 发现并修掉的真实缺陷）
> 2026-09-16 增补：**联机（P2P，vibehub）对局回放**已实现并**线上两场验收通过**（见 §12）
> 范围：单机（本地）对局回放 + 联机（P2P）全知牌谱下发的录制、本地存储、列表与回放查看器
> 关联需求：只存本地浏览器数据库（不上服务器）；列表显示「玩法 / 场次 / 对局日期 / 位次」+「查看」按钮；一并保存对局所用主题；回放画面参考雀魂式牌谱（3D 牌桌 + 全明牌 + 底部控制条）

---

## 1. 已确认的产品决策

| 项 | 决策 |
|---|---|
| 覆盖范围 | **只做单机（本地）对局**；联机（WS / P2P）不记录 |
| 玩法范围 | **三个玩法全做**：莲花广麻（`lotus-classic`）、莲花麻将（`lotus-legacy`）、莲花麻将·血流（`lotus-blood-flow`） |
| 回放画面 | **复用现有 3D 牌桌 `MahjongTable3D`** 只读回放（不新做 2D 牌谱视图） |
| 列表粒度 | **一行 = 一整场**；进入后按局切换 |
| 「场次」口径 | `matchName`：东风场 / 半庄场 |
| 「位次」口径 | 本家**最终名次 1~4 位**（`standings` 的 `rank`）+ 净胜分 |
| 入口位置 | **只在大厅**加「对局回放」入口 |
| 未打完的场次 | **记录**，列表标「未完成」，位次显示「—」 |
| 默认视角 | **全知视角（四家明牌）**；顶栏保留「全知视角 / 按当时所见」（他家暗牌）开关 |
| 回放控制条 | **保留**：牌山余张 / 上一局 / 局切换 / 上一步 / 巡目 / 下一步 / 下一局 / 播放暂停 / 调速。**不设进度条**，不支持拖动或点击定位 |
| 存储 | 浏览器 IndexedDB，**不引入新依赖**（裸封装，不用 `idb`） |
| 主题 | 记录 `themeName`（5 个主题之一）+ 每家 `characterId`；回放**固定按记录时的主题渲染，不提供任何主题切换入口**（顶栏仅以只读文字标注当时所用主题） |

---

## 2. 可行性结论（关键代码依据）

### 2.1 3D 牌桌可以直接喂历史状态

`src/components/MahjongTable3D.vue` 的响应式契约正好满足回放需求：

- 第 585–626 行 `watch` 一组状态键（各家 `hand.length / concealedTileCount / drawnTileIndex / discards / melds`、`revealHands`、`winnerIndex`、`winEffect.id`、`winPresentation`、`dealAnimation.serial`、`wall.length`、`horses.length`、`jokerTiles`、`wildcardTiles`、`flipStack`、`flipTile`、`wallBreakIndex`、`lastDiscard.id`、`localSeat` 等），命中即 `tableTiles.rebuild()` + `invalidate()`。
- `tableTilePresenter` 的重建是**直接按当前记录摆放**（`rebuilds place current records directly; historical wins never replay here`），不会重演历史动画。
- `revealHands: true` 时四家手牌翻面朝上并按精牌规则排序（presenter 第 117 / 137 / 156 行），即参考图的"全明牌"视角。
- presenter 以 `props.players[playerIndex]` 取人（第 102 行起），因此回放必须按**本家在前**的本地座序重建 `players`（`player.seat` 保留绝对座位），与实时牌桌一致。

### 2.2 牌山不需要真实牌序

`tableTilePresenter` 第 516 行注明牌山"背朝上"，渲染只用 `wall.length + wallHeadDrawn + wallBreakIndex + flipStack`，**牌的身份不可见**。血流单机已经用这个事实：`useBloodFlowGame.ts` 第 289 行 `state.wall.value = Array(next.wallCount).fill('east')`（注释：*Only public count placeholders reach the renderer; the actual wall stays in worker*）。

⇒ **录制只存"剩余张数 + 牌头累计摸走数"，不存 136 张牌序**，存储量大幅下降。

### 2.3 血流回放需要一个"本地专用旁观视角"

血流单机把权威引擎放在 Web Worker（`workerClient.ts` / `engineWorker.ts`），页面只拿到 `BloodFlowSeatView`；`seatView.ts` 第 6 行明确"对手暗牌不外泄"：

```ts
hand: seat === s || engine.result ? [...p.hand] : [], concealedTileCount: p.hand.length
```

要让血流回放也能四家明牌，需新增**本地专用**的旁观投影（不介入任何网络路径）：

| 文件 | 改动 |
|---|---|
| `bloodFlow/seatView.ts` | `bloodFlowSeatView(engine, seat, { revealAll?, includeDiscards? })`：`revealAll` 打开四家明牌、`includeDiscards` 附上本局累计弃牌流水。默认调用（联机下发）输出**逐字段不变** |
| `bloodFlow/engineWorker.ts` | 请求新增可选 `replay?: boolean`：为 true 时回复里附带一份旁观视角（`{ ...view, replay: spectator }`） |
| `bloodFlow/useBloodFlowGame.ts` | 录制开启时给所有 worker 请求带 `replay: true`，并在 `apply()` 里折成回放事件 |

**该视图永不上网**：不进 `BloodFlowPacket`、不走 `isSeatView()` 校验（`network/protocol.ts`），联机协议与校验路径零影响。

> **与初版方案的差异（实施后修正）**：初版设计成"录制器每步再发一个 `{kind:'spectator'}` 请求"。
> e2e 证明这条链会丢数据 —— 每一局结束的瞬间下一局会重开 worker，在途的旁观请求被中断，导致整局结算丢失。
> 最终改为**旁观视角与座位视角在同一次回复里送达**（同一个 `await`），并且录制挂在 `apply()` 这个
> "所有视角更新的唯一汇聚点"上（`request()`、机器人直连 worker、远端桥三条路径都经过它）。

若不加该接口，血流回放只能是"他家暗牌"，与全知视角需求冲突。

### 2.4 血流的步骤流现成可用

`bloodFlow/engine.ts` 已内建事件账本：

- `actions: TableActionEvent[]`（第 52 行，鸣牌 / 胡牌动作，`push` 于第 146 行）
- `discardActions`（弃牌，`lastDiscardAction` 即其末条）
- `public.batches: WinBatch[]`（含番型明细、倍数、逐家收支、来源事件）
- `ledger` / `roundResult.ledger`（杠流水与局末结算）

⇒ 血流步进 = `(discardActions 新增 | actions 新增 | batches 新增 | 局末结算)` 各取一份旁观快照。

---

## 3. 数据模型

### 3.1 存储库结构（IndexedDB）

库名 `lianhua-guangma-replay`，版本 1：

```
matches  (keyPath: id)                 ← 列表只读这张表，不加载牌谱负载
  indexes: startedAt, rulesetId, status
rounds   (keyPath: id, index: matchId) ← 一局一条，局末即时落库
```

### 3.2 `ReplayMatch`

```ts
interface ReplayMatch {
  id: string                    // uuid
  schemaVersion: 1
  rulesetId: RuleVariant        // 'lotus-classic' | 'lotus-legacy' | 'lotus-blood-flow'
  rulesetName: string           // 落库时快照文案（防后续改名）：「莲花广麻」…
  matchType: MatchType          // 'east' | 'hanchan'
  matchName: string             // 「东风场」|「半庄场」
  gameMode: 'local'
  themeName: TableThemeName     // 'jade'|'happyMahjong'|'rosewood'|'llm'|'llmAnime'
  players: ReplayPlayer[]       // 4 家：seat/name/avatar/characterId/playerKind/isLlm + 起始分
  humanSeat: 0
  startedAt: number             // 对局日期
  endedAt: number
  status: 'finished' | 'aborted'
  roundCount: number
  myRank?: number               // 位次（finished 才有）
  myScore?: number
  finalStandings?: Array<{ seat: number; name: string; score: number; rank: number }>
  summary: string               // 列表副标题用一句话摘要
}
```

### 3.3 `ReplayRound`

```ts
interface ReplayRound {
  id: string                    // `${matchId}:${roundIndex}`
  matchId: string
  roundIndex: number            // 1..8
  roundLabel: string            // 「东1局」
  dealer: number
  honba: number
  dice: { first?: [number, number]; second: [number, number] }
  flipTile: TileType | null
  jokerTiles: TileType[]
  wildcardTiles: TileType[]
  wallBreakIndex: number
  flipStack: number | null
  scoresBefore: number[]
  anchor: {                     // 发牌完成的锚点
    hands: TileType[][]         // 四家起手牌（已排序）
    melds: Meld[][]             // 起手副露（红宝牌花牌）
    wallLeft: number
    headDrawn: number
  }
  steps: ReplayStep[]           // 事件流（牌谱）
  final: {                      // 局末亮牌快照（荒庄也写）
    hands: TileType[][]
    melds: Meld[][]
    discards: TileType[][]
    scores: number[]
    draw: boolean
    winSeat?: number
    winTile?: TileType
    winType?: RoundResult['winType']
    horses?: TileType[]
    details?: RoundScoreDetail[]
    totalMultiplier?: number
    drawTileIndex?: number[]
  }
  landedAt: number
}
```

### 3.4 `ReplayStep`

每步存"动作后**变化者**的真实手牌/副露"，不靠规则推理 → 折叠是纯覆盖，不会与引擎漂移。

```ts
interface ReplayStep {
  t: 'draw' | 'discard' | 'meld' | 'win' | 'draw-end'
  seat: number
  tile?: TileType
  kind?: 'peng' | 'chi' | 'gang-discard' | 'gang-concealed'
       | 'gang-added' | 'gang-flower' | 'gang-wind'
  from?: number | null
  // 公共帧：3D 牌桌直接消费
  wallLeft: number
  headDrawn: number
  currentPlayer: number
  lastDiscardId?: number        // 复现「最近弃牌高亮」与落牌动效
  // 变化者的真实值（只存变化的那一家）
  hand?: TileType[]
  melds?: Meld[]
  discards?: TileType[]         // 仅当动作移除了牌河里的牌（碰/吃/杠）时存
  scores?: number[]             // 仅当分数变化（杠 / 胡 / 跟庄）时存
}
```

### 3.5 投影（回放端）

```ts
project(round: ReplayRound, k: number): ReplayFrame
```

- 起点 = `anchor`；按顺序应用 `steps[0..k]`，覆盖变化者的 `hand/melds/discards/scores`；牌河按 `discard` 事件累加。
- `ReplayFrame` 直接映射成 `TableProps`：

| TableProps | 来源 |
|---|---|
| `players` | 折叠结果（本家在前，`seat` 保留绝对座位），`score` 取当前步 |
| `wall` | `Array(wallLeft).fill('east')`（背朝上，身份不可见） |
| `wallHeadDrawn` / `wallBreakIndex` / `flipStack` / `flipTile` | 帧字段 / 锚点 |
| `revealHands` | 全知视角恒 `true`；「按当时所见」模式下仅本家为 `true` |
| `currentPlayer` / `dealerIndex` / `lastDiscard` | 帧字段（`lastDiscard = { tile, from, id: lastDiscardId }`） |
| `jokerTiles` / `wildcardTiles` | 锚点 |
| `diceValues` / `diceThrowerIndex` | 锚点（`diceValues` 用二骰） |
| `horses` | 仅和了局末帧（`final.horses`） |
| `winPresentation` / `winEffect` | 仅和了局末帧；`winEffect.id = Date.now()`、`duration`、`reducedMotion` 按现有常量 |
| `dealAnimation` / `openingStage` | 中性值（`{ playerIndex: -1, count: 0, serial: 0 }` / `null`），不播发牌与掷骰 |
| `tableActionEvent` | 当前步对应的 `TableActionEvent`（用于鸣牌提示字），无则 `null` |
| `localSeat` | `match.humanSeat`（0），牌山朝向与本人当时一致 |

---

## 4. 录制

### 4.1 录制点（广麻 / 莲花麻将）

`useGame.ts`、`lotusGame.ts` 共用同一套挂点。**包装必须早于下游工厂创建**——它们按引用捕获这些函数：

| 事件 | 挂点 | 约束 |
|---|---|---|
| 摸牌 | 包装 `tileFlowExecutor.drawFor` | 必须早于 `createLocalTurnOrchestrator`（`useGame.ts` 第 264 行）与 `createLocalKongActionExecutor`（第 255 行） |
| 出牌 | 包装 `tileFlowExecutor.discardTile` | 必须早于 `turnOrchestrator`（第 273 行）、`playerActions`（第 293 行） |
| 碰/吃/杠/胡 | 包装 `transientEvents.showTableAction` | 10 种 `TableActionType` 的唯一出口，已覆盖 `peng`/`chi`/各类杠/`self-draw`/`discard-win`/`robbed-kong-win` |
| 开局锚点 | `phase` 变为 `opening` 时（App 层） | 此时发牌 + 红宝替换已完成、手牌已排序 |
| 局末亮牌 | App 层 `watch(result)` | 取四家亮牌 + `RoundResult`（含马牌/番型/收支） |
| 场末位次 | App 层 `watch(matchFinished)` + `standings` | 写 `finalStandings` / `myRank` |
| 中途退出 | `returnToLobby` 时（App 层） | `status = 'aborted'` |

录制器注入方式：`useGame({ recorder? })` / `useLotusGame({ recorder? })`，**不传时零行为变化**（现有 137 个测试文件不受影响）。

### 4.2 录制点（血流）

- 步进触发：`discardActions` 新增 / `actions` 新增 / `batches` 新增 / `roundResult` 到达。
- 每步取一份**旁观快照**（见 §2.3）；血流不接入共享摸打层。
- 局末局 `final` 取 `roundResult.ledger` 全量亮牌。

### 4.3 写入策略

- **局末落库**：一局一次 `rounds.put()`（结构化克隆，异步不阻塞牌桌）。
- **场末更新** `matches`：`endedAt` / `status` / `finalStandings` / `myRank`。
- **中途退出**：`status='aborted'`，已打完的局仍可查看。
- **任何 IDB 异常**（隐私模式 / 配额满 / 老浏览器无 IDB）→ 静默降级为"不记录"，UI 显示「当前浏览器不支持本地回放存储」，**绝不影响对局**。

### 4.4 保留策略

- 上限 **50 场**（常量可配），超出按 `startedAt` 淘汰最旧（连带删除其 `rounds`）。
- 列表内单条删除 + 全部清空（二次确认）→ M3。

---

## 5. 回放视图

### 5.1 结构

新建 `ReplayViewer.vue` 作为壳，**直接渲染 `<MahjongTable3D>`**（不经过 `GameTableHud`，避免把实时对局的 HUD 逻辑与 3D 场景耦合），上面叠一层只读 UI：

```
┌──────────────────────────────────────────────────────────────┐
│ ← 返回大厅  莲花广麻 · 东风场 · 东1局  [视角: 全知▾]  主题 墨玉 │ 顶栏
├──────────────────────────────────────────────────────────────┤
│              <MahjongTable3D>                                │
│   背朝上的牌山 + 四家明牌手牌/副露/牌河 + 中央机台 +          │
│   骰子 + 翻精指示牌 + 和马牌                                 │
│   ┌ 只读叠层 ──────────────────────────────┐                │
│   │ 东1局 · 本场0 · 供托0 · 余27            │                │
│   │ 四家分数 + 位次 + 庄家徽标               │                │
│   └─────────────────────────────────────────┘                │
├──────────────────────────────────────────────────────────────┤
│ 牌谱侧栏（可折叠）：摸/打/碰/杠/胡 逐条，点击跳步              │
├──────────────────────────────────────────────────────────────┤
│ 〔牌山 余27〕 ⏮ [东1局▾] ◀ 12巡 ▶ ⏭ ⏯ 1x/2x/4x            │ 控制条（无进度条）
└──────────────────────────────────────────────────────────────┘
```

对照参考图：`牌山` 按钮 ↔ 剩余张数；`东1局` ↔ 局切换；`12巡` ↔ 巡目；`⏪◀▶⏩⏸` ↔ 首末 / 单步 / 播放暂停。

控制条**不含进度条**，也不支持拖动或点击时间轴定位；任意步跳转通过上一步 / 下一步、键盘快捷键与牌谱侧栏条目完成。

### 5.2 交互

- `←/→` 单步，`Shift+←/→` 跳事件节点，`空格` 播放/暂停，`Home/End` 首末。
- 播放速度 0.5 / 1 / 2 / 4 倍（默认 800ms/步）。
- **无进度条**：不提供拖动或点击定位；跳转只靠上一步 / 下一步、键盘与牌谱侧栏条目。
- 巡目定义：`min(floor(该步之前的摸牌数 / 4) + 1, ...)`，显示为「N巡」。
- **只读**：不提供任何操作牌桌的按钮（不渲染 `GameTableHud` 的行动条）。

### 5.3 视角与主题

- 默认**全知视角**（`revealHands: true`，四家明牌，照参考图）；顶栏保留「全知视角 / 按当时所见」开关（他家暗牌）。
- **主题固定使用记录时的主题**渲染（`themeName` + `themePresentationCssVariables` + 二次元主题的 `characterId`），**不提供任何主题切换入口**；顶栏只用只读文字标注当时所用主题名。
- 主题只影响观感，不改规则。

### 5.4 跳步观感

presenter 会对"新出现的记录"播放落牌补间：相邻步是平滑落牌；跳大步是"快进"观感。**先按现状实现并在验收时看效果**；若跳动观感不可接受，再给 `MahjongTable3D` 加可选 `staticReplay` 抑制位移补间（1~3 行），默认不改该文件。

---

## 6. 列表与入口

大厅（`LobbyView.vue`）新增「对局回放」入口 → 列表，一行 = 一整场：

```
[主题色块] 莲花广麻 · 东风场              09-14 21:03
           4局 · 2位 · +13200分           [查看] [删除]
```

| 字段 | 来源 |
|---|---|
| 玩法 | `rulesetName`（莲花广麻 / 莲花麻将 / 莲花麻将·血流） |
| 场次 | `matchName`（东风场 / 半庄场） |
| 对局日期 | `startedAt`：今天显示 `时:分`，本年内 `月-日 时:分`，跨年带年份 |
| 位次 | `myRank`（1~4 位，配色）+ 净胜分 `myScore`；`aborted` 显示「—」并标「未完成」 |
| 主题 | 主题色块 + 名称角标 |

列表只读 `matches` 表，不加载牌谱负载；点「查看」时才读 `rounds`。

---

## 7. 文件改动清单

**新增**

- `src/game/replay/types.ts` — `ReplayMatch` / `ReplayRound` / `ReplayStep` / `ReplayFrame`
- `src/game/replay/recorder.ts` — 录制器（广麻 / 莲花麻将）
- `src/game/replay/bloodFlowRecorder.ts` — 血流录制器
- `src/game/replay/projection.ts` — `project()` 折叠 + `ReplayFrame → TableProps` 映射
- `src/game/replay/storage.ts` + `src/game/replay/idb.ts` — 存储接口 + IndexedDB 适配（薄）
- `src/game/replay/useReplayRecorder.ts` — App 层装配（watch phase / result / matchFinished / returnToLobby）
- `src/game/replay/useReplayPlayer.ts` — 播放状态机（当前步 / 播放 / 速度 / 局切换）
- `src/game/replay/format.ts` — 日期、位次、巡目、玩法/场次文案
- `src/components/replay/ReplayListView.vue`、`ReplayViewer.vue`、`ReplayTimeline.vue`、`ReplayEventLog.vue`、`ReplayInfoBoard.vue`
- 单测：`format.test.ts`、`storage.test.ts`、`recorder.test.ts`（含 10 种动作映射与场次语义）、
  `recorder.sim.test.ts`（广麻整场）、`lotusRecorder.sim.test.ts`（莲花整场）、`bloodFlowRecorder.test.ts`（血流）
- e2e：`tests/e2e/replay.spec.ts` + `tests/e2e/fixtures/replay.{html,ts}`（真实引擎打完整场 → IndexedDB → 真实 App 回放）

**修改**

- `src/game/core/local/useGame.ts` — 可选 `recorder` + 包装 `drawFor` / `discardTile` / `showTableAction` + 同步 watcher
- `src/game/variants/lotus/lotusGame.ts` — 同上，并多记录翻精指示牌 / 精牌 / 替身 / 断点 / 两次骰子
- `src/game/variants/lotus/bloodFlow/seatView.ts` — `revealAll` / `includeDiscards`（仅本地旁观用）
- `src/game/variants/lotus/bloodFlow/engineWorker.ts` — 请求可选 `replay`：回复附带旁观视角
- `src/game/variants/lotus/bloodFlow/useBloodFlowGame.ts` — 录制挂在 `apply()` 汇聚点
- `src/App.vue` — 装配录制器（三个单机引擎）/ 列表 / 回放视图 / 收尾时机
- `src/components/lobby/LobbyView.vue` — 大厅「对局回放 →」入口
- `src/components/replay/*` 内的样式为组件内 scoped，未改 `src/style.css`

**不改动**

`MahjongTable3D.vue` 与 `table/three/*`、共享摸打层（`shared/runtime/*`）、规则层、联机协议与校验（`online/*`、`bloodFlow/network/*`）。

### 7.1 分支同步注意

- 以上均为 UI / 规则共享文件：**必须在 `master` 提交**，随后 `pnpm sync:vibehub`。
- `src/App.vue` 与 `src/components/lobby/*` 在同步脚本的 `vibehubKeep` 清单内（两边本质不同），**vibehub 不会自动获得回放入口与装配**。
- 缓解：把 App 侧装配收敛为「1 个 composable + 1 个组件 + 1 行模板」，便于在 vibehub 侧手动补同样几行。

---

## 8. 测试

| 层级 | 内容 |
|---|---|
| 纯逻辑单测 | 事件构建（含 10 种 `TableActionType` 映射）、`project()` 抽样任意步、保留淘汰、日期/位次/巡目格式化 |
| **整场集成断言（最关键）** | 仿 `useGame.sim.test.ts` 自动打完东风场；断言「最后一步折叠出的四家手牌 / 牌河 / 分数」与引擎结算时的真实值**完全一致** —— 直接证明录制无遗漏 |
| 莲花麻将 | 仿 `lotusGame.sim.test.ts` 跑一场，覆盖翻精 / 吃 / 乱风杠 |
| 血流 | node 内跑一局（复用 `bloodFlow/simulation.ts` / `engine.test.ts` 套路），断言旁观快照流与引擎终态一致 |
| e2e（Playwright） | 大厅 → 打完一局 → 列表出现一行 → 点「查看」→ 3D 牌桌渲染出四家明牌 → 播放至末步 |

vitest 为 node 环境且无 `fake-indexeddb`：**纯逻辑独立成模块全量覆盖，IDB 适配层做薄（只做 open / CRUD 转发）不引入新依赖**。

---

## 9. 分期（全部完成）

- **M1（已完成）**：录制 + IDB + 大厅入口 / 列表 + 3D 回放壳 + 控制条（单步 / 播放 / 局切换）+ 和了与荒庄帧 —— 覆盖 **莲花广麻 + 莲花麻将**
- **M2（已完成）**：**血流**（worker 旁观视角 + 一局多胡步进）+ 牌谱事件侧栏（摸/打/鸣牌/和牌分层、巡目分隔）+ 跳鸣牌节点（侧栏按钮 + `Shift + ←/→`）+ 视角开关（**主题不提供切换**）
- **M3（已完成）**：删除 / 清空 / 保留策略 UI（10 / 30 / 50 场，本机偏好，超出自动淘汰最旧）+ 导出 JSON 牌谱（真下载，文件名为 `replay-<玩法>-<时间>-<场次短 id>.json`）
  - 「从结算页直接查看本局回放」**未做**：与已确认的「只在大厅加入口」决策冲突，需要改决策再开。

### 9.1 M2/M3 实施要点

- 跳鸣牌节点的锚点集合由 `projection` 的帧序列推导（`step.t === 'meld' | 'win'`），越界停在原位，不改变控制条形态（仍无进度条）。
- 保留上限是**运行时可调**的：`ReplayStorage` 暴露 `maxMatches` / `setMaxMatches()`，改完立即淘汰；偏好存 `localStorage`（`lgm_replay_keep`），读取时校验取值、隐私模式下静默降级。
- 导出走 `export.ts`：`buildReplayExport()`（纯函数，局按 roundIndex 升序，便于比对）+ `downloadReplayExport()`（Blob + `<a download>`，无 DOM 环境返回 false 而不抛错）。
- 牌谱面板宽度改为 CSS 变量 `--replay-log-width` 的单一来源，本家身份牌按它让位（此前两处各自写死，M2 加宽面板时错位过一次 —— e2e 的几何断言当场抓到）。

---

## 10. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 包装时序错误（必须在 orchestrator / kong executor / playerActions 创建之前） | 整场模拟单测断言 steps 完整性与终态一致 |
| 点炮胡亮牌：赢家手牌不含点炮牌 | `projection` 在 `final` 帧按 `winTile` + `winPresentation` 补齐，专测 |
| 边角动作（花牌杠 / 乱风杠 / 抢杠 / 四红 / 荒庄） | `showTableAction` 统一覆盖；每种 `TableActionType` 均有映射用例 |
| 血流旁观视角需动 worker（共享引擎路径） | 仅本地录制开启时使用；视图不上网、不走 `isSeatView` 校验；回归全量血流测试 |
| 跳步时 3D 落牌补间观感 | 先按现状验收；必要时加 `staticReplay` 抑制补间（1~3 行） |
| 每步触发整桌 rebuild 的性能 | 与实时对局「每次出牌都 rebuild」同量级；4 倍速上限 200ms/步，注意观测 |
| vibehub 不会自动获得入口与装配 | 装配收敛成 1 行，vibehub 手动补同款 |
| 首次录制对性能的影响 | 每步结构化克隆 + 局末一次 IDB put，异步；50 场上限 |

---

## 11. 验收标准

1. 打完一场东风场后，大厅「对局回放」出现一行，显示正确的玩法 / 场次 / 日期 / 位次 / 主题。
2. 点「查看」进入回放：3D 牌桌 + 四家明牌 + 牌山剩余 + 翻精指示 + 中央信息盘正确。
3. 可单步、播放/暂停、调速、切局，末步画面等于该局结算亮牌画面。
4. 「按当时所见」开关生效（他家暗牌）。
5. **回放界面没有主题切换入口**，画面始终按记录时的主题渲染（顶栏只有只读主题名）。
6. **控制条没有进度条**，也不能拖动或点击定位；上一步 / 下一步 / 播放 / 局切换均可正常使用。
7. 三个玩法（含血流）均可回放。
8. 中途退出的场次标「未完成」，已打完的局仍可查看。
9. 刷新页面、重启浏览器后回放仍在；全程无任何服务端请求。
10. `pnpm test` 全绿；`pnpm typecheck` 通过。

**验证结果（2026-09-15）**

| 项 | 结果 |
|---|---|
| 单测 | 回放相关 **50 项**全绿（格式/存储/偏好/导出/播放状态机/录制器 15 项含 10 种动作映射/广麻整场/莲花整场/血流 3 项） |
| 全量回归 | `pnpm test` **146 文件 / 1492 项通过**，`pnpm typecheck` 通过 |
| 端到端 | `tests/e2e/replay.spec.ts`：三种玩法各打完整场东风场 → 落库 → 真实 App 列表 → 3D 回放（单步/末步/牌谱跳转/跳鸣牌节点/切局/视角开关/按记录主题渲染）→ 列表导出 JSON（真下载，校验文件名与内容）→ 保留策略切换 |
| vibehub | 同步后同款 typecheck / 全量测试 / 回放 e2e 在 vibehub worktree 全部通过（见 §7.1） |
| 截图 | `work/replay-e2e/*.png`（列表 / 三玩法开局帧 / 结算帧 / 暗牌视角 / 单步 / 跳鸣牌） |

### 11.1 实施中由 e2e 发现并修复的真实缺陷

1. **落库 DataCloneError**：`state.result` 是 Vue 响应式代理，直接塞进 IndexedDB 会被结构化克隆拒绝；
   存储层又按设计"静默降级"，于是表现为"列表永远为空"。修复：录制器显式取字段转纯对象；
   并加**结构性克隆守卫单测**（`firstUncloneable()` 直接报出坏字段路径，例如 `$.final.details[0]`）。
2. **结算帧被 `roundStart` 吞掉**：血流的旁观视角采样若"首份快照即结算态"，早退分支会跳过收尾；
   修复：收尾独立成 `recordBloodFlowSettle()`，按 `roundId` 幂等。
3. **绕过 `request()` 的路径漏事件**：`actBot()` 直连 worker 拿视角并调用 `apply()`，
   既没有旁观视角也没有收尾 ⇒ 奇数局结算整段丢失（计数在 2/4 之间抖动）。
   修复：录制统一挂在 `apply()`（本地所有视角更新的唯一汇聚点）。
4. **底栏按钮点不动**：回放视图误用实时牌桌的 `.user-area`（`z-index:15` 覆盖底部中央），
   把手牌架容器盖在控制条上拦截点击。修复：回放用自己的定位容器 + `pointer-events:none`；
   并加"身份牌与牌谱面板不重叠"的几何断言。
5. **`finishAuto()` 不返回结果 / 位次缺失**：`useReplayRecorder` 未透传录制器返回值；
   `finalize()` 在置空 `match` 之后才计算名次 ⇒ 位次恒为 undefined。均已修复并有单测覆盖。

### 11.2 界面走查后修的三处观感问题（2026-09-15 第二轮）

6. **原生下拉弹层白底浅字**：全局声明了 `color-scheme: only light`，原生 `<select>` 弹层用系统浅色底，
   而选项文字继承主题浅色 ⇒ 看不清。修法：控制条与列表的 `select` 显式 `color-scheme: dark`，
   并给 `option` 指定 `--theme-panel` / `--theme-text` 配色（e2e 断言 `color-scheme` 计算值）。
7. **列表底部两个按钮"戳出"卡片圆角**：实测（临时几何探针）按钮并未超出卡片盒
   （actions 行 273..1007，内容区 272..1008），是 `space-between` 贴到内容区左右边缘 +
   卡片 8px 圆角造成的视觉溢出。改为居中 + 14px 间距（与结算卡片一致），并留 8px 内边距。
8. **信息盘默认展开压住对家牌面**：局数/巡目/牌山余张在底部控制条上已有，信息盘改为**默认收起**
   的一枚小药丸（「本场 N · 分数 ▾」），点击才展开四家分数与名次（e2e 断言默认隐藏 + 展开可见）。
   牌谱侧栏同样可收起（点左侧竖条），默认保持展开以对齐参考图的牌谱形态。

---

## 12. 联机（P2P）对局回放（2026-09-16）

### 12.1 产品口径与架构

联机沿用「只存本机 + 不上传服务器」的前提，做法是**房主生成全知牌谱 → 广播给房间里所有玩家 → 各自存进自己的本地库**：

| 项 | 做法 |
|---|---|
| 牌谱来源 | 房主权威引擎（vibehub P2P 的房主本来就用真实本地引擎做权威） |
| 血流特殊点 | 血流房主的权威引擎在 `BloodFlowAuthority`（worker）里，座位视角只有本家手牌 ⇒ 全知牌谱走新增的 `authority.spectatorView()`（`backend.spectator()`：四家明牌 + 累计弃牌流水，**本地专用、绝不进下发报文**） |
| 传输 | 自建「清单 + 切片 + 回执补发」中继（`src/game/replay/transfer.ts` + `remoteRelay.ts`）：每片 base64 ≤ 2400 字符（远小于传输层 4000 字节自动分片上限）、gzip + SHA-256 校验；任一片丢失由收方回执只补缺失片；**清单本身丢了**也能靠场次记录比对"应有几局 vs 本地已有"主动补拉 |
| 收方视角 | 牌谱由房主生成 ⇒ 客机落库时按自己座位重写 `humanSeat`，并从 `finalStandings` 重算自己的位次/净胜分 |
| 零行为变化 | 未注入 `replayStorage` 时不创建任何录制器/中继/定时器 |

### 12.2 线上验收发现并修掉的三个真实缺陷

这三个都**无法用本地 mock 复现**（`mockVibeHub` 进程内投递、无大小上限），只能上线跑出来：

1. **房主的旁观采样挂在报文处理上会漏采** ⇒ 血流牌谱每局 `steps=0`（只有结算帧）。房主自身的视图应用不走 `present()` 的那个分支；改为由房间已有的 450ms 定时器驱动采样，并在结算帧**当场收尾本局**（否则场末最后一局可能还没落库就被读取）。
2. **同一个录制器被两条路径驱动** ⇒ 我给房间的本地客户端也传了 `recorder`，它用自己的状态再 `roundStart` 一次，把"有事件流的那份"按同一 id **覆盖成"只有结算帧的那份"**（实测：steps 全 0、final 齐全、四家明牌）。血流的录制**只由旁观视角单一路径驱动**。
3. **房主中继是惰性创建** ⇒ sink 里的 `replayHostRelay?.broadcastRound()` 永远命中 `null`，**根本没广播**（客机本地一条牌谱都没有；第一轮误判成"客机拿到了牌谱"，其实那是客机自己的自录）。经典（莲花广麻/莲花麻将）联机路径有同一个 bug，一并修掉：中继在 sink 内惰性建。

### 12.3 线上验收结果（AGENTS.md 要求的门禁）

`vibehubcli` 部署后用 `tmp/online_test` 两个真实账号跑 `tests/e2e/online-two-accounts-two-east-matches.spec.ts` 的血流两场（2 真人 + 2 普通机器人 / 2 真人 + 2 大模型机器人），spec 内新增断言并取证到 `tmp/bf-online-evidence/*.json`：

- 两场**全部通过**（`2 passed`，约 12 分钟）；每场赛后读取**两名玩家各自浏览器**的本地回放库；
- 两边的记录都是 `gameMode=remote`、`roundCount=4`（东风场四局）、每局 `hasFinal=true`、**每局 `steps` 与房主完全一致**（如 199/185/192/208）；
- 每局结算帧 `revealedHands` 四家均非空 ⇒ 客机拿到的确实是**全知**牌谱，而不是只有自己的牌；
- `humanSeat` 分别为 0 / 1、`myRank` 各按自己计算（如房主 2 位、客机 4 位）⇒ 座位与位次口径正确。

### 12.4 边界与未覆盖

- **只覆盖 vibehub 的 P2P 联机**；master 的 WS 联机（服务端权威，客户端只有"所见"信息）本次未动，要做全知需后端提供牌谱接口。
- 经典 P2P（莲花广麻 / 莲花麻将）的联机回放已接线并修掉同一个中继缺陷，但**其线上断言尚未加入验收 spec**（只验了血流两场）。
- 客机中途加入只能拿到加入之后的局；场次记录会触发补拉，但房主本地也没有的那些局无法补齐。
- 本地 mock 房间可覆盖"房主录制 → 广播 → 客机落库"的确定性流程（开发期用临时 fixture 验证过），但**分片丢弃、peer id 漂移、收帧饥饿**这类线上缺陷仍需线上验收。
