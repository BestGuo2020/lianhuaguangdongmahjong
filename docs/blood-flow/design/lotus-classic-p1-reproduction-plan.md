# 复制清单：广麻 P1（赛后复现）= 把翻精癞子 P1 移植过来

> 状态：**待执行**（2026-09-21 编写）。单人单会话执行，直接在主工作区 master 上做。
> **先读**：`lotus-legacy-p1-reproduction-plan.md`（翻精癞子的 P1 方案 = **通用方案**：
> §6 要求、快照取法、动作日志、校验器判据、坑、DoD、最小切片都在那里，本文件不重复）。
> 本文件只写**差异**：哪些照抄、哪些必须换。

## 0. 结论先说

- **不需要另写方案**：通用方案 + 本差异清单就是完整方案。
- **建议顺序**：**先把翻精癞子 P1 做完再复制**。理由：共享件（`AnalysisReproduction` 的新字段、
  校验器骨架、`export.ts` 的能力判定、夹具写法与全部踩坑记录）都是那份 P1 的产物；
  先做它，广麻这一遍就只剩"换引擎/换适配层/换夹具"，成本大约只有第一遍的三分之一。
- 若坚持先做广麻：通用方案里的设计照样适用，但共享件你要自己先建一遍，
  之后翻精癞子再复用（顺序反过来而已，总工作量更大）。

## 1. 照抄（不用改）

| 复用项 | 说明 |
|---|---|
| `AnalysisReproduction` 的可选字段 | `ringWall`（环状牌墙 136）/`dice`/`postDealHands`/`variant` —— 类型是共用的，广麻只需把 `variant` 填 `'lotus-classic'` |
| 动作日志形状 | `commandEntry.ts` 的 `AnalysisCommandEntry`，顺序判据用 `windowId` |
| 校验器判据 | 命令对不上/不足/缺 `openingScores` ⇒ 如实报错，**不许跳过命令**；重跑前用 `postDealHands` 交叉校验，不一致就停 |
| 校验器运行方式 | 引擎是 composable ⇒ **浏览器夹具内**重跑，定时器压 0ms（`fixtures/analysis-lotus-classic.ts` 已有这套压缩） |
| `export.ts` 的 `reproductionCapable` | 按记录内容判定（有完整复现数据 ⇒ true） |
| 硬护栏 | 开/关两种设置下结束分数、动作数、随机流抽取逐位相同（A 的 spec 已有这条，继续绿） |
| 单人流程与提交纪律 | 见通用方案 §5：直接改 master、`pnpm typecheck`+`pnpm test`、提交后 `pnpm sync:vibehub`、keep 文件手动镜像 |

## 2. 差异（必须换的）

| 维度 | 翻精癞子（已完成方） | 广麻（本次） |
|---|---|---|
| 引擎文件 | `src/game/variants/lotus/lotusGame.ts` | **`src/game/core/local/useGame.ts`** |
| 开局模块 | `variants/lotus/lotusOpening.ts`（有翻精：`flipTile`/`jokers`/`wallBreakIndex`/`flipSeat`/`flipStack`） | **`core/local/localOpeningTimeline.ts`** —— 无翻精 ⇒ 快照里**没有**那些字段（少一类交叉校验项，别硬塞） |
| 重跑入口 | `startGame(mode, { initialWall, openingDice, openingSecondDice })` | **同形**：`useGame.ts:623` 的 `startGame(mode, options: GameStartOptions)` → `localOpeningTimeline.start`（`initialWall`/`openingDice` 在 `:76/:104` 生效） |
| 快照取点 | `createLotusOpening({ …, beginTurn })` 回调 | **`useGame.ts:516` 的 `beginTurn` 包装**：本局第一次调用（发牌完成、dealer 首巡 `{skipDraw:true, preDrawn:true}`）时取；`localOpeningTimeline` 的 options 里同样有 `beginTurn`（`:18/:147`） |
| P0 适配层 | `analysis/lotusLegacyAdapter.ts` | **`analysis/lotusClassicAdapter.ts`**（动作汇聚点、窗口 ID 规则都要按它来） |
| 夹具 | `tests/e2e/fixtures/analysis-lotus-legacy.ts` | **`analysis-lotus-classic.ts`**（已有真实 `useGame` + 真分析区 + 0ms 压缩） |
| e2e | `analysis-lotus-legacy.spec.ts`（5 条） | **`analysis-lotus-classic.spec.ts`**（3 条；负向按 `E2E_SLOW=1`）⇒ 新增"整局重跑一致"第 4 条 |
| 玩法文档 | `analysis-lotus-legacy.md` | **`analysis-lotus-classic.md`** |
| dev server 端口 | 4178 | **4179** |
| vibehub keep 文件 | `lotusGame.ts`（+ App.vue） | **`useGame.ts`**（App.vue 本任务大概率不用动） |

