import { tileAudioFile } from '../../core/rules/tiles'
import type { TileType } from '../../core/contracts/types'
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
  | 'matchFinished' | 'waitingNextRound'
  | 'rulesetId' | 'secondDice' | 'flipTile' | 'jokerTiles' | 'wildcardTiles'
  | 'flipStack' | 'openingStack' | 'wallBreakIndex' | 'matchType'
>

export interface SnapshotReconcilerOptions {
  state: SnapshotState
  getLocalSeat(): number
  isShowingRoundResult(): boolean
  opening: {
    isRunning(): boolean
    /** round_start 已到，但尚未收到同轮的第一份权威开局快照。 */
    isWaitingForSnapshot?(): boolean
    primeSnapshot?(snapshot: ServerSnapshot): void
    captureSnapshot(snapshot: ServerSnapshot): void
    cancel(): void
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
  let authorityEpoch: string | null = null
  let lastSequence = -1
  // 结算/发牌动画期间的快照会暂存。单独记录暂存快照的序号，避免
  // 「先收到新快照、后收到旧快照」时旧包覆盖 pendingSnapshot。
  let pendingSequence = -1
  // 牌山单调性诊断游标：wall 张数回跳或 headDrawn 回退 = 牌山重建/瞬移信号（§6.2）。
  let lastDiagRound = -1
  let diagWallLen = -1
  let diagHeadDrawn = -1

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
    const current = {
      text: message.text,
      tone: message.tone ?? 'gold',
      id: message.id ?? Date.now(),
    }
    state.announcement.value = current
    later(() => {
      if (state.announcement.value?.id === current.id && state.announcement.value.text === current.text) {
        state.announcement.value = null
      }
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
    // 牌山单调性诊断：wall 张数回跳（超过 2 张）或 headDrawn 回退 = 牌山瞬移证据。
    // 开局/换庄边界（round 变化）重置游标；正常对局中 wall 只减、headDrawn 只增。
    if (lastDiagRound !== snapshot.round) {
      lastDiagRound = snapshot.round
      diagWallLen = -1
      diagHeadDrawn = -1
    }
    const newWallLen = snapshot.wall && snapshot.wall.length > 0 ? snapshot.wall.length : (snapshot.wallCount ?? -1)
    if (
      diagWallLen >= 0 && newWallLen > diagWallLen + 2
      || (diagHeadDrawn >= 0 && (snapshot.headDrawn ?? 0) < diagHeadDrawn)
    ) {
      console.warn('[wall-regress] 牌山回跳/重建', JSON.stringify({
        wallLen: diagWallLen, newWallLen, headDrawn: diagHeadDrawn, newHeadDrawn: snapshot.headDrawn,
        round: snapshot.round, phase: snapshot.phase, seq: snapshot.sequence,
      }))
    }
    if (newWallLen >= 0) diagWallLen = newWallLen
    if (snapshot.headDrawn != null) diagHeadDrawn = snapshot.headDrawn
    state.players.splice(
      0,
      state.players.length,
      ...mapPlayersToLocal(snapshot.players, getLocalSeat()),
    )
    // 远端快照故意省略 wall 内容，避免泄露未来摸牌顺序；牌桌 3D 只需要
    // 张数和 head 进度即可重建牌背。不能把省略的 wall 当成空墙，否则慢网
    // 重连时首个完整快照到达会清空牌山，网络恢复后牌山就“消失”了。
    if (snapshot.wall && snapshot.wall.length > 0) {
      state.wall.value = [...snapshot.wall]
    } else if (state.wall.value.length !== snapshot.wallCount) {
      state.wall.value = Array<TileType>(Math.max(0, snapshot.wallCount)).fill('m1')
    }
    state.wallHeadDrawn.value = snapshot.headDrawn ?? 0
    // 场次也是牌局事实，不能只信加入时读取的房间元数据；重进/旧缓存可能
    // 带着旧的 east/hanchan 值。以后续当前房主快照为唯一来源。
    state.matchType.value = snapshot.mode
    state.rulesetId.value = snapshot.rulesetId ?? 'lotus-classic'
    state.secondDice.value = snapshot.secondDice ?? snapshot.dice ?? [1, 1]
    state.flipTile.value = snapshot.flipTile ?? null
    state.jokerTiles.value = snapshot.jokerTiles ?? []
    state.wildcardTiles.value = snapshot.wildcardTiles ?? []
    state.flipStack.value = snapshot.flipStack ?? null
    state.openingStack.value = snapshot.openingStack ?? null
    state.wallBreakIndex.value = snapshot.wallBreakIndex ?? 0
  }

  function acceptMetadata(snapshot: ServerSnapshot): boolean {
    // 快照是客户端唯一可落地的牌局来源。房主刷新/换代后 epoch 必须变化；
    // 同一 epoch 只接受单调递增序列，旧 Room 的迟到终局不能覆盖当前对局。
    if (snapshot.authorityEpoch) {
      if (authorityEpoch === null) authorityEpoch = snapshot.authorityEpoch
      else if (authorityEpoch !== snapshot.authorityEpoch) return false
    }
    if (snapshot.sequence != null) {
      if (!Number.isInteger(snapshot.sequence) || snapshot.sequence < 1) return false
      if (snapshot.sequence <= Math.max(lastSequence, pendingSequence)) return false
      pendingSequence = snapshot.sequence
    }
    return true
  }

  function applyNow(snapshot: ServerSnapshot, metadataAccepted = false): boolean {
    if (!metadataAccepted && !acceptMetadata(snapshot)) return false
    if (snapshot.sequence != null) {
      lastSequence = snapshot.sequence
      pendingSequence = -1
    }
    // 直接落地的新快照已经比任何暂存快照更新，旧 pending 不能在之后复活。
    pendingSnapshot = null
    pendingSequence = -1
    // 房主「返回大厅」会广播 lobby 快照（空玩家）；客户端若正在展示最终排名页
    // （matchFinished 为 true），保持现状不落地——否则最终对局排行会被房主的
    // 返回动作冲掉（players 清空 → standings 消失）。客户端自己点「返回大厅」时
    // 会先经 matchLifecycle.returnToLobby 清掉 matchFinished，此后快照正常落地。
    if (state.matchFinished.value && (snapshot.phase === 'lobby' || snapshot.players.length === 0)) {
      return true
    }
    // 终局必须由同一帧的两个权威字段共同确认；不完整/旧协议快照不能把
    // 客户端复活到最终排名页。useVibeRemoteGame 会在进入这里前做同样的
    // publicStateVerifier 校验，reconciler 自身也保持 fail-closed，避免被
    // 单测、离线恢复或未来新增调用路径绕过。
    if (snapshot.matchFinished && snapshot.phase === 'finished') {
      settlement.cancel()
      clearCountdown()
      pendingSnapshot = null
      onFinishedSnapshot()
      state.matchFinished.value = true
      state.phase.value = 'finished'
      // 匹配结束走快照分支（房主不发 match_finished 消息），必须清掉「已确认，
      // 等待其他玩家」标记，否则东四局/南四局打完会永远卡在等待确认提示上。
      state.waitingNextRound.value = false
      state.result.value = null
      state.winEffect.value = null
      state.winPresentation.value = null
      state.revealHands.value = true
      state.winningPlayerIndex.value = -1
      applySharedSnapshot(snapshot)
      return true
    }

    // 当前房主已经确认回到发牌/进行中状态时，上一局的结算表现层必须立即
    // 失效。否则旧 settlement timeline 的延迟回调仍可能在新局快照之后把
    // phase/result/revealHands 写回旧结算页，形成“房主已进入下一局、客户端仍在结算”
    // 的状态分叉。settlement.start() 自身也会 cancel，但这里只在 settled 分支调用，
    // 因此非结算快照必须显式取消旧时间线。
    if (snapshot.phase !== 'settled' || snapshot.result == null) settlement.cancel()

    // 旧连接的房主失联兜底可能先把客户端置为最终结算；收到当前房间的完整
    // 非终局快照后，应允许恢复到真实对局状态。旧 Room 消息已由 transport/session
    // 层隔离，这里只处理当前权威快照的残留状态。
    if (snapshot.players.length === 4 && state.matchFinished.value) {
      state.matchFinished.value = false
      state.revealHands.value = false
      state.phase.value = 'playing'
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
      clearCountdown()
      onFinishedSnapshot()
      settlement.start(snapshot)
      return true
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
    return true
  }

  function apply(snapshot: ServerSnapshot): boolean {
    if (!acceptMetadata(snapshot)) return false
    // round_start/state_snapshot 通过不同的 SDK 消息路径传输；快照先到时先
    // 暂存同轮 opening 数据，等 round_start 到达后仍播放开局动画。真正的牌局
    // 状态依旧只在 applyNow() 里由房主快照落地。
    if (snapshot.phase === 'opening') opening.primeSnapshot?.(snapshot)
    // 快照先到时不能直接把客户端推进到 playing：这样后到的 round_start
    // 会被 lifecycle 当成“已经消费过的动画通知”，最终只有房主播放开局。
    // 先保留完整权威快照，等 round_start 启动开局时间线；动画结束后 flush()
    // 再把同一份快照落地。若 round_start 丢失，后续更高序号的非 opening
    // 快照仍可直接收敛，避免把房间永久卡在 opening。
    // dealing 阶段同理：房主引擎 headless 开局时，摸牌进度 watcher 会在
    // round_start 之前广播带完整手牌的 dealing 快照；若立即落地，handleRoundStart
    // 看到 players=4/phase=playing 会走「本局已渲染」分支跳过整个开局动画
    // （四端都没有 start/dice/deal 提示层）。开局时间线未运行时先缓存 dealing
    // 快照，等 round_start 启动动画后再由 flush() 落地最新一份。
    if ((snapshot.phase === 'opening' || snapshot.phase === 'dealing')
      && !opening.isRunning() && !isShowingRoundResult()) {
      pendingSnapshot = snapshot
      pendingSequence = snapshot.sequence ?? pendingSequence
      if (snapshot.phase !== 'opening') return false
      // 需要先挂载牌桌才能让 openingTimeline 的 tableReady gate 解除；这里只
      // 落地开局骨架和房主给出的轮次元数据，不落地完整手牌/回合状态。真正的
      // opening 快照仍由动画结束后的 flush() 原子提交。
      applySharedSnapshot(snapshot)
      state.wallCount.value = snapshot.wallCount
      // openingTimeline 会从 0 开始按批次发牌；snapshot.headDrawn 是房主引擎
      // 当前牌墙进度，不能提前写入，否则动画再发 53 张牌会把进度加倍。
      state.wallHeadDrawn.value = 0
      state.currentPlayer.value = -1
      state.dealer.value = toLocal(snapshot.dealer)
      state.honba.value = snapshot.honba
      state.round.value = snapshot.round
      state.selectedIndex.value = -1
      state.actionPrompt.value = null
      state.lastDiscard.value = null
      state.result.value = null
      state.winEffect.value = null
      state.winPresentation.value = null
      state.revealHands.value = false
      state.winningPlayerIndex.value = -1
      clearCountdown()
      state.phase.value = 'dealing'
      return false
    }
    // 匹配结束快照（房主只广播快照、不发 match_finished 消息）必须立即落地：
    // 最后一局打完时结算页仍在展示（phase='settled'+result），若走缓冲，
    // 没有下一局 round_start 触发 flush，最终排名页永远不出现、等待确认横幅永远挂着。
    if (snapshot.matchFinished && snapshot.phase === 'finished') {
      return applyNow(snapshot, true)
    }
    // 如果开局瞬时消息丢失，但当前房主快照已经明确进入更后轮次，
    // 不能继续播放旧轮次动画并等待它结束；最新权威快照优先，直接取消旧开局表现层。
    if (opening.isRunning() && snapshot.round > state.round.value) {
      // round_start 与 state_snapshot 通过 SDK 分开传输，不能假设先后顺序。
      // 若开局动画还在等待同轮快照，先交给 opening gate 配对；不能直接把
      // round_start 当成已提交的 round，或把当前快照误判成“未来轮次”并丢掉。
      if (opening.isWaitingForSnapshot?.()) {
        opening.captureSnapshot(snapshot)
        pendingSnapshot = snapshot
        pendingSequence = snapshot.sequence ?? pendingSequence
        return false
      }
      opening.cancel()
      settlement.cancel()
      return applyNow(snapshot, true)
    }
    if (isShowingRoundResult()) {
      pendingSnapshot = snapshot
      pendingSequence = snapshot.sequence ?? pendingSequence
      return false
    }
    if (opening.isRunning()) {
      opening.captureSnapshot(snapshot)
      pendingSnapshot = snapshot
      pendingSequence = snapshot.sequence ?? pendingSequence
      return false
    }
    return applyNow(snapshot, true)
  }

  function takePending(): ServerSnapshot | null {
    const snapshot = pendingSnapshot
    pendingSnapshot = null
    pendingSequence = -1
    return snapshot
  }

  function flush(): ServerSnapshot | null {
    const snapshot = takePending()
    if (snapshot && applyNow(snapshot)) return snapshot
    return null
  }

  function clearPending() {
    pendingSnapshot = null
    pendingSequence = -1
  }

  function resetDiscardDedup() {
    lastDiscardIdApplied = -1
  }

  function reset() {
    pendingSnapshot = null
    lastAnnouncementId = -1
    lastDiscardIdApplied = -1
    authorityEpoch = null
    lastSequence = -1
    pendingSequence = -1
  }

  function setAuthorityEpoch(epoch?: string) {
    if (!epoch || authorityEpoch === epoch) return
    authorityEpoch = epoch
    lastSequence = -1
    pendingSequence = -1
    pendingSnapshot = null
    // 事件 id 通常由引擎在新生命周期重新从 0/1 开始；旧生命周期的去重游标
    // 不能阻止新房主的第一张弃牌/公告在重开一局时展示。
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
    setAuthorityEpoch,
    reset,
  }
}
