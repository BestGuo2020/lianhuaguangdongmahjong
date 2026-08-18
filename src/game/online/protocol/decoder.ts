import type { GamePhase, RoundResult } from '../../core/contracts/gamePort'
import type { TileType, WinPresentation } from '../../core/contracts/types'
import type { ServerMeldDto, ServerPlayerDto } from './dto'
import type { ServerMessage } from './messages'

type JsonObject = Record<string, unknown>

const GAME_PHASES = new Set<GamePhase>([
  'lobby', 'dealing', 'opening', 'playing', 'drawing', 'thinking', 'checking',
  'discard', 'prompt', 'kong', 'win-effect', 'revealing', 'settled', 'finished',
])
const MATCH_TYPES = new Set(['east', 'hanchan'])
const HONORS = new Set(['east', 'south', 'west', 'north', 'red', 'green', 'white'])
const MELD_TYPES = new Set(['peng', 'gang', 'angang', 'flower', 'chi'])
const TABLE_ACTION_TYPES = new Set([
  'peng', 'chi', 'discard-gang', 'concealed-gang', 'added-gang', 'flower-gang',
  'wind-kong', 'self-draw', 'discard-win', 'robbed-kong-win',
])
const SEAT_MIN = 0
const SEAT_MAX = 3

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isPositiveInteger(value: unknown): value is number {
  return isNumber(value) && Number.isInteger(value) && value >= 1
}

function isIntegerAtLeast(value: unknown, min: number): value is number {
  return isNumber(value) && Number.isInteger(value) && value >= min
}

function isIntegerBetween(value: unknown, min: number, max: number): value is number {
  return isNumber(value) && Number.isInteger(value) && value >= min && value <= max
}

function isSeat(value: unknown): value is number {
  return isIntegerBetween(value, SEAT_MIN, SEAT_MAX)
}

function isMaybeSeat(value: unknown): value is number | null {
  return value === null || isSeat(value)
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean'
}

function isNullable<T>(value: unknown, guard: (candidate: unknown) => candidate is T): value is T | null {
  return value === null || guard(value)
}

function isOptional<T>(value: unknown, guard: (candidate: unknown) => candidate is T): boolean {
  return value === undefined || guard(value)
}

function isSnapshotAuthorityMeta(message: JsonObject): boolean {
  return isString(message.authorityEpoch)
    && isPositiveInteger(message.sequence)
    && (message.requestId === null) === (message.requestSeq === null)
    && (message.requestId === null || (isString(message.requestId) && isPositiveInteger(message.requestSeq)))
}

function isRequestAuthorityMeta(message: JsonObject): boolean {
  return isString(message.authorityEpoch)
    && isPositiveInteger(message.round)
    && isString(message.requestId)
    && isPositiveInteger(message.requestSeq)
    && isSeat(message.targetSeat)
}

function isArrayOf<T>(value: unknown, guard: (candidate: unknown) => candidate is T): value is T[] {
  return Array.isArray(value) && value.every(guard)
}

function isTile(value: unknown): value is TileType {
  return typeof value === 'string'
    && (HONORS.has(value) || /^[mps][1-9]$/.test(value))
}

function isMeld(value: unknown): value is ServerMeldDto {
  if (!isObject(value)) return false
  return isString(value.type) && MELD_TYPES.has(value.type)
    && isTile(value.tile)
    && isArrayOf(value.tiles, isTile)
    && isOptional(value.from, isMaybeSeat)
    && isOptional(value.added, (candidate): candidate is boolean | null => isNullable(candidate, isBoolean))
    && isOptional(value.pending, (candidate): candidate is boolean | null => isNullable(candidate, isBoolean))
    && isOptional(value.windKong, (candidate): candidate is boolean | null => isNullable(candidate, isBoolean))
}

function isPlayer(value: unknown): value is ServerPlayerDto {
  if (!isObject(value)) return false
  return isString(value.name) && isString(value.avatar)
    && isNumber(value.score) && isSeat(value.seat)
    // 服务端会用 null 遮蔽其他玩家的暗牌；mapper 在进入核心状态时继续按牌背处理。
    && Array.isArray(value.hand) && value.hand.every((tile) => tile === null || isTile(tile))
    && isArrayOf(value.discards, isTile)
    && isArrayOf(value.melds, isMeld)
    && isIntegerAtLeast(value.redCount, 0) && isIntegerAtLeast(value.drawnTileIndex, -1)
}

