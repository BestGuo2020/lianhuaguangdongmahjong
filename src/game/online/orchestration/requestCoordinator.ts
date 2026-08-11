import type { RemoteGameState } from '../state/remoteGameState'
import type { ServerRequest } from '../protocol/messages'

type RequestState = Pick<RemoteGameState,
  | 'phase' | 'currentPlayer' | 'userDrewThisTurn' | 'actionPrompt'
  | 'turnSeconds' | 'autoPlay'
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

  function clearCountdown() {
    if (countdownHandle != null) globalThis.clearInterval(countdownHandle)
    countdownHandle = null
  }

  function startCountdown(onExpire: () => void) {
    clearCountdown()
    state.turnSeconds.value = countdownSeconds
    countdownHandle = globalThis.setInterval(() => {
      state.turnSeconds.value -= 1
      if (state.turnSeconds.value === 3) playSound('didu.ogg')
      if (state.turnSeconds.value <= 0) {
        clearCountdown()
        onExpire()
      }
    }, 1000)
  }

  function scheduleAutoAction(callback: () => void) {
    if (!state.autoPlay.value) return
    later(() => {
      if (state.autoPlay.value) callback()
    }, autoPlayDelay)
  }

  function applyNow(message: ServerRequest) {
    if (message.kind === 'turn_request') {
      state.currentPlayer.value = 0
      state.userDrewThisTurn.value = !message.ctx.skipDraw
      state.actionPrompt.value = null
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
      state.actionPrompt.value = {
        type: 'claim',
        tile: message.ctx.tile,
        from: toLocalSeat(message.ctx.from),
        canGang: message.ctx.canGang,
      }
      state.phase.value = 'prompt'
      startCountdown(() => {
        if (state.actionPrompt.value?.type === 'claim') actions.pass()
      })
      scheduleAutoAction(() => {
        if (state.actionPrompt.value?.type === 'claim') actions.pass()
      })
      return
    }

    state.actionPrompt.value = {
      type: 'rob',
      tile: message.ctx.tile,
      from: toLocalSeat(message.ctx.from),
    }
    state.phase.value = 'prompt'
    announce('可抢杠胡', 'red')
    startCountdown(() => {
      if (state.actionPrompt.value?.type === 'rob') actions.pass()
    })
    scheduleAutoAction(() => {
      if (state.actionPrompt.value?.type === 'rob') actions.pass()
    })
  }

  function apply(message: ServerRequest) {
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
    if (request) apply(request)
  }

  function clearPending() {
    pendingRequest = null
  }

  function reset() {
    clearCountdown()
    clearPending()
  }

  return { apply, flush, takePending, clearPending, clearCountdown, reset }
}
