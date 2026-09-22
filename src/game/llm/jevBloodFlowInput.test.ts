// Jev 血流请求构造单测：A/B 两臂的公平性约束（state 一致、推荐不泄漏）与 criteria 渲染。
import { describe, expect, it } from 'vitest'
import { BLOOD_FLOW_PROMPT_RULES } from './bloodFlowDecisionInput'
import {
  JEV_BLOOD_FLOW_TEMPLATE_VERSION, buildJevBloodFlowRequest, jevBloodFlowTemplateId,
  type JevBloodFlowDecisionLike,
} from './jevBloodFlowInput'

function decisionFixture(overrides: Partial<JevBloodFlowDecisionLike['request']> = {}): JevBloodFlowDecisionLike {
  return {
    request: {
      decision: 'turn',
      state: { hand: ['3万', '5筒'], wallCount: 40, claimTile: null, claimFrom: null },
      engineSuggestion: 'A1',
      ...overrides,
    },
    candidates: [
      { id: 'A0', label: '打出3万', summary: 'A0 打出3万 ｜ 向听：1｜有效进张：12张' },
      { id: 'A1', label: '打出5筒', summary: 'A1 打出5筒 ｜ 向听：2｜听牌：否' },
      { id: 'A2', label: '胡牌（首次胡后锁手）', summary: 'A2 胡牌（首次胡后锁手）' },
    ],
  }
}

describe('buildJevBloodFlowRequest', () => {
  it('盲判臂：criteria 只含动作名；模板 id、promptVariables 与 engineSuggestion 正确', () => {
    const built = buildJevBloodFlowRequest({ decision: decisionFixture(), mode: 'blind', requestId: 'r1' })
    expect(built.templateId).toBe(`jev-bf-blind-v${JEV_BLOOD_FLOW_TEMPLATE_VERSION}`)
    expect(built.candidates).toEqual([
      { id: 'A0', description: '打出3万' },
      { id: 'A1', description: '打出5筒' },
      { id: 'A2', description: '胡牌（首次胡后锁手）' },
    ])
    expect(built.state.rules).toBe(BLOOD_FLOW_PROMPT_RULES)
    expect(built.state.situation).toEqual(decisionFixture().request.state)
    expect(built.promptVariables).toEqual({
      mode: 'blind', templateId: built.templateId, requestId: 'r1',
      candidateIds: ['A0', 'A1', 'A2'], engineSuggestion: 'A1',
    })
    expect(built.engineSuggestion).toBe('A1')
  })

  it('提示臂：criteria 为特征行（去候选 id 前缀）；无特征候选退化为动作名', () => {
    const built = buildJevBloodFlowRequest({ decision: decisionFixture(), mode: 'hint', requestId: 'r1' })
    expect(built.candidates).toEqual([
      { id: 'A0', description: '打出3万 ｜ 向听：1｜有效进张：12张' },
      { id: 'A1', description: '打出5筒 ｜ 向听：2｜听牌：否' },
      { id: 'A2', description: '胡牌（首次胡后锁手）' },
    ])
  })

  it('A/B 公平性：两臂 state 除 template 外完全一致；engineSuggestion 不进入请求材料', () => {
    const blind = buildJevBloodFlowRequest({ decision: decisionFixture(), mode: 'blind', requestId: 'r1' })
    const hint = buildJevBloodFlowRequest({ decision: decisionFixture(), mode: 'hint', requestId: 'r1' })
    const { template: blindTemplate, ...blindRest } = blind.state
    const { template: hintTemplate, ...hintRest } = hint.state
    expect(blindRest).toEqual(hintRest)
    expect(blindTemplate).toBe(jevBloodFlowTemplateId('blind'))
    expect(hintTemplate).toBe(jevBloodFlowTemplateId('hint'))
    // 推荐不泄漏：state 序列化里没有 engineSuggestion 字段，criteria 描述里没有推荐标记
    const serialized = JSON.stringify(blind.state) + JSON.stringify(hint.state)
      + JSON.stringify(blind.candidates) + JSON.stringify(hint.candidates)
      + blind.instructions + hint.instructions
    expect(serialized).not.toContain('engineSuggestion')
    expect(serialized).not.toContain('推荐')
  })

  it('turn 与 claim 窗口使用不同 instructions', () => {
    const turn = buildJevBloodFlowRequest({ decision: decisionFixture(), mode: 'blind', requestId: 'r1' })
    const claim = buildJevBloodFlowRequest({
      decision: decisionFixture({
        decision: 'claim',
        state: { hand: ['3万'], wallCount: 40, claimTile: '5筒', claimFrom: '上家' },
      }),
      mode: 'blind', requestId: 'r2',
    })
    expect(turn.instructions).toContain('轮到本家行动')
    expect(claim.instructions).toContain('claimTile')
    expect(turn.instructions).not.toBe(claim.instructions)
  })

  it('engineSuggestion 缺失时 promptVariables 不带该字段', () => {
    const built = buildJevBloodFlowRequest({
      decision: decisionFixture({ engineSuggestion: undefined }), mode: 'blind', requestId: 'r1',
    })
    expect('engineSuggestion' in built.promptVariables).toBe(false)
    expect(built.engineSuggestion).toBeUndefined()
  })
})
