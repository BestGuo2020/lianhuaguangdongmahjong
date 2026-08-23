import { tileAudioFile } from '../../core/rules/tiles'
import type { TileType } from '../../core/contracts/types'
import type { Announcement } from '../../core/contracts/gamePort'
import type { RemoteGameState } from '../state/remoteGameState'
import type { ServerSnapshot } from '../protocol/dto'
import type { RoundSettledMessage } from '../protocol/messages'
import type { SettlementPresentationPayload } from '../presentation/settlementTimeline'
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
    /** 当前开局动画的目标手（round_start 轮次）；未启动时返回 null。 */
    getTargetHand?(): { round: number; honba: number } | null
    primeSnapshot?(snapshot: ServerSnapshot): void
    captureSnapshot(snapshot: ServerSnapshot): void
    cancel(): void
  }
  settlement: {
    start(snapshot: SettlementPresentationPayload): void
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
  // 客户端已确认本局结算（nextRound）：后续到达的下一局 opening/dealing 快照
  // 必须放行落地，不能再被 isShowingRoundResult 结算屏障缓存。否则自动确认
  // 路径（双方同时确认、round_start 未到）下新局快照永远无法落地、开局动画缺失。
  let nextHandAllowed = false
  // 牌山单调性诊断游标：wall 张数回跳或 headDrawn 回退 = 牌山重建/瞬移信号（§6.2）。
  let lastDiagHand = ''
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
    // 大模型保留实体落牌声，但不播放牌名人声；其表达统一由吐槽 TTS 承担。
    if (snapshot.players.find((player) => player.seat === discard.from)?.isLlm) return
    const audio = tileAudioFile(discard.tile)
    if (audio) later(() => playSound(audio), 80)
  }

  function applySharedSnapshot(snapshot: ServerSnapshot) {
    // 牌山单调性诊断：wall 张数回跳（超过 2 张）或 headDrawn 回退 = 牌山瞬移证据。
    // 开局边界按 (round, honba) 重置。round 已先推进但新牌墙尚未装载的过渡
    // 快照也可能存在，所以 opening/dealing 必须再次建立新基线；正常 playing
    // 阶段 wall 只减、headDrawn 只增。
    const diagHand = `${snapshot.round}:${snapshot.honba}`
    const openingBoundary = snapshot.phase === 'opening' || snapshot.phase === 'dealing'
    if (lastDiagHand !== diagHand || openingBoundary) {
      lastDiagHand = diagHand
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
        round: snapshot.round, honba: snapshot.honba, phase: snapshot.phase, seq: snapshot.sequence,
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

  function acceptMetadata(snapshot: Pick<ServerSnapshot, 'authorityEpoch' | 'sequence'>): boolean {
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

  function commitAcceptedMetadata(message: Pick<ServerSnapshot, 'sequence'>) {
    if (message.sequence != null) {
      lastSequence = message.sequence
      pendingSequence = -1
    }
    // 当前权威消息已经不旧于任何暂存快照；旧 pending 不能在表现结束后复活。
    pendingSnapshot = null
    pendingSequence = -1
  }

  function applyNow(snapshot: ServerSnapshot, metadataAccepted = false): boolean {
    if (!metadataAccepted && !acceptMetadata(snapshot)) return false
    commitAcceptedMetadata(snapshot)
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
    if (opening.isRunning()) {
      // 「未来轮次」必须与开局动画的目标手比较，而不是与滞后的 state.round 比较：
      // 动画 gate 等待期间 state.round 仍是上一手，同手 opening 快照会被误判成
      // 未来轮 → 取消刚启动的开局动画并 applyNow 直接落地（自动确认路径的东2局无动画）。
      const targetHand = opening.getTargetHand?.()
      const isFutureHand = targetHand
        ? snapshot.round > targetHand.round
          || (snapshot.round === targetHand.round && snapshot.honba > targetHand.honba)
        : snapshot.round > state.round.value
      if (isFutureHand) {
        // round_start 与 state_snapshot 通过 SDK 分开传输，不能假设先后顺序。
        // 若开局动画还在等待同轮快照，先交给 opening gate 配对；不能直接把
        // round_start 当成已提交的 round，或把当前快照误判成“未来轮次”并丢掉。
        if (opening.isWaitingForSnapshot?.()) {
          opening.captureSnapshot(snapshot)
          pendingSnapshot = snapshot
          pendingSequence = snapshot.sequence ?? pendingSequence
          return false
        }
        console.log(`[client] reconciler 未来轮快照取消旧开局动画: round=${snapshot.round} honba=${snapshot.honba} phase=${snapshot.phase} target=${targetHand ? `${targetHand.round}:${targetHand.honba}` : `${state.round.value}:${state.honba.value}`} waiting=${Boolean(opening.isWaitingForSnapshot?.())}`)
        opening.cancel()
        settlement.cancel()
        return applyNow(snapshot, true)
      }
    }
    if (isShowingRoundResult()) {
      // win_effect 公共事件会先把客户端置为表现阶段；随后到达的定向 settled
      // 快照必须立即为同一条时间线补上最终结果，不能像普通下一局快照一样缓存。
      if (snapshot.phase === 'settled' && snapshot.result) return applyNow(snapshot, true)
      // round_start 已启动开局动画（gate 正在等快照）时，即使仍处于结算表现层
      // （动画 run() 尚未把 phase 切到 dealing），同局 opening 快照也必须喂给
      // 动画 gate——否则 round_start 先到、快照后到时，动画 gate 永远等不到
      // 快照，15 秒超时后静默跳过整个开局动画（自动确认路径的东2局无动画）。
      if ((opening.isRunning() || opening.isWaitingForSnapshot?.()) && snapshot.phase === 'opening') {
        opening.captureSnapshot(snapshot)
        pendingSnapshot = snapshot
        pendingSequence = snapshot.sequence ?? pendingSequence
        return false
      }
      // 客户端已确认本局结算后，下一局 opening 快照必须放行到开局时间线：
      // 不能继续缓存（round_start 动画 gate 等不到快照 → 自动确认路径进入新一局
      // 无开局动画），也不能 applyNow 直接落地（round_start 到达时会因
      // hasSnapshotForHand=false 走 confirm 只 ack，start/dice/flip 动画仍缺失）。
      // prime 保留动画数据，round_start 到达后 opening.start 用 primed 快照
      // 播放完整 136/断点0 → 一骰 → 翻精134 → 二骰 → 断点 → 分批发牌 时序。
      const isNextHand = snapshot.round > state.round.value
        || (snapshot.round === state.round.value && snapshot.honba > state.honba.value)
      if (nextHandAllowed && isNextHand) {
        // opening 快照 prime 到开局时间线（running 时即 captureSnapshot 喂给
        // 动画 gate）；dealing 快照（可能先到）只缓存等待 opening。放行标志
        // 保持到新一局动画真正启动（opening.start 时由 lifecycle 复位），
        // 不能在这里提前复位——否则后续 opening 快照会被普通缓存挡住，
        // round_start 的动画 gate 等不到快照 → 开局动画缺失。
        if (snapshot.phase === 'opening') opening.primeSnapshot?.(snapshot)
        pendingSnapshot = snapshot
        pendingSequence = snapshot.sequence ?? pendingSequence
        return false
      }
      pendingSnapshot = snapshot
      pendingSequence = snapshot.sequence ?? pendingSequence
      return false
    }
    if (opening.isRunning()) {
      // 天胡/地胡/起手即胡：开局动画还在播放时，胡牌表现与结算快照已经到达。
      // 不能继续缓冲等动画播完（高负载下可能超过 20 秒），必须像公共
      // round_settled 路径一样取消开局动画、立即进入胡牌表现与结算时间线，
      // 否则房主端永远不出现结算弹窗、真人无法确认下一局。
      if (snapshot.phase === 'win-effect' || snapshot.phase === 'revealing'
        || snapshot.phase === 'settled' || snapshot.winPresentation) {
        opening.cancel()
        clearCountdown()
        onFinishedSnapshot()
        state.selectedIndex.value = -1
        state.currentPlayer.value = -1
        state.actionPrompt.value = null
        state.waitingNextRound.value = false
        state.matchFinished.value = false
        applySharedSnapshot(snapshot)
        state.wallCount.value = snapshot.wallCount
        state.honba.value = snapshot.honba
        state.round.value = snapshot.round
        state.dealer.value = toLocal(snapshot.dealer)
        // settlement.start 会按 key 幂等：win-effect 快照先启动特效，
        // 随后同 round/honba 的 settled 快照只补最终 result，不重播动画。
        settlement.start(snapshot)
        return true
      }
      opening.captureSnapshot(snapshot)
      pendingSnapshot = snapshot
      pendingSequence = snapshot.sequence ?? pendingSequence
      return false
    }
    return applyNow(snapshot, true)
  }

  /**
   * 应用不含暗牌/牌墙的房间级结算事实。房主给公共兜底分配较小 sequence，
   * 完整定向快照使用紧随其后的较大 sequence：公共事实可先启动结算，但不能
   * 挡住随后包含四家真实牌面的亮牌快照。
   */
  function applySettlementNotice(message: RoundSettledMessage): boolean {
    if (message.round < state.round.value) return false
    if (!acceptMetadata(message)) return false
    commitAcceptedMetadata(message)
    if (state.matchFinished.value) return false

    // 公共结算事实本身携带四家已公开牌面，不能继续沿用上一帧定向快照里的
    // null 暗牌占位；否则 revealHands 开启时另外三家会从牌桌上消失。
    state.players.splice(
      0,
      state.players.length,
      ...mapPlayersToLocal(message.players, getLocalSeat()),
    )
    for (const entry of message.scores) {
      const player = state.players[toLocal(entry.seat)]
      if (!player) continue
      player.name = entry.name
      player.score = entry.score
    }
    state.matchType.value = message.mode
    state.rulesetId.value = message.rulesetId ?? state.rulesetId.value
    state.round.value = message.round
    state.honba.value = message.honba
    state.dealer.value = toLocal(message.dealer)

    // 已完整进入结算页时，每秒重发只刷新序号/分数；若当前仍是 win-effect /
    // revealing 且 result 尚未到达，则必须把最终结果交给同一条时间线补齐。
    if (isShowingRoundResult() && state.result.value != null) return true

    opening.cancel()
    clearCountdown()
    onFinishedSnapshot()
    state.selectedIndex.value = -1
    state.currentPlayer.value = -1
    state.actionPrompt.value = null
    state.waitingNextRound.value = false
    state.matchFinished.value = false
    settlement.start(message)
    return true
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

  /** 客户端确认本局结算后调用：放行下一局 opening 快照 prime 到开局时间线。 */
  function allowNextHand() {
    nextHandAllowed = true
  }

  /** 新一局开局动画已启动后调用：停止放行，恢复常规结算屏障。 */
  function clearNextHand() {
    nextHandAllowed = false
  }

  /** nextRound 发现取出的快照已 prime 给开局动画时，放回 pending 等待动画后 flush 落地。 */
  function restorePending(snapshot: ServerSnapshot) {
    pendingSnapshot = snapshot
    pendingSequence = snapshot.sequence ?? pendingSequence
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
    lastDiagHand = ''
    diagWallLen = -1
    diagHeadDrawn = -1
    nextHandAllowed = false
  }

  function setAuthorityEpoch(epoch?: string) {
    if (!epoch || authorityEpoch === epoch) return
    authorityEpoch = epoch
    lastSequence = -1
    pendingSequence = -1
    pendingSnapshot = null
    lastDiagHand = ''
    diagWallLen = -1
    diagHeadDrawn = -1
    // 事件 id 通常由引擎在新生命周期重新从 0/1 开始；旧生命周期的去重游标
    // 不能阻止新房主的第一张弃牌/公告在重开一局时展示。
    lastAnnouncementId = -1
    lastDiscardIdApplied = -1
    nextHandAllowed = false
  }

  return {
    apply,
    applyNow,
    applySettlementNotice,
    flush,
    takePending,
    clearPending,
    allowNextHand,
    clearNextHand,
    restorePending,
    showAnnouncement,
    resetDiscardDedup,
    setAuthorityEpoch,
    reset,
  }
}
