import type { GamePhase, RoundResult } from '../../core/contracts/gamePort'
import type { Meld, TileType, WinPresentation } from '../../core/contracts/types'
import type { ServerPlayerDto } from './dto'
import type { ServerMessage } from './messages'

type JsonObject = Record<string, unknown>

const GAME_PHASES = new Set<GamePhase>([
  'lobby', 'dealing', 'opening', 'playing', 'drawing', 'thinking', 'checking',
  'discard', 'prompt', 'kong', 'win-effect', 'revealing', 'settled', 'finished',
])
const MATCH_TYPES = new Set(['east', 'hanchan'])
const HONORS = new Set(['east', 'south', 'west', 'north', 'red', 'green', 'white'])
const MELD_TYPES = new Set(['peng', 'gang', 'angang', 'flower'])
const TABLE_ACTION_TYPES = new Set([
  'peng', 'discard-gang', 'concealed-gang', 'added-gang', 'flower-gang',
  'self-draw', 'robbed-kong-win',
])

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
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

function isArrayOf<T>(value: unknown, guard: (candidate: unknown) => candidate is T): value is T[] {
  return Array.isArray(value) && value.every(guard)
}

function isTile(value: unknown): value is TileType {
  return typeof value === 'string'
    && (HONORS.has(value) || /^[mps][1-9]$/.test(value))
}

function isMeld(value: unknown): value is Meld {
  if (!isObject(value)) return false
  return isString(value.type) && MELD_TYPES.has(value.type)
    && isTile(value.tile)
    && isArrayOf(value.tiles, isTile)
    && isOptional(value.from, isNumber)
    && isOptional(value.added, isBoolean)
    && isOptional(value.pending, isBoolean)
}

function isPlayer(value: unknown): value is ServerPlayerDto {
  if (!isObject(value)) return false
  return isString(value.name) && isString(value.avatar)
    && isNumber(value.score) && isNumber(value.seat)
    // 服务端会用 null 遮蔽其他玩家的暗牌；mapper 在进入核心状态时继续按牌背处理。
    && Array.isArray(value.hand) && value.hand.every((tile) => tile === null || isTile(tile))
    && isArrayOf(value.discards, isTile)
    && isArrayOf(value.melds, isMeld)
    && isNumber(value.redCount) && isNumber(value.drawnTileIndex)
}

function isRoundResult(value: unknown): value is RoundResult {
  if (!isObject(value)) return false
  return isOptional(value.draw, isBoolean)
    && isOptional(value.winnerIndex, isNumber)
    && isOptional(value.winner, isString)
    && isOptional(value.roundLabel, isString)
    && isOptional(value.honba, isNumber)
    && isOptional(value.horses, (item): item is TileType[] => isArrayOf(item, isTile))
    && isOptional(value.hits, isNumber)
    && isOptional(value.multiplier, isNumber)
    && isOptional(value.totalMultiplier, isNumber)
    && isOptional(value.horsePoints, isNumber)
    && isOptional(value.points, isNumber)
    && isOptional(value.totalWon, isNumber)
    && isOptional(value.tenpai, (item): item is number[] => isArrayOf(item, isNumber))
    && isOptional(value.dealerTenpai, isBoolean)
    && isOptional(value.fourRed, isBoolean)
    && isOptional(value.kongBloom, isBoolean)
    && isOptional(value.robbedKong, isBoolean)
    && isOptional(value.robbedKongPlayerIndex, isNumber)
    && isOptional(value.winTile, isTile)
    && isOptional(value.details, (items): items is JsonObject[] => isArrayOf(items, (item): item is JsonObject => (
      isObject(item) && isString(item.label)
      && isOptional(item.multiplier, isNumber) && isOptional(item.points, isNumber)
    )))
    && isOptional(value.scoreChanges, (items): items is JsonObject[] => isArrayOf(items, (item): item is JsonObject => (
      isObject(item) && isNumber(item.playerIndex) && isString(item.name)
      && isString(item.avatar) && isNumber(item.score) && isNumber(item.delta)
      && isOptional(item.rank, isNumber) && isOptional(item.fallbackAvatar, isString)
    )))
}

function isAnnouncement(value: unknown): value is JsonObject {
  return isObject(value) && isString(value.text) && isString(value.tone) && isNumber(value.id)
}

