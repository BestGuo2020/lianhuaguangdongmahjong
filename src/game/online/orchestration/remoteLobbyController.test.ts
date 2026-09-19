import { nextTick, ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRemoteLobbyController, type RemoteLobbyActions } from './remoteLobbyController'
import type { RoomSeatState } from '../api/roomApi'
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
  const nickname = ref('')
  const controller = createRemoteLobbyController({
    gameMode: ref('local'),
    selectedMatch: ref('hanchan'),
    phase: ref('lobby'),
    roomId: ref(''),
    nickname,
    playerId: ref('guest-1'),
    roomSeats: ref<Array<RoomSeatState | null>>([
      { seat: 0, nickname: 'A', ready: true, connected: true },
      { seat: 1, nickname: 'B', ready: true, connected: true },
      null,
      null,
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
  return { controller, actions, alerts, nickname, runPending: () => pendingEntry?.() }
}

describe('remoteLobbyController', () => {
  it('guards room creation and normalizes the nickname before dispatch', () => {
    const { controller, actions, runPending } = setup()
    controller.nicknameInput.value = '  莲花客  '
    controller.createRoom()
    expect(actions.createRoom).not.toHaveBeenCalled()
    runPending()
    expect(actions.createRoom).toHaveBeenCalledWith('hanchan', 4, 'lotus-classic', false)
  })

  it('uses the explicit remote LLM switch and never reads the local single-player settings', () => {
    const { controller, actions, runPending } = setup()
    controller.nicknameInput.value = '莲花客'
    controller.createRoom(true)
    runPending()
    expect(actions.createRoom).toHaveBeenCalledWith('hanchan', 4, 'lotus-classic', true)
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

  it('forwards server provider selections when starting the match', async () => {
    const { controller, actions } = setup()
    const llmSeats = [
      { seat: 2, providerId: 'deepseek', style: '激进' as const },
      { seat: 3, providerId: 'kimi', style: '高冷' as const },
    ]
    await controller.startMatch(llmSeats)
    expect(actions.startMatch).toHaveBeenCalledWith(llmSeats)
  })

  it('passes an empty selection when no provider was chosen', async () => {
    const { controller, actions } = setup()
    await controller.startMatch()
    expect(actions.startMatch).toHaveBeenCalledWith([])
  })

  it('submits moderation reports with room and player identity', async () => {
    const { controller, alerts } = setup()
    await controller.report('违规玩家')
    expect(alerts).toEqual(['举报已提交，感谢反馈'])
  })
})

// 「每次都以账号昵称为准」：登录/切换账号时账号昵称始终覆盖昵称框，
// 本地旧昵称（lgm_nickname）与玩家手输内容都不再优先。
describe('remoteLobbyController 账号昵称', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  function stubStoredNickname(stored: string) {
    const data = new Map<string, string>([['lgm_nickname', stored]])
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => { data.set(key, value) },
      removeItem: (key: string) => { data.delete(key) },
    })
  }

  it('账号昵称覆盖本地旧昵称，且覆盖后就是建房用的昵称', () => {
    stubStoredNickname('老玩家昵称')
    const { controller, actions, nickname, runPending } = setup()
    expect(controller.nicknameInput.value).toBe('老玩家昵称')   // 未登录/账号无昵称时的兜底
    controller.applyAccountNickname('登录昵称')
    expect(controller.nicknameInput.value).toBe('登录昵称')
    controller.createRoom()
    runPending()
    expect(nickname.value).toBe('登录昵称')
    expect(actions.createRoom).toHaveBeenCalledOnce()
  })

  it('覆盖玩家手输内容，并按 12 字截断（与输入框 maxlength 一致）', () => {
    const { controller } = setup()
    controller.nicknameInput.value = '手输的昵称'
    controller.applyAccountNickname('  麻将对局昵称超过十二个字测试  ')
    expect(controller.nicknameInput.value).toBe('麻将对局昵称超过十二个字')
  })

  it('切换账号每次都重算，不等同于「只在空的时候填」', () => {
    const { controller } = setup()
    controller.applyAccountNickname('第一个账号')
    expect(controller.nicknameInput.value).toBe('第一个账号')
    controller.applyAccountNickname('第二个账号')
    expect(controller.nicknameInput.value).toBe('第二个账号')
  })

  it('账号没有昵称时保留昵称框原值，玩家仍可自己填', () => {
    const { controller } = setup()
    controller.nicknameInput.value = '手输的昵称'
    controller.applyAccountNickname(null)
    controller.applyAccountNickname(undefined)
    controller.applyAccountNickname('   ')
    expect(controller.nicknameInput.value).toBe('手输的昵称')
  })

  it('纯函数：去空白、截 12 字、空值返回空串', async () => {
    const { accountNickname, NICKNAME_MAX_LENGTH } = await import('./remoteLobbyController')
    expect(NICKNAME_MAX_LENGTH).toBe(12)
    expect(accountNickname('  阿莲  ')).toBe('阿莲')
    expect(accountNickname('一二三四五六七八九十十一十二十三')).toHaveLength(12)
    expect(accountNickname(null)).toBe('')
    expect(accountNickname('   ')).toBe('')
  })
})
