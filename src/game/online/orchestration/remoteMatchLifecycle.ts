import type { RemoteGameState } from '../state/remoteGameState'
import type { RoundStartMessage } from '../protocol/messages'
import type { ServerSnapshot } from '../protocol/dto'

export interface RemoteMatchLifecycleOptions {
  state: RemoteGameState
  isShowingRoundResult(): boolean
  clearTimers(): void
  opening: {
    start(message: RoundStartMessage): void
    confirm(message: RoundStartMessage): void
    hasSnapshotForHand?(round: number, honba: number): boolean
    cancel(): void
  }
  settlement: {
    cancel(): void
    reset(): void
  }
  snapshots: {
    reset(): void
    clearPending(): void
    takePending(): ServerSnapshot | null
    apply(snapshot: ServerSnapshot): boolean
    allowNextHand(): void
    clearNextHand(): void
    restorePending(snapshot: ServerSnapshot): void
  }
  requests: {
    reset(): void
    clearPending(): void
    flush(): void
    syncSnapshot(snapshot: Pick<ServerSnapshot, 'authorityEpoch' | 'round' | 'requestId' | 'requestSeq'>): void
  }
  transientEvents: { clear(): void }
  sendContinue(): void
  refreshRoom(): void | Promise<void>
}

export function createRemoteMatchLifecycle({
  state,
  isShowingRoundResult,
  clearTimers,
  opening,
  settlement,
  snapshots,
  requests,
  transientEvents,
  sendContinue,
  refreshRoom,
}: RemoteMatchLifecycleOptions) {
  let pendingRoundStart: RoundStartMessage | null = null
  let startedHand = ''
  let lastRoundStartSequence = -1
  let authorityEpoch: string | null = null

  const handKey = (value: Pick<RoundStartMessage, 'round' | 'honba'>) => `${value.round}:${value.honba}`
  const snapshotPrecedesState = (value: Pick<ServerSnapshot, 'round' | 'honba'>) => (
    value.round < state.round.value
    || (value.round === state.round.value && value.honba < state.honba.value)
  )

  function clearRoundBarrier() {
    // 这里只清理“等待玩家确认”的表现层屏障；不能清掉 round_start 的去重游标。
    // 否则继续按钮之后，旧 Room 里迟到的同轮 round_start 会再次清空手牌并重播开局。
    pendingRoundStart = null
    state.waitingNextRound.value = false
  }

  function handleRoundStart(message: RoundStartMessage) {
    // round_start 只负责表现层开局动画，但它仍然会清空手牌、结果和操作提示，
    // 因此不能把它当作普通瞬时通知。当前房主生命周期内每个轮次只允许启动一次；
    // 刷新/换房主时由 authorityEpoch 重置历史；普通的继续屏障清理不能清掉
    // 同一房主生命周期内的 round_start 去重游标。
    // 新房主引擎生命周期拥有新的 epoch；只有此时才允许重新从 sequence=1
    // 开始计数。相同 epoch 下无论重进、Relay 还是清理继续屏障，都不能复活旧消息。
    if (message.authorityEpoch && authorityEpoch !== message.authorityEpoch) {
      authorityEpoch = message.authorityEpoch
      pendingRoundStart = null
      startedHand = ''
      lastRoundStartSequence = -1
    }
    const currentHand = handKey(message)
    if (snapshotPrecedesState(message) || startedHand === currentHand) {
      console.log(`[client] round_start 丢弃/去重: round=${message.round} honba=${message.honba} startedHand=${startedHand || '(空)'} currentHand=${currentHand}`)
      return
    }
    if (message.sequence != null) {
      if (message.sequence <= lastRoundStartSequence) return
      lastRoundStartSequence = message.sequence
    }
    if (state.matchFinished.value) return
    // state_snapshot 可能先于 round_start 到达。若当前轮次已经由完整房主快照
    // 落地（四家牌手已存在、且不在大厅/结算/终局），round_start 只需作为已消费
    // 的动画通知，不应再次启动 opening gate 等待一份已经错过的快照，更不能把
    // 已经一致的牌局清空后让房主 opening barrier 等到超时。
    if (
      message.round === state.round.value
      && state.players.length === 4
      && !isShowingRoundResult()
      && state.phase.value !== 'lobby'
      && state.phase.value !== 'finished'
    ) {
      startedHand = currentHand
      pendingRoundStart = null
      state.waitingNextRound.value = false
      if (opening.hasSnapshotForHand?.(message.round, message.honba)) {
        console.log(`[client] round_start 快照已配对，播放开局动画: round=${message.round} honba=${message.honba}`)
        snapshots.clearNextHand()
        opening.start(message)
      } else {
        console.log(`[client] round_start 快照已落地但无动画数据，confirm 只 ack: round=${message.round} honba=${message.honba}`)
        opening.confirm(message)
      }
      return
    }
    startedHand = currentHand
    const alreadyConfirmed = state.waitingNextRound.value
    state.waitingNextRound.value = false
    if (isShowingRoundResult() && !alreadyConfirmed) {
      // 结算页等待确认时到达的 round_start 先缓存；用户点「继续」后再放行。
      console.log(`[client] round_start 结算页缓存待确认后放行: round=${message.round} honba=${message.honba}`)
      pendingRoundStart = message
      return
    }
    pendingRoundStart = null
    // 开局动画正式启动：同局后续快照不再需要放行，恢复常规结算屏障。
    snapshots.clearNextHand()
    console.log(`[client] round_start 直接启动开局动画: round=${message.round} honba=${message.honba} alreadyConfirmed=${alreadyConfirmed}`)
    opening.start(message)
  }

  /**
   * round_start 是瞬时表现消息，可能在 P2P/Relay 切换窗口丢失；opening 快照
   * 才是房主的持久权威状态。收到已经验收并缓存的同轮 opening 快照时，用快照
   * 参数恢复一次动画触发器，不能因为缺一条瞬时消息而让客户端“状态正确但无动画”。
   */
  function handleOpeningSnapshot(snapshot: ServerSnapshot) {
    if (snapshot.phase !== 'opening' || state.matchFinished.value || isShowingRoundResult()) return
    const currentHand = handKey(snapshot)
    if (snapshotPrecedesState(snapshot) || startedHand === currentHand) return
    if (!opening.hasSnapshotForHand?.(snapshot.round, snapshot.honba)) return
    if (snapshot.authorityEpoch && authorityEpoch !== snapshot.authorityEpoch) {
      authorityEpoch = snapshot.authorityEpoch
      pendingRoundStart = null
      startedHand = ''
      lastRoundStartSequence = -1
    }
    startedHand = currentHand
    pendingRoundStart = null
    state.waitingNextRound.value = false
    opening.start({
      kind: 'round_start',
      roomId: snapshot.roomId,
      authorityEpoch: snapshot.authorityEpoch,
      sequence: snapshot.sequence ?? 1,
      matchStarted: snapshot.round === 1,
      round: snapshot.round,
      dealer: snapshot.dealer,
      honba: snapshot.honba,
      dice: snapshot.dice ?? [1, 1],
      secondDice: snapshot.secondDice,
      flipTile: snapshot.flipTile ?? undefined,
      flipStack: snapshot.flipStack ?? undefined,
    })
  }

  function resetAll() {
    clearTimers()
    settlement.reset()
    snapshots.reset()
    requests.reset()
    clearRoundBarrier()
    authorityEpoch = null
    startedHand = ''
    lastRoundStartSequence = -1
    opening.cancel()
    state.openingStage.value = null
    state.dealAnimation.value = { playerIndex: -1, count: 0, serial: 0 }
    state.diceValues.value = [1, 1]
    state.phase.value = 'lobby'
    state.players.splice(0, state.players.length)
    state.wall.value = []
    state.wallHeadDrawn.value = 0
    state.wallCount.value = 0
    state.rulesetId.value = 'lotus-classic'
    state.secondDice.value = [1, 1]
    state.flipTile.value = null
    state.jokerTiles.value = []
    state.wildcardTiles.value = []
    state.flipStack.value = null
    state.openingStack.value = null
    state.wallBreakIndex.value = 0
    state.turnCanHu.value = false
    state.turnCanWindKong.value = false
    state.currentPlayer.value = -1
    state.selectedIndex.value = -1
    state.turnSeconds.value = 12
    state.userDrewThisTurn.value = false
    state.lastDiscard.value = null
    state.actionPrompt.value = null
    transientEvents.clear()
    state.result.value = null
    state.winEffect.value = null
    state.winPresentation.value = null
    state.revealHands.value = false
    state.winningPlayerIndex.value = -1
    state.round.value = 1
    state.dealer.value = 0
    state.honba.value = 0
    state.matchFinished.value = false
    state.roomId.value = ''
    state.mySeat.value = -1
    state.nickname.value = ''
    state.roomTimeLimit.value = null
    state.sessionStatus.value = 'idle'
    state.sessionError.value = ''
  }

  function nextRound() {
    // 「继续」只是对当前房主结算事实的确认，不是客户端可以自行推进
    // round/phase 的命令。没有当前局 settled+result 时，丢弃本地点击，避免
    // 旧页面/重进残留提前进入 waitingNextRound 并制造假屏障。
    if (state.matchFinished.value || state.phase.value !== 'settled' || state.result.value == null) return
    settlement.cancel()
    // 已确认本局结算：后续到达的新一局快照（opening/dealing）不能再被
    // isShowingRoundResult 结算屏障缓存——否则自动确认路径（双方同时确认、
    // round_start 未到）下 takePending 的新局快照永远无法落地，开局动画缺失。
    // 这里只放行 reconciler 的新局快照，不改 phase/result 语义（房主自视与
    // 客户端 continue 协议都依赖结算状态）。
    snapshots.allowNextHand()
    sendContinue()
    state.waitingNextRound.value = true

    if (pendingRoundStart) {
      const message = pendingRoundStart
      pendingRoundStart = null
      state.waitingNextRound.value = false
      snapshots.clearNextHand()
      opening.start(message)
    }

    const pendingSnapshot = snapshots.takePending()
    if (pendingSnapshot && !(pendingSnapshot.phase === 'settled' && pendingSnapshot.result)) {
      // 新一局 opening 快照已 prime 到开局时间线：动画由 round_start 启动，
      // 快照必须放回 pending，动画结束后 flush 落地（否则开局动画结束时
      // flush 取不到快照，新一局牌桌永不落地）。
      if (pendingSnapshot.phase === 'opening' && opening.hasSnapshotForHand?.(pendingSnapshot.round, pendingSnapshot.honba)) {
        snapshots.restorePending(pendingSnapshot)
      } else if (snapshots.apply(pendingSnapshot)) {
        requests.syncSnapshot(pendingSnapshot)
      }
    }
    requests.flush()
  }

  function returnToLobby() {
    if (!state.matchFinished.value) return
    settlement.reset()
    requests.reset()
    // 新一场的轮次/本场/庄家边界：上一场结束时 state.round/honba 仍是末局值
    // （如东4局·2本场）。不重置的话，同一房间再次开局时新一局的 round=1 消息
    // 会被「旧轮次」门禁全部丢弃（round_shuffle_start / round_start /
    // state_snapshot），客户端永远停在大厅而房主已进入新对局（第二场开局失败）。
    // 新房主引擎的 authorityEpoch 变化会在首个 round_start 处重置 startedHand/
    // lastRoundStartSequence，这里只负责把轮次边界归零。
    state.round.value = 1
    state.dealer.value = 0
    state.honba.value = 0
    state.diceValues.value = [1, 1]
    state.secondDice.value = [1, 1]
    state.flipTile.value = null
    state.jokerTiles.value = []
    state.wildcardTiles.value = []
    state.flipStack.value = null
    state.openingStack.value = null
    state.wallBreakIndex.value = 0
    state.openingStage.value = null
    state.dealAnimation.value = { playerIndex: -1, count: 0, serial: 0 }
    state.diceThrowerIndex.value = 0
    state.turnSeconds.value = 12
    state.turnCanHu.value = false
    state.turnCanWindKong.value = false
    state.userDrewThisTurn.value = false
    snapshots.reset()
    clearRoundBarrier()
    state.matchFinished.value = false
    state.result.value = null
    state.winEffect.value = null
    state.winPresentation.value = null
    state.revealHands.value = false
    state.winningPlayerIndex.value = -1
    state.lastDiscard.value = null
    state.actionPrompt.value = null
    transientEvents.clear()
    state.selectedIndex.value = -1
    state.currentPlayer.value = -1
    state.wall.value = []
    state.wallHeadDrawn.value = 0
    state.wallCount.value = 0
    state.players.splice(0, state.players.length)
    state.phase.value = 'lobby'
    void refreshRoom()
  }

  return {
    handleRoundStart,
    handleOpeningSnapshot,
    resetAll,
    nextRound,
    returnToLobby,
    clearRoundBarrier,
  }
}
