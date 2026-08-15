import { nextTick, ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { createRemoteLobbyController, type RemoteLobbyActions } from './remoteLobbyController'
import type { LobbySeat } from '../vibe/vibeLobby'
import type { GamePhase } from '../../core/contracts/gamePort'

function setup() {
  const actions: RemoteLobbyActions = {
    createRoom: vi.fn(async () => {}),
    joinRoom: vi.fn(async () => {}),
    toggleReady: vi.fn(async () => {}),
    startMatch: vi.fn(async () => {}),
    leaveRoom: vi.fn(async () => {}),
    closeRoom: vi.fn(async () => {}),
    resumeSession: vi.fn(async () => {}),
  }
  let pendingEntry: (() => void) | null = null
  const alerts: string[] = []
  const controller = createRemoteLobbyController({
    gameMode: ref('local'),
    selectedMatch: ref('hanchan'),
    phase: ref('lobby'),
    roomId: ref(''),
    nickname: ref(''),
    playerId: ref('guest-1'),
    roomSeats: ref<LobbySeat[]>([
      { seat: 0, peerId: 'host-peer', nickname: 'A', avatar: '', ready: true },
      { seat: 1, peerId: 'peer1', nickname: 'B', avatar: '', ready: true },
    ]),
    actions,
    guardEntry: (action) => { pendingEntry = action },
    startBgm: vi.fn(),
    report: vi.fn(async () => ({ reported: true })),
    environment: {
      confirm: () => true,
      prompt: () => '违规',
      alert: (message) => alerts.push(message),
      copyText: async () => true,
      schedule: (callback) => callback(),
    },
  })
  return { controller, actions, alerts, runPending: () => pendingEntry?.() }
}

describe('remoteLobbyController', () => {
  it('guards room creation and normalizes the nickname before dispatch', () => {
    const { controller, actions, runPending } = setup()
    controller.nicknameInput.value = '  莲花客  '
    controller.createRoom()
    expect(actions.createRoom).not.toHaveBeenCalled()
    runPending()
  expect(actions.createRoom).toHaveBeenCalledWith('hanchan', 4, 'lotus-classic')
  })

  it('blocks duplicate leave/close operations while one is in flight', async () => {
    let finishLeave!: () => void
    const { controller, actions } = setup()
    vi.mocked(actions.leaveRoom).mockReturnValue(new Promise<void>((resolve) => { finishLeave = resolve }))
    const leaving = controller.leaveRoom()
    await controller.closeRoom()
    expect(actions.closeRoom).not.toHaveBeenCalled()
    finishLeave()
    await leaving
    expect(controller.leaving.value).toBe(false)
  })

  it('resets the starting indicator when the phase leaves the lobby', async () => {
    const phase = ref<GamePhase>('lobby')
    const startBgm = vi.fn()
    const base = setup()
    const controller = createRemoteLobbyController({
      gameMode: ref('remote'), selectedMatch: ref('east'), phase, roomId: ref('ROOM01'),
      nickname: ref('A'), playerId: ref('guest-1'), roomSeats: ref([]), actions: base.actions,
      guardEntry: (action) => action(), startBgm,
      environment: { confirm: () => false, prompt: () => null, alert: () => {}, copyText: async () => false, schedule: () => {} },
    })
    controller.matchStarting.value = true
    phase.value = 'discard'
    await nextTick()
    expect(controller.matchStarting.value).toBe(false)
    expect(startBgm).toHaveBeenCalledOnce()
  })

  it('submits moderation reports with room and player identity', async () => {
    const { controller, alerts } = setup()
    await controller.report('违规玩家')
    expect(alerts).toEqual(['举报已提交，感谢反馈'])
  })
})
