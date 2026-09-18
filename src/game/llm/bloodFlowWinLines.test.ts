import { expect, it } from 'vitest'
import {
  BLOOD_FLOW_MOMENT_LINES,
  bloodFlowWinMomentGroup,
  bloodFlowWinMomentLine,
  bloodFlowWinMomentTier,
  type BloodFlowWinMomentContext,
  type BloodFlowWinMomentGroup,
} from './bloodFlowWinLines'
import { winTier } from '../variants/lotus/bloodFlow/presentation'
import type { LlmStyle } from './config'
import type { WinSource } from '../variants/lotus/bloodFlow/types'

const STYLES: LlmStyle[] = ['激进', '稳健', '话痨', '高冷']
const GROUPS = Object.keys(BLOOD_FLOW_MOMENT_LINES) as BloodFlowWinMomentGroup[]
const SOURCES: WinSource[] = ['self-draw', 'discard', 'robbed-kong', 'kong-bloom']
const SOURCE_GROUP: Record<WinSource, BloodFlowWinMomentGroup> = {
  'self-draw': 'self-draw', discard: 'discard-win', 'robbed-kong': 'robbed-kong-win', 'kong-bloom': 'kong-bloom-win',
}
/** 与血流出品口径一致：第一人称、不指代或评价他人。 */
const NO_OTHERS = /你|他|她|大家|别人|各位/
/** `speechPolicy` 的幕后词与暗手结构词：模板台词同样不得出现。 */
const BACKSTAGE = /引擎|候选|编号|模型|系统|提示词|基线|默认建议|默认参考|人工智能|程序|算法|规则摘要|choice|message|json/i
const PRIVATE_STRUCTURE = /暗手|手牌|手里|手上|我有|我拿着|我摸到|对子|刻子|顺子|单张|两张|三张|四张|一向听|二向听|听口|清一色|混一色|七对|十三幺|十三烂/

it('每个档位 × 性格都有三条唯一短句，且符合血流台词口径', () => {
  for (const group of GROUPS) {
    for (const style of STYLES) {
      const variants = BLOOD_FLOW_MOMENT_LINES[group][style]
      expect(variants, `${group}/${style}`).toHaveLength(3)
      expect(new Set(variants).size, `${group}/${style}`).toBe(3)
      expect(variants.every(line => [...line].length <= 16), group).toBe(true)
      expect(variants.every(line => !NO_OTHERS.test(line)), group).toBe(true)
      expect(variants.every(line => !BACKSTAGE.test(line)), group).toBe(true)
      expect(variants.every(line => !PRIVATE_STRUCTURE.test(line)), group).toBe(true)
      expect(variants.every(line => line.endsWith('！') || line.endsWith('。')), group).toBe(true)
    }
  }
})

it('全库无重复文案（同一次对局不会因串组出现同一句）', () => {
  const all = GROUPS.flatMap(group => STYLES.flatMap(style => [...BLOOD_FLOW_MOMENT_LINES[group][style]]))
  expect(new Set(all).size).toBe(all.length)
})

it('基础档按胡法分组，不走性格通用库', () => {
  for (const source of SOURCES) {
    for (const style of STYLES) {
      expect(bloodFlowWinMomentGroup({ source, style })).toBe(SOURCE_GROUP[source])
      // 首次胡牌、普通番：直接落在该胡法的基础档里。
      expect(BLOOD_FLOW_MOMENT_LINES[SOURCE_GROUP[source]][style]).toContain(
        bloodFlowWinMomentLine({ source, style, ordinal: 1, tier: 0, sequence: 0 }))
    }
  }
})

it('高光档优先级：一炮多响 > 大牌 > 连胡 > 胡法基础档', () => {
  expect(bloodFlowWinMomentGroup({ source: 'discard', style: '稳健', multiWin: true, tier: 3, ordinal: 9 })).toBe('multi')
  expect(bloodFlowWinMomentGroup({ source: 'discard', style: '稳健', tier: 2, ordinal: 9 })).toBe('big')
  expect(bloodFlowWinMomentGroup({ source: 'discard', style: '稳健', tier: 1, ordinal: 3 })).toBe('streak')
  expect(bloodFlowWinMomentGroup({ source: 'discard', style: '稳健', tier: 1, ordinal: 2 })).toBe('discard-win')
})

it('轮换：同组相邻两次不重复，并按序号循环', () => {
  const style: LlmStyle = '稳健'
  const cases: { group: BloodFlowWinMomentGroup; context: (sequence: number) => BloodFlowWinMomentContext }[] = [
    { group: 'self-draw', context: sequence => ({ source: 'self-draw', style, ordinal: 2, sequence }) },
    { group: 'discard-win', context: sequence => ({ source: 'discard', style, ordinal: 2, sequence }) },
    { group: 'robbed-kong-win', context: sequence => ({ source: 'robbed-kong', style, ordinal: 2, sequence }) },
    { group: 'kong-bloom-win', context: sequence => ({ source: 'kong-bloom', style, ordinal: 2, sequence }) },
    { group: 'streak', context: sequence => ({ source: 'self-draw', style, ordinal: 3, sequence }) },
    { group: 'big', context: sequence => ({ source: 'self-draw', style, tier: 3, sequence }) },
    { group: 'multi', context: sequence => ({ source: 'discard', style, multiWin: true, sequence }) },
  ]
  for (const { group, context } of cases) {
    const lines = [0, 1, 2, 3, 4].map(sequence => bloodFlowWinMomentLine(context(sequence)))
    expect(bloodFlowWinMomentGroup(context(0)), group).toBe(group)
    expect(new Set(lines.slice(0, 3)).size, group).toBe(3)
    expect(lines[3], group).toBe(lines[0])
    expect(lines[4], group).toBe(lines[1])
  }
})

it('缺省序号时按本局胡牌序号轮换（首个调用方不传 sequence 也稳定）', () => {
  const first = bloodFlowWinMomentLine({ source: 'self-draw', style: '高冷', ordinal: 1 })
  const second = bloodFlowWinMomentLine({ source: 'self-draw', style: '高冷', ordinal: 2 })
  expect(first).toBe(BLOOD_FLOW_MOMENT_LINES['self-draw']['高冷'][0])
  expect(second).toBe(BLOOD_FLOW_MOMENT_LINES['self-draw']['高冷'][1])
})

it('主番档与牌桌演出的 winTier 同阈值（≥4 / ≥8 / ≥16）', () => {
  for (const weight of [1, 2, 3, 4, 7, 8, 15, 16, 32]) {
    const score = { items: [{ weight }] }
    expect(bloodFlowWinMomentTier(score)).toBe(winTier({ score: { items: [{ weight }] } } as never))
  }
  expect(bloodFlowWinMomentTier({ items: [] })).toBe(0)
})
