import { describe, expect, it } from 'vitest'
import { compactLlmSpeechText } from './speechPolicy'

describe('compactLlmSpeechText', () => {
  it('keeps only the first short sentence for TTS and bubbles', () => {
    expect(compactLlmSpeechText('  先稳住这一手。后面还有很多话不用念。  ')).toBe('先稳住这一手。')
    expect([...compactLlmSpeechText('这是一句明显超过十六个汉字的超长牌桌吐槽文本')]).toHaveLength(16)
  })

  it('drops backstage language and internal candidate ids', () => {
    expect(compactLlmSpeechText('听引擎的？')).toBe('')
    expect(compactLlmSpeechText('候选A1最合适。')).toBe('')
    expect(compactLlmSpeechText('AI建议这么打。')).toBe('')
    expect(compactLlmSpeechText('wait一下,先看牌。')).toBe('wait一下,先看牌。')
    expect(compactLlmSpeechText('这张先打，稳住。')).toBe('这张先打,稳住。')
  })
})