function isLastDiscard(value: unknown): value is JsonObject {
  return isObject(value) && isTile(value.tile) && isNumber(value.from) && isNumber(value.id)
}

function isWinPresentation(value: unknown): value is WinPresentation {
  return isObject(value)
    && isNumber(value.winnerIndex) && isTile(value.tile) && isNumber(value.sourceIndex)
    && isBoolean(value.robbedKong) && isNumber(value.robbedKongPlayerIndex)
    && isNumber(value.robbedKongMeldIndex)
}

function isDice(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length === 2 && value.every(isNumber)
}

function isSnapshot(message: JsonObject): boolean {
  return isString(message.roomId)
    && isString(message.mode) && MATCH_TYPES.has(message.mode)
    && isString(message.phase) && GAME_PHASES.has(message.phase as GamePhase)
    && isNumber(message.round) && isNumber(message.dealer) && isNumber(message.honba)
    && isOptional(message.dice, isDice)
    && isNumber(message.wallCount) && isArrayOf(message.wall, isTile)
    && isNumber(message.headDrawn) && isNumber(message.currentPlayer)
    && isArrayOf(message.players, isPlayer) && isNumber(message.seat)
    && isNullable(message.result, isRoundResult)
    && isNullable(message.announcement, isAnnouncement)
    && isBoolean(message.matchFinished)
    && isNullable(message.lastDiscard, isLastDiscard)
    && isNullable(message.winPresentation, isWinPresentation)
    && isNumber(message.winningPlayerIndex)
}

export function decodeServerMessage(raw: unknown): ServerMessage | null {
  if (!isObject(raw) || !isString(raw.kind)) return null
  const valid = (() => {
    switch (raw.kind) {
      case 'state_snapshot': return isSnapshot(raw)
      case 'round_start':
        return isBoolean(raw.matchStarted) && isNumber(raw.round) && isNumber(raw.dealer)
          && isNumber(raw.honba) && isDice(raw.dice)
      case 'rejoin_ok':
        return isNumber(raw.seat) && isBoolean(raw.rejoin) && isString(raw.roomId)
          && isString(raw.mode) && MATCH_TYPES.has(raw.mode)
          && isString(raw.nickname) && isString(raw.rejoinCode)
      case 'rejoin_err':
      case 'error': return isString(raw.code)
      case 'turn_request':
        return isObject(raw.ctx) && isArrayOf(raw.ctx.hand, isTile)
          && isArrayOf(raw.ctx.melds, isMeld) && isNumber(raw.ctx.exposedMelds)
          && isBoolean(raw.ctx.kongBloom) && isBoolean(raw.ctx.skipDraw)
          && isBoolean(raw.ctx.afterKong)
      case 'claim_request':
        return isObject(raw.ctx) && isArrayOf(raw.ctx.hand, isTile)
          && isBoolean(raw.ctx.canGang) && isTile(raw.ctx.tile) && isNumber(raw.ctx.from)
      case 'rob_kong_request':
        return isObject(raw.ctx) && isTile(raw.ctx.tile) && isNumber(raw.ctx.from)
          && isArrayOf(raw.ctx.hand, isTile) && isNumber(raw.ctx.exposedMelds)
      case 'table_action':
        return isObject(raw.event) && isNumber(raw.event.id)
          && isString(raw.event.type) && TABLE_ACTION_TYPES.has(raw.event.type)
          && isNumber(raw.event.actorIndex) && isNullable(raw.event.sourceIndex, isNumber)
          && isTile(raw.event.tile) && isNumber(raw.event.meldIndex)
      case 'score_flow':
        return isArrayOf(raw.deltas, (item): item is JsonObject => (
          isObject(item) && isNumber(item.playerIndex) && isNumber(item.amount)
        ))
      case 'announcement':
        return isString(raw.text) && isString(raw.tone) && isOptional(raw.id, isNumber)
      case 'hand_result': return isRoundResult(raw.result)
      case 'continue_prompt': return isNumber(raw.total)
      case 'match_finished':
        return isString(raw.roomId) && isString(raw.mode) && MATCH_TYPES.has(raw.mode)
          && isArrayOf(raw.finalScores, (item): item is JsonObject => (
            isObject(item) && isNumber(item.seat) && isString(item.name) && isNumber(item.score)
          ))
      case 'room_closed':
      case 'pong': return true
      default: return false
    }
  })()
  return valid ? raw as unknown as ServerMessage : null
}
