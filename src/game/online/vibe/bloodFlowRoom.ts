import type { MatchType, GamePlayer } from '../../core/contracts/types'
import { createWall } from '../../core/rules/tiles'
import { useBloodFlowGame, type BloodFlowGameOptions } from '../../variants/lotus/bloodFlow/useBloodFlowGame'
import { BLOOD_FLOW_CONFIG } from '../../variants/lotus/bloodFlow/config'
import { BloodFlowAuthority } from '../../variants/lotus/bloodFlow/network/authority'
import { BloodFlowReplica } from '../../variants/lotus/bloodFlow/network/replica'
import { createWorkerAuthorityBackend } from '../../variants/lotus/bloodFlow/network/backends'
import { decodeBloodFlowPacket, type BloodFlowPacket } from '../../variants/lotus/bloodFlow/network/protocol'
import type { Seat } from '../../variants/lotus/bloodFlow/types'
import type { HostOpeningData } from '../host/hostGameRunner'
import { runCommittedShuffle } from '../antiCheat/committedShuffle'
import { createMatchStatsRecorder } from './matchStatsRecorder'
import { sendChunked, unwrapChunk } from '../transport/vibeRoomTransport'

/** 线上验收诊断开关：`?bfdiag=1` 时打印血流 P2P 收帧/失败的关键路径（默认静默）。 */
const BF_DIAG = typeof location !== 'undefined' && new URLSearchParams(location.search).has('bfdiag')
import { updatePlayerStats } from './vibeStats'
import { watch } from 'vue'
import { createBloodFlowDecisions, createBloodFlowReactions, type BloodFlowReaction } from '../../llm/bloodFlowRuntime'
import { readLlmSettings, type LlmProviderPreset } from '../../llm/config'
import type { HostLlmSeatSelection } from './vibeLlm'
import {actionSpeechMatches,type BloodFlowActionSpeech} from '../../llm/bloodFlowSpeech'

interface BloodFlowRoomOptions extends Pick<BloodFlowGameOptions, 'playSound' | 'playSoundAndWait' | 'getThemeName' | 'animeFixedTts' | 'paceMs'> {
  getSeat(): number
  getMode(): MatchType
  getIsHost(): boolean
  /** Supplied only from the lobby's verified seat-token roster. */
  getVerifiedBindings(): Map<string, number>
  getPlayerProfile(seat: number): Partial<Pick<GamePlayer, 'name' | 'avatar' | 'characterId' | 'playerKind' | 'isLlm'>>
  leave(): void
  onError(message: string): void
  getPrivateAiSelections?(): readonly HostLlmSeatSelection[]
  onAutoPlayChanged?(enabled: boolean): void
}

