// ε-容忍约束（2026-09-17，任务 ε）：**在调用大模型之前**判断"这个窗口值不值得问模型"。
//
// 动机（实测数据）：在莲花麻将·血流里用同一套本地引擎驱动 4 座、把其中 1 座换成大模型
// （`deepseek-flash`，1000 局 / 33,197 次调用），该座位**平均每局亏 224.7 点**且显著（t = −3.57）。
// 机制已定位：模型的同类弃牌改牌**用番型潜力换听牌速度**（潜力更低:更高 = 165:58，平均 −0.745）。
// 同时实测"覆盖质量"里 `deepseek-v4-pro` 的 300 局花了 ¥300+，而**缓存永远打不中**
//（prompt 首字段 `requestId`/`stateVersion` 每次不同，前缀缓存要求逐字节相同）。
//
// 因此最大的降本杠杆**不是**换模型或前缀化，而是：**明显该打哪张的窗口根本不用问模型**。
// 本模块就是那条闸门：
//
//   设本地候选按价值（点）降序为 v1 ≥ v2 ≥ …，`gap = v1 − v2`：
//     · `gap ≤ ε`  → 本地最优与次优**几乎等价** ⇒ 模型怎么选都无所谓 ⇒ **跳过调用**，
//                    直接采用本地 EV 建议；调用次数与对局耗时同时下降。
//     · `gap >  ε` → 这个窗口模型真正有话语权（选错要真金白银地亏）⇒ 照常调用模型。
//
// `gap` 的两个口径（都在下面导出，实验时两个都用）：
//   · `topTwoGap`  —— v1 − v2（"本地最优与次优差多少"）：默认闸门口径，最保守。
//   · `spread`     —— v1 − v_min（"本地最优与最差差多少"）：等价于对**全部**候选设限，
//                     模型连最差的候选都不能选；跳过比例更高但更激进。
//
// 边界与安全：
//   · 只影响"要不要问模型 / 采不采用模型的选择"，**不触碰规则、计分、封顶、合法性**；
//   · `epsilon <= 0`（默认）→ 闸门**完全关闭**，行为与既有线上逐位一致；
//   · 候选数 ≤ 1 的窗口本来就不调用模型（`createBloodFlowDecisions.decide` 已短路），闸门不参与。
import type { BloodFlowSeatView } from './seatView'
import type { BloodFlowAiConfig } from './config'
import { BLOOD_FLOW_AI } from './config'
import type { BloodFlowAction } from './state'
import { actionValue } from './evValue'

/** ε 闸门配置。`enabled: false` = 关闭（默认，行为与既有版本逐位一致）。 */
export interface BloodFlowEvGateConfig {
  /**
   * 是否开启闸门。**与 ε 的取值解耦**：`enabled: true` + `epsilon: 0` 表示
   * "只跳过本地完全等价（gap = 0）的窗口"——这是一个**有意义的实验臂**（实测能跳过约 18~24% 的窗口），
   * 而不是"关闭"。早期实现用 `epsilon > 0` 兼作开关，导致 ε=0 被静默当成关闭（2026-09-17 修正）。
   */
  readonly enabled: boolean
  /**
   * 容忍阈值（点）。`gap <= epsilon` 的窗口跳过模型调用。
   * `0` 表示"只跳过本地完全等价的窗口"。
   */
  readonly epsilon: number
  /** 闸门口径：`top-two`（默认，保守）或 `spread`（对全部候选设限，更保守，见文件头）。 */
  readonly mode: 'top-two' | 'spread'
}

export const BLOOD_FLOW_EV_GATE_OFF: BloodFlowEvGateConfig = Object.freeze({ enabled: false, epsilon: 0, mode: 'top-two' })

/**
 * 从环境变量读 ε（实验开关）：
 *   `VITE_BLOOD_FLOW_LLM_EPSILON` = 数字（点，**允许 0**），设置即开启闸门。
 *   `VITE_BLOOD_FLOW_LLM_EPSILON_MODE` = `top-two`（默认）| `spread`。
 * 未设置 ⇒ 关闭。只在**显式设置**时打开，保证默认部署行为不变。
 */
export function bloodFlowEvGateFromEnv(): BloodFlowEvGateConfig {
  const env = (import.meta as { env?: Record<string, string | undefined> }).env
  const raw = env?.VITE_BLOOD_FLOW_LLM_EPSILON
  const epsilon = raw === undefined || raw === '' ? Number.NaN : Number(raw)
  const mode = env?.VITE_BLOOD_FLOW_LLM_EPSILON_MODE === 'spread' ? 'spread' : 'top-two'
  return Object.freeze({
    enabled: Number.isFinite(epsilon) && epsilon >= 0,
    epsilon: Number.isFinite(epsilon) && epsilon > 0 ? epsilon : 0,
    mode,
  })
}

/** 当前闸门是否开启（关闭时所有调用路径走原逻辑）。 */
export function bloodFlowEvGateEnabled(gate: BloodFlowEvGateConfig) {
  return gate.enabled
}

export interface EvGateDecision {
  /** 价值的降序向量（点）。 */
  readonly values: readonly number[]
  /** v1 − v2（候选 < 2 时为 0）。 */
  readonly topTwoGap: number
  /** v1 − v_min（候选 < 2 时为 0）。 */
  readonly spread: number
  /** 闸门判定的那个差（按 mode 取 topTwoGap 或 spread）。 */
  readonly gap: number
  /** true = 这个窗口不必调用模型。 */
  readonly skipModel: boolean
}

/**
 * 闸门判定（纯函数）。
 * `actions` 必须是**模型能看到的候选集**（即 `buildBloodFlowDecisionInput` 里 offered 的那一份），
 * 否则闸门会算错——模型看不到的候选不构成"自由度"。
 */
export function evaluateEvGate(
  view: BloodFlowSeatView, actions: readonly BloodFlowAction[],
  config: BloodFlowAiConfig = BLOOD_FLOW_AI, gate: BloodFlowEvGateConfig = BLOOD_FLOW_EV_GATE_OFF,
): EvGateDecision {
  const values = actions.map(action => actionValue(view, action, config)).sort((a, b) => b - a)
  const topTwoGap = values.length >= 2 ? values[0] - values[1] : 0
  const spread = values.length >= 2 ? values[0] - values[values.length - 1] : 0
  const gap = gate.mode === 'spread' ? spread : topTwoGap
  return {
    values, topTwoGap, spread, gap,
    // 候选 ≤ 1 的窗口本来就不调用模型（调用方已短路）→ 这里不算"跳过"。
    skipModel: bloodFlowEvGateEnabled(gate) && values.length >= 2 && gap <= gate.epsilon,
  }
}
