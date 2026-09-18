import { expect, it } from 'vitest'
import { BLOOD_FLOW_LOSS_LINES, BLOOD_FLOW_WIN_LINES, bloodFlowAnimeResultKey, bloodFlowRoundReactionLine } from './bloodFlowRoundLines'
import { llmRoundReactionLine } from './winLines'
import { ANIME_RESULT_VOICE_KEYS, animeVoiceLine } from './animeCharacters'
import type { LlmStyle } from './config'
import type { LlmWinType } from './winLines'

const STYLES: LlmStyle[] = ['激进', '稳健', '话痨', '高冷']
const WIN_TYPES: LlmWinType[] = ['self-draw', 'discard-win', 'robbed-kong-win']
/** 不指代/评价他人：输家与赢家台词都只说自己。 */
const NO_OTHERS = /你|他|她|大家|别人|各位/

it('血流输家台词按性格提供三条唯一短句，且只自我评价', () => {
  for (const style of STYLES) {
    const variants = BLOOD_FLOW_LOSS_LINES[style]
    expect(variants).toHaveLength(3)
    expect(new Set(variants).size).toBe(3)
    expect(variants.every(line => [...line].length <= 18)).toBe(true)
    expect(variants.every(line => !NO_OTHERS.test(line))).toBe(true)
  }
})

it('血流赢家台词按胡法与性格提供三条唯一短句，且不评价他人', () => {
  for (const type of WIN_TYPES) {
    for (const style of STYLES) {
      const variants = BLOOD_FLOW_WIN_LINES[type][style]
      expect(variants).toHaveLength(3)
      expect(new Set(variants).size).toBe(3)
      expect(variants.every(line => [...line].length <= 16)).toBe(true)
      expect(variants.every(line => !NO_OTHERS.test(line))).toBe(true)
    }
  }
})

it('按序号稳定轮换并循环', () => {
  expect(bloodFlowRoundReactionLine({ outcome: 'loss' }, '高冷', 0)).toBe('这局我输了，仅此而已。')
  expect(bloodFlowRoundReactionLine({ outcome: 'loss' }, '高冷', 3)).toBe('这局我输了，仅此而已。')
  expect(bloodFlowRoundReactionLine({ outcome: 'win', type: 'self-draw' }, '激进', 0)).toBe('这局自摸收官，净胜到手！')
  expect(bloodFlowRoundReactionLine({ outcome: 'win', type: 'self-draw' }, '激进', 3)).toBe('这局自摸收官，净胜到手！')
})

it('荒庄仍沿用共享台词库，不改变非血流玩法', () => {
  for (const style of STYLES) {
    for (let sequence = 0; sequence < 6; sequence++) {
      expect(bloodFlowRoundReactionLine({ outcome: 'draw' }, style, sequence))
        .toBe(llmRoundReactionLine({ outcome: 'draw' }, style, sequence))
    }
  }
})

it('血流赢家台词与共享库不同（专属语境，不误用经典台词）', () => {
  for (const type of WIN_TYPES) {
    for (const style of STYLES) {
      const reaction = { outcome: 'win', type } as const
      expect(bloodFlowRoundReactionLine(reaction, style, 0))
        .not.toBe(llmRoundReactionLine(reaction, style, 0))
    }
  }
})

it('llmAnime 局末感言映射到角色专属固定文案键', () => {
  expect(bloodFlowAnimeResultKey({ outcome: 'draw' })).toBe('draw')
  expect(bloodFlowAnimeResultKey({ outcome: 'loss' })).toBe('loss')
  expect(bloodFlowAnimeResultKey({ outcome: 'win', type: 'self-draw' })).toBe('win-self-draw')
  expect(bloodFlowAnimeResultKey({ outcome: 'win', type: 'discard-win' })).toBe('win-discard')
  expect(bloodFlowAnimeResultKey({ outcome: 'win', type: 'robbed-kong-win' })).toBe('win-robbed-kong')
  // 只使用既有结果类键：不新增角色合同文案，也不借用动作类（吃碰杠胡）键。
  for (const reaction of [{ outcome: 'draw' }, { outcome: 'loss' },
    ...WIN_TYPES.map(type => ({ outcome: 'win', type } as const))] as const) {
    expect(ANIME_RESULT_VOICE_KEYS).toContain(bloodFlowAnimeResultKey(reaction))
  }
  expect(bloodFlowAnimeResultKey({ outcome: 'win', type: 'self-draw' })).not.toBe('hu')
  // 每个角色都提供这五条结果台词，因此血流局末感言对任意角色都有专属文案。
  expect(animeVoiceLine('deepseek', 'win-discard')).toBe('接得漂亮，这一局我赢啦！')
})
