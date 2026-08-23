import { describe, expect, it } from 'vitest'
import { LLM_WIN_LINES, llmWinLine } from './winLines'

describe('LLM win lines', () => {
  it('为每种胡法和性格提供三条不超过 16 字的唯一短句', () => {
    for (const styles of Object.values(LLM_WIN_LINES)) {
      for (const variants of Object.values(styles)) {
        expect(variants).toHaveLength(3)
        expect(new Set(variants).size).toBe(3)
        expect(variants.every((line) => [...line].length <= 16)).toBe(true)
      }
    }
  })

  it('按序号稳定轮换并循环', () => {
    expect(llmWinLine('self-draw', '高冷', 0)).toBe('自摸，意料之中。')
    expect(llmWinLine('self-draw', '高冷', 1)).toBe('牌到了，仅此而已。')
    expect(llmWinLine('self-draw', '高冷', 3)).toBe('自摸，意料之中。')
  })
})