## 3. 广麻特有的两个注意点

1. **`useGame.ts` 同时是 vibehub 的 keep 文件**：改动要手动镜像（通用方案 §5 第 5 条的手法：
   先 sync 再镜像；三方合并 `base` 取"改动前的 master 版本"；vibehub 是 CRLF、`git show` 是 LF，
   不统一行尾会把每一行都判成冲突）。**而且 A 的 P0 已经改过这个文件**，
   所以镜像时 base 要取**这次改动之前**的 master 版本，别用更早的。
2. **广麻没有翻精**：`postDealHands` 的交叉校验照做，但不要为了"和翻精癞子一样"去造假字段
   （没有翻精牌就是没有；如实少一项）。

## 4. DoD（在通用方案 §4 基础上替换/新增）

- [ ] 快照：`ringWall` 136 张每种 4 张、`dice`、`dealer`、`openingScores`；**无翻精字段**（并断言它们不存在/为 undefined）；
- [ ] 交叉校验：改一张 `postDealHands` ⇒ 校验器报"发牌/记录不一致"并停止；
- [ ] 动作日志：形状/`windowId`/被拒不入列（含**吃碰杠**这几类 A 在 P0 里处理过的动作）；
- [ ] e2e 新增「整局重跑到同一结束状态」：命令全消费、结束分数一致、窗口序列无错位；
- [ ] 既有 3 条用例仍全绿（含 app-path 正向、硬护栏、开关关掉零写入）；
- [ ] `reproductionCapable` 按记录内容判定；
- [ ] vibehub 镜像 + `pnpm test`（vibehub）通过；
- [ ] `analysis-lotus-classic.md` 补 P1 一节（字段口径、判据、未做项）。

## 5. 开场提示（复制粘贴）

> 你负责「莲花广麻」的 **P1 赛后复现**，单人单会话做到底（没有并行方，也没有协调者）。
> 先读两份：`docs/blood-flow/design/lotus-legacy-p1-reproduction-plan.md`（**通用方案**：§6 要求、快照取法、
> 动作日志、校验器判据、坑、DoD、单人流程）与 `docs/blood-flow/design/lotus-classic-p1-reproduction-plan.md`
> （**本文件：差异复制清单**），再读 `docs/blood-flow/design/analysis-lotus-classic.md`（A 写的 P0 字段口径与窗口 ID）。
> 参考实现：翻精癞子 P1 的落地代码（`lotusLegacyAdapter.ts` 的复现部分、`reproduceLotusLegacy`/校验器、
> `analysis-lotus-legacy.spec.ts` 的"整局重跑"用例、`fixtures/analysis-lotus-legacy.ts` 的重跑写法），
> 以及血流的 `commandEntry.ts`/`openingFromReproduction.ts`/`replayReproduction.ts`。
> 直接在主工作区 master 上改（不需要分支/工作树）。硬要求：
> ① dev server 用 **4179**，起完先确认端口是自己的，e2e 前先访问一次页面焐热；
> ② 提交 master 后必须 `pnpm sync:vibehub`；**`useGame.ts` 是 vibehub keep 文件**，同步不会带过去 ⇒ 手动镜像
> （base 取**这次改动之前**的 master 版本；注意 CRLF/LF）；③ 按最小切片推进：先快照 + 单测 → 动作日志 →
> 校验器 + e2e → 导出能力 → 文档；
> ④ 失败如实（交叉校验不一致、命令对不上、缺 `openingScores` 都报"不可比对"），**不许跳过命令或改判据把用例弄绿**；
> ⑤ 广麻没有翻精 ⇒ 快照里就是没有那些字段，不要为了对齐翻精癞子而编造。
