import { describe, expect, it } from 'vitest'
import {
  TABLE_ACTION_PRESENTATIONS,
  resolveRoundResultPresentation,
  resolveTableActionPresentation,
  scoreDirection,
} from './themeEventPresentation'

describe('主题动作表现分类', () => {
  it('覆盖吃碰、全部杠型与三类胡牌事件', () => {
    expect(Object.keys(TABLE_ACTION_PRESENTATIONS)).toEqual([
      'chi', 'peng', 'discard-gang', 'concealed-gang', 'added-gang', 'flower-gang', 'wind-kong',
      'self-draw', 'discard-win', 'robbed-kong-win',
    ])
    expect(resolveTableActionPresentation('chi')).toEqual({ label: '吃', kind: 'chi', strength: 'medium' })
    expect(resolveTableActionPresentation('peng')).toEqual({ label: '碰', kind: 'peng', strength: 'medium' })
    expect(resolveTableActionPresentation('concealed-gang')).toEqual({ label: '杠', kind: 'gang', strength: 'strong' })
    expect(resolveTableActionPresentation('robbed-kong-win')).toEqual({ label: '抢杠胡', kind: 'win', strength: 'climax' })
  })

  it('解析流局、自摸、点炮、抢杠胡与天地胡结算', () => {
    expect(resolveRoundResultPresentation({ draw: true }).kind).toBe('draw')
    expect(resolveRoundResultPresentation({ winType: 'self-draw' }).label).toBe('自摸')
    expect(resolveRoundResultPresentation({ winType: 'discard' }).label).toBe('点炮')
    expect(resolveRoundResultPresentation({ robbedKong: true }).kind).toBe('robbed-kong')
    expect(resolveRoundResultPresentation({ winType: 'tianhu' }).label).toBe('天胡')
    expect(resolveRoundResultPresentation({ winType: 'dihu' }).label).toBe('地胡')
  })

  it('分数方向不依赖主题或最终分数', () => {
    expect(scoreDirection(1200)).toBe('positive')
    expect(scoreDirection(-400)).toBe('negative')
    expect(scoreDirection(0)).toBe('neutral')
  })
})
