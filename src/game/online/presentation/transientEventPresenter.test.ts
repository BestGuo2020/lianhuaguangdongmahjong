import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRemoteGameState } from '../state/remoteGameState'
import { createTransientEventPresenter } from './transientEventPresenter'

function setup() {
  const state = createRemoteGameState({ autoPlay: false })
  let opening = false
  const playSound = vi.fn()
  const showServerAnnouncement = vi.fn()
  const presenter = createTransientEventPresenter({
    state,
    getLocalSeat: () => 2,
    isOpening: () => opening,
    showServerAnnouncement,
    playSound,
    later: (callback, delay) => { globalThis.setTimeout(callback, delay) },
  })
  return {
    state, presenter, playSound, showServerAnnouncement,
    setOpening: (value: boolean) => { opening = value },
  }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('transientEventPresenter', () => {
  it('映射桌面动作、播放对应音效并自动清除', async () => {
    const { state, presenter, playSound } = setup()
    presenter.handleTableAction({
      kind: 'table_action',
      event: { id: 7, type: 'peng', actorIndex: 3, sourceIndex: 0, tile: 'm1', meldIndex: 0 },
    })

    expect(state.tableActionEvent.value?.actorIndex).toBe(1)
    expect(state.tableActionEvent.value?.sourceIndex).toBe(2)
    expect(playSound).toHaveBeenCalledWith('peng.mp3')
    await vi.advanceTimersByTimeAsync(1050)
    expect(state.tableActionEvent.value).toBeNull()
  })

  it('开局期间忽略桌面动作，胡牌动作不重复播放结算音效', () => {
    const { state, presenter, playSound, setOpening } = setup()
    setOpening(true)
    presenter.handleTableAction({
      kind: 'table_action',
      event: { id: 1, type: 'peng', actorIndex: 0, sourceIndex: 1, tile: 'm1', meldIndex: 0 },
    })
    expect(state.tableActionEvent.value).toBeNull()

    setOpening(false)
    presenter.handleTableAction({
      kind: 'table_action',
      event: { id: 2, type: 'self-draw', actorIndex: 2, sourceIndex: 1, tile: 'p5', meldIndex: -1 },
    })
    expect(state.tableActionEvent.value?.type).toBe('self-draw')
    expect(playSound).not.toHaveBeenCalled()
  })

  it('映射分数流水并在展示结束后清除', async () => {
    const { state, presenter } = setup()
    presenter.handleScoreFlow({
      kind: 'score_flow',
      deltas: [{ playerIndex: 2, amount: 300 }, { playerIndex: 0, amount: -100 }],
    })
    expect(state.scoreFlowEvent.value?.deltas).toEqual([
      { playerIndex: 0, amount: 300 }, { playerIndex: 2, amount: -100 },
    ])
    await vi.advanceTimersByTimeAsync(1050)
    expect(state.scoreFlowEvent.value).toBeNull()
  })

  it('本地公告自行展示，服务端公告交给快照去重入口', async () => {
    const { state, presenter, showServerAnnouncement } = setup()
    presenter.announce('可抢杠胡', 'red')
    expect(state.announcement.value).toMatchObject({ text: '可抢杠胡', tone: 'red' })
    await vi.advanceTimersByTimeAsync(1500)
    expect(state.announcement.value).toBeNull()

    const message = { kind: 'announcement' as const, text: '东2局', tone: 'gold', id: 4 }
    presenter.handleAnnouncement(message)
    expect(showServerAnnouncement).toHaveBeenCalledWith(message)
  })
})
