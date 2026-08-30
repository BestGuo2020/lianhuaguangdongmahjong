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

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isIntegerBetween(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
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

function isMeld(value: unknown): value is ServerMeldDto {
  if (!isObject(value)) return false
  return isString(value.type) && MELD_TYPES.has(value.type)
    && isTile(value.tile)
    && isArrayOf(value.tiles, isTile)
    && isOptional(value.from, (candidate): candidate is number | null => isNullable(candidate, isNumber))
    && isOptional(value.added, (candidate): candidate is boolean | null => isNullable(candidate, isBoolean))
    && isOptional(value.pending, (candidate): candidate is boolean | null => isNullable(candidate, isBoolean))
    && isOptional(value.windKong, (candidate): candidate is boolean | null => isNullable(candidate, isBoolean))
}

function isPlayer(value: unknown): value is ServerPlayerDto {
  if (!isObject(value)) return false
  return isString(value.name) && isString(value.avatar)
    && isOptional(value.isLlm, isBoolean)
    && isOptional(value.characterId, isString)
    && isOptional(value.playerKind, (candidate): candidate is 'human' | 'llm' | 'bot' => (
      candidate === 'human' || candidate === 'llm' || candidate === 'bot'
    ))
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
    && isNumber(value.winnerIndex) && isTile(value.tile)
    // sourceIndex 是赢家手牌内的索引（drawnTileIndex / hand.lastIndexOf(winTile)），
    // 不是座位：手牌最多 14+ 张，索引可到 13+。曾误限制在 [-1,3]，胡牌在手牌
    // 位置 >= 4 时整条快照解码失败，客户端永远进不了结算。
    && isIntegerBetween(value.sourceIndex, -1, 20)
    && isBoolean(value.robbedKong) && isNumber(value.robbedKongPlayerIndex)
    && isNumber(value.robbedKongMeldIndex)
}

function isDice(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length === 2 && value.every(isNumber)
}

function isSnapshot(message: JsonObject): boolean {
  return isString(message.roomId)
    && isString(message.mode) && MATCH_TYPES.has(message.mode)
    && isOptional(message.rulesetId, (value) => value === 'lotus-classic' || value === 'lotus-legacy')
    && isString(message.phase) && GAME_PHASES.has(message.phase as GamePhase)
    && isNumber(message.round) && isNumber(message.dealer) && isNumber(message.honba)
    && isOptional(message.dice, isDice)
    && isOptional(message.secondDice, isDice)
    // lotus-classic（莲花广麻，默认规则）无翻精：后端这三个字段发送 null 而非省略，
    // 故用 isNullable（接受 null）而非 isOptional（仅接受 undefined），否则整条快照解码失败。
    && isNullable(message.flipTile, isTile)
    && isOptional(message.jokerTiles, (value): value is TileType[] => isArrayOf(value, isTile))
    && isOptional(message.wildcardTiles, (value): value is TileType[] => isArrayOf(value, isTile))
    && isNullable(message.flipStack, isNumber)
    && isNullable(message.openingStack, isNumber)
    && isOptional(message.wallBreakIndex, isNumber)
     && isNumber(message.wallCount) && isOptional(message.wall, (value): value is TileType[] => isArrayOf(value, isTile))
    && isNumber(message.headDrawn) && isNumber(message.currentPlayer)
    && isArrayOf(message.players, isPlayer) && isNumber(message.seat)
    && isNullable(message.result, isRoundResult)
    && isNullable(message.announcement, isAnnouncement)
    && isBoolean(message.matchFinished)
    // 终局一致性：phase=finished 当且仅当 matchFinished=true（房主/后端同源发送）。
    && ((message.phase === 'finished') === message.matchFinished)
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
          && isOptional(raw.secondDice, isDice)
          && isOptional(raw.flipTile, isTile)
          && isOptional(raw.flipStack, isNumber)
          && isOptional(raw.flipSeat, isNumber)
      case 'rejoin_ok':
        return isNumber(raw.seat) && isBoolean(raw.rejoin) && isString(raw.roomId)
          && isString(raw.mode) && MATCH_TYPES.has(raw.mode)
          && isOptional(raw.rulesetId, (value) => value === 'lotus-classic' || value === 'lotus-legacy')
          && isString(raw.nickname) && isString(raw.rejoinCode)
      case 'rejoin_err':
      case 'error': return isString(raw.code)
      case 'turn_request':
        return isObject(raw.ctx) && isArrayOf(raw.ctx.hand, isTile)
          && isArrayOf(raw.ctx.melds, isMeld) && isNumber(raw.ctx.exposedMelds)
          && isBoolean(raw.ctx.kongBloom) && isBoolean(raw.ctx.skipDraw)
          && isBoolean(raw.ctx.afterKong)
          && isOptional(raw.ctx.jokers, (item): item is TileType[] => isArrayOf(item, isTile))
          && isOptional(raw.ctx.canHu, isBoolean)
          && isOptional(raw.ctx.canWindKong, isBoolean)
      case 'claim_request':
        return isObject(raw.ctx) && isArrayOf(raw.ctx.hand, isTile)
          && isOptional(raw.ctx.canPeng, isBoolean)
          && isOptional(raw.ctx.canHu, isBoolean)
          && isBoolean(raw.ctx.canGang) && isTile(raw.ctx.tile) && isNumber(raw.ctx.from)
          && isOptional(raw.ctx.chiOptions, (items): items is JsonObject[] => isArrayOf(items, (item): item is JsonObject => (
            isObject(item) && isArrayOf(item.tiles, isTile)
            && isString(item.kind) && ['sequence', 'wind', 'dragon'].includes(item.kind)
          )))
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
      case 'llm_message':
        return isIntegerBetween(raw.seat, 0, 3) && isString(raw.text)
          && raw.text.length > 0 && raw.text.length <= 60 && isNumber(raw.id)
          && isOptional(raw.priority, (value) => value === 'normal' || value === 'important')
      case 'llm_status':
        return isIntegerBetween(raw.seat, 0, 3) && isBoolean(raw.active)
          && isOptional(raw.text, (value): value is string => (
            isString(value) && value.length > 0 && value.length <= 60
          ))
      case 'llm_audio':
        return isNumber(raw.messageId) && isIntegerBetween(raw.seat, 0, 3)
          && isString(raw.audioUrl)
          && /^\/api\/tts\/audio\/[0-9a-f]{64}\.mp3$/.test(raw.audioUrl)
          && isBoolean(raw.cached)
          && isOptional(raw.priority, (value) => value === 'normal' || value === 'important')
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
