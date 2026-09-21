# 莲花广麻（`lotus-classic`）的 AI 分析记录 —— 字段口径与未做的部分

> 角色：并行开发约定里的 **A**（`docs/blood-flow/design/analysis-two-variants-work-agreement.md` §1）。
> 方案：`analysis-recording-other-variants-plan.md`（§3 P0、§5 验收、§6 坑）。
> 本轮范围：**P0（能归因，不含赛后复现）**。P1（§4 复现）不在本轮，见文末。
> 分支：`feat/analysis-lotus-classic`；工作树 `work/analysis-classic`。

## 1. 一句话

莲花广麻的对局现在会把**决策前态 / 合法动作 / 选择与来源 / 执行回执 / 结算**写进与血流
**同一个分析区**（存储、容量账本、分块压缩、导出导入、列表状态、界面开关都不重做）。
引擎侧只加了一个可选 `analysis` 选项，**不接时对局路径与改动前逐字相同**。

## 2. 改动清单

| 文件 | 改动 | 归属 |
|---|---|---|
| `src/game/replay/analysis/lotusClassicAdapter.ts`（新） | 窗口 ID / 前态投影 / 合法动作规范化 / 回执判定 / 结算折算（纯函数） | A |
| `src/game/replay/analysis/lotusClassicAdapter.test.ts`（新） | 上者的单测（20 条） | A |
| `src/game/core/local/useGame.ts` | 新增 `analysis?: AnalysisRecorder \| null` + 记录接线 | A（**vibehub keep 文件，需镜像**） |
| `src/game/core/local/useGame.analysis.test.ts`（新） | 接线用例（含"记录不影响对局"硬护栏） | A |
| `tests/e2e/fixtures/analysis-lotus-classic.{html,ts}`（新） | 端到端探针 | A |
| `tests/e2e/analysis-lotus-classic.spec.ts`（新） | 上者的断言 | A |
| `src/game/llm/llmController.ts`、`src/game/llm/runtime.ts`（+测试）（新提交 `23dc5a0`） | §5 的两个可选钩子，**公共改动**（B 依赖） | A 实现，协调者带上 master |

## 3. 字段口径（与血流的差别都在这里）

### 3.1 窗口 ID：`${roundId}/window/${N}`

- `roundId` = 本场第几局（1 起，本局第一个决策窗口之前由 `state.phase === 'opening'` 计数）。
- `N` = **本局内第 N 次进入决策**的自增计数（每局清零）。
- 与血流的 `${roundId}/window/${version}` **同形**，便于"两侧同编号窗口类型对照"。
- **不用**引擎的 `ctx.requestId`：它是场次级单调计数（`core/controllers/llmContext.ts` 的
  `requestSeq`），抢杠窗口的上下文根本没有它，离线复算不可靠。B（`lotus-legacy`）独立得出同一
  结论并使用同一形状 —— 两边都由分析侧自己计数。
- 天然满足：本局内稳定（同一窗口重复渲染得到同一 ID）、跨局不重复、缺 ID 条目数为 0。
  `useGame` 用**座位代理**包住三个决策入口，所以每个窗口只开一次，不需要额外的闩锁。

### 3.2 决策前态：只露该座位自己那一份

`decisionStateOf(view, seat)` 的字段形状是**固定**的（单测断言"多一个字段就失败"）：

```
{ id, fingerprint, hand?, drawnTileIndex?, melds?, legalActions }
```

- `hand` / `drawnTileIndex` / `melds` **只在该座位就是决策者时**才写（`seat === view.seat`）；
  别的座位连字段都不出现。
- 视图里**故意**带着四家真实手牌与真实牌墙顺序（`wall`）—— 隐私护栏因此是**适配层的责任**、
  可被单测抓住（断言别家暗手与未摸牌墙一个牌面都不出现、而视图里确实有这些牌）。
- 四家公开牌河/副露/分数不在前态里：展示回放是公开字段的唯一来源（§9.3）。
- `fingerprint` 由窗口 ID、座位、牌墙数、庄家、当前行动者、合法动作折成（状态变了就不是同一份前态）。

### 3.3 合法动作：从**引擎决策上下文**折出

口径对齐 `localTurnOrchestrator` 的 `handleAction` / `offerNextClaim` / `offerRobKong`：

