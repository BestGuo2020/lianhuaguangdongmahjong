import type { MatchType } from '../../../../core/contracts/types'
import { TILE_TYPES } from '../../../../core/rules/tiles'
import { BLOOD_FLOW_CONFIG } from '../config'
import type { BloodFlowSeatView } from '../seatView'
import type { EngineCommand } from '../state'
import type { Seat, WinBatch } from '../types'
import type { BloodFlowReaction } from '../../../../llm/bloodFlowRuntime'
import { LLM_TTS_VOICE_OPTIONS } from '../../../../llm/config'

export interface BloodFlowEnvelope {
  roomId: string
  ruleVersion: string
}
export interface AuthorityEnvelope extends BloodFlowEnvelope {
  authorityEpoch: string
  sequence: number
  round: number
  continuation?: { readySeats: Seat[]; requiredSeats: Seat[] }
}
export interface NetworkOpening { firstDice: [number, number]; secondDice: [number, number] }
export type BloodFlowPacket =
  | (BloodFlowEnvelope & { kind: 'blood_flow_hello' })
  | (BloodFlowEnvelope & { kind: 'blood_flow_sync' })
  | (BloodFlowEnvelope & { kind: 'blood_flow_command'; command: EngineCommand })
  | (BloodFlowEnvelope & { kind: 'blood_flow_continue'; authorityEpoch: string; round: number })
  | (BloodFlowEnvelope & { kind: 'blood_flow_opening_done'; authorityEpoch: string; round: number })
  | (BloodFlowEnvelope & { kind: 'blood_flow_auto'; authorityEpoch: string; enabled: boolean })
  | (BloodFlowEnvelope & { kind: 'blood_flow_reaction'; reaction: BloodFlowReaction })
  | (AuthorityEnvelope & { kind: 'blood_flow_snapshot'; mode: MatchType; dealer: Seat; view: BloodFlowSeatView; opening?: NetworkOpening; autoPlay?: boolean })
  | (AuthorityEnvelope & { kind: 'win_batch'; batch: WinBatch })
  | (AuthorityEnvelope & { kind: 'round_settled'; view: BloodFlowSeatView; mode: MatchType; dealer: Seat })
  | (BloodFlowEnvelope & { kind: 'blood_flow_error'; code: 'INCOMPATIBLE_RULE_VERSION' | 'INTERRUPTED' })

const object = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v)
const int = (v: unknown) => Number.isSafeInteger(v)
const seat = (v: unknown): v is Seat => int(v) && Number(v) >= 0 && Number(v) < 4
const text = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length < 256
const tiles = (v: unknown, limit = 136) => Array.isArray(v) && v.length <= limit && v.every(t => TILE_TYPES.includes(t))
const vector = (v: unknown) => Array.isArray(v) && v.length === 4 && v.every(int)
const zeroSum = (v: unknown) => vector(v) && (v as number[]).reduce((a, b) => a + b, 0) === 0
const only = (v: Record<string, any>, keys: readonly string[]) => Object.keys(v).every(k => keys.includes(k))

export function isPublicWinScore(v: unknown): boolean {
  if (!object(v) || !only(v, ['items', 'excluded', 'hardWin', 'source', 'opening', 'patternMultiplier', 'eventMultiplier',
    'openingApplied', 'uncappedMultiplier', 'finalMultiplier', 'capped', 'paymentPerPayer'])) return false
  return Array.isArray(v.items) && v.items.length <= 21 && v.items.every((p: unknown) => object(p)
    && only(p, ['id', 'label', 'weight']) && Object.hasOwn(BLOOD_FLOW_CONFIG.patterns, p.id)
    && p.label === BLOOD_FLOW_CONFIG.patterns[p.id].label && p.weight === BLOOD_FLOW_CONFIG.patterns[p.id].weight)
    && Array.isArray(v.excluded) && v.excluded.every((p: unknown) => object(p) && only(p, ['id', 'includedBy'])
      && Object.hasOwn(BLOOD_FLOW_CONFIG.patterns, p.id) && Object.hasOwn(BLOOD_FLOW_CONFIG.patterns, p.includedBy))
    && typeof v.hardWin === 'boolean' && ['discard', 'self-draw', 'robbed-kong', 'kong-bloom'].includes(v.source)
    && [null, 'heaven', 'earth'].includes(v.opening) && typeof v.openingApplied === 'boolean' && typeof v.capped === 'boolean'
    && ['patternMultiplier', 'eventMultiplier', 'uncappedMultiplier', 'finalMultiplier', 'paymentPerPayer'].every(k => int(v[k]) && v[k] > 0)
    && v.finalMultiplier <= 64 && v.paymentPerPayer === v.finalMultiplier * 10
}

