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

  it('允许牌路烟雾弹，但非庄家不能冒充庄家', () => {
    const action = { kind: 'discard', handIndex: 0 } as const
    expect(resolveDecisionSpeech('这张留着。', action, '激进', 0, { isDealer: false }))
      .toBe('这张留着。')
    expect(resolveDecisionSpeech('我就是庄家！', action, '激进', 0, { isDealer: false }))
      .toBe('这张不要了。')
    expect(resolveDecisionSpeech('庄家就是我！', action, '激进', 0, { isDealer: true }))
      .toBe('庄家就是我!')
    expect(resolveDecisionSpeech('我不是庄家。', action, '稳健', 0, { isDealer: true }))
      .toBe('这张先走。')
  })

  it('公开动作承诺必须与最终 choice 一致', () => {
    const discard = { kind: 'discard', handIndex: 0 } as const
    expect(resolveDecisionSpeech('这牌我吃定了！', discard, '激进')).toBe('这张不要了。')
    expect(resolveDecisionSpeech('这牌我吃定了！', { kind: 'chi', optionIndex: 0 }, '激进'))
      .toBe('这牌我吃定了!')
  })

  it('他家公开吃碰杠与当前弃牌来源说错时回退，但牌路烟雾弹仍保留', () => {
    const discard = { kind: 'discard', handIndex: 0 } as const
    const facts = {
      publicMeldTypes: { 上家: [], 对家: [], 下家: ['peng'] },
      currentDiscard: { from: '上家' as const, tile: '7万' },
    }
    expect(resolveDecisionSpeech('下家杠了，我稳一手。', discard, '稳健', 0, facts))
      .toBe('这张先走。')
    expect(resolveDecisionSpeech('下家碰了，我稳一手。', discard, '稳健', 0, facts))
      .toBe('下家碰了,我稳一手。')
    expect(resolveDecisionSpeech('下家打出7万。', discard, '稳健', 0, facts))
      .toBe('这张先走。')
    expect(resolveDecisionSpeech('上家打出7万，这张留着。', discard, '稳健', 0, facts))
      .toBe('上家打出7万,这张留着。')
  })
})
