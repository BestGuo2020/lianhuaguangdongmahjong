// Jev 血流决策请求构造：把 buildBloodFlowDecisionInput 的产物折成 /v1/systemone 请求材料。
//
// A/B 协议（docs/blood-flow/design/jev-selfplay.md）：
// - state 两臂完全一致（模板 id + 规则文本 + 公开决策快照）；唯一差异是 choice criteria 描述：
//   blind = 仅动作名（label）；hint = 动作名 + **v2 紧凑特征短语**（向听/进张/听口/安全/风险赔付/EV/杠净值）。
// - v2 变更（2026-09-23，cpu-pilot 结案驱动）：v1 直接复用 candidateLine 长特征行，1.5B 基座利用率极低
//   （一致率仅比 blind +2.6pp）；v2 压成「label·短token」格式，只保留决策相关的关键数值信号。
//   升版本即换模板 id（jev-bf-{mode}-v2）；旧记录按当时落库的 promptTemplate 自包含可读。
// - engineSuggestion / bigHandRoute **绝不进入请求**（不泄漏本地推荐，保证盲判臂公平）；
//   它们只写入 promptVariables 供分析记录计算「Jev vs 本地推荐」一致率。
// - v2 仍只发主 choice 问题；noul/score 附加问属于后续模板版本。
import { BLOOD_FLOW_PROMPT_RULES } from './bloodFlowDecisionInput'
import type { JevCandidate } from './jevClient'

export type JevBloodFlowMode = 'blind' | 'hint'

/** 模板版本：state/criteria/instructions 形状变更时必须递增（分析记录按 id 去重存模板）。 */
export const JEV_BLOOD_FLOW_TEMPLATE_VERSION = 2

export function jevBloodFlowTemplateId(mode: JevBloodFlowMode): string {
  return `jev-bf-${mode}-v${JEV_BLOOD_FLOW_TEMPLATE_VERSION}`
}

/** v2 紧凑渲染用到的 CandidateFeatures 结构子集（结构化类型，测试夹具无需完整 features）。 */
export interface JevCandidateFeaturesLite {
  shanten?: number | 'n/a'
  ukeire?: number | 'n/a'
  ready?: boolean | 'unknown'
  waits?: ReadonlyArray<unknown> | 'n/a'
  waitsTotal?: number
  safety?: string
  specialPattern?: string
  scoreDeltaBand?: string
  opponentRisk?: { tier?: string; payment?: number }
  ev?: {
    income?: { total?: number }
    win?: { immediateTotal?: number; lockedChain?: number; floor?: number }
    reform?: { chain?: number; anyWait?: boolean }
    rob?: { winEv?: number; passEv?: number }
    developEv?: number
  }
  kongValue?: { net?: number }
}

/** buildBloodFlowDecisionInput 返回值中本模块用到的结构子集（便于测试夹具，不绑定完整类型）。 */
export interface JevBloodFlowDecisionLike {
  request: {
    decision: string
    state: Record<string, unknown>
    engineSuggestion?: string
  }
  candidates: Array<{ id: string; label: string; summary?: string; features?: JevCandidateFeaturesLite }>
}

/**
 * v2 紧凑 criteria 描述：`label·token·token…`。
 * 只渲染存在的信号；无 features 或无可渲染信号时退化为 label。
 * token 词表（与结案记录一致，改动即升模板版本）：
 *   向N=向听 进M=有效进张 听K口=已听K种 安高/中/低=安全度 险{档}{点数}=对手风险赔付
 *   {番型名}=特殊牌型 得N=胡牌即得 链N=锁手连锁 门N=首胡门槛 改N[任]=改张连锁(任意听)
 *   抢N/过M=抢杠两值 发N=过牌发育期望 EV±N=固定手毛收入 杠净±N=开杠价值 收{档}=收益档
 */
export function compactCandidateDescription(label: string, features?: JevCandidateFeaturesLite): string {
  if (!features) return label
  const tokens: string[] = []
  if (typeof features.shanten === 'number') tokens.push(`向${features.shanten}`)
  if (typeof features.ukeire === 'number') tokens.push(`进${features.ukeire}`)
  if (features.ready === true) {
    const waits = features.waitsTotal ?? (Array.isArray(features.waits) ? features.waits.length : 0)
    tokens.push(waits > 0 ? `听${waits}口` : '听')
  }
  if (features.safety === '高' || features.safety === '中' || features.safety === '低') tokens.push(`安${features.safety}`)
  const risk = features.opponentRisk
  if (risk && typeof risk.payment === 'number') tokens.push(`险${risk.tier ?? ''}${risk.payment}`)
  if (features.specialPattern && features.specialPattern !== 'none' && features.specialPattern !== 'n/a') {
    tokens.push(features.specialPattern)
  }
  const ev = features.ev
  if (ev?.win) {
    tokens.push(`得${Math.round(ev.win.immediateTotal ?? 0)}`, `链${Math.round(ev.win.lockedChain ?? 0)}`)
    if (ev.win.floor) tokens.push(`门${ev.win.floor}`)
  }
  if (ev?.reform) tokens.push(`改${Math.round(ev.reform.chain ?? 0)}${ev.reform.anyWait ? '任' : ''}`)
  if (ev?.rob) tokens.push(`抢${Math.round(ev.rob.winEv ?? 0)}/过${Math.round(ev.rob.passEv ?? 0)}`)
  if (typeof ev?.developEv === 'number') tokens.push(`发${Math.round(ev.developEv)}`)
  if (typeof ev?.income?.total === 'number' && !ev?.win && !ev?.reform) {
    const total = Math.round(ev.income.total)
    tokens.push(`EV${total >= 0 ? '+' : ''}${total}`)
  }
  if (typeof features.kongValue?.net === 'number') {
    const net = Math.round(features.kongValue.net)
    tokens.push(`杠净${net >= 0 ? '+' : ''}${net}`)
  }
  if (!ev?.win && typeof ev?.income?.total !== 'number'
    && features.scoreDeltaBand && features.scoreDeltaBand !== 'n/a') {
    tokens.push(`收${features.scoreDeltaBand}`)
  }
  return tokens.length ? `${label}·${tokens.join('·')}` : label
}

export interface JevBloodFlowRequest {
  templateId: string
  mode: JevBloodFlowMode
  /** /v1/systemone 的 state：JSON 对象（OpenJev 接受对象并自行嵌入提示词）。 */
  state: Record<string, unknown>
  /** 主 choice 问题的 instructions（两臂一致，属于模板的一部分）。 */
  instructions: string
  /** choice criteria 材料：id → 描述（blind 只有动作名；hint 附 v2 紧凑特征短语）。 */
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
    description: mode === 'blind'
      ? candidate.label
      : compactCandidateDescription(candidate.label, candidate.features),
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
