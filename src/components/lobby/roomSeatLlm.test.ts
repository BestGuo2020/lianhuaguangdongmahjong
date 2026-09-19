// 房间面板「空位」语义（房主选模型 = 该座预留给大模型，真人不可占）的纯逻辑单测。
import { describe, expect, it } from 'vitest'
import {
  isReservationUnavailable,
  pickValue,
  pickValueForSeat,
  reservationFromPick,
  reservedSeatLabel,
  seatLlmState,
  startLlmSeats,
  stylesForProvider,
} from './roomSeatLlm'
import type { LlmProviderInfo, RoomSeatState } from '../../game/online/api/roomApi'

const PROVIDERS: LlmProviderInfo[] = [
  {
    id: 'ds', name: 'DeepSeek', model: 'deepseek-chat', style: '话痨',
    styles: ['激进', '稳健', '话痨', '高冷'], nickname: '大肥鱼', avatar: 'a.png',
  },
  {
    id: 'kimi', name: 'Kimi', model: 'kimi-k2', style: '稳健', nickname: '小K', avatar: 'b.png',
  },
]

const seat = (index: number, nickname = `P${index}`): RoomSeatState => ({
  seat: index, nickname, ready: false, connected: true,
})

describe('seatLlmState', () => {
  it('三档：真人已占 / 已预留给大模型 / 自动（真人可占）', () => {
    const seats: Array<RoomSeatState | null> = [seat(0), null, null, null]
    const reserved = [{ seat: 1, providerId: 'kimi', style: '高冷' as const }]
    expect(seatLlmState(0, seats, reserved)).toEqual({ kind: 'occupied' })
    expect(seatLlmState(1, seats, reserved)).toEqual({
      kind: 'reserved', providerId: 'kimi', style: '高冷',
    })
    expect(seatLlmState(2, seats, reserved)).toEqual({ kind: 'auto' })
  })

  it('真人坐进预留座（服务端拒绝后不可能发生）仍以真人为准', () => {
    const seats: Array<RoomSeatState | null> = [null, seat(1, '乙'), null, null]
    const reserved = [{ seat: 1, providerId: 'kimi' }]
    expect(seatLlmState(1, seats, reserved).kind).toBe('occupied')
  })

  it('预留缺省策略时 style 归一为 null（由提供商默认策略兜底）', () => {
    expect(seatLlmState(1, [null, null, null, null], [{ seat: 1, providerId: 'ds' }]))
      .toEqual({ kind: 'reserved', providerId: 'ds', style: null })
  })
})

describe('reservationFromPick', () => {
  it('选择具体模型 → 写预留', () => {
    expect(reservationFromPick(2, pickValue('kimi', '高冷')))
      .toEqual({ seat: 2, providerId: 'kimi', style: '高冷' })
  })

  it('改回「自动选择」→ 取消预留（providerId 为空）', () => {
    expect(reservationFromPick(2, '')).toEqual({ seat: 2, providerId: null, style: null })
    expect(reservationFromPick(2, 'kimi::')).toEqual({ seat: 2, providerId: null, style: null })
    expect(reservationFromPick(2, 'bogus')).toEqual({ seat: 2, providerId: null, style: null })
  })

  it('策略名必须来自白名单，避免把非法值写进房间状态', () => {
    expect(reservationFromPick(1, 'kimi::温和')).toEqual({ seat: 1, providerId: null, style: null })
  })
})

describe('pickValueForSeat', () => {
  it('有预留 → 回显该模型（缺省策略按注册表补齐）', () => {
    expect(pickValueForSeat(1, [{ seat: 1, providerId: 'kimi', style: '激进' }], PROVIDERS))
      .toBe(pickValue('kimi', '激进'))
    expect(pickValueForSeat(1, [{ seat: 1, providerId: 'kimi' }], PROVIDERS))
      .toBe(pickValue('kimi', '稳健'))
  })

  it('未预留 → 空值（自动选择）', () => {
    expect(pickValueForSeat(2, [], PROVIDERS)).toBe('')
  })
})

describe('reservedSeatLabel / isReservationUnavailable', () => {
  it('已知提供商显示「昵称（策略）」', () => {
    expect(reservedSeatLabel({ providerId: 'kimi', style: '高冷' }, PROVIDERS)).toBe('小K（高冷）')
    expect(reservedSeatLabel({ providerId: 'kimi' }, PROVIDERS)).toBe('小K（稳健）')
  })

  it('服务端已下架的 providerId 标记为不可用', () => {
    expect(reservedSeatLabel({ providerId: 'ghost' }, PROVIDERS)).toContain('服务端未配置')
    expect(isReservationUnavailable({ providerId: 'ghost' }, PROVIDERS)).toBe(true)
    expect(isReservationUnavailable({ providerId: 'kimi' }, PROVIDERS)).toBe(false)
  })
})

describe('stylesForProvider', () => {
  it('有 styles 用 styles，否则退回默认策略', () => {
    expect(stylesForProvider(PROVIDERS[0])).toEqual(['激进', '稳健', '话痨', '高冷'])
    expect(stylesForProvider(PROVIDERS[1])).toEqual(['稳健'])
  })
})

describe('startLlmSeats', () => {
  it('只送仍空着的预留座位', () => {
    const seats: Array<RoomSeatState | null> = [seat(0), null, seat(2), null]
    const reserved = [
      { seat: 1, providerId: 'kimi', style: '高冷' as const },
      { seat: 2, providerId: 'ds' },
      { seat: 3, providerId: 'ds', style: '话痨' as const },
    ]
    expect(startLlmSeats(seats, reserved)).toEqual([
      { seat: 1, providerId: 'kimi', style: '高冷' },
      { seat: 3, providerId: 'ds', style: '话痨' },
    ])
  })

  it('没有预留 → 空数组（空位全由服务端默认提供商补位）', () => {
    expect(startLlmSeats([null, null, null, null], [])).toEqual([])
  })
})
