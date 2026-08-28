import { describe, expect, it } from 'vitest'
import { DECISION_SPEECH_LINES, decisionSpeech, resolveDecisionSpeech } from './decisionSpeech'

describe('动作一致的 LLM 决策台词', () => {
  it('所有动作与性格都有不超过 16 字的程序台词', () => {
    for (const styles of Object.values(DECISION_SPEECH_LINES)) {
      for (const variants of Object.values(styles)) {
        expect(variants.length).toBeGreaterThan(0)
        expect(variants.every((line) => [...line].length <= 16)).toBe(true)
      }
    }
  })

  it('弃牌台词不会表达保留，且按序号稳定轮换', () => {
    const lines = DECISION_SPEECH_LINES.discard
    for (const variants of Object.values(lines)) {
      expect(variants.every((line) => !/留着|保留|不打/.test(line))).toBe(true)
    }
    expect(decisionSpeech({ kind: 'discard', handIndex: 0 }, '稳健', 0)).toBe('这张先走。')
    expect(decisionSpeech({ kind: 'discard', handIndex: 0 }, '稳健', 3)).toBe('这张先走。')
  })

  it('稳健性格不使用“稳稳”措辞', () => {
    for (const styles of Object.values(DECISION_SPEECH_LINES)) {
      expect(styles.稳健.every((line) => !line.includes('稳稳'))).toBe(true)
    }
  })

  it('保留牌桌烟雾弹和模型“稳稳”措辞，仅幕后内容回退程序台词', () => {
    const action = { kind: 'discard', handIndex: 0 } as const
    expect(resolveDecisionSpeech('这张留着。', action, '稳健')).toBe('这张留着。')
    expect(resolveDecisionSpeech('稳稳出牌。', action, '稳健')).toBe('稳稳出牌。')
    expect(resolveDecisionSpeech('按候选A1来。', action, '话痨')).toBe('先把这张放出去。')
  })
})