function isSource(v: unknown) {
  return object(v) && only(v, ['id', 'seat', 'tile', 'kind']) && text(v.id) && seat(v.seat)
    && TILE_TYPES.includes(v.tile) && ['draw', 'discard', 'added-kong'].includes(v.kind)
}
export function isWinBatch(v: unknown): v is WinBatch {
  if (!object(v) || !only(v, ['authorityEpoch', 'roundId', 'sequence', 'ruleVersion', 'batchId', 'windowId', 'source', 'winners', 'deltas', 'scoresAfter', 'nextAction'])) return false
  if (v.ruleVersion !== BLOOD_FLOW_CONFIG.version || !text(v.authorityEpoch) || !text(v.roundId) || !int(v.sequence)
    || !text(v.batchId) || !text(v.windowId) || !isSource(v.source) || !zeroSum(v.deltas) || !vector(v.scoresAfter)) return false
  if (!Array.isArray(v.winners) || !v.winners.length || v.winners.length > 3) return false
  const winners = new Set<number>(), ids = new Set<string>(), aggregate = [0, 0, 0, 0]
  for (const r of v.winners) {
    if (!object(r) || !only(r, ['id', 'batchId', 'winner', 'ordinal', 'sourceEventId', 'score', 'deltas']) || !seat(r.winner)
      || winners.has(r.winner) || !text(r.id) || ids.has(r.id) || r.batchId !== v.batchId || r.sourceEventId !== v.source.id
      || !int(r.ordinal) || r.ordinal < 1 || r.ordinal > 136 || !isPublicWinScore(r.score) || !zeroSum(r.deltas)) return false
    const selfDraw = r.score.source === 'self-draw' || r.score.source === 'kong-bloom'
    if (selfDraw ? v.source.kind !== 'draw' || r.winner !== v.source.seat || v.winners.length !== 1
      : v.source.kind === 'draw' || r.winner === v.source.seat) return false
    for (let s = 0; s < 4; s++) {
      const expected = s === r.winner ? r.score.paymentPerPayer * (selfDraw ? 3 : 1)
        : selfDraw || s === v.source.seat ? -r.score.paymentPerPayer : 0
      if (r.deltas[s] !== expected) return false
      aggregate[s] += r.deltas[s]
    }
    winners.add(r.winner); ids.add(r.id)
  }
  return aggregate.every((n, s) => n === v.deltas[s]) && object(v.nextAction)
    && (v.nextAction.kind === 'draw' ? seat(v.nextAction.seat) : v.nextAction.kind === 'finish-round' && v.nextAction.reason === 'wall-exhausted')
}