| 窗口 | 合法动作 |
|---|---|
| `turn`（摸牌回合） | 每个手牌下标一条 `discard`（**带 `handIndex`**，摸切/手切语义不能丢）+ 补杠（`added-kong`，带 `meldIndex`）+ 暗杠（`concealed-kong`）+ 胡（`win`，仅当引擎判断成胡） |
| `claim`（响应弃牌） | `peng` / `gang` / `pass` |
| `rob-kong`（抢杠） | `win` / `pass` |

弃牌**不按牌种去重**：同一张牌的不同下标是不同的合法动作。
窗口内稳定 ID = `${windowId}/${下标}`（与血流同一口径），`chosen` 的 ID 一定落在该窗口的
合法动作里（单测 + e2e 都断言）。

### 3.4 来源与执行回执

- 来源：本家（`controllers[seat] === humanController`）记 `human`；其余按玩家形象记
  `local-ai → 'rule-auto'`；**LLM 座位本轮先记 `unknown`**（见 §5）。
- 回执**只认可见变化**（`choiceTookEffect`）：弃牌 ⇒ 牌河变长；吃碰杠 ⇒ 副露变多；
  胡 ⇒ 本局结束且赢家是该座位；过牌 ⇒ 以上都没变。
  观察点用引擎已有的唯一出口：`showTableAction`（鸣牌/杠/胡）与 `discardTile`（弃牌）。
  过牌没有"上桌"事件，让出一个宏任务后按状态比对判定（用的是同一套 `choiceTookEffect`）。
- **引擎改判**（例如下标越界被夹到末张）会被认成 `state-changed`，不会记成 `executed`；
  什么都没观察到就保持 `pending`。绝不因为"函数被调用过"就记 `executed`（§3.2、§10.2）。

### 3.5 结算：按分数实际变化折算

经典玩法**没有权威账本**，可靠的只有"分数变了多少"：

- 每条变化记一条 `AnalysisSettlement`：`deltas = after - before`，
  `winners`/`payers` 由正负号决定（与账本天然一致，不猜谁付谁），四家变化之和恒为 0。
- 一次结算会连写四家分数 ⇒ 用微任务合并成**一条**，否则会记出几条不守恒的半截流水。
- 本局**开局分**在"本局第一个决策窗口"取基线：开局建玩家本身会写一次分数（空 → 起始分），
  那不是结算；真的分数变化必然晚于第一个窗口。
- `kind`：本局结束的那次用 `RoundResult` 标成 `self-draw` / `win-discard` / `robbed-kong-win` / `draw`，
  局中的分数流动（杠、跟庄）记 `score-flow` —— **不猜具体杠型**（宁可粗一点，也不猜）。
- 流水首尾相接（相邻两条 `before` 与上一条 `scoresAfter` 一致）由单测与 e2e 断言。

### 3.6 场次与显示口径

- 场次 id 与展示回放**共用一把钥匙**（`matchId`），否则分析数据会在"按展示回放清单回收"时
  被当成悬空数据整场删掉。
- 落库状态 `complete` ⇒ 列表行用真实的 `analysisAreaLabel` 得到「**分析：完整**」。
- 中途退出（未打完整场回大厅）会写 `noteGap({ scope: 'match', reason: 'match-aborted' })`
  并结束本场；不收尾的话会话会一直是 active，下一场的 `start()` 会被守卫跳过，新对局的记录
  就挂到上一场的 matchId 上了（错场归属）。
- 响应窗口额外写一条 `responderCheckpoint`（该座位当时的手牌与摸牌下标）：展示回放的步骤流
  只含行动者视角，响应座位的手牌无法从中还原（§9.3 的已知格式缺口）。**广麻的响应窗口能看到
  该座位手牌**（决策者就是响应者），所以这类记录是齐全的，不产生 `responder-checkpoint` 缺失。

## 4. 验收证据（本分支实测）

命令与环境：工作树 `work/analysis-classic`（`feat/analysis-lotus-classic`，干净树）；
dev server 复用 `npx vite --port 4174 --force`，e2e 用 `E2E_PORT=4174 E2E_REUSE_ONLY=1`。

| 项 | 命令 | 结果 |
|---|---|---|
| 类型 | `pnpm typecheck` | 通过 |
| 单测 | `npx vitest run src` | 187 passed \| 1 skipped，**1891 tests passed** |
| 适配层 | `npx vitest run src/game/replay/analysis/lotusClassicAdapter.test.ts` | 20 passed |
| 接线 | `npx vitest run src/game/core/local/useGame.analysis.test.ts` | 4 passed |
| 端到端 | `npx playwright test tests/e2e/analysis-lotus-classic.spec.ts --workers=1` | 1 passed（13.1s） |

