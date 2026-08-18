import { describe, expect, it, vi } from 'vitest'
import type { GamePlayer, TileType } from '../../core/contracts/types'
import type { ActionPrompt } from '../../core/contracts/gamePort'
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
    // actionPrompt 是房主事实，客户端动作只能发送意图；待房主快照确认后再清除。
    expect(state.actionPrompt.value).not.toBeNull()
  })

  it('切换自动操作，并始终返回有效的自动弃牌索引', () => {
    const { state, user, controller } = setup()
    controller.toggleAutoPlay()
    expect(state.autoPlay.value).toBe(true)
    expect(controller.pickDiscard()).toBeGreaterThanOrEqual(0)
    expect(controller.pickDiscard()).toBeLessThan(user.hand.length)
  })

  it('房主引擎桥的 response 提示也能触发胡/吃/碰/杠（修复按钮点了没反应）', () => {
    // 回归：房主 viewer 的弃牌响应提示来自引擎桥（LotusHumanController →
    // type 'response'），不是 wire 的 'claim'；动作守卫若只认 'claim'，
    // 房主「胡/吃/碰/杠」按钮点了没反应，只有「过」能用。
    const { state, send, controller } = setup()
    const prompt: ActionPrompt = {
      type: 'response', tile: 'm1', from: 1,
      canHu: true, canPeng: true, canGang: true,
      chiOptions: [{ kind: 'sequence', tiles: ['m1', 'm2', 'm3'] }],
    }

    state.actionPrompt.value = { ...prompt }
    controller.userHu()
    expect(send).toHaveBeenLastCalledWith({ type: 'hu' })

    send.mockClear()
    state.actionPrompt.value = { ...prompt }
    controller.userPeng()
    expect(send).toHaveBeenLastCalledWith({ type: 'claim', action: 'peng' })

    send.mockClear()
    state.actionPrompt.value = { ...prompt }
    controller.userGangFromDiscard()
    expect(send).toHaveBeenLastCalledWith({ type: 'claim', action: 'gang' })

    send.mockClear()
    state.actionPrompt.value = { ...prompt }
    controller.userChi(0)
    expect(send).toHaveBeenLastCalledWith({ type: 'claim', action: 'chi', optionIndex: 0 })
  })
})
