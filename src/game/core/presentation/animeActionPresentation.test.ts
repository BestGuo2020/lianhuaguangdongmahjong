import { describe, expect, it } from 'vitest'
import type { TableActionType } from '../contracts/types'
import { animeActionPresentation } from './animeActionPresentation'

describe('llmAnime 动作表现映射', () => {
  it.each([
    ['chi', 'chi', '吃'],
    ['peng', 'peng', '碰'],
    ['discard-gang', 'gang', '杠'],
    ['concealed-gang', 'gang', '杠'],
    ['added-gang', 'gang', '杠'],
    ['flower-gang', 'gang', '杠'],
    ['wind-kong', 'gang', '杠'],
    ['discard-win', 'hu', '胡'],
    ['self-draw', 'zimo', '自摸'],
    ['robbed-kong-win', 'qiangganghu', '抢杠胡'],
  ] satisfies Array<[TableActionType, string, string]>)('%s → %s', (type, key, label) => {
    expect(animeActionPresentation(type)).toEqual({ key, label })
  })
})
