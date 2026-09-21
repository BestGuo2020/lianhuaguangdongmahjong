import { describe, expect, it } from 'vitest'
import { reassembleFragments, splitOversizedPart, partBytes } from './fragments'
import type { AnalysisBlockPart } from './codec'

// §9.3：单条超大记录（例如模型返回的超长回答）必须切成**可重组的片段**，且原文逐字保留。
// 验收点：小记录不包装；大记录每片有界；重组后与原值完全一致（含中文与代理对/emoji）；
// 缺片、坏片都要能被读取侧识别为"不完整"，不得静默给半份数据。

function bigAnswer(size: number, fill = '字'): AnalysisBlockPart {
  return { tag: 'llmAttempt', value: { id: 'attempt/1', answer: fill.repeat(size), model: 'test' } }
}

describe('超大记录片段化（§9.3）', () => {
  it('不超过阈值就原样返回（绝大多数记录不额外包装）', () => {
    const part: AnalysisBlockPart = { tag: 'decision', value: { id: 'd1' } }
    expect(splitOversizedPart(part)).toEqual([part])
  })

  it('超大记录切成多片，每片 JSON 字节有界', () => {
    const part = bigAnswer(200_000)
    const fragments = splitOversizedPart(part, { targetBytes: 8 * 1024, nextId: () => 'f1' })
    expect(fragments.length).toBeGreaterThan(1)
    for (const fragment of fragments) expect(partBytes(fragment)).toBeLessThanOrEqual(8 * 1024)
    const values = fragments.map(fragment => fragment.value as { id: string; index: number; total: number; tag: string })
    expect(values.every(value => value.id === 'f1')).toBe(true)
    expect(values.every(value => value.total === fragments.length)).toBe(true)
    expect(values.map(value => value.index)).toEqual(fragments.map((_, index) => index))
    expect(values.every(value => value.tag === 'llmAttempt')).toBe(true)
  })

  it('重组后与原记录**完全一致**（原文逐字保留）', () => {
    const part = bigAnswer(120_000)
    const fragments = splitOversizedPart(part, { targetBytes: 4 * 1024, nextId: () => 'f2' })
    const rebuilt = reassembleFragments(fragments)
    expect(rebuilt.incomplete).toEqual([])
    expect(rebuilt.parts).toEqual([part])
    expect((rebuilt.parts[0].value as { answer: string }).answer.length).toBe(120_000)
  })

  it('切片落在代理对中间也不损坏（emoji / 生僻字拼接后仍是同一个字符串）', () => {
    const emoji = '🎋莲花广麻🀄'.repeat(4_000)
    const part: AnalysisBlockPart = { tag: 'llmAttempt', value: { id: 'a2', answer: emoji } }
    const fragments = splitOversizedPart(part, { targetBytes: 2 * 1024, nextId: () => 'f3' })
    const rebuilt = reassembleFragments(fragments)
    expect(rebuilt.incomplete).toEqual([])
    expect((rebuilt.parts[0].value as { answer: string }).answer).toBe(emoji)
  })

  it('顺序无关：打乱片段顺序仍能正确重组', () => {
    const part = bigAnswer(50_000)
    const fragments = splitOversizedPart(part, { targetBytes: 3 * 1024, nextId: () => 'f4' })
    const shuffled = [...fragments].reverse()
    expect(reassembleFragments(shuffled).parts).toEqual([part])
  })

  it('缺片 ⇒ 计入 incomplete，且**不产出半份数据**', () => {
    const part = bigAnswer(50_000)
    const fragments = splitOversizedPart(part, { targetBytes: 3 * 1024, nextId: () => 'f5' })
    const missing = fragments.filter((_, index) => index !== 1)
    const rebuilt = reassembleFragments(missing)
    expect(rebuilt.incomplete).toEqual(['f5'])
    expect(rebuilt.parts).toEqual([])
  })

  it('坏片（形状不对）同样算不完整，不冒充内容', () => {
    const part = bigAnswer(20_000)
    const fragments = splitOversizedPart(part, { targetBytes: 2 * 1024, nextId: () => 'f6' })
    const broken = [...fragments.slice(0, -1), { tag: 'fragment', value: { id: 'f6' } } as AnalysisBlockPart]
    const rebuilt = reassembleFragments(broken)
    expect(rebuilt.incomplete).toContain('f6')
    expect(rebuilt.parts).toEqual([])
  })

  it('多组片段与普通记录混排：各自归位、顺序不变', () => {
    const plainA: AnalysisBlockPart = { tag: 'config', value: { id: 'c1' } }
    const first = splitOversizedPart(bigAnswer(30_000, '甲'), { targetBytes: 3 * 1024, nextId: () => 'g1' })
    const plainB: AnalysisBlockPart = { tag: 'settlement', value: { id: 's1' } }
    const second = splitOversizedPart(bigAnswer(30_000, '乙'), { targetBytes: 3 * 1024, nextId: () => 'g2' })
    const rebuilt = reassembleFragments([plainA, ...first, plainB, ...second])
    expect(rebuilt.incomplete).toEqual([])
    expect(rebuilt.parts.map(part => part.tag)).toEqual(['config', 'llmAttempt', 'settlement', 'llmAttempt'])
    expect((rebuilt.parts[1].value as { answer: string }).answer).toBe('甲'.repeat(30_000))
    expect((rebuilt.parts[3].value as { answer: string }).answer).toBe('乙'.repeat(30_000))
    expect(rebuilt.fragments).toBe(first.length + second.length)
  })
})
