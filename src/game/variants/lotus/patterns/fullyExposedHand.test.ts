import { describe, expect, it } from 'vitest'
import type { Meld } from '../../../core/contracts/types'
import { bloodFlowScoreCardItems } from '../../../../components/table/bloodFlowScoreCard'
import { BLOOD_FLOW_PROMPT_RULES } from '../../../llm/bloodFlowDecisionInput'
import { isPublicWinScore } from '../bloodFlow/network/protocol'
import { estimateWinIncome, patternPotentials } from '../bloodFlow/patternPotentials'
import { canDevelopPatternWithMelds } from '../bloodFlow/patternReachability'
import { evaluateWaits } from './evaluate'
import fixtures from './fixtures/fullyExposedHand.json'
import type { GoldenWinCase } from './fixtures/types'

const fixture = (fixtures.cases as readonly GoldenWinCase[]).find(c => c.id === 'twelve-joker-self-draw')!.input
const id = 'fully-exposed-hand'

describe('十二落抬精吊与消费链路', () => {
  it('34 种自摸听口都带 2 番，接炮全禁；结算明细和协议保留番种', () => {
    const waits = evaluateWaits(fixture)
    expect(waits).toHaveLength(34)
    for (const wait of waits) {
      expect(wait.discard).toBeNull()
      expect(wait.selfDraw).not.toBeNull()
      expect(bloodFlowScoreCardItems(wait.selfDraw!)).toContainEqual({ id, label: '十二落抬', weight: 2 })
      expect(isPublicWinScore(JSON.parse(JSON.stringify(wait.selfDraw)))).toBe(true)
    }
    expect(BLOOD_FLOW_PROMPT_RULES).toContain('十二落抬（2番')
    expect(BLOOD_FLOW_PROMPT_RULES).toContain('含暗杠或风杠不算')
  })

  it.each(['off', 'ev'] as const)('AI %s 估值计入已成立的十二落抬', model => {
    const { concealed, melds, jokers, winningTile } = fixture
    expect(patternPotentials(concealed, melds, jokers, model)).toContainEqual({ id, weight: 2, progress: 1, score: 2 })
    expect(estimateWinIncome([...concealed, winningTile], melds, jokers, 'self-draw', model).paymentPerPayer).toBe(40)
  })

  it.each(['twelve-concealed-kong-excluded', 'twelve-wind-kong-excluded', 'twelve-pending-added-kong-not-counted'])(
    'AI 不把不可达结构当作十二落抬：%s', name => {
      const { input } = (fixtures.cases as readonly GoldenWinCase[]).find(c => c.id === name)!
      expect(canDevelopPatternWithMelds(id, input.melds)).toBe(false)
      expect(patternPotentials(input.concealed, input.melds, input.jokers, 'ev').map(p => p.id)).not.toContain(id)
    },
  )

  it('尚未四副露时只标可达，不预支完成后的 2 番', () => {
    const melds = fixture.melds.slice(0, 3) as Meld[]
    expect(canDevelopPatternWithMelds(id, melds)).toBe(true)
    expect(patternPotentials(['east', 'east', 'east', 'red'], melds, fixture.jokers, 'ev').map(p => p.id)).not.toContain(id)
  })
})
