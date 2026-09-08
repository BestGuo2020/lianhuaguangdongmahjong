import { expect, it } from 'vitest'
import { BLOOD_FLOW_LOSS_LINES, bloodFlowRoundReactionLine } from './bloodFlowRoundLines'
import { llmRoundReactionLine } from './winLines'
import type { LlmStyle } from './config'

const STYLES: LlmStyle[] = ['激进', '稳健', '话痨', '高冷']

it('血流输家台词按性格提供三条唯一短句，且只自我评价', () => {
  for (const style of STYLES) {
    const variants = BLOOD_FLOW_LOSS_LINES[style]
    expect(variants).toHaveLength(3)
    expect(new Set(variants).size).toBe(3)
    expect(variants.every(line => [...line].length <= 18)).toBe(true)
    // 不评价别人：不得出现指代他人的字眼。
    expect(variants.every(line => !/你|他|她|大家|别人|各位/.test(line))).toBe(true)
  }
})

it('按序号稳定轮换并循环', () => {
  expect(bloodFlowRoundReactionLine({ outcome: 'loss' }, '高冷', 0)).toBe('这局我输了，仅此而已。')
  expect(bloodFlowRoundReactionLine({ outcome: 'loss' }, '高冷', 1)).toBe('我自己的问题，下一局。')
  expect(bloodFlowRoundReactionLine({ outcome: 'loss' }, '高冷', 3)).toBe('这局我输了，仅此而已。')
})

it('赢家与荒庄仍沿用共享台词库，不改变非血流玩法', () => {
  for (const style of STYLES) {
    for (let sequence = 0; sequence < 6; sequence++) {
      expect(bloodFlowRoundReactionLine({ outcome: 'win', type: 'self-draw' }, style, sequence))
        .toBe(llmRoundReactionLine({ outcome: 'win', type: 'self-draw' }, style, sequence))
      expect(bloodFlowRoundReactionLine({ outcome: 'draw' }, style, sequence))
        .toBe(llmRoundReactionLine({ outcome: 'draw' }, style, sequence))
    }
  }
})
