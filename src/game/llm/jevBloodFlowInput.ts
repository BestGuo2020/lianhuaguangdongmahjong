// Jev 血流决策请求构造：把 buildBloodFlowDecisionInput 的产物折成 /v1/systemone 请求材料。
//
// A/B 协议（docs/blood-flow/design/jev-selfplay.md）：
// - state 两臂完全一致（模板 id + 规则文本 + 公开决策快照）；唯一差异是 choice criteria 描述：
//   blind = 仅动作名（label）；hint = 动作名 + 本地特征行（candidateLine 输出，去候选 id 前缀）。
// - engineSuggestion / bigHandRoute **绝不进入请求**（不泄漏本地推荐，保证盲判臂公平）；
//   它们只写入 promptVariables 供分析记录计算「Jev vs 本地推荐」一致率。
// - v1 模板只发主 choice 问题；noul/score 附加问属于后续模板版本（改模板必须升版本号留痕）。
import { BLOOD_FLOW_PROMPT_RULES } from './bloodFlowDecisionInput'
import type { JevCandidate } from './jevClient'

export type JevBloodFlowMode = 'blind' | 'hint'

/** 模板版本：state/criteria/instructions 形状变更时必须递增（分析记录按 id 去重存模板）。 */
export const JEV_BLOOD_FLOW_TEMPLATE_VERSION = 1

export function jevBloodFlowTemplateId(mode: JevBloodFlowMode): string {
  return `jev-bf-${mode}-v${JEV_BLOOD_FLOW_TEMPLATE_VERSION}`
}

/** buildBloodFlowDecisionInput 返回值中本模块用到的结构子集（便于测试夹具，不绑定完整类型）。 */
export interface JevBloodFlowDecisionLike {
  request: {
    decision: string
    state: Record<string, unknown>
    engineSuggestion?: string
  }
  candidates: Array<{ id: string; label: string; summary: string }>
}

export interface JevBloodFlowRequest {
  templateId: string
  mode: JevBloodFlowMode
  /** /v1/systemone 的 state：JSON 对象（OpenJev 接受对象并自行嵌入提示词）。 */
  state: Record<string, unknown>
  /** 主 choice 问题的 instructions（两臂一致，属于模板的一部分）。 */
  instructions: string
  /** choice criteria 材料：id → 描述（blind 只有动作名；hint 附特征行）。 */
  candidates: JevCandidate[]
  /** 本地确定性推荐（只进分析记录，不发给 Jev）。 */
  engineSuggestion: string | undefined
  /** attemptStarted 的 promptVariables：足以事后精确重建这次请求。 */
  promptVariables: {
    mode: JevBloodFlowMode
    templateId: string
    requestId: string
    candidateIds: string[]
    engineSuggestion?: string
  }
}

export const JEV_BLOOD_FLOW_TURN_INSTRUCTIONS = '轮到本家行动。从候选中选出你要执行的一个动作。'
export const JEV_BLOOD_FLOW_CLAIM_INSTRUCTIONS = '对手刚打出一张牌（牌张与来源见 situation 的 claimTile / claimFrom）。从候选中选出你要执行的一个动作；不行动就选「过」。'

/** candidateLine 输出为 `${id} ${label} ｜ 特征…`：去掉 id 前缀，criteria 键已经是 id。 */
function stripCandidateIdPrefix(summary: string, id: string): string {
  return summary.startsWith(`${id} `) ? summary.slice(id.length + 1) : summary
}

export function buildJevBloodFlowRequest(input: {
  decision: JevBloodFlowDecisionLike
  mode: JevBloodFlowMode
  requestId: string
}): JevBloodFlowRequest {
  const { decision, mode, requestId } = input
  const templateId = jevBloodFlowTemplateId(mode)
  const claim = decision.request.decision === 'claim'
  const instructions = claim ? JEV_BLOOD_FLOW_CLAIM_INSTRUCTIONS : JEV_BLOOD_FLOW_TURN_INSTRUCTIONS
  const state: Record<string, unknown> = {
    template: templateId,
    rules: BLOOD_FLOW_PROMPT_RULES,
    situation: decision.request.state,
  }
  const candidates: JevCandidate[] = decision.candidates.map((candidate) => ({
    id: candidate.id,
    description: mode === 'blind' ? candidate.label : stripCandidateIdPrefix(candidate.summary, candidate.id),
  }))
  return {
    templateId,
    mode,
    state,
    instructions,
    candidates,
    engineSuggestion: decision.request.engineSuggestion,
    promptVariables: {
      mode,
      templateId,
      requestId,
      candidateIds: candidates.map((candidate) => candidate.id),
      ...(decision.request.engineSuggestion ? { engineSuggestion: decision.request.engineSuggestion } : {}),
    },
  }
}
