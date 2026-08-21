import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServerRequest } from '../protocol/messages'
import { createRemoteGameState } from '../state/remoteGameState'
import { createRequestCoordinator } from './requestCoordinator'

const TURN_REQUEST: ServerRequest = {
  kind: 'turn_request',
  ctx: { hand: ['m1'], melds: [], exposedMelds: 0, kongBloom: false, skipDraw: false, afterKong: false },
}

function setup({ autoPlay = false, blocked = false, canHu = false } = {}) {
  const state = createRemoteGameState({ autoPlay })
  let blockedState = blocked
  let canHuState = canHu
  const actions = {
    discard: vi.fn(), pass: vi.fn(), hu: vi.fn(), pickDiscard: vi.fn(() => 2),
  }
  const announce = vi.fn()
  const playSound = vi.fn()
  const coordinator = createRequestCoordinator({
    state,
    isBlocked: () => blockedState,
    isUserTurn: () => state.phase.value === 'discard' && state.currentPlayer.value === 0,
    canUserHu: () => canHuState,
    getUserHandLength: () => 4,
    toLocalSeat: (seat) => (seat + 2) % 4,
    announce,
    playSound,
    later: (callback, delay) => { globalThis.setTimeout(callback, delay) },
    actions,
  })
  return {
    state, actions, announce, playSound, coordinator,
    setBlocked: (value: boolean) => { blockedState = value },
    setCanHu: (value: boolean) => { canHuState = value },
  }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('requestCoordinator', () => {
  it('claim_request 根据手牌补算可碰状态，确保多人模式显示碰按钮', () => {
    const { state, coordinator } = setup()
    coordinator.apply({
      kind: 'claim_request',
      ctx: { hand: ['m9', 'm9', 'p1'], canGang: false, tile: 'm9', from: 3 },
    })

    expect(state.actionPrompt.value).toMatchObject({
      type: 'claim',
      canPeng: true,
      canGang: false,
    })
  })

  it('应用出牌请求并在倒计时到期后打出末张', async () => {
    const { state, actions, playSound, coordinator } = setup()
    coordinator.apply(TURN_REQUEST)

    expect(state.phase.value).toBe('discard')
    expect(state.userDrewThisTurn.value).toBe(true)
    expect(playSound).toHaveBeenCalledWith('give.mp3', 0.7)

    await vi.advanceTimersByTimeAsync(9000)
    expect(playSound).toHaveBeenCalledWith('didu.ogg')
    await vi.advanceTimersByTimeAsync(3000)
    expect(actions.discard).toHaveBeenCalledWith(3)
  })

  it('自动操作时优先胡牌，否则采用选牌策略弃牌', async () => {
    const first = setup({ autoPlay: true, canHu: true })
    first.coordinator.apply(TURN_REQUEST)
    await vi.advanceTimersByTimeAsync(600)
    expect(first.actions.hu).toHaveBeenCalledOnce()
    expect(first.actions.discard).not.toHaveBeenCalled()

    first.coordinator.reset()
    first.setCanHu(false)
    first.coordinator.apply(TURN_REQUEST)
    await vi.advanceTimersByTimeAsync(600)
    expect(first.actions.pickDiscard).toHaveBeenCalled()
    expect(first.actions.discard).toHaveBeenCalledWith(2)
  })

  it('映射声明与抢杠请求，并在受阻期间只保留最新请求', async () => {
    const { state, actions, announce, coordinator, setBlocked } = setup({ autoPlay: true, blocked: true })
    coordinator.apply(TURN_REQUEST)
    coordinator.apply({
      kind: 'rob_kong_request',
      ctx: { tile: 'p5', from: 1, hand: [], exposedMelds: 0 },
    })
    expect(state.actionPrompt.value).toBeNull()

    setBlocked(false)
    coordinator.flush()
    expect(state.actionPrompt.value).toEqual({ type: 'rob', tile: 'p5', from: 3 })
    expect(announce).toHaveBeenCalledWith('可抢杠胡', 'red')
    await vi.advanceTimersByTimeAsync(600)
    expect(actions.hu).toHaveBeenCalledOnce()
  })

  it('托管时放炮可胡直接胡，否则自动过牌（吃碰杠不自动）', async () => {
    const huCase = setup({ autoPlay: true })
    huCase.coordinator.apply({
      kind: 'claim_request',
      ctx: { hand: [], canGang: true, tile: 'm5', from: 3, canHu: true },
    })
    await vi.advanceTimersByTimeAsync(600)
    expect(huCase.actions.hu).toHaveBeenCalledOnce()
    expect(huCase.actions.pass).not.toHaveBeenCalled()

    huCase.coordinator.reset()
    const passCase = setup({ autoPlay: true })
    passCase.coordinator.apply({
      kind: 'claim_request',
      ctx: { hand: ['m9', 'm9'], canGang: false, tile: 'm9', from: 3 },
    })
    await vi.advanceTimersByTimeAsync(600)
    expect(passCase.actions.pass).toHaveBeenCalledOnce()
    expect(passCase.actions.hu).not.toHaveBeenCalled()
  })
})
