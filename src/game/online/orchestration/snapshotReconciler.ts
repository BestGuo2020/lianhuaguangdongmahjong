import { tileAudioFile } from '../../core/rules/tiles'
import type { Announcement } from '../../core/contracts/gamePort'
import type { RemoteGameState } from '../state/remoteGameState'
import type { ServerSnapshot } from '../protocol/dto'
import {
  mapLastDiscardToLocal,
  mapPlayersToLocal,
} from '../protocol/mapper'

type SnapshotState = Pick<RemoteGameState,
  | 'phase' | 'players' | 'wall' | 'wallCount' | 'wallHeadDrawn'
  | 'currentPlayer' | 'selectedIndex' | 'lastDiscard' | 'actionPrompt'
  | 'announcement' | 'result' | 'winEffect' | 'winPresentation'
  | 'revealHands' | 'winningPlayerIndex' | 'round' | 'dealer' | 'honba'
  | 'matchFinished'
  | 'rulesetId' | 'secondDice' | 'flipTile' | 'jokerTiles' | 'wildcardTiles'
  | 'flipStack' | 'openingStack' | 'wallBreakIndex'
>

export interface SnapshotReconcilerOptions {
  state: SnapshotState
  getLocalSeat(): number
  isShowingRoundResult(): boolean
  opening: {
    isRunning(): boolean
    captureSnapshot(snapshot: ServerSnapshot): void
  }
  settlement: {
    start(snapshot: ServerSnapshot): void
    cancel(): void
  }
  clearCountdown(): void
  onFinishedSnapshot(): void
  playSound(name: string, volume?: number): unknown
  later(callback: () => void, delay: number): void
  /** 房主视图：快照 phase 里的 discard/prompt 是房主自己的回合/提示，直接保留（客户端则折叠为 playing）。 */
  isLocalAuthority?(): boolean
}

export type ServerAnnouncement = Pick<Announcement, 'text' | 'tone'> & { id?: number }

