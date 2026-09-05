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
import { updatePlayerStats } from './vibeStats'
import { watch } from 'vue'
import { createBloodFlowDecisions, createBloodFlowReactions, type BloodFlowReaction } from '../../llm/bloodFlowRuntime'
import { readLlmSettings, type LlmProviderPreset } from '../../llm/config'
import type { HostLlmSeatSelection } from './vibeLlm'

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
  let timer: ReturnType<typeof setInterval> | null = null
  let latestFrame: Extract<BloodFlowPacket, { kind: 'blood_flow_snapshot' | 'round_settled' }> | null = null
  let offline: (() => void) | null = null, online: (() => void) | null = null
  const shuffleIds = new Set<string>()
  const stats = createMatchStatsRecorder({ writeStats: updatePlayerStats, storageKey: 'lgm_blood_flow_match_stats' })
  const version = BLOOD_FLOW_CONFIG.version
  const completedKey = 'lgm_blood_flow_completed_epochs'
  const completed = new Set<string>()
  const pendingReactions = new Map<string, BloodFlowReaction>()
  const provider = (seat: Seat): LlmProviderPreset | null => {
    if ([...options.getVerifiedBindings().values()].includes(seat)) return null
    const selected = options.getPrivateAiSelections?.().find(s => s.seat === seat), settings = readLlmSettings()
    if (!settings.enabled || !selected) return null
    const preset = settings.presets.find(p => p.id === selected.presetId)
    return preset?.apiKey.trim() ? { ...preset, style: selected.style } : null
  }
  const decisions = createBloodFlowDecisions({ provider })
  try { for (const id of JSON.parse(sessionStorage.getItem(completedKey) ?? '[]')) if (typeof id === 'string') completed.add(id) } catch { /* ephemeral stats */ }

  const port = useBloodFlowGame({ ...options, externalAuthority: {
    send: command => transmit({ kind: 'blood_flow_command', roomId: room?.roomId ?? '', ruleVersion: version, command }),
    nextRound: () => {
      if (!latestFrame) return
      if (authority) reactions.cancel()
      pendingReactions.clear()
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
      room.send(message); present(message, hostPeer)
    },
  })
  watch(() => options.getThemeName?.(), () => { reactions.cancel(); pendingReactions.clear() })

  function flushReactions() {
    if (!replica?.view?.public.roundResult) return
    for (const [id, line] of pendingReactions) {
      pendingReactions.delete(id)
      if (line.roundId === replica.view.roundId && line.authorityEpoch === replica.view.authorityEpoch) void port.presentRoundReaction(line)
    }
  }

  function transmit(message: BloodFlowPacket) {
    if (!room) return
    if (authority) void authority.receive(message, room.peerId)
    else try { room.send(message, hostPeer) } catch { /* periodic sync retries while disconnected */ }
  }
  function fail(message: string) {
    options.onError(message)
    replica?.interrupt()
    if (replica?.view && latestFrame) void port.acceptRemoteView(replica.view, { ...latestFrame, replay: true })
  }
  function present(raw: unknown, from: string) {
    const active = room, current = replica
    if (!active || !current) return
    const reaction = decodeBloodFlowPacket(raw)
    if (reaction?.kind === 'blood_flow_reaction') {
      if (from !== hostPeer || reaction.roomId !== active.roomId || reaction.reaction.authorityEpoch !== current.view?.authorityEpoch
        || reaction.reaction.roundId !== current.view?.roundId) return
      pendingReactions.set(reaction.reaction.id, reaction.reaction); flushReactions(); return
    }
    if (!current.receive(raw, from)) return
    lastReceived = Date.now(); goneSince = 0
    const message = decodeBloodFlowPacket(raw)
    if (!message) return
    if (message.kind === 'blood_flow_error') {
      fail(message.code === 'INCOMPATIBLE_RULE_VERSION' ? '房间规则版本不兼容，请更新所有客户端' : '房主对局已中断，保留最后确认流水')
      return
    }
    if (message.kind === 'blood_flow_snapshot' || message.kind === 'round_settled') {
      if ('autoPlay' in message) options.onAutoPlayChanged?.(message.autoPlay === true)
      const replay = latestFrame === null || port.view.value?.public.status === 'paused'
      latestFrame = message
      if (!current.view) return
      try { sessionStorage.setItem(`blood-flow-view:${active.roomId}:${current.seat}`, JSON.stringify(message)) } catch { /* view remains in memory */ }
      void port.acceptRemoteView(current.view, { ...message, replay }).then(() => {
        flushReactions()
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
      }).catch(() => fail('牌桌展示恢复失败，已保留确认流水'))
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
    decisions.cancel(); reactions.cancel(); pendingReactions.clear()
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
        if (replica.view) void port.acceptRemoteView(replica.view, { round: cached.round, dealer: cached.dealer, mode: cached.mode, replay: true })
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
          else active.send(packet, peer)
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
            active.send(packet)
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
      if (!authority && from === hostPeer && typeof raw === 'object' && raw !== null && (raw as any).type === 'blood_flow_shuffle') {
        const m = raw as any
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
      } else if (authority) void authority.receive(raw, from)
      else present(raw, from)
    })
    active.onPeer(event => {
      if (room !== active || token !== lifecycle || event.type === 'error') return
      if (authority) {
        if (event.type === 'leave' || event.type === 'reconnecting') authority.peerDisconnected(event.id)
        return
      }
      if (event.id !== hostPeer) return
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
        } else if (started) void authority.tick()
        if (!started && !starting && Date.now() - lastReceived > 15_000) {
          fail('有客户端未支持当前血流规则，请更新后重开'); authority.interrupt(); if (timer) clearInterval(timer); timer = null
        }
      } else {
        if ((!replica?.view || replica.view.public.status === 'paused') && Date.now() - lastHello >= 1000) { lastHello = Date.now(); transmit(replica!.hello()) }
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
