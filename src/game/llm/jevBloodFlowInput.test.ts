// Jev 血流请求构造单测（模板 v2）：A/B 两臂的公平性约束（state 一致、推荐不泄漏）与紧凑 criteria 渲染。
import { describe, expect, it } from 'vitest'
import { BLOOD_FLOW_PROMPT_RULES } from './bloodFlowDecisionInput'
import {
  JEV_BLOOD_FLOW_TEMPLATE_VERSION, buildJevBloodFlowRequest, compactCandidateDescription,
  jevBloodFlowTemplateId, type JevBloodFlowDecisionLike,
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
      {
        id: 'A0', label: '打出3万',
        features: { shanten: 1, ukeire: 12, safety: '中', ev: { income: { total: 340 } } },
      },
      {
        id: 'A1', label: '打出5筒',
        features: { shanten: 2, ready: false },
      },
      {
        id: 'A2', label: '胡牌（首次胡后锁手）',
        features: { specialPattern: '清一色', ev: { win: { immediateTotal: 240, lockedChain: 1180, floor: 480 } } },
      },
    ],
  }
}

describe('buildJevBloodFlowRequest（v2）', () => {
  it('盲判臂：criteria 只含动作名；模板 id 升 v2；promptVariables 与 engineSuggestion 正确', () => {
    const built = buildJevBloodFlowRequest({ decision: decisionFixture(), mode: 'blind', requestId: 'r1' })
    expect(JEV_BLOOD_FLOW_TEMPLATE_VERSION).toBe(2)
    expect(built.templateId).toBe('jev-bf-blind-v2')
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

  it('提示臂：criteria 为 v2 紧凑短语（label·tokens），无 features 候选退化为动作名', () => {
    const built = buildJevBloodFlowRequest({ decision: decisionFixture(), mode: 'hint', requestId: 'r1' })
    expect(built.candidates).toEqual([
      { id: 'A0', description: '打出3万·向1·进12·安中·EV+340' },
      { id: 'A1', description: '打出5筒·向2' },
      { id: 'A2', description: '胡牌（首次胡后锁手）·清一色·得240·链1180·门480' },
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

describe('compactCandidateDescription（v2 token 词表）', () => {
  it('杠净值（负值带符号）', () => {
    expect(compactCandidateDescription('暗杠5筒', { kongValue: { net: -30 } })).toBe('暗杠5筒·杠净-30')
    expect(compactCandidateDescription('直杠', { kongValue: { net: 45 } })).toBe('直杠·杠净+45')
  })
  it('过牌发育期望与抢杠两值', () => {
    expect(compactCandidateDescription('过', { ev: { developEv: 180 } })).toBe('过·发180')
    expect(compactCandidateDescription('过', { ev: { rob: { winEv: 320, passEv: 180 } } })).toBe('过·抢320/过180')
  })
  it('对手风险赔付与听口', () => {
    expect(compactCandidateDescription('打出9条', {
      ready: true, waitsTotal: 2, opponentRisk: { tier: '高', payment: 640 },
    })).toBe('打出9条·听2口·险高640')
  })
  it('win/reform 在场时不重复渲染 EV 毛收入', () => {
    expect(compactCandidateDescription('打出1万', {
      ev: { income: { total: 500 }, reform: { chain: 220, anyWait: true } },
    })).toBe('打出1万·改220任')
  })
  it('无 features 或无可渲染信号时退化为 label', () => {
    expect(compactCandidateDescription('碰', undefined)).toBe('碰')
    expect(compactCandidateDescription('碰', {})).toBe('碰')
    expect(compactCandidateDescription('打出2万', { shanten: 'n/a', ukeire: 'n/a', ready: 'unknown' })).toBe('打出2万')
  })
  it('收益档只在没有 EV 数值时兜底', () => {
    expect(compactCandidateDescription('胡牌', { scoreDeltaBand: '高' })).toBe('胡牌·收高')
    expect(compactCandidateDescription('打出3万', { scoreDeltaBand: '高', ev: { income: { total: 120 } } })).toBe('打出3万·EV+120')
  })
})