export function createSnapshotReconciler({
  state,
  getLocalSeat,
  isShowingRoundResult,
  opening,
  settlement,
  clearCountdown,
  onFinishedSnapshot,
  playSound,
  later,
  isLocalAuthority,
}: SnapshotReconcilerOptions) {
  let pendingSnapshot: ServerSnapshot | null = null
  let lastAnnouncementId = -1
  let lastDiscardIdApplied = -1

  const toLocal = (seat: number) => {
    const localSeat = getLocalSeat()
    return ((seat - localSeat + 4) % 4 + 4) % 4
  }

  function reconcileAnnouncement(message: ServerAnnouncement | null) {
    if (!message?.text) {
      state.announcement.value = null
      return
    }
    if (message.id != null) {
      if (message.id === lastAnnouncementId) return
      lastAnnouncementId = message.id
    } else if (state.announcement.value?.text === message.text) {
      return
    }
    state.announcement.value = {
      text: message.text,
      tone: message.tone ?? 'gold',
      id: message.id ?? Date.now(),
    }
    later(() => {
      if (state.announcement.value?.text === message.text) state.announcement.value = null
    }, 1500)
  }

  function showAnnouncement(message: ServerAnnouncement) {
    if (isShowingRoundResult() || opening.isRunning()) return
    reconcileAnnouncement(message)
  }

  function applyLastDiscard(snapshot: ServerSnapshot) {
    const discard = snapshot.lastDiscard
    if (!discard) {
      state.lastDiscard.value = null
      return
    }
    state.lastDiscard.value = mapLastDiscardToLocal(discard, getLocalSeat())
    if (discard.id === lastDiscardIdApplied) return
    lastDiscardIdApplied = discard.id
    if (opening.isRunning()) return
    playSound('dapai.mp3', 0.8)
    const audio = tileAudioFile(discard.tile)
    if (audio) later(() => playSound(audio), 80)
  }

  function applySharedSnapshot(snapshot: ServerSnapshot) {
    state.players.splice(
      0,
      state.players.length,
      ...mapPlayersToLocal(snapshot.players, getLocalSeat()),
    )
    state.wall.value = snapshot.wall ?? []
    state.wallHeadDrawn.value = snapshot.headDrawn ?? 0
    state.rulesetId.value = snapshot.rulesetId ?? 'lotus-classic'
    state.secondDice.value = snapshot.secondDice ?? snapshot.dice ?? [1, 1]
    state.flipTile.value = snapshot.flipTile ?? null
    state.jokerTiles.value = snapshot.jokerTiles ?? []
    state.wildcardTiles.value = snapshot.wildcardTiles ?? []
    state.flipStack.value = snapshot.flipStack ?? null
    state.openingStack.value = snapshot.openingStack ?? null
    state.wallBreakIndex.value = snapshot.wallBreakIndex ?? 0
  }

  function applyNow(snapshot: ServerSnapshot) {
    if (snapshot.matchFinished || snapshot.phase === 'finished') {
      settlement.cancel()
      pendingSnapshot = null
      onFinishedSnapshot()
      state.matchFinished.value = true
      state.phase.value = 'finished'
      state.result.value = null
      state.winEffect.value = null
      state.winPresentation.value = null
      state.revealHands.value = true
      state.winningPlayerIndex.value = -1
      applySharedSnapshot(snapshot)
      return
    }

    applySharedSnapshot(snapshot)
    state.wallCount.value = snapshot.wallCount
    state.currentPlayer.value = snapshot.currentPlayer >= 0 ? toLocal(snapshot.currentPlayer) : -1
    state.dealer.value = toLocal(snapshot.dealer)
    state.honba.value = snapshot.honba
    state.round.value = snapshot.round
    applyLastDiscard(snapshot)
    reconcileAnnouncement(snapshot.announcement)

    if (snapshot.phase === 'settled' && snapshot.result) {
      settlement.start(snapshot)
      return
    }

    state.selectedIndex.value = -1
    state.winningPlayerIndex.value = snapshot.winningPlayerIndex >= 0
      ? toLocal(snapshot.winningPlayerIndex)
      : -1
    state.result.value = null
    const localAuthority = isLocalAuthority?.() ?? false
    if (!localAuthority) {
      state.actionPrompt.value = null
      clearCountdown()
    }
    // A room snapshot without players cannot render a game table. Keep it in the
    // room lobby even if an inconsistent/stale server phase says otherwise.
    // 房主视图：discard/prompt 是房主自己的回合/提示，保留；客户端统一折叠为 playing。
    state.phase.value = snapshot.phase === 'lobby' || snapshot.players.length === 0
      ? 'lobby'
      : (localAuthority && (snapshot.phase === 'discard' || snapshot.phase === 'prompt')
        ? snapshot.phase
        : 'playing')
  }

  function apply(snapshot: ServerSnapshot) {
    if (isShowingRoundResult()) {
      pendingSnapshot = snapshot
      return
    }
    if (opening.isRunning()) {
      opening.captureSnapshot(snapshot)
      pendingSnapshot = snapshot
      return
    }
    applyNow(snapshot)
  }

  function takePending(): ServerSnapshot | null {
    const snapshot = pendingSnapshot
    pendingSnapshot = null
    return snapshot
  }

  function flush() {
    const snapshot = takePending()
    if (snapshot) applyNow(snapshot)
  }

  function clearPending() {
    pendingSnapshot = null
  }

  function resetDiscardDedup() {
    lastDiscardIdApplied = -1
  }

  function reset() {
    pendingSnapshot = null
    lastAnnouncementId = -1
    lastDiscardIdApplied = -1
  }

  return {
    apply,
    applyNow,
    flush,
    takePending,
    clearPending,
    showAnnouncement,
    resetDiscardDedup,
    reset,
  }
}
