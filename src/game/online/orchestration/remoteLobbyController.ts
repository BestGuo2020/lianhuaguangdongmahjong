import { computed, ref, watch, type Ref } from 'vue'
import type { GameMode } from '../../core/contracts/activeGamePort'
import type { GamePhase } from '../../core/contracts/gamePort'
import type { MatchType } from '../../core/contracts/types'
import { reportPlayer, type ReportRequest } from '../api/moderationApi'
import type { LlmSeatRequest, RoomSeatState } from '../api/roomApi'
import type { RuleVariant } from '../../core/rules/ruleVariants'
import { presetForSeat, readLlmSettings, styleForSeat } from '../../llm/config'

export interface RemoteLobbyActions {
  createRoom(mode: MatchType, capacity: number, rulesetId?: RuleVariant,
    llmEnabled?: boolean): Promise<void>
  joinRoom(code: string): Promise<void>
  toggleReady(): Promise<void>
  startMatch(llmSeats?: Array<LlmSeatRequest>): Promise<void>
  leaveRoom(): Promise<void>
  closeRoom(): Promise<void>
  resumeSession(): Promise<void>
}

/** 联机建房的空座补位是否使用大模型：读取设置面板「启用」开关（无 localStorage 环境返回 false）。 */
function readLlmEnabled(): boolean {
  try { return readLlmSettings().enabled } catch { return false }
}

/**
 * 联机开局：为每个空位（按座位号升序）取设置面板 1/2/3 号预置，生成 llmSeats。
 * 未启用 / 无可用预置 → 空数组（服务端回退全局配置或启发式 AI）。
 * 注意：key 随请求发送到用户自己的后端，仅会话内存使用，不落库/日志/响应。
 */
function buildLlmSeats(roomSeats: Array<RoomSeatState | null>): Array<LlmSeatRequest> {
  try {
    const settings = readLlmSettings()
    if (!settings.enabled) return []
    const emptySeats = roomSeats
      .map((state, index) => (state ? null : index))
      .filter((index): index is number => index !== null)
    return emptySeats.slice(0, 3).reduce<Array<LlmSeatRequest>>((list, seat, order) => {
      const slot = (order + 1) as 1 | 2 | 3
      const preset = presetForSeat(settings, slot)
      if (!preset || !preset.baseUrl || !preset.apiKey || !preset.model) return list
      list.push({
        seat,
        baseUrl: preset.baseUrl,
        apiKey: preset.apiKey,
        model: preset.model,
        style: styleForSeat(settings, slot) ?? preset.style,
        timeoutMs: preset.timeoutMs,
        ...(preset.nickname?.trim() ? { nickname: preset.nickname.trim() } : {}),
      })
      return list
    }, [])
  } catch {
    return []
  }
}

interface RemoteLobbyEnvironment {
  confirm(message: string): boolean
  prompt(message: string, initialValue: string): string | null
  alert(message: string): void
  copyText(text: string): Promise<boolean>
  schedule(callback: () => void, delay: number): void
}

interface RemoteLobbyControllerOptions {
  gameMode: Ref<GameMode>
  selectedMatch: Ref<MatchType>
  selectedRule?: Ref<RuleVariant>
  phase: Ref<GamePhase>
  roomId: Ref<string>
  nickname: Ref<string>
  playerId: Ref<string>
  roomSeats: Ref<Array<RoomSeatState | null>>
  actions: RemoteLobbyActions
  guardEntry(action: () => void): void | Promise<void>
  startBgm(): void
  report?: (request: ReportRequest) => Promise<{ reported: boolean }>
  environment?: RemoteLobbyEnvironment
}

function readStoredNickname() {
  try { return localStorage.getItem('lgm_nickname') || '' } catch { return '' }
}

async function copyText(text: string) {
  if (window.isSecureContext && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // 局域网 HTTP 或权限拒绝时使用 DOM 回退。
    }
  }
  let textarea: HTMLTextAreaElement | null = null
  try {
    textarea = document.createElement('textarea')
    textarea.value = text
    textarea.setAttribute('readonly', '')
    textarea.style.position = 'fixed'
    textarea.style.top = '-9999px'
    document.body.appendChild(textarea)
    textarea.select()
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    textarea?.remove()
  }
}

