import type { TableActionType } from '../contracts/types'

export type AnimeActionKey = 'chi' | 'peng' | 'gang' | 'hu' | 'zimo' | 'qiangganghu'

export interface AnimeActionPresentation {
  key: AnimeActionKey
  label: '吃' | '碰' | '杠' | '胡' | '自摸' | '抢杠胡'
}

/** 规则/协议动作 → 二次元表现动作。新增 TableActionType 时必须在这里显式处理。 */
export function animeActionPresentation(type: TableActionType): AnimeActionPresentation {
  switch (type) {
    case 'chi': return { key: 'chi', label: '吃' }
    case 'peng': return { key: 'peng', label: '碰' }
    case 'discard-gang':
    case 'concealed-gang':
    case 'added-gang':
    case 'flower-gang':
    case 'wind-kong': return { key: 'gang', label: '杠' }
    case 'discard-win': return { key: 'hu', label: '胡' }
    case 'self-draw': return { key: 'zimo', label: '自摸' }
    case 'robbed-kong-win': return { key: 'qiangganghu', label: '抢杠胡' }
    default: return type satisfies never
  }
}
