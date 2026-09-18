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
import { LLM_DRAW_LINES, LLM_LOSS_LINES, LLM_WIN_LINES } from './winLines'
import { BLOOD_FLOW_LOSS_LINES, BLOOD_FLOW_WIN_LINES } from './bloodFlowRoundLines'
import { DECISION_SPEECH_LINES } from './decisionSpeech'
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

it('两条文风红线：不重复局末库用滥的收尾套语；话痨不刷同一个语气词', () => {
  const all = GROUPS.flatMap(group => STYLES.flatMap(style => [...BLOOD_FLOW_MOMENT_LINES[group][style]]))
  // 「仅此而已」在 `bloodFlowRoundLines` / `winLines` 的高冷档里已反复出现（2026-09-19 评审点名），本库不得再用。
  expect(all.filter(line => line.includes('仅此而已'))).toEqual([])
  // 一炮三响真实存在，任何档位都不写具体家数（旧「两家齐胡」即此错，2026-09-19 评审点名）。
  expect(all.filter(line => /两家|三家|四家/.test(line))).toEqual([])
  const chatty = GROUPS.flatMap(group => [...BLOOD_FLOW_MOMENT_LINES[group]['话痨']])
  expect(chatty.filter(line => line.includes('啦')).length).toBeLessThanOrEqual(5)
  // 句首语气词同样要打散：同一个开场字不得覆盖话痨台词的三分之一以上。
  const openers = chatty.map(line => line.slice(0, 1))
  const counts = [...new Set(openers)].map(opener => openers.filter(item => item === opener).length)
  expect(Math.max(...counts)).toBeLessThanOrEqual(Math.floor(chatty.length / 3))
})

it('档位集合固定为「四胡法 + 连胡 + 大牌」：一炮多响不设专属台词', () => {
  // 2026-09-19 用户决定：多响批次里各赢家各说自己的胡法 / 连胡台词，不另设一炮多响语气。
  // 若有人重新加回 multi 档，这条断言会失败，强制重新决策。
  expect([...GROUPS].sort()).toEqual(['big', 'discard-win', 'kong-bloom-win', 'robbed-kong-win', 'self-draw', 'streak'])
  expect(GROUPS).not.toContain('multi')
  // 多响批次用同一种来源逐家取词：同批赢家因序号叠加座位号而拿到不同变体。
  const first = bloodFlowWinMomentLine({ source: 'discard', style: '稳健', ordinal: 1, sequence: 0 + 1 })
  const second = bloodFlowWinMomentLine({ source: 'discard', style: '稳健', ordinal: 1, sequence: 0 + 2 })
  const third = bloodFlowWinMomentLine({ source: 'discard', style: '稳健', ordinal: 1, sequence: 0 + 3 })
  expect(new Set([first, second, third]).size).toBe(3)
})

it('与既有三个台词库不重复成句（局末 / 经典 / 通用动作各说各的）', () => {
  const moment = new Set(GROUPS.flatMap(group => STYLES.flatMap(style => [...BLOOD_FLOW_MOMENT_LINES[group][style]])))
  const others = [
    ...Object.values(LLM_WIN_LINES).flatMap(styles => Object.values(styles).flat()),
    ...Object.values(LLM_LOSS_LINES).flat(), ...Object.values(LLM_DRAW_LINES).flat(),
    ...Object.values(BLOOD_FLOW_WIN_LINES).flatMap(styles => Object.values(styles).flat()),
    ...Object.values(BLOOD_FLOW_LOSS_LINES).flat(),
    ...Object.values(DECISION_SPEECH_LINES).flatMap(styles => Object.values(styles).flat()),
  ]
  expect(others.filter(line => moment.has(line))).toEqual([])
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

it('高光档优先级：大牌 > 连胡 > 胡法基础档', () => {
  expect(bloodFlowWinMomentGroup({ source: 'discard', style: '稳健', tier: 3, ordinal: 9, previousSource: 'discard' })).toBe('big')
  expect(bloodFlowWinMomentGroup({ source: 'discard', style: '稳健', tier: 2, ordinal: 9 })).toBe('big')
  expect(bloodFlowWinMomentGroup({ source: 'discard', style: '稳健', tier: 1, ordinal: 3, previousSource: 'discard' })).toBe('streak')
  expect(bloodFlowWinMomentGroup({ source: 'discard', style: '稳健', tier: 1, ordinal: 2, previousSource: 'discard' })).toBe('discard-win')
})

it('连胡档只在「第 3 胡起且与上一胡同源」触发，胡法交替时始终保留胡法台词', () => {
  // 同源连胡 → 连胡语气。
  expect(bloodFlowWinMomentGroup({ source: 'self-draw', style: '话痨', ordinal: 3, previousSource: 'self-draw' })).toBe('streak')
  expect(bloodFlowWinMomentGroup({ source: 'discard', style: '话痨', ordinal: 7, previousSource: 'discard' })).toBe('streak')
  // 胡法交替（血流里自摸/吃胡交替是常态）→ 不得吞掉胡法区分。
  for (const [source, previous] of [['self-draw', 'discard'], ['discard', 'self-draw'],
    ['robbed-kong', 'discard'], ['kong-bloom', 'self-draw']] as const) {
    expect(bloodFlowWinMomentGroup({ source, style: '话痨', ordinal: 5, previousSource: previous }),
      `${previous} → ${source}`).toBe(SOURCE_GROUP[source])
  }
  // 本局前两胡即便同源也先说胡法本味（第 3 胡起才算「连」）。
  expect(bloodFlowWinMomentGroup({ source: 'discard', style: '话痨', ordinal: 2, previousSource: 'discard' })).toBe('discard-win')
  // 没有上一胡（本局首胡，或跨局后的第一次）→ 基础档。
  expect(bloodFlowWinMomentGroup({ source: 'discard', style: '话痨', ordinal: 3, previousSource: null })).toBe('discard-win')
  expect(bloodFlowWinMomentGroup({ source: 'discard', style: '话痨', ordinal: 3 })).toBe('discard-win')
})

it('轮换：同组相邻两次不重复，并按序号循环', () => {
  const style: LlmStyle = '稳健'
  const cases: { group: BloodFlowWinMomentGroup; context: (sequence: number) => BloodFlowWinMomentContext }[] = [
    { group: 'self-draw', context: sequence => ({ source: 'self-draw', style, ordinal: 2, sequence }) },
    { group: 'discard-win', context: sequence => ({ source: 'discard', style, ordinal: 2, sequence }) },
    { group: 'robbed-kong-win', context: sequence => ({ source: 'robbed-kong', style, ordinal: 2, sequence }) },
    { group: 'kong-bloom-win', context: sequence => ({ source: 'kong-bloom', style, ordinal: 2, sequence }) },
    { group: 'streak', context: sequence => ({ source: 'self-draw', style, ordinal: 3, previousSource: 'self-draw', sequence }) },
    { group: 'big', context: sequence => ({ source: 'self-draw', style, tier: 3, sequence }) },
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