const BROWSER_ENVIRONMENT: RemoteLobbyEnvironment = {
  confirm: (message) => window.confirm(message),
  prompt: (message, initialValue) => window.prompt(message, initialValue),
  alert: (message) => window.alert(message),
  copyText,
  schedule: (callback, delay) => { window.setTimeout(callback, delay) },
}

export function createRemoteLobbyController(options: RemoteLobbyControllerOptions) {
  const environment = options.environment ?? BROWSER_ENVIRONMENT
  const sendReport = options.report ?? reportPlayer
  const nicknameInput = ref(readStoredNickname())
  const joinCode = ref('')
  const copied = ref(false)
  const matchStarting = ref(false)
  const leaving = ref(false)
  const closing = ref(false)
  const allOccupiedReady = computed(() => {
    const occupied = options.roomSeats.value.filter(Boolean)
    return occupied.length > 0 && occupied.every((seat) => seat?.ready)
  })

  function createRoom() {
    if (options.roomId.value) return
    const name = nicknameInput.value.trim()
    if (!name) return
    options.nickname.value = name
    void options.guardEntry(() => void options.actions.createRoom(
      options.selectedMatch.value, 4, options.selectedRule?.value ?? 'lotus-classic',
      readLlmEnabled(),
    ))
  }

  function joinRoom() {
    if (options.roomId.value) return
    const name = nicknameInput.value.trim()
    const code = joinCode.value.trim()
    if (!name || !code) return
    options.nickname.value = name
    void options.guardEntry(() => void options.actions.joinRoom(code))
  }

  function resumeSession() {
    void options.guardEntry(() => {
      options.gameMode.value = 'remote'
      void options.actions.resumeSession()
    })
  }

  async function copyRoomCode() {
    if (!options.roomId.value || !await environment.copyText(options.roomId.value)) return
    copied.value = true
    environment.schedule(() => { copied.value = false }, 1600)
  }

  async function startMatch() {
    matchStarting.value = true
    try {
      await options.actions.startMatch(buildLlmSeats(options.roomSeats.value))
    } catch {
      matchStarting.value = false
    }
  }

  function quitMatch() {
    if (environment.confirm('退出对局将放弃本场对局（座位由 AI 代打），确定退出？')) {
      void options.actions.leaveRoom()
    }
  }

  async function leaveRoom() {
    if (leaving.value || closing.value) return
    leaving.value = true
    try {
      await options.actions.leaveRoom()
    } finally {
      leaving.value = false
    }
  }

  async function closeRoom() {
    if (leaving.value || closing.value) return
    closing.value = true
    try {
      await options.actions.closeRoom()
    } finally {
      closing.value = false
    }
  }

  async function report(name: string) {
    if (!options.playerId.value) return
    const reason = environment.prompt(`举报「${name}」的原因？（对局中违规 / 作弊 / 赌博引流 等）`, '对局中违规')
    if (reason == null) return
    try {
      await sendReport({
        roomId: options.roomId.value,
        reporterPlayerId: options.playerId.value,
        targetName: name,
        reason,
      })
      environment.alert('举报已提交，感谢反馈')
    } catch {
      environment.alert('举报提交失败，请稍后再试')
    }
  }

  watch(options.phase, (phase) => {
    if (options.gameMode.value === 'remote' && phase !== 'lobby') options.startBgm()
    matchStarting.value = false
  })

  return {
    nicknameInput,
    joinCode,
    copied,
    matchStarting,
    leaving,
    closing,
    allOccupiedReady,
    createRoom,
    joinRoom,
    resumeSession,
    copyRoomCode,
    startMatch,
    quitMatch,
    leaveRoom,
    closeRoom,
    report,
    toggleReady: options.actions.toggleReady,
  }
}
