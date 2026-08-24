import { describe, expect, it } from 'vitest'
import { compactLlmSpeechText, LlmSpeechPolicy } from './speechPolicy'

describe('LlmSpeechPolicy', () => {
  it('enforces a global cooldown across alternating AI seats', () => {
    let now = 1_000
    const policy = new LlmSpeechPolicy(() => now)
    expect(policy.admit({ seat: 1, style: '话痨' })).toBe(true)
    now += 1_999
    expect(policy.admit({ seat: 2, style: '话痨' })).toBe(false)
    now += 1
    expect(policy.admit({ seat: 2, style: '话痨' })).toBe(true)
  })

  it('makes 高冷 significantly quieter than 话痨 and always admits important lines', () => {
    let now = 10_000
    const policy = new LlmSpeechPolicy(() => now)
    expect(policy.admit({ seat: 1, style: '高冷' })).toBe(true)
    now += 8_000
    expect(policy.admit({ seat: 1, style: '高冷' })).toBe(false)
    expect(policy.admit({ seat: 1, style: '高冷', priority: 'important' })).toBe(true)
    now += 2_000
    expect(policy.admit({ seat: 2, style: '话痨' })).toBe(true)
  })

  it('keeps only the first short sentence for TTS and bubbles', () => {
    expect(compactLlmSpeechText('  先稳住这一手。后面还有很多话不用念。  ')).toBe('先稳住这一手。')
    expect([...compactLlmSpeechText('这是一句明显超过十六个汉字的超长牌桌吐槽文本')]).toHaveLength(16)
  })

  it('drops backstage language and internal candidate ids', () => {
    expect(compactLlmSpeechText('跟引擎走，稳。')).toBe('')
    expect(compactLlmSpeechText('候选A1最合适。')).toBe('')
    expect(compactLlmSpeechText('AI建议这么打。')).toBe('')
    expect(compactLlmSpeechText('wait一下,先看牌。')).toBe('wait一下,先看牌。')
    expect(compactLlmSpeechText('这张先打，稳住。')).toBe('这张先打,稳住。')
  })
})
