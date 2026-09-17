# 修复：三个"可调参数"被硬读冻结默认值，覆盖完全不生效（2026-09-18）

## 症状（任务 A 实测发现）

把 `chainHorizon` 从 8 改成 5，跑 **1200 局**，两个臂的**逐局快照完全一致**（8 个指标的配对 Δ 全为 `0.000 ± 0.000`）。
`configSnapshot` 明确写着 `chainHorizon: 8 → 5`，但行为零差异——**说明该参数根本没被读到**。

## 根因（代码证据）

`patternPotentials.ts` 里三处**硬读模块级冻结常量** `BLOOD_FLOW_AI`，而不是用调用方传入的
`config`：

| 函数 | 硬读的字段 | 所在行（修复前） |
|---|---|---|
| `patternPotentialEv` | `BLOOD_FLOW_AI.lateGameWallCount` | 352 |
| `chainEvEst` | `BLOOD_FLOW_AI.chainHorizon` | 528 |
| `chainEvEst` | `BLOOD_FLOW_AI.selfDrawWeight` | 535 |

而 `BloodFlowAiConfig` 的文档明确写着这三个是**可调参数**：

```ts
/** 自摸单次总收入（×2 ×3 家）相对点炮（×1 ×1 家）的连锁期望权重。 */
readonly selfDrawWeight: number
/** 锁手后连锁期望的展望巡数。 */
readonly chainHorizon: number
/** 墙余分界：≤ late 为残局，> early 为早局。 */
readonly lateGameWallCount: number
```

也就是说：**A/B 实验、测试注入、甚至未来任何"改配置做实验"的尝试，对这三个参数都是静默无效的**。
（`ai-strategy.md` 的"参数默认值"表里列了 `selfDrawWeight` 与 `chainHorizon`——文档承诺与代码行为不一致。）

## 修复

给 `patternPotentialEv` / `chainEvEst` 增加可选 `config` 形参（默认仍是 `BLOOD_FLOW_AI`，
保持既有调用点的行为逐位不变），并在所有生产调用点传入当前生效的 config：

- `evContext.ts`：`chainAfterWin`、`developEv`、`reformCandidates[].ev`、`robEv.passEv`（5 处）
- `ai.ts`：`decideBloodFlowActionEv` 注入的 `patternBonus`（1 处）

**默认行为不变**：`BLOOD_FLOW_AI` 的这三个字段恰好就是原先硬编码的值（`lateGameWallCount: 15`、
`chainHorizon: 8`、`selfDrawWeight: 6`），所以只要没人覆盖，数值逐位相同。
（已用 `pnpm test` 152 个文件 / 1,534 个用例全绿 + `pnpm typecheck` 通过验证。）

## 验证（修复前后对比）

同 20 个种子，只改 `chainHorizon`：

| | 胡牌 | 决策 | 逐局快照 |
|---|---|---|---|
| `chainHorizon=8` | 559 | 2,504 | — |
| `chainHorizon=5` | 548 | 2,492 | **与上面不同** |
| 修复前 8 vs 5 | 完全相同 | 完全相同 | **全等（Δ 恒为 0）** |

## 影响范围（必须一起看）

1. **任务 A 的 H3 臂（`chainHorizon 8→5`）作废**：它测的是"没改任何东西"，所以结果全等。
   修复后重跑才有意义。
2. **同理，`selfDrawWeight` 与 `lateGameWallCount` 相关的任何历史 A/B 也是无效的**。
   仓库里 `docs/blood-flow/design/ai-strategy.md` 的"参数默认值"表需要按此更新口径。
3. **对本次 ε 实验无影响**：ε 闸门用的是 `evValue`/`evGate`，与这三个参数无关；
   且 ε 实验全程未覆盖这三个字段（`lateGameWallCount` 用的是默认 15）。
4. 这是一个**纯产品侧缺陷**（不是测试台问题），已随本次改动一并修复。
