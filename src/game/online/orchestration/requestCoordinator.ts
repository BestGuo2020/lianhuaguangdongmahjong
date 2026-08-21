import type { RemoteGameState } from '../state/remoteGameState'
import type { ServerRequest } from '../protocol/messages'
import { matchingCount } from '../../core/rules/rules'

type RequestState = Pick<RemoteGameState,
  | 'phase' | 'currentPlayer' | 'userDrewThisTurn' | 'actionPrompt'
  | 'turnSeconds' | 'autoPlay' | 'turnCanHu' | 'turnCanWindKong'
  | 'players' | 'selectedIndex' | 'round'
>

export interface RequestCoordinatorOptions {
  state: RequestState
  isBlocked(): boolean
  isUserTurn(): boolean
  canUserHu(): boolean
  getUserHandLength(): number
  toLocalSeat(seat: number): number
  announce(text: string, tone?: string): void
  playSound(name: string, volume?: number): unknown
  later(callback: () => void, delay: number): void
  actions: {
    discard(index: number): void
    pass(): void
    hu(): void
    pickDiscard(): number
  }
  countdownSeconds?: number
  autoPlayDelay?: number
}

export function createRequestCoordinator({
  state,
  isBlocked,
  isUserTurn,
  canUserHu,
  getUserHandLength,
  toLocalSeat,
  announce,
  playSound,
  later,
  actions,
  countdownSeconds = 12,
  autoPlayDelay = 600,
}: RequestCoordinatorOptions) {
  let pendingRequest: ServerRequest | null = null
  let countdownHandle: ReturnType<typeof globalThis.setInterval> | null = null
  // 每次请求/清理都会推进代次。除了 interval 之外，autoPlay 使用的是外部
  // later(setTimeout)，单纯 clearCountdown() 清不掉它；没有这个代次保护时，
  // 玩家手动出牌或刷新重进后，旧回合的 600ms fallback 仍可能再次发动作。
  let requestGeneration = 0
  let authorityEpoch: string | null = null
  let activeRequestId: string | null = null
  let activeRequestSeq: number | null = null
  let expectedRequestSeq: number | null = null
  let highestRequestSeq = -1

  function clearCountdown() {
    if (countdownHandle != null) globalThis.clearInterval(countdownHandle)
    countdownHandle = null
    requestGeneration += 1
    state.turnSeconds.value = 0
  }

  function startCountdown(onExpire: () => void) {
    clearCountdown()
    state.turnSeconds.value = countdownSeconds
    countdownHandle = globalThis.setInterval(() => {
      state.turnSeconds.value -= 1
      if (state.turnSeconds.value === 3) playSound('didu.ogg')
      // 提前 2s 自动出牌（剩 2 秒时）：留给网络往返余量，确保响应早于房主掉线超时
      // （25s）与 AI 兜底（22s）——否则倒计时归零才发出，relay 延迟下可能被 AI 先
      // 接管（「AI 夺舍」：在线玩家被短暂代打一手）。
      if (state.turnSeconds.value <= 2) {
        clearCountdown()
        onExpire()
      }
    }, 1000)
  }

  function scheduleAutoAction(callback: () => void) {
    if (!state.autoPlay.value) return
    const generation = requestGeneration
    later(() => {
      if (generation === requestGeneration && state.autoPlay.value) callback()
    }, autoPlayDelay)
  }

  function applyNow(message: ServerRequest) {
    // 新请求必须使上一个请求的延迟 fallback 失效，即使旧 setTimeout 尚未被
    // useVibeRemoteGame 的全局 timers 集合清掉。
    requestGeneration += 1
    if (message.kind === 'turn_request') {
      state.currentPlayer.value = 0
      state.userDrewThisTurn.value = !message.ctx.skipDraw
      state.turnCanHu.value = message.ctx.canHu ?? false
      state.turnCanWindKong.value = message.ctx.canWindKong ?? false
      state.actionPrompt.value = null
      state.selectedIndex.value = -1
      // 同步本家手牌（含刚摸的牌）：房主在等待响应期间暂停快照广播，手牌只能由 turn_request 带入。
      if (state.players[0]) {
        state.players[0].hand = [...message.ctx.hand]
        state.players[0].drawnTileIndex = message.ctx.skipDraw ? -1 : message.ctx.hand.length - 1
      }
      state.phase.value = 'discard'
      if (!message.ctx.skipDraw) playSound('give.mp3', 0.7)
      startCountdown(() => {
        const handLength = getUserHandLength()
        if (isUserTurn() && handLength) actions.discard(handLength - 1)
      })
      scheduleAutoAction(() => {
        if (!isUserTurn()) return
        if (canUserHu()) actions.hu()
        else actions.discard(actions.pickDiscard())
      })
      return
    }

    if (message.kind === 'claim_request') {
      state.turnCanHu.value = false
      state.turnCanWindKong.value = false
      state.actionPrompt.value = {
        type: 'claim',
        tile: message.ctx.tile,
        from: toLocalSeat(message.ctx.from),
        canHu: message.ctx.canHu ?? false,
        canPeng: message.ctx.canPeng ?? matchingCount(message.ctx.hand, message.ctx.tile) >= 2,
        canGang: message.ctx.canGang,
        chiOptions: message.ctx.chiOptions,
      }
      state.phase.value = 'prompt'
      startCountdown(() => {
        if (state.actionPrompt.value?.type === 'claim') actions.pass()
      })
      scheduleAutoAction(() => {
        if (state.actionPrompt.value?.type !== 'claim') return
        // auto 联调：放炮可胡时直接胡（加快对局收敛），否则过。
        if (state.actionPrompt.value.canHu) actions.hu()
        else actions.pass()
      })
      return
    }

    state.actionPrompt.value = {
      type: 'rob',
      tile: message.ctx.tile,
      from: toLocalSeat(message.ctx.from),
    }
    state.phase.value = 'prompt'
    state.turnCanHu.value = false
    state.turnCanWindKong.value = false
    announce('可抢杠胡', 'red')
    startCountdown(() => {
      if (state.actionPrompt.value?.type === 'rob') actions.pass()
    })
    scheduleAutoAction(() => {
      // 托管：抢杠胡提示即本家可胡，直接胡。
      if (state.actionPrompt.value?.type === 'rob') actions.hu()
    })
  }

  function apply(message: ServerRequest) {
    if (!acceptRequest(message)) return
    if (isBlocked()) {
      pendingRequest = message
      return
    }
    applyNow(message)
  }

  function takePending(): ServerRequest | null {
    const request = pendingRequest
    pendingRequest = null
    return request
  }

  function flush() {
    const request = takePending()
    // apply() 已经在进入 blocked 状态时完成了请求代次校验；这里不能再次按“重复
    // 请求”过滤，否则开局/结算动画结束后永远不会真正启动当前请求。
    if (request) applyNow(request)
  }

  function clearPending() {
    pendingRequest = null
    activeRequestId = null
    activeRequestSeq = null
    expectedRequestSeq = null
    requestGeneration += 1
  }

  function reset() {
    clearCountdown()
    clearPending()
  }

  function acceptAuthorityEpoch(epoch?: string): boolean {
    if (!epoch) return true
    if (authorityEpoch === null) {
      authorityEpoch = epoch
      return true
    }
    return authorityEpoch === epoch
  }

  function setAuthorityEpoch(epoch?: string) {
    if (!epoch || authorityEpoch === epoch) return
    authorityEpoch = epoch
    pendingRequest = null
    activeRequestId = null
    activeRequestSeq = null
    expectedRequestSeq = null
    highestRequestSeq = -1
    requestGeneration += 1
  }

  function acceptRequest(message: ServerRequest): boolean {
    if (!acceptAuthorityEpoch(message.authorityEpoch)) return false
    if (message.round != null && message.round < state.round.value) return false
    const sequence = message.requestSeq
    if (sequence == null) return true
    if (activeRequestSeq === sequence && activeRequestId === message.requestId) return false
    // 同一房主代次下，低于已接受请求的消息只能是旧 Room/旧 DataChannel 的迟到包。
    // 重进补发的当前请求由 expectedRequestSeq 明确放行。
    if (sequence < highestRequestSeq && sequence !== expectedRequestSeq) return false
    if (sequence === highestRequestSeq && sequence !== expectedRequestSeq) return false
    highestRequestSeq = Math.max(highestRequestSeq, sequence)
    expectedRequestSeq = sequence
    activeRequestSeq = sequence
    activeRequestId = message.requestId ?? null
    return true
  }

  function syncSnapshot(snapshot: {
    authorityEpoch?: string
    round: number
    requestId?: string | null
    requestSeq?: number | null
  }) {
    if (!acceptAuthorityEpoch(snapshot.authorityEpoch)) return
    if (snapshot.round < state.round.value) return
    expectedRequestSeq = snapshot.requestSeq ?? null
    if (snapshot.requestSeq == null || activeRequestSeq !== snapshot.requestSeq || activeRequestId !== snapshot.requestId) {
      // 快照明确当前房主已经不再等待本地旧请求时，必须同时销毁 interval。
      // 仅推进 generation 只能拦住 later(setTimeout) 的 autoPlay，旧倒计时 interval
      // 仍会在“剩 3 秒”触发 discard/pass，正是重进后自动出牌的来源。
      clearCountdown()
      pendingRequest = null
      activeRequestId = null
      activeRequestSeq = null
      state.actionPrompt.value = null
      state.turnCanHu.value = false
      state.turnCanWindKong.value = false
      state.userDrewThisTurn.value = false
      state.selectedIndex.value = -1
    }
  }

  return {
    apply,
    flush,
    takePending,
    clearPending,
    clearCountdown,
    reset,
    acceptAuthorityEpoch,
    setAuthorityEpoch,
    syncSnapshot,
    getActiveRequestId: () => activeRequestId,
    getAuthorityEpoch: () => authorityEpoch,
  }
}