export function isSeatView(v: unknown): v is BloodFlowSeatView {
  if (!object(v) || !only(v, ['authorityEpoch', 'roundId', 'version', 'seat', 'players', 'currentPlayer', 'wallCount', 'headDrawn',
    'flipTile', 'jokers', 'flipStack', 'flipSeat', 'wallBreakIndex', 'window', 'ownActions', 'ownScore', 'waitingSeats', 'public', 'actionEvents', 'lastDiscardAction'])) return false
  if (!text(v.authorityEpoch) || !text(v.roundId) || !int(v.version) || !seat(v.seat) || !seat(v.currentPlayer)
    || !int(v.wallCount) || v.wallCount < 0 || v.wallCount > 134 || !int(v.headDrawn) || !TILE_TYPES.includes(v.flipTile)
    || !tiles(v.jokers, 2) || !Array.isArray(v.players) || v.players.length !== 4 || !object(v.public)) return false
  if (!only(v.public, ['ruleVersion', 'roundId', 'status', 'seats', 'batches', 'roundResult']) || v.public.ruleVersion !== BLOOD_FLOW_CONFIG.version
    || v.public.roundId !== v.roundId || !['playing', 'paused', 'interrupted', 'settled'].includes(v.public.status)
    || !Array.isArray(v.public.batches) || v.public.batches.length > 136 || !v.public.batches.every(isWinBatch)) return false
  if (!Array.isArray(v.public.seats) || v.public.seats.length !== 4 || !v.public.seats.every((s: any) => object(s)
    && only(s, ['winCount', 'locked', 'firstWinSequence', 'recordIds']) && int(s.winCount) && s.winCount >= 0
    && typeof s.locked === 'boolean' && (s.firstWinSequence === null || int(s.firstWinSequence)) && Array.isArray(s.recordIds) && s.recordIds.every(text))) return false
  const settled = v.public.status === 'settled'
  if (settled !== (v.public.roundResult !== null)) return false
  if (settled) {
    const r = v.public.roundResult
    if (!object(r) || !only(r, ['ruleVersion', 'roundId', 'reason', 'openingScores', 'endingScores', 'winNet', 'kongNet', 'winCounts', 'ranks', 'ledger'])
      || r.roundId !== v.roundId || r.ruleVersion !== BLOOD_FLOW_CONFIG.version || r.reason !== 'wall-exhausted'
      || !['openingScores', 'endingScores', 'winNet', 'kongNet', 'winCounts', 'ranks'].every(k => vector(r[k])) || !Array.isArray(r.ledger)
      || !zeroSum(r.winNet) || !zeroSum(r.kongNet)
      || r.openingScores.some((n: number, s: number) => n + r.winNet[s] + r.kongNet[s] !== r.endingScores[s])) return false
    for (const entry of r.ledger) {
      if (!object(entry)) return false
      if (entry.kind === 'win') { if (!only(entry, ['kind', 'batch']) || !isWinBatch(entry.batch)) return false }
      else if (entry.kind !== 'kong' || !only(entry, ['kind', 'authorityEpoch', 'roundId', 'sequence', 'id', 'actor', 'kongKind', 'sourceSeat', 'deltas', 'scoresAfter'])
        || !text(entry.id) || !text(entry.authorityEpoch) || entry.roundId !== v.roundId || !int(entry.sequence) || !seat(entry.actor)
        || !['discard', 'added', 'concealed', 'wind'].includes(entry.kongKind) || !(entry.sourceSeat === null || seat(entry.sourceSeat))
        || !zeroSum(entry.deltas) || !vector(entry.scoresAfter)) return false
    }
  }
  if (!v.players.every((p: any, s: number) => object(p) && only(p, ['name', 'avatar', 'isLlm', 'characterId', 'playerKind', 'score', 'seat', 'hand', 'concealedTileCount', 'discards', 'melds', 'redCount', 'drawnTileIndex'])
    && seat(p.seat) && p.seat === s && typeof p.name === 'string'
    && int(p.score) && tiles(p.hand, 14) && tiles(p.discards, 136) && int(p.concealedTileCount)
    && (settled || s === v.seat || p.hand.length === 0) && Array.isArray(p.melds)
    && p.melds.every((m: any) => object(m) && only(m, ['type', 'tile', 'tiles', 'from', 'added', 'pending', 'windKong'])
      && ['peng', 'gang', 'angang', 'chi'].includes(m.type) && !m.pending && tiles(m.tiles, 4) && TILE_TYPES.includes(m.tile)))) return false
  if (v.window !== null && (!object(v.window) || !only(v.window, ['id', 'version', 'kind', 'deadlineAt', 'opensAt', 'source']) || !text(v.window.id)
    || !int(v.window.version) || !Number.isFinite(v.window.opensAt) || !Number.isFinite(v.window.deadlineAt) || !['turn', 'win', 'meld'].includes(v.window.kind) || !isSource(v.window.source))) return false
  return Array.isArray(v.ownActions) && v.ownActions.every(isAction) && (v.ownScore === null || isPublicWinScore(v.ownScore))
    && Array.isArray(v.waitingSeats) && v.waitingSeats.every(seat) && Array.isArray(v.actionEvents)
    && v.actionEvents.every((a: any) => object(a) && only(a, ['id', 'type', 'actorIndex', 'sourceIndex', 'tile', 'meldIndex'])
      && int(a.id) && seat(a.actorIndex) && (a.sourceIndex === null || seat(a.sourceIndex)) && int(a.meldIndex) && TILE_TYPES.includes(a.tile)
      && ['peng', 'chi', 'discard-gang', 'concealed-gang', 'added-gang', 'wind-kong', 'self-draw', 'discard-win', 'robbed-kong-win'].includes(a.type))
    && (v.lastDiscardAction === null || isSource(v.lastDiscardAction))
}