function isRoundResult(value: unknown): value is RoundResult {
  if (!isObject(value)) return false
  return isOptional(value.draw, isBoolean)
    && isOptional(value.winnerIndex, (candidate) => isSeat(candidate))
    && isOptional(value.winner, isString)
    && isOptional(value.roundLabel, isString)
    && isOptional(value.honba, (candidate) => isIntegerAtLeast(candidate, 0))
    && isOptional(value.horses, (item): item is TileType[] => isArrayOf(item, isTile))
    && isOptional(value.hits, isNumber)
    && isOptional(value.multiplier, isNumber)
    && isOptional(value.totalMultiplier, isNumber)
    && isOptional(value.horsePoints, isNumber)
    && isOptional(value.points, isNumber)
    && isOptional(value.totalWon, isNumber)
    && isOptional(value.tenpai, (item): item is number[] => isArrayOf(item, isSeat))
    && isOptional(value.dealerTenpai, isBoolean)
    && isOptional(value.fourRed, isBoolean)
    && isOptional(value.kongBloom, isBoolean)
    && isOptional(value.robbedKong, isBoolean)
    && isOptional(value.robbedKongPlayerIndex, (candidate) => isIntegerBetween(candidate, -1, SEAT_MAX))
    && isOptional(value.winTile, isTile)
    && isOptional(value.details, (items): items is JsonObject[] => isArrayOf(items, (item): item is JsonObject => (
      isObject(item) && isString(item.label)
      && isOptional(item.multiplier, isNumber) && isOptional(item.points, isNumber)
    )))
    && isOptional(value.scoreChanges, (items): items is JsonObject[] => isArrayOf(items, (item): item is JsonObject => (
      isObject(item) && isSeat(item.playerIndex) && isString(item.name)
      && isString(item.avatar) && isNumber(item.score) && isNumber(item.delta)
      && isOptional(item.rank, (candidate) => isIntegerAtLeast(candidate, 1)) && isOptional(item.fallbackAvatar, isString)
    )))
}

function isAnnouncement(value: unknown): value is JsonObject {
  return isObject(value) && isString(value.text) && isString(value.tone) && isPositiveInteger(value.id)
}

function isLastDiscard(value: unknown): value is JsonObject {
  return isObject(value) && isTile(value.tile) && isSeat(value.from) && isPositiveInteger(value.id)
}

function isWinPresentation(value: unknown): value is WinPresentation {
  return isObject(value)
    && isSeat(value.winnerIndex) && isTile(value.tile) && isIntegerBetween(value.sourceIndex, -1, SEAT_MAX)
    && isBoolean(value.robbedKong) && isIntegerBetween(value.robbedKongPlayerIndex, -1, SEAT_MAX)
    && isIntegerAtLeast(value.robbedKongMeldIndex, -1)
}

function isDice(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length === 2 && value.every((item) => isIntegerBetween(item, 1, 6))
}

function isSnapshot(message: JsonObject): boolean {
  return isString(message.roomId)
    && isSnapshotAuthorityMeta(message)
    && isString(message.mode) && MATCH_TYPES.has(message.mode)
    && isOptional(message.rulesetId, (value) => value === 'lotus-classic' || value === 'lotus-legacy')
    && isString(message.phase) && GAME_PHASES.has(message.phase as GamePhase)
    && isPositiveInteger(message.round) && isSeat(message.dealer) && isIntegerAtLeast(message.honba, 0)
    && isOptional(message.dice, isDice)
    && isOptional(message.secondDice, isDice)
    // lotus-classic（莲花广麻，默认规则）无翻精：后端这三个字段发送 null 而非省略，
    // 故用 isNullable（接受 null）而非 isOptional（仅接受 undefined），否则整条快照解码失败。
    && isNullable(message.flipTile, isTile)
    && isOptional(message.jokerTiles, (value): value is TileType[] => isArrayOf(value, isTile))
    && isOptional(message.wildcardTiles, (value): value is TileType[] => isArrayOf(value, isTile))
    && isNullable(message.flipStack, (value) => isIntegerAtLeast(value, 0))
    && isNullable(message.openingStack, (value) => isIntegerAtLeast(value, 0))
    && isOptional(message.wallBreakIndex, (value) => isIntegerAtLeast(value, 0))
     && isIntegerAtLeast(message.wallCount, 0) && isOptional(message.wall, (value): value is TileType[] => isArrayOf(value, isTile))
    && isIntegerAtLeast(message.headDrawn, 0) && isIntegerBetween(message.currentPlayer, -1, SEAT_MAX)
    && isArrayOf(message.players, isPlayer) && isSeat(message.seat)
    && isNullable(message.result, isRoundResult)
    && isNullable(message.announcement, isAnnouncement)
    && isBoolean(message.matchFinished)
    && ((message.phase === 'finished') === message.matchFinished)
    && isNullable(message.lastDiscard, isLastDiscard)
    && isNullable(message.winPresentation, isWinPresentation)
    && isIntegerBetween(message.winningPlayerIndex, -1, SEAT_MAX)
}

