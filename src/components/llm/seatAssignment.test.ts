import { describe, expect, it } from 'vitest'
import { LOCAL_LLM_SEAT_OPTIONS } from './seatAssignment'

describe('单机大模型座位配置', () => {
  it('按牌桌实际方位绑定上家、对家、下家', () => {
    expect(LOCAL_LLM_SEAT_OPTIONS).toEqual([
      { seat: 3, label: '上家（左）' },
      { seat: 2, label: '对家（上）' },
      { seat: 1, label: '下家（右）' },
    ])
  })
})