function isAction(v: unknown) {
  if (!object(v)) return false
  if (['win', 'pass', 'wind-kong', 'peng', 'gang'].includes(v.kind)) return only(v, ['kind'])
  if (v.kind === 'discard') return only(v, ['kind', 'index']) && int(v.index) && v.index >= 0 && v.index < 14
  if (v.kind === 'added-kong') return only(v, ['kind', 'meldIndex']) && int(v.meldIndex) && v.meldIndex >= 0 && v.meldIndex < 4
  if (v.kind === 'concealed-kong') return only(v, ['kind', 'tile']) && TILE_TYPES.includes(v.tile)
  return v.kind === 'chi' && only(v, ['kind', 'tiles']) && tiles(v.tiles, 3) && v.tiles.length === 3
}

export function decodeBloodFlowPacket(value: unknown): BloodFlowPacket | null {
  if (!object(value) || !text(value.roomId) || typeof value.ruleVersion !== 'string') return null
  if (value.kind === 'blood_flow_hello' || value.kind === 'blood_flow_sync') return value as BloodFlowPacket
  if (value.kind === 'blood_flow_error' && ['INCOMPATIBLE_RULE_VERSION', 'INTERRUPTED'].includes(value.code)) return value as BloodFlowPacket
  if (value.ruleVersion !== BLOOD_FLOW_CONFIG.version) return null
  if (value.kind === 'blood_flow_auto') return text(value.authorityEpoch) && typeof value.enabled === 'boolean' ? value as BloodFlowPacket : null
  if (value.kind === 'blood_flow_reaction') {
    const r = value.reaction
    return object(r) && only(r, ['id', 'authorityEpoch', 'roundId', 'seat', 'text', 'voiceKey', 'style', 'theme'])
      && text(r.id) && text(r.authorityEpoch) && text(r.roundId) && seat(r.seat) && typeof r.text === 'string' && r.text.length > 0 && r.text.length <= 40
      && LLM_TTS_VOICE_OPTIONS.some(v => v.value !== 'auto' && v.value === r.voiceKey)
      && ['激进', '稳健', '话痨', '高冷'].includes(r.style) && ['llm', 'llmAnime'].includes(r.theme) ? value as BloodFlowPacket : null
  }
  if (value.kind === 'blood_flow_command') {
    const c = value.command
    return object(c) && only(c, ['authorityEpoch', 'roundId', 'windowId', 'stateVersion', 'seat', 'action'])
      && text(c.authorityEpoch) && text(c.roundId) && text(c.windowId) && int(c.stateVersion) && seat(c.seat) && isAction(c.action) ? value as BloodFlowPacket : null
  }
  if (value.kind === 'blood_flow_continue' || value.kind === 'blood_flow_opening_done') return text(value.authorityEpoch) && int(value.round) ? value as BloodFlowPacket : null
  if (!text(value.authorityEpoch) || !int(value.sequence) || value.sequence < 1 || !int(value.round) || value.round < 1 || value.round > 8) return null
  if (value.kind === 'win_batch') return isWinBatch(value.batch) && value.batch.authorityEpoch === value.authorityEpoch ? value as BloodFlowPacket : null
  if (value.kind === 'blood_flow_snapshot' || value.kind === 'round_settled') {
    if (value.continuation !== undefined && (!object(value.continuation) || !only(value.continuation,['readySeats','requiredSeats'])
      || !['readySeats','requiredSeats'].every(k=>Array.isArray(value.continuation[k])&&value.continuation[k].length<=4
        &&value.continuation[k].every(seat)&&new Set(value.continuation[k]).size===value.continuation[k].length)
      || !value.continuation.readySeats.every((s:Seat)=>value.continuation.requiredSeats.includes(s)))) return null
    if (value.autoPlay !== undefined && typeof value.autoPlay !== 'boolean') return null
    if (value.opening !== undefined && (!object(value.opening) || !['firstDice', 'secondDice'].every(k => Array.isArray(value.opening[k])
      && value.opening[k].length === 2 && value.opening[k].every((n: unknown) => int(n) && Number(n) >= 1 && Number(n) <= 6)))) return null
    return ['east', 'hanchan'].includes(value.mode) && seat(value.dealer) && isSeatView(value.view)
      && value.view.authorityEpoch === value.authorityEpoch ? value as BloodFlowPacket : null
  }
  return null
}