export function decodeServerMessage(raw: unknown): ServerMessage | null {
  if (!isObject(raw) || !isString(raw.kind)) return null
  const valid = (() => {
    switch (raw.kind) {
      case 'state_snapshot': return isSnapshot(raw)
      case 'round_start':
        return isString(raw.roomId)
          && isString(raw.authorityEpoch)
          && isPositiveInteger(raw.sequence)
          && isBoolean(raw.matchStarted) && isPositiveInteger(raw.round) && isSeat(raw.dealer)
          && isIntegerAtLeast(raw.honba, 0) && isDice(raw.dice)
          && isOptional(raw.secondDice, isDice)
          && isOptional(raw.flipTile, isTile)
          && isOptional(raw.flipStack, (value) => isIntegerAtLeast(value, 0))
          && isOptional(raw.flipSeat, isSeat)
      case 'rejoin_ok':
        return isSeat(raw.seat) && isBoolean(raw.rejoin) && isString(raw.roomId)
          && isString(raw.mode) && MATCH_TYPES.has(raw.mode)
          && isOptional(raw.rulesetId, (value) => value === 'lotus-classic' || value === 'lotus-legacy')
          && isString(raw.nickname) && isString(raw.rejoinCode)
          && isString(raw.authorityEpoch)
      case 'rejoin_err':
      case 'error': return isString(raw.code)
      case 'turn_request':
        return isRequestAuthorityMeta(raw)
          && isObject(raw.ctx) && isArrayOf(raw.ctx.hand, isTile)
          && isArrayOf(raw.ctx.melds, isMeld) && isIntegerAtLeast(raw.ctx.exposedMelds, 0)
          && isBoolean(raw.ctx.kongBloom) && isBoolean(raw.ctx.skipDraw)
          && isBoolean(raw.ctx.afterKong)
          && isOptional(raw.ctx.jokers, (item): item is TileType[] => isArrayOf(item, isTile))
          && isOptional(raw.ctx.canHu, isBoolean)
          && isOptional(raw.ctx.canWindKong, isBoolean)
      case 'claim_request':
        return isRequestAuthorityMeta(raw)
          && isObject(raw.ctx) && isArrayOf(raw.ctx.hand, isTile)
          && isOptional(raw.ctx.canPeng, isBoolean)
          && isOptional(raw.ctx.canHu, isBoolean)
          && isBoolean(raw.ctx.canGang) && isTile(raw.ctx.tile) && isSeat(raw.ctx.from)
          && isOptional(raw.ctx.chiOptions, (items): items is JsonObject[] => isArrayOf(items, (item): item is JsonObject => (
            isObject(item) && isArrayOf(item.tiles, isTile)
            && isString(item.kind) && ['sequence', 'wind', 'dragon'].includes(item.kind)
          )))
      case 'rob_kong_request':
        return isRequestAuthorityMeta(raw)
          && isObject(raw.ctx) && isTile(raw.ctx.tile) && isSeat(raw.ctx.from)
          && isArrayOf(raw.ctx.hand, isTile) && isIntegerAtLeast(raw.ctx.exposedMelds, 0)
      case 'table_action':
        return isString(raw.authorityEpoch) && isPositiveInteger(raw.round)
          && isObject(raw.event) && isPositiveInteger(raw.event.id)
          && isString(raw.event.type) && TABLE_ACTION_TYPES.has(raw.event.type)
          && isSeat(raw.event.actorIndex) && isNullable(raw.event.sourceIndex, isSeat)
          && isTile(raw.event.tile) && isIntegerBetween(raw.event.meldIndex, -1, 3)
      case 'score_flow':
        return isString(raw.authorityEpoch) && isPositiveInteger(raw.round)
          && isArrayOf(raw.deltas, (item): item is JsonObject => (
          isObject(item) && isSeat(item.playerIndex) && isNumber(item.amount)
        ))
      case 'announcement':
        return isString(raw.text) && isString(raw.tone) && isOptional(raw.id, isPositiveInteger)
          && isString(raw.authorityEpoch) && isPositiveInteger(raw.round)
      case 'hand_result':
        return isString(raw.authorityEpoch) && isPositiveInteger(raw.round)
          && isRoundResult(raw.result)
      case 'continue_prompt': return isIntegerAtLeast(raw.total, 0)
      case 'match_finished':
        return isString(raw.roomId) && isString(raw.mode) && MATCH_TYPES.has(raw.mode)
          && isString(raw.authorityEpoch)
          && isPositiveInteger(raw.sequence)
          && isPositiveInteger(raw.round)
          && isArrayOf(raw.finalScores, (item): item is JsonObject => (
            isObject(item) && isSeat(item.seat) && isString(item.name) && isNumber(item.score)
          ))
      case 'room_closed':
      case 'pong': return true
      default: return false
    }
  })()
  return valid ? raw as unknown as ServerMessage : null
}