e2e 探针实测数字（东风场，固定随机序列，同一场跑两遍）：

| | 开关关 | 开关开 |
|---|---|---|
| 打完 | ✅ 5 局 | ✅ 5 局 |
| 展示回放事件数 | 422 | **422（逐条相同）** |
| 结束分数 | `[-600, -800, 5400, 0]` | **`[-600, -800, 5400, 0]`（相同）** |
| 分析库 | 场次 0→0，分块 0 | 场次 1，记录 705 条 |

开关打开时：窗口 225、选择 225、回执 225、`parts` 形状
`{config:1, decisionState:225, decision:450, responderCheckpoint:24, settlement:5}`、
状态 `complete`、行内文案 `分析：完整`、导出包 637,738 字节且
`configReferencesClosed=true` / `includesReplay=true`，`missing` **只有**
`复现数据（reproduction）` 一条（P0 的预期，见 §5）。

## 5. 未做的部分（明确留痕，不冒充完成）

1. **P1 赛后复现（§6）未做**：没有开局快照、没有权威动作日志、没有离线重跑。
   因此导出包的 `reproductionCapable=false`、`missing` 里有 `复现数据（reproduction）` ——
   这是 **P0 的正确口径**，不是数据丢了。方案 §4 说这块要动引擎、风险最高，单独排期。
2. **LLM 座位还没接钩子**：`llmController.ts` 的两个可选钩子已经实现并单测（提交 `23dc5a0`，
   公共改动，B 依赖），但广麻的 LLM 座位目前仍记 `source: 'unknown'`（§9 DoD 允许）。
   接 sink 时需要两件事：
   - `src/App.vue` 把 `onDecisionRequest` / `onDecisionAnswer` 传进 `createLocalLlmControllers`
     —— **App.vue 在冻结清单里**，由协调者的「公共改动」提交落实；
   - sink 用 `seat` 找到"该座位当前打开的窗口"，把 `attemptStarted({ decisionWindowId })` 指过去。
     **不要**拿钩子里的 `windowId` 当分析窗口号：它按契约是引擎侧请求标识
     （`context.requestId`），与分析侧自己计数的 `${roundId}/window/${N}` 是两套编号。
3. **`src/App.vue` 的两处改动由协调者做**（本分支不碰冻结清单）：
   - `localGame = useGame({ …, analysis: analysis.port })` —— 少了这一行，广麻这一场只会有配置、
     没有任何决策记录（列表会如实显示「分析：未记录到任何数据」，不会谎称"数据丢了"）。
   - `analysisSnapshotFor` 补广麻的 `rules` / `aiConfig` 口径：现在是 `{ id: 'lotus-classic' }`
     占位（只记标识）。P0 的记录本身不依赖它，但它决定"这一手是在什么规则/AI 配置下决定的"
     能不能被回答，建议与 B 的 `lotus-legacy` 口径一起放进同一次公共改动。
4. **`useGame.ts` 是 vibehub keep 文件**：上述改动需要手动镜像到 vibehub 的同一份文件
   （约定 §6）—— 由协调者在合并后落实。
5. **e2e 不经由 App.vue**：App 那一行端口传递在冻结清单里，所以探针直接对 `useGame` 传入
   会话代理（与 App 同一条路径、同一个 storage、同一把 matchId 钥匙），"列表行文案"用真实的
   `analysisAreaLabel` 在数据层判定。等公共改动落地后，可以照 `analysis-human.spec.ts` 补一条
   走真实 UI 的用例（点开大厅 → 打一场 → 在回放列表里看到那一行）。

## 6. 维护提示

- 新增决策窗口时：在 `useGame` 的座位代理里加一个入口，并在 `lotusClassicAdapter` 里补
  `windowKindOf` 的映射与合法动作折法；**不要**在编排器里零散插桩（汇聚点只有控制器这一处）。
- 改前态字段前先跑 `lotusClassicAdapter.test.ts` 的"字段形状"用例 —— 它是防止顺手把整个局面
  塞进前态的守卫。
- 记录代码一律走代理 / 容错：任何位置抛错都只丢一条记录，绝不影响对局（§9.5）。