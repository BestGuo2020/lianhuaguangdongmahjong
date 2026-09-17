# 任务 ε：ε-容忍约束实验（2026-09-17）

## 一、产品实现（已落地，默认关闭）

| 文件 | 作用 |
|---|---|
| `src/game/variants/lotus/bloodFlow/evValue.ts` | **单一事实来源**：把"某个候选值多少点"抽成函数（与 `lotusAi.discardQuality` 的 netScore 逐项同式，含 win/pass/peng/chi/杠 的归一化口径） |
| `src/game/variants/lotus/bloodFlow/evGate.ts` | 闸门判定：`gap = v1 − v2`（或 `v1 − v_min`），`gap ≤ ε` ⇒ 不调用模型 |
| `src/game/llm/bloodFlowRuntime.ts` | 在 `createBloodFlowDecisions.decide()` 里**调用模型之前**拦截；跳过时返回 `null`（调用方照常采用本地 EV 建议） |
| `src/game/llm/llmController.ts` | `LlmControllerStats.gateSkips` 统计字段 |
| `src/game/variants/lotus/bloodFlow/evGate.test.ts` | 7 个单测（含"spread 比 top-2 更保守"这条易搞反的语义） |

开关（**默认关闭 = 行为与既有线上逐位一致**）：

- `VITE_BLOOD_FLOW_LLM_EPSILON` = 阈值（点），未设或 ≤0 = 关闭
- `VITE_BLOOD_FLOW_LLM_EPSILON_MODE` = `top-two`（默认）| `spread`
- 也可以从代码传 `createBloodFlowDecisions({ gate })`

**口径提醒**：`spread` 的 gap 更大 ⇒ 达到阈值更难 ⇒ **同一 ε 下跳过的是子集**（更保守），
不是更激进。任务零的 7 个单测固化了这条语义。

## 二、三臂设计（同一批种子 1~300，逐局配对）

| tag | ε（点） | 口径 | 预计调用/局 | 预计调用总数 | 每片上限 `SHARD_MAX_CALLS` | 空闲时段费用 |
|---|---|---|---|---|---|---|
| `eps0` | **0** | top-two | 27.3 | 8,191 | 2,294 | ¥37.7 |
| `epss` | **10** | top-two | 20.2 | 6,050 | 1,695 | ¥27.8 |
| `epsm` | **40** | top-two | 9.5 | 2,854 | 800 | ¥13.1 |

**合计 ≈ ¥78.6 输入 + ¥3.4 输出 ≈ ¥82**（高峰时段翻倍）。

**为什么是这三个值**（依据 = 任务零的直方图与调用率，见 `ev-gate-skip-rate-2026-09-17.md`）：

- `ε=0` **不是"照抄基线"**：它已经能跳过 **18.5%** 的调用（"最优与最差完全同值"的窗口），
  是文档 §1 那张降本表里"Gating/ε"一项的最小可行版本，**应当作为正式实验臂**。
- `ε=10` 落在直方图第一个拐点上（10~20 档占 15.80%），跳过率 **39.8%**，且仍在 top-2 差**中位数 16.5 以下**。
- `ε=40` 超过中位数（保护不到一半的窗口），跳过率 **71.6%**，用来测"划边界划到过头会怎样"的上界。

## 三、验收指标

1. **净分是否归零**：各臂每座每局净分 ± SE、t；与基线 `flash-1seat`（−224.7，t = −3.57）比，
   并做**逐种子配对检验**（d = 臂 − 基线，同种子同牌局，只有决策不同）。
2. **调用降幅**：`calls` 之和，以及 `evGate.considered / skipped / skipRate`。
3. **对局耗时**：由调用次数线性反映（本地计算与 API 调用串行）。
4. **覆盖率**：`overrides / decisions`——ε 越大，模型能改的窗口越少，覆盖率必然下降；
   若净分同时改善，说明"少让模型说话"本身就是对的。

## 四、启动命令

```powershell
node tmp/make-epsilon-shards.mjs 300 5 eps        # 生成三臂 × 5 片
# 每臂单独作为一个 DSH 后台作业（不要并行三臂：会互相压 CPU、也会让"耗时"指标失真）
$env:LLMAB_SHARDS='5'; $env:LLMAB_PREFIX='llmab'; $env:LLMAB_WORKER_MATCH='llm-vs-ev'
$env:SHARD_MAX_CALLS='2294'; powershell -NoProfile -ExecutionPolicy Bypass -File tmp/run-llmab.ps1 eps0
$env:SHARD_MAX_CALLS='1695'; powershell -NoProfile -ExecutionPolicy Bypass -File tmp/run-llmab.ps1 epss
$env:SHARD_MAX_CALLS='800';  powershell -NoProfile -ExecutionPolicy Bypass -File tmp/run-llmab.ps1 epsm

node tmp/llmab-epsilon-analyze.mjs flash-1seat eps0 epss epsm
```

## 五、已知会影响读数的两件事

1. **调用率会随 ε 变化**（局内决策被闸门改写 → 牌局走向与长度跟着变），
   所以"预计调用/局"只是上界估计；实测值以 `calls` 为准。
2. **归因钩子在 ε 臂里关闭**（`ATTRIB=0`），避免把额度花在记录上；
    ε 臂只需要 净分 / 调用数 / 覆盖率。
