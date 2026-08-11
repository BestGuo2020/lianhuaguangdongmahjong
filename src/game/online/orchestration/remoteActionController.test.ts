import { describe, expect, it, vi } from 'vitest'
import type { GamePlayer, TileType } from '../../core/contracts/types'
import { createRemoteGameState } from '../state/remoteGameState'
import { createRemoteActionController } from './remoteActionController'

function setup() {
  const state = createRemoteGameState({ autoPlay: false })
  let userTurn = true
  let canHu = false
  const user: GamePlayer = {
    name: '本家', avatar: '', score: 1000, seat: 0,
    hand: ['m1', 'm2', 'm3', 'p1'], discards: [], melds: [],
    redCount: 0, drawnTileIndex: -1,
  }
  const send = vi.fn()
  const clearCountdown = vi.fn()
  const playSound = vi.fn()
  const controller = createRemoteActionController({
    state,
    isUserTurn: () => userTurn,
    canUserHu: () => canHu,
    getUser: () => user,
    getUserKongs: () => ['m1'],
    clearCountdown,
    playSound,
    send,
  })
  return {
    state, user, send, clearCountdown, playSound, controller,
    setUserTurn: (value: boolean) => { userTurn = value },
    setCanHu: (value: boolean) => { canHu = value },
  }
}

describe('remoteActionController', () => {
  it('只在本家回合选择和弃牌，并发送服务端手牌索引', () => {
    const { state, send, controller, setUserTurn } = setup()
    setUserTurn(false)
    controller.selectTile(2)
    controller.userDiscard(2)
    expect(state.selectedIndex.value).toBe(-1)
    expect(send).not.toHaveBeenCalled()

    setUserTurn(true)
    controller.selectTile(2)
    controller.userDiscard()
    expect(state.selectedIndex.value).toBe(-1)
    expect(send).toHaveBeenCalledWith({ type: 'discard', handIndex: 2 })
  })

  it('按提示守卫过、碰和明杠动作', () => {
    const { state, send, controller } = setup()
    controller.userPeng()
    expect(send).not.toHaveBeenCalled()

    state.actionPrompt.value = { type: 'claim', tile: 'm1', from: 1, canGang: false }
    controller.userGangFromDiscard()
    expect(send).not.toHaveBeenCalled()
    controller.userPeng()
    expect(send).toHaveBeenLastCalledWith({ type: 'claim', action: 'peng' })

    state.actionPrompt.value = { type: 'claim', tile: 'm1', from: 1, canGang: true }
    controller.userGangFromDiscard()
    expect(send).toHaveBeenLastCalledWith({ type: 'claim', action: 'gang' })

    state.actionPrompt.value = { type: 'rob', tile: 'p5', from: 2 }
    controller.userPass()
    expect(send).toHaveBeenLastCalledWith({ type: 'pass' })
  })

  it('区分暗杠与加杠的协议消息', () => {
    const { user, send, controller } = setup()
    controller.userGang('m1')
    expect(send).toHaveBeenLastCalledWith({ type: 'gang', kind: 'concealed', tile: 'm1' })

    user.melds.push({ type: 'peng', tile: 'p1', tiles: ['p1', 'p1', 'p1'] })
    controller.userGang('p1')
    expect(send).toHaveBeenLastCalledWith({ type: 'gang', kind: 'added', tile: 'p1' })
  })

  it('抢杠提示可直接胡，普通胡牌必须通过可胡守卫', () => {
    const { state, send, controller, setCanHu } = setup()
    controller.userHu()
    expect(send).not.toHaveBeenCalled()

    setCanHu(true)
    controller.userHu()
    expect(send).toHaveBeenLastCalledWith({ type: 'hu' })

    send.mockClear()
    setCanHu(false)
    state.actionPrompt.value = { type: 'rob', tile: 's9' as TileType, from: 1 }
    controller.userHu()
    expect(send).toHaveBeenCalledWith({ type: 'hu' })
    expect(state.actionPrompt.value).toBeNull()
  })

  it('切换自动操作，并始终返回有效的自动弃牌索引', () => {
    const { state, user, controller } = setup()
    controller.toggleAutoPlay()
    expect(state.autoPlay.value).toBe(true)
    expect(controller.pickDiscard()).toBeGreaterThanOrEqual(0)
    expect(controller.pickDiscard()).toBeLessThan(user.hand.length)
  })
})
