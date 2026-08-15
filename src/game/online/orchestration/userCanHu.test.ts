import { describe, expect, it, vi } from 'vitest'
import { computed, ref } from 'vue'
import type { ServerRequest } from '../protocol/messages'
import { createRemoteGameState } from '../state/remoteGameState'
import { createRequestCoordinator } from './requestCoordinator'
import { createPlayerSelectors } from '../../core/selectors/playerSelectors'
import type { GamePlayer, TileType } from '../../core/contracts/types'

function player(seat: number, hand: TileType[] = []): GamePlayer {
  return {
    name: `P${seat}`, avatar: '', score: 1000, seat, hand,
    discards: [], melds: [], redCount: 0, drawnTileIndex: -1,
  }
}

// 经典广麻（lotus-classic）胡牌判定链路回归：turn_request 同步手牌后，本家 userCanHu 应为 true。
describe('本家胡牌判定（经典广麻）', () => {
  it('turn_request 带入 14 张胡牌手后 userCanHu 为 true', () => {
    const state = createRemoteGameState({ autoPlay: false })
    // 自摸胡牌手：m123 p456 s789 东东东 白白（白板作癞，实际是 m123 p456 s789 东东东 + 白板对子）
    const winningHand: TileType[] = ['m1', 'm2', 'm3', 'p4', 'p5', 'p6', 's7', 's8', 's9', 'east', 'east', 'east', 'white', 'white']
    state.players.push(
      player(0, ['m1', 'm2', 'm3', 'p4', 'p5', 'p6', 's7', 's8', 's9', 'east', 'east', 'east', 'white']),
      player(1, []), player(2, []), player(3, []),
    )

    const user = computed(() => state.players[0])
    const isUserTurn = computed(() => state.currentPlayer.value === 0 && state.phase.value === 'discard')
    const { userCanHu } = createPlayerSelectors({
      players: state.players,
      user,
      phase: state.phase,
      isUserTurn,
      userDrewThisTurn: state.userDrewThisTurn,
      selectedIndex: state.selectedIndex,
    })

    const coordinator = createRequestCoordinator({
      state,
      isBlocked: () => false,
      isUserTurn: () => isUserTurn.value,
      canUserHu: () => userCanHu.value,
      getUserHandLength: () => user.value?.hand.length ?? 0,
      toLocalSeat: (seat) => seat,
      announce: vi.fn(),
      playSound: vi.fn(),
      later: (cb) => { globalThis.setTimeout(cb, 0) },
      actions: { discard: vi.fn(), pass: vi.fn(), hu: vi.fn(), pickDiscard: vi.fn(() => 0) },
    })

    const turnRequest: ServerRequest = {
      kind: 'turn_request',
      ctx: { hand: winningHand, melds: [], exposedMelds: 0, kongBloom: false, skipDraw: false, afterKong: false },
    }
    coordinator.apply(turnRequest)

    expect(state.phase.value).toBe('discard')
    expect(state.userDrewThisTurn.value).toBe(true)
    expect(state.players[0].hand).toEqual(winningHand)
    expect(userCanHu.value).toBe(true)
  })
})
