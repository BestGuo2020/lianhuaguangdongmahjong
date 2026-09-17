# 观察：`chainEvEst` 量级偏大，任务 D 的 Δ价值 必须分窗口类型读（2026-09-17）

## 现象（实测，非推测）

任务 D 的归因钩子（`ATTRIB=1`）在冒烟批次（`tmp/bulk/smoke-d2.json`，2 局 / 8 条覆盖）里看到：

```
deltaValue: -28 | -339.9 | -13287.9 | -13983.1 | -15014.6 | -15857.3 | -16895.9 | -16322.5
outcome.net: 300 | 300 | 300 | ...（同一 seed 的同一座位）
```

8 条里 7 条是**跨类型覆盖**（`win → discard`，即模型在能胡的窗口选择改张），
其 Δ价值 达到 **−1.3 万 ~ −1.7 万点**。

## 来源定位（代码证据）

`patternPotentials.chainEvEst()`（第 519–539 行）在 `chainHorizon` 巡内**把每个听口的剩余张全部
乘上期望收入**：

```ts
const chainFactor = Math.min(1, BLOOD_FLOW_AI.chainHorizon / Math.max(1, wallCount / 4))
for (const tile of waits) {
  const remaining = remainingCount(tile, visibleTiles)
  total += remaining * average * chainFactor      // average 已含 selfDrawWeight=6 加权
}
```

- 单吊任意听（`waits.length >= 34`）时，34 个听口 × 各自剩余张 ≈ **上百次"胡"** 被加进一次评估；
- 清一色级手牌的 `average` 可达数百点 → 单张听口的期望就近千点 → 合计上万。
- 它**没有时间衰减/兑现概率折扣**（除了墙余比例的 `chainFactor`），因此是**上界式估计**。

## 两个必须区分的结论

### ① 这是"模型覆盖的代价"还是"参照物被高估"？——**两者都有，必须分开报**

`deltaValue = actionValue(模型选的) − actionValue(本地建议的)`。本地建议在"胡 vs 改张"抉择上
用的正是 `ev.winEv = immediateTotal + chainAfterWin` 与 `best.ev = chainEvEst(...)`
（`ai.ts` 的 `reformGainRatio` 分支），所以：

- **同类弃牌覆盖**（discard→discard）：两侧都走同一套弃牌 netScore，Δ价值**可比可信**（量级几十点，
  与已有 `quality2-flash` 的 Δ潜力 −0.745 相符）。
- **跨类型覆盖**（尤其 win→discard）：Δ价值里的"本地建议"是**上界式**的，−1.3 万不是"真亏 1.3 万点"，
  而是"模型放弃了一个按该公式估价值 1.3 万的窗口"。**衡量真实代价要看 `outcome.net`（局末实测净分）**，
  以及"该局本座是否胡、胡的倍率"。

→ 任务 D 的分析脚本（`tmp/llmab-attrib-analyze.mjs`）已按 `windowKind` × `同类/跨类型` 分档，
并在结论区用**按局聚合**复核（消除"同局多条记录共享结局"的聚类放大）。读表时：
**先看同类弃牌的 Δ价值，再看跨类型覆盖的实测净分**。

### ② 本地引擎自己是否在"拒胡追高"？——**这是一个可直接验证的假设**

如果 `chainEvEst` 偏大，那么 `decideBloodFlowActionEv` 的这条分支就是可疑的：

```ts
const best = ev.reformCandidates.find(candidate => discards.some(d => d.index === candidate.index))
if (best && best.ev >= ev.winEv * config.reformGainRatio) return discards.find(d => d.index === best.index) ?? win
```

即**本地 AI 也会为了"上界式连锁期望"放弃已经能胡的牌**。间接证据：
纯本地 4 座自对局里 **硬胡只占胡牌的 1.7~1.9%**（`v6-standard` 1200 局 1.72%、`b-standard` 1200 局 1.88%），
封顶次数 **0**——说明这套策略几乎从不追求高倍率胡。

**可验证的开关**：`chainHorizon`（`PROBE_CHAIN_HORIZON`）直接缩放到该公式的 `chainFactor`。
把它设成 `0.01` ≈ 关闭连锁期望（保留公式路径，不改代码），即可做"有没有连锁期望"的 A/B。
这条已作为任务 A 的候选假设之一（见 `tmp/bulk/A-hypotheses.json`）。

## 对任务 ε 的影响

ε 闸门比的是**本地候选之间**的 top-2 价值差，两侧同源、口径一致，因此**闸门判定本身不受此偏差影响**；
受影响的只是"跳过这个窗口到底损失多少"的**解释**。ε=0 档（跳过本地完全等价窗口）不受任何影响。