export function createBloodFlowRoom(options: BloodFlowRoomOptions) {
  let room: VibeHubSDK.Room | null = null, replica: BloodFlowReplica | null = null, authority: BloodFlowAuthority | null = null
  let lifecycle = 0, hostPeer = '', started = false, starting = false, lastReceived = 0, lastHello = 0, goneSince = 0
  /** 状态推进（sequence/round 变化）与"收到帧"分开跟踪；见 present() 里的注释。 */
  let lastStateSequence = -1, lastStateRound = -1, lastStateAdvance = 0
  /** 自愈可观测：已上报过的决策超时次数（避免同一计数重复打印）。 */
  let reportedDecisionTimeouts = 0
  /** 自愈可观测：客机因"状态停滞"重握手的次数（打印时自增）。 */
  let stateStallHandshakes = 0
  let timer: ReturnType<typeof setInterval> | null = null
  let latestFrame: Extract<BloodFlowPacket, { kind: 'blood_flow_snapshot' | 'round_settled' }> | null = null
  let offline: (() => void) | null = null, online: (() => void) | null = null
  const shuffleIds = new Set<string>()
  const stats = createMatchStatsRecorder({ writeStats: updatePlayerStats, storageKey: 'lgm_blood_flow_match_stats' })
  const version = BLOOD_FLOW_CONFIG.version
  const completedKey = 'lgm_blood_flow_completed_epochs'
  const completed = new Set<string>()
  const pendingReactions = new Map<string, BloodFlowReaction>()
  const pendingActionSpeech=new Map<string,{line:BloodFlowActionSpeech;receivedAt:number}>()
  const provider = (seat: Seat): LlmProviderPreset | null => {
    if ([...options.getVerifiedBindings().values()].includes(seat)) return null
    const selected = options.getPrivateAiSelections?.().find(s => s.seat === seat), settings = readLlmSettings()
    if (!settings.enabled || !selected) return null
    const preset = settings.presets.find(p => p.id === selected.presetId)
    return preset?.apiKey.trim() ? { ...preset, style: selected.style } : null
  }
  const decisions = createBloodFlowDecisions({ provider,theme:()=>options.getThemeName?.()??'jade' })
  try { for (const id of JSON.parse(sessionStorage.getItem(completedKey) ?? '[]')) if (typeof id === 'string') completed.add(id) } catch { /* ephemeral stats */ }

  const port = useBloodFlowGame({ ...options, externalAuthority: {
    send: command => transmit({ kind: 'blood_flow_command', roomId: room?.roomId ?? '', ruleVersion: version, command }),
    nextRound: () => {
      if (!latestFrame) return
      if (authority) reactions.cancel()
      pendingReactions.clear()
      pendingActionSpeech.clear();decisions.cancelSpeech()
      transmit({ kind: 'blood_flow_continue', roomId: latestFrame.roomId, ruleVersion: version,
        authorityEpoch: latestFrame.authorityEpoch, round: latestFrame.round })
    },
    openingDone: round => {
      if (!latestFrame) return
      transmit({ kind: 'blood_flow_opening_done', roomId: latestFrame.roomId, ruleVersion: version,
        authorityEpoch: latestFrame.authorityEpoch, round })
    },
    leave: () => { stop(); options.leave() },
  } })
  const reactions = createBloodFlowReactions({ provider, theme: () => options.getThemeName?.() ?? 'jade',
    current: view => !!authority && replica?.view?.roundId === view.roundId && !!replica?.view?.public.roundResult,
    emit: line => {
      if (!room || !authority) return
      const message: BloodFlowPacket = { kind: 'blood_flow_reaction', roomId: room.roomId, ruleVersion: version, reaction: line }
      sendChunked(room, message); present(message, hostPeer)
    },
  })
  watch(() => options.getThemeName?.(), () => { reactions.cancel(); pendingReactions.clear();pendingActionSpeech.clear();decisions.cancelSpeech() })

  function flushReactions() {
    if (!replica?.view?.public.roundResult) return
    for (const [id, line] of pendingReactions) {
      pendingReactions.delete(id)
      if (line.roundId === replica.view.roundId && line.authorityEpoch === replica.view.authorityEpoch) void port.presentRoundReaction(line)
    }
  }
  function flushActionSpeech(){
    const view=port.view.value;if(!view)return
    for(const [id,p] of pendingActionSpeech){
      if(actionSpeechMatches(p.line,view)){pendingActionSpeech.delete(id);void port.presentActionSpeech(p.line)}
      else if(Date.now()-p.receivedAt>5000||view.roundId!==p.line.roundId||view.public.roundResult||view.public.status==='interrupted'
        ||view.public.status==='playing'&&view.version>=p.line.stateVersion)pendingActionSpeech.delete(id)
    }
  }

  /**
   * 房主 peer 实时解析：`hostPeer` 只在 attach 时取一次（`active.hostId`），对端 id 一旦变化
   * （SDK 修复连接 / 中继切换 / 重新入房），客机的 hello/回执会发往旧 id、主机的帧也会被判成
   * 「非房主」丢弃——实测表现为：主机侧 `[VibeHub] 联机消息加密失败: 消息未发送` 连续刷屏、
   * 客机再也收不到帧却仍能显示旧视图，最后判「房主无法恢复」整场中断（2026-09-10 线上验收）。
   */
  function liveHostPeer(): string {
    const active = room
    if (!active) return hostPeer
    const resolved = options.getIsHost() ? active.peerId : (active.hostId ?? '')
    if (!resolved) return hostPeer
    if (resolved !== hostPeer) {
      if (BF_DIAG) console.warn(`[bf-diag] 房主 peer 变更 ${hostPeer || '(空)'} → ${resolved}`)
      hostPeer = resolved
      // replica 用它拒收非房主消息，必须同步更新：否则对端 id 一变，客机会「收到帧但全部拒收」
      // ——实测表现为 HUD 停在 checking、结算面板永不出现，随后判「房主无法恢复」整场中断。
      if (replica) replica.hostPeer = resolved
    }
    return hostPeer
  }

  function isFromHost(from: string): boolean {
    return from === liveHostPeer()
  }

  function transmit(message: BloodFlowPacket) {
    if (!room) return
    if (authority) void authority.receive(message, room.peerId)
    else try { sendChunked(room, message, liveHostPeer()) } catch { /* periodic sync retries while disconnected */ }
  }
  function fail(message: string) {
    if (BF_DIAG) console.warn(`[bf-diag] fail: ${message}`)
    options.onError(message)
    replica?.interrupt()
    if (replica?.view && latestFrame) void port.acceptRemoteView(replica.view, { ...latestFrame, replay: true })
  }
  function present(raw: unknown, from: string) {
    const active = room, current = replica
    if (!active || !current) return
    const reaction = decodeBloodFlowPacket(raw)
    if(reaction?.kind==='blood_flow_action_speech'){
      const line=reaction.speech
      if(!isFromHost(from)||reaction.roomId!==active.roomId||line.authorityEpoch!==current.view?.authorityEpoch||line.roundId!==current.view?.roundId)return
      pendingActionSpeech.set(line.id,{line,receivedAt:Date.now()});flushActionSpeech();return
    }
    if (reaction?.kind === 'blood_flow_reaction') {
      if (!isFromHost(from) || reaction.roomId !== active.roomId || reaction.reaction.authorityEpoch !== current.view?.authorityEpoch
        || reaction.reaction.roundId !== current.view?.roundId) return
      pendingReactions.set(reaction.reaction.id, reaction.reaction); flushReactions(); return
    }
    if (!current.receive(raw, from)) {
      if (BF_DIAG) {
        const probe = decodeBloodFlowPacket(raw)
        const seq = probe && 'sequence' in probe ? (probe as { sequence: number }).sequence : null
        const result = probe && 'view' in probe
          ? Boolean((probe as { view?: { public?: { roundResult?: unknown } } }).view?.public?.roundResult) : null
        if (probe && (probe.kind === 'round_settled' || probe.kind === 'blood_flow_snapshot')) {
          console.warn(`[bf-diag] replica 拒收 kind=${probe.kind} round=${probe.round} seq=${seq} `
            + `携带结算=${result} 已应用round=${current.round} replicaSeq=${current.sequence} `
            + `已应用结算=${Boolean(current.view?.public.roundResult)}`)
        }
      }
      return
    }
    lastReceived = Date.now(); goneSince = 0
    const message = decodeBloodFlowPacket(raw)
    if (!message) return
    // 状态推进打点（2026-09-14 自愈）：与"收到帧"分开记。主机权威链被堵住时会**反复广播同一份
    // 状态**——只按收帧判断会以为一切正常，其实牌局早已停住（线上验收实测：双端停在等待、只剩托管）。
    if ('sequence' in message && (message.sequence !== lastStateSequence || message.round !== lastStateRound)) {
      lastStateSequence = message.sequence; lastStateRound = message.round; lastStateAdvance = Date.now()
    }
    if (message.kind === 'blood_flow_error') {
      fail(message.code === 'INCOMPATIBLE_RULE_VERSION' ? '房间规则版本不兼容，请更新所有客户端' : '房主对局已中断，保留最后确认流水')
      return
    }
    if (message.kind === 'blood_flow_snapshot' || message.kind === 'round_settled') {
      if ('autoPlay' in message) options.onAutoPlayChanged?.(message.autoPlay === true)
      const replay = latestFrame === null || port.view.value?.public.status === 'paused'
      latestFrame = message
      if (!current.view) return
      if(authority)for(const line of decisions.observe(current.view)){
        sendChunked(active, {kind:'blood_flow_action_speech',roomId:active.roomId,ruleVersion:version,speech:line} satisfies BloodFlowPacket)
        pendingActionSpeech.set(line.id,{line,receivedAt:Date.now()})
      }
      try { sessionStorage.setItem(`blood-flow-view:${active.roomId}:${current.seat}`, JSON.stringify(message)) } catch { /* view remains in memory */ }
      void port.acceptRemoteView(current.view, { ...message, replay }).then(() => {
        flushReactions()
        flushActionSpeech()
        if (room !== active || !message.view.public.roundResult || completed.has(message.authorityEpoch)) return
        const result = message.view.public.roundResult, own = current.seat
        stats.noteHandResult({ epoch: message.authorityEpoch, round: message.round, honba: 0,
          result: { winnerIndex: result.winCounts[own] > 0 ? 0 : undefined,
            scoreChanges: [{ playerIndex: 0, name: message.view.players[own].name, avatar: message.view.players[own].avatar,
              delta: result.endingScores[own] - result.openingScores[own], score: result.endingScores[own] }] } })
        if (message.round === BLOOD_FLOW_CONFIG.rounds[message.mode]) {
          completed.add(message.authorityEpoch)
          try { sessionStorage.setItem(completedKey, JSON.stringify([...completed].slice(-20))) } catch { /* at-most-once in this session */ }
          void stats.flushMatch(message.authorityEpoch)
        }
      }).catch((error) => {
        if (BF_DIAG) console.warn(`[bf-diag] acceptRemoteView 失败 round=${message.round} `
          + `result=${Boolean(message.view.public.roundResult)} err=${String(error).slice(0, 200)}`)
        fail('牌桌展示恢复失败，已保留确认流水')
      })
    } else if (message.kind === 'win_batch' && current.view && latestFrame) {
      void port.acceptRemoteView(current.view, { round: latestFrame.round, dealer: latestFrame.dealer, mode: latestFrame.mode })
    }
  }

  function verified(): Map<string, Seat> {
    const entries = [...options.getVerifiedBindings()].filter(([, seat]) => Number.isInteger(seat) && seat >= 0 && seat < 4)
    return new Map(entries.map(([peer, seat]) => [peer, seat as Seat]))
  }
  function shuffle(active: VibeHubSDK.Room, roundId: string, epoch: string, bindings: Map<string, Seat>, onMissing?: (seats: number[]) => void) {
    return new Promise<HostOpeningData>((resolve, reject) => runCommittedShuffle({ room: active, roundId, authorityEpoch: epoch,
      mySeat: options.getSeat(), seatCount: 4, seatByPeer: bindings, tiles: createWall(), onTimeout: onMissing,
      onComplete: (initialWall, openingDice, openingSecondDice) => resolve({ initialWall, openingDice, openingSecondDice }), onError: reject }))
  }

  function stop() {
    lifecycle++
    if (timer) clearInterval(timer)
    timer = null
    if (offline) window.removeEventListener('offline', offline)
    if (online) window.removeEventListener('online', online)
    authority?.stop(); authority = null; room = null; replica = null
    decisions.cancel(); reactions.cancel(); pendingReactions.clear();pendingActionSpeech.clear()
    port.dispose(); port.view.value = null; port.result.value = null; port.phase.value = 'lobby'
    started = false; starting = false; latestFrame = null
  }
  function attach(active: VibeHubSDK.Room, firstOpening?: PromiseLike<HostOpeningData>, initialBindings?: Map<string, number>) {
    const seat = options.getSeat()
    if (!Number.isInteger(seat) || seat < 0 || seat > 3) return
    if (room === active && (!firstOpening || authority)) return
    if (options.getIsHost() && !firstOpening) return // lobby alone must never start an authority
    stop()
    const token = lifecycle
    room = active; hostPeer = options.getIsHost() ? active.peerId : active.hostId ?? ''
    if (!hostPeer) return fail('无法验证房主身份')
    lastReceived = Date.now(); lastHello = 0; goneSince = 0; shuffleIds.clear()
    replica = new BloodFlowReplica(active.roomId, hostPeer, seat as Seat, () => transmit({ kind: 'blood_flow_sync', roomId: active.roomId, ruleVersion: version }))
    // Cached state is displayed as paused until the pinned host confirms it again.
    try {
      const cached = decodeBloodFlowPacket(JSON.parse(sessionStorage.getItem(`blood-flow-view:${active.roomId}:${seat}`) ?? 'null'))
      if (cached && (cached.kind === 'blood_flow_snapshot' || cached.kind === 'round_settled') && replica.receive(cached, hostPeer)) {
        latestFrame = cached; replica.pause()
        if (replica.view) void port.acceptRemoteView(replica.view, { round: cached.round, dealer: cached.dealer, mode: cached.mode, replay: true,continuation:cached.continuation })
      }
    } catch { /* corrupt cache is not authority */ }

    if (options.getIsHost()) {
      const epoch = crypto.randomUUID()
      const bindings = new Map([...(initialBindings ?? verified())].map(([peer, s]) => [peer, s as Seat]))
      bindings.set(active.peerId, 0)
      authority = new BloodFlowAuthority({ roomId: active.roomId, authorityEpoch: epoch, hostPeer: active.peerId,
        mode: options.getMode(), seatByPeer: bindings, backend: createWorkerAuthorityBackend(),
        decide: (view, current) => decisions.decide(view, current), cancelDecisions: decisions.cancel,
        onRoundSettled: view => { void reactions.run(view) },
        send: (peer, message) => {
          if (room !== active || token !== lifecycle) return
          let packet = message
          if (message.kind === 'blood_flow_snapshot' || message.kind === 'round_settled') packet = {
            ...message, view: { ...message.view, players: message.view.players.map(p => ({ ...p, ...options.getPlayerProfile(p.seat) })) },
          }
          if (peer === active.peerId) present(packet, hostPeer)
          else sendChunked(active, packet, peer)
        },
        prepareOpening: async round => {
          if (round === 1) {
            const initial = await firstOpening!
            return { initialWall: initial.initialWall, firstDice: initial.openingDice, secondDice: initial.openingSecondDice }
          }
          for (let attempt = 0; attempt < 3; attempt++) {
            const current = authority!
            const participants = new Map([...current.bindings].filter(([, s]) => !current.aiSeats.has(s)))
            const roundId = `${epoch}/shuffle/${round}/${attempt}`
            const packet = { type: 'blood_flow_shuffle', roomId: active.roomId, ruleVersion: version, authorityEpoch: epoch,
              round, roundId, participants: [...participants].map(([peerId, s]) => ({ peerId, seat: s })) }
            sendChunked(active, packet)
            let missing: number[] = []
            try {
              const prepared = await shuffle(active, roundId, epoch, participants, seats => { missing = seats })
              return { initialWall: prepared.initialWall, firstDice: prepared.openingDice, secondDice: prepared.openingSecondDice }
            } catch (error) {
              let changed = false
              for (const s of missing) {
                const peer = [...participants].find(([, candidate]) => candidate === s)?.[0]
                if (peer && !active.peers().some(p => p.id === peer && p.open)
                  && Date.now() - (current.disconnected.get(peer) ?? Date.now()) >= 12_000) { current.aiSeats.add(s as Seat); changed = true }
              }
              if (!changed || attempt === 2) throw error
            }
          }
          throw new Error('Committed shuffle unavailable')
        },
      })
    } else void Promise.resolve(firstOpening).catch(() => fail('承诺洗牌失败，未进入对局'))

    active.onMessage((raw, from) => {
      if (room !== active || token !== lifecycle) return
      // 本房间直接订阅 SDK 的 room.onMessage（不经传输层），因此必须自己拆大包分片：
      // 否则被分片的结算帧在这里会被当成未知包丢弃 —— 线上实测「主机一直发、客机计数收到、
      // 但视图永远没有 roundResult、结算面板不出现」（场景 B 帧更大更早触发分片）。
      const unwrapped = unwrapChunk(raw)
      if (unwrapped === null) return
      const raw2 = unwrapped
      if (!authority && isFromHost(from) && typeof raw2 === 'object' && raw2 !== null && (raw2 as any).type === 'blood_flow_shuffle') {
        const m = raw2 as any
        if (m.roomId !== active.roomId || m.ruleVersion !== version || m.authorityEpoch !== latestFrame?.authorityEpoch
          || !Number.isInteger(m.round) || m.round !== (latestFrame?.round ?? 0) + 1 || typeof m.roundId !== 'string' || shuffleIds.has(m.roundId)
          || !Array.isArray(m.participants)) return
        const bindings = new Map<string, Seat>()
        for (const participant of m.participants) {
          if (typeof participant.peerId !== 'string' || !Number.isInteger(participant.seat) || participant.seat < 0 || participant.seat > 3
            || bindings.has(participant.peerId) || [...bindings.values()].includes(participant.seat)) return
          bindings.set(participant.peerId, participant.seat)
        }
        if (bindings.get(hostPeer) !== 0 || bindings.get(active.peerId) !== options.getSeat()) return
        shuffleIds.add(m.roundId)
        void shuffle(active, m.roundId, m.authorityEpoch, bindings).catch(() => { /* host retries or sends interruption */ })
      } else if (authority) void authority.receive(raw2, from)
      else present(raw2, from)
    })
    active.onPeer(event => {
      if (room !== active || token !== lifecycle || event.type === 'error') return
      if (authority) {
        if (event.type === 'leave' || event.type === 'reconnecting') authority.peerDisconnected(event.id)
        return
      }
      if (event.id !== liveHostPeer()) return
      if (event.type === 'leave' || event.type === 'reconnecting') {
        goneSince ||= Date.now(); replica?.pause()
        if (replica?.view && latestFrame) void port.acceptRemoteView(replica.view, { ...latestFrame, opening: undefined, replay: true })
      } else if (event.type === 'join' || event.type === 'connecting' || event.type === 'relay' && event.active) {
        transmit(replica!.hello())
      }
    })
    offline = () => { if (authority) void authority.pause(); else { goneSince ||= Date.now(); replica?.pause() } }
    online = () => { if (authority) void authority.resume(); else transmit(replica!.hello()) }
    window.addEventListener('offline', offline); window.addEventListener('online', online)
    timer = setInterval(() => {
      if (token !== lifecycle || room !== active) return
      if (authority) {
        const observed = verified(), bindings = new Map(authority.bindings)
        // Refresh verified peer IDs for existing seats, never drop a locked human merely
        // because a transient/older roster omitted them and never admit a new mid-game seat.
        for (const [peer, s] of observed) if ([...bindings.values()].includes(s)) {
          for (const [oldPeer, oldSeat] of bindings) if (oldSeat === s) bindings.delete(oldPeer)
          bindings.set(peer, s)
        }
        bindings.set(active.peerId, 0)
        if (started) authority.replaceVerifiedBindings(bindings)
        if (!started && !starting && [...authority.bindings.keys()].every(p => authority!.compatible.has(p))) {
          starting = true
          void authority.start().then(() => { started = true; starting = false }).catch(() => { starting = false; fail('规则版本协商或承诺洗牌失败'); authority?.interrupt() })
        } else if (started) void authority.tick().then(() => {
          // 自愈可观测（2026-09-14）：决策超时是"权威链差点被堵死"的直接信号。
          // 只有 ?bfdiag=1 才打印，验收脚本会把它计数进结果里（跑通也看得见看门狗有没有干活）。
          if (BF_DIAG && authority && authority.botDecisionTimeouts > reportedDecisionTimeouts) {
            reportedDecisionTimeouts = authority.botDecisionTimeouts
            console.warn(`[bf-diag] 权威决策超时 #${reportedDecisionTimeouts}（已回落引擎机器人策略）`)
          }
        })
        if (!started && !starting && Date.now() - lastReceived > 15_000) {
          fail('有客户端未支持当前血流规则，请更新后重开'); authority.interrupt(); if (timer) clearInterval(timer); timer = null
        }
      } else {
        if ((!replica?.view || replica.view.public.status === 'paused') && Date.now() - lastHello >= 1000) { lastHello = Date.now(); transmit(replica!.hello()) }
        // 客机：收帧停滞就主动重握手——`hello` 会触发主机立刻重发权威快照。此前只在视图
        // paused 时重握手：一旦漏掉终局帧（大帧静默发送失败/中继切换），客机既不请求重发
        // 又等不到新帧，40s+30s 后判「房主无法恢复」把整场打断（2026-09-10 线上验收实测）。
        else if (Date.now() - lastReceived > 3_000 && Date.now() - lastHello >= 3_000) {
          lastHello = Date.now(); transmit(replica!.hello())
          if (BF_DIAG) console.warn(`[bf-diag] 客机收帧停滞 ${Math.round((Date.now() - lastReceived) / 1000)}s，已重握手请求权威快照`)
        }
        // 第二道网：帧一直在到，但**状态不前进**（sequence/round 都没变）——典型是主机权威链被
        // 一条挂住的机器人/大模型决策堵死，只反复广播同一份状态。20s 阈值大于最长决策窗口
        // （12s）+ 一炮多响的并发决策余量，避免把正常的慢回合误判成停滞。
        else if (replica?.view && !replica.view.public.roundResult
          && Date.now() - lastStateAdvance > 20_000 && Date.now() - lastHello >= 20_000) {
          lastHello = Date.now(); transmit(replica!.hello())
          if (BF_DIAG) console.warn(`[bf-diag] 客机状态停滞 ${Math.round((Date.now() - lastStateAdvance) / 1000)}s（seq=${lastStateSequence} 未推进，帧仍在到），已重握手 #${++stateStallHandshakes}`)
        }
        if (replica?.view && !replica.view.public.roundResult && Date.now() - lastReceived > 40_000) goneSince ||= Date.now()
        if (goneSince && Date.now() - goneSince > 30_000) fail('房主无法恢复，对局中断，保留最后确认流水')
      }
    }, options.paceMs === 0 ? 10 : 450)
    if (!authority) transmit(replica.hello())
  }

  return { port, attach, stop, get activeRoom() { return room }, recover: () => { if (replica) transmit(replica.hello()) },
    setAutoPlay: (enabled: boolean) => { if (latestFrame) transmit({ kind: 'blood_flow_auto', roomId: latestFrame.roomId,
      ruleVersion: version, authorityEpoch: latestFrame.authorityEpoch, enabled }) },
    interrupt: (reason: string) => { fail(reason); authority?.stop(); if (timer) clearInterval(timer); timer = null },
  }
}
