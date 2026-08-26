import { describe, expect, it } from 'vitest'
import { compactLlmSpeechText, LlmSpeechPolicy } from './speechPolicy'

describe('compactLlmSpeechText', () => {
  it('保留联机权威层使用的全桌与座位冷却', () => {
    let now = 1_000
    const policy = new LlmSpeechPolicy(() => now)
    expect(policy.admit({ seat: 1, style: '话痨' })).toBe(true)
    now += 1_999
    expect(policy.admit({ seat: 2, style: '话痨' })).toBe(false)
    now += 1
    expect(policy.admit({ seat: 2, style: '话痨' })).toBe(true)
  })

  it('联机重要台词始终放行', () => {
    let now = 10_000
    const policy = new LlmSpeechPolicy(() => now)
    expect(policy.admit({ seat: 1, style: '高冷' })).toBe(true)
    now += 8_000
    expect(policy.admit({ seat: 1, style: '高冷' })).toBe(false)
    expect(policy.admit({ seat: 1, style: '高冷', priority: 'important' })).toBe(true)
  })

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
