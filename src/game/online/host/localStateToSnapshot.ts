// 房主权威快照序列化：把本地引擎状态（LocalGameState / LotusGameState）映射成
// ServerSnapshot（P2P 广播用）。房主本地下标即绝对座位（localOpening 里 seat=index），
// 因此座位字段无需旋转；只对「非目标座位」的暗牌做脱敏（置 null，长度不变）。
import type {
  Announcement,
  GamePhase,
  LastDiscard,
  RefLike,
  RoundResult,
} from '../../core/contracts/gamePort'
import type { GamePlayer, MatchType, TileType, WinPresentation } from '../../core/contracts/types'
import type { ServerMeldDto, ServerPlayerDto, ServerSnapshot } from '../protocol/dto'
import type { RuleVariant } from '../../core/rules/ruleVariants'

/** 快照数据源：本地引擎状态的最小公共形状（广麻/莲花引擎都满足）。 */
export interface SnapshotSource {
  phase: RefLike<GamePhase>
  players: GamePlayer[]
  wall: RefLike<TileType[]>
  wallHeadDrawn: RefLike<number>
  currentPlayer: RefLike<number>
  lastDiscard: RefLike<LastDiscard | null>
  result: RefLike<RoundResult | null>
  announcement: RefLike<Announcement | null>
  winPresentation: RefLike<WinPresentation | null>
  winningPlayerIndex: RefLike<number>
  round: RefLike<number>
  dealer: RefLike<number>
  honba: RefLike<number>
  matchType: RefLike<MatchType>
  matchFinished: RefLike<boolean>
  diceValues: RefLike<number[]>
  /** 结算亮牌：为 true 时不再对非目标座位脱敏，让客户端/房主 viewer 都能看到各家手牌。 */
  revealHands?: RefLike<boolean>
  // 莲花麻将（lotus-legacy）专属字段；广麻引擎无这些字段。
  firstDice?: RefLike<[number, number] | null>
  secondDice?: RefLike<[number, number] | null>
  flipSeat?: RefLike<number | null>
  flipTile?: RefLike<TileType | null>
  jokerTiles?: RefLike<TileType[]>
  wildcardTiles?: RefLike<TileType[]>
  flipStack?: RefLike<number | null>
  wallBreakIndex?: RefLike<number>
}

export interface SnapshotContext {
  roomId: string
  rulesetId: RuleVariant
  /** 生产快照必须绑定当前房主引擎生命周期；缺失时序列化直接失败。 */
  authorityEpoch: string
  sequence?: number
  requestId?: string | null
  requestSeq?: number | null
  /** Only the local authority viewer needs the exact remaining wall order. */
  includeWall?: boolean
}

function toServerPlayer(player: GamePlayer, visible: boolean): ServerPlayerDto {
  return {
    name: player.name,
    avatar: player.avatar,
    isLlm: player.isLlm === true,
    characterId: player.characterId,
    score: player.score,
    seat: player.seat,
    discards: [...player.discards],
    redCount: player.redCount,
    drawnTileIndex: player.drawnTileIndex,
    // 暗牌脱敏：仅目标座位可见手牌；其余座位保留张数、置 null。
    hand: visible ? [...player.hand] : player.hand.map(() => null),
    melds: player.melds.map((meld) => ({ ...meld }) as ServerMeldDto),
  }
}

/** 结算公共事实专用：牌局已经结束，四家最终手牌全部公开且不含 null 占位。 */
export function serializeRevealedPlayers(players: GamePlayer[]): ServerPlayerDto[] {
  return players.map((player) => toServerPlayer(player, true))
}

export function serializeStateToSnapshot(
  source: SnapshotSource,
  targetSeat: number,
  context: SnapshotContext,
): ServerSnapshot {
  if (!context.authorityEpoch.trim()
    || !Number.isSafeInteger(context.sequence)
    || (context.sequence as number) < 1) {
    throw new Error('无法序列化无房主代次或序号的权威快照')
  }
  const dice = source.diceValues.value
  // 莲花麻将 diceValues 在第二次掷骰时被覆盖；一骰必须取 firstDice，否则客户端
  // 一骰阶段会显示成二骰（与单人模式不一致）。
  const firstDice = source.firstDice?.value
  const reveal = source.revealHands?.value ?? false
  return {
    kind: 'state_snapshot',
    roomId: context.roomId,
    authorityEpoch: context.authorityEpoch,
    sequence: context.sequence,
    requestId: context.requestId ?? null,
    requestSeq: context.requestSeq ?? null,
    mode: source.matchType.value,
    rulesetId: context.rulesetId,
    phase: source.phase.value,
    round: source.round.value,
    dealer: source.dealer.value,
    honba: source.honba.value,
    dice: firstDice ?? [dice[0] ?? 1, dice[1] ?? 1] as [number, number],
    secondDice: source.secondDice?.value ?? undefined,
    flipTile: source.flipTile?.value ?? null,
    jokerTiles: source.jokerTiles?.value ?? [],
    wildcardTiles: source.wildcardTiles?.value ?? [],
    flipStack: source.flipStack?.value ?? null,
    // 本地引擎不追踪 openingStack（远端表现层字段），发 null 以满足 decoder 的 isNullable 校验。
    openingStack: null,
    wallBreakIndex: source.wallBreakIndex?.value ?? 0,
    wallCount: source.wall.value.length,
    ...(context.includeWall === false ? {} : { wall: [...source.wall.value] }),
    headDrawn: source.wallHeadDrawn.value,
    currentPlayer: source.currentPlayer.value,
    players: source.players.map((player, seat) => toServerPlayer(player, seat === targetSeat || reveal)),
    seat: targetSeat,
    result: source.result.value,
    announcement: source.announcement.value,
    matchFinished: source.matchFinished.value,
    lastDiscard: source.lastDiscard.value,
    winPresentation: source.winPresentation.value,
    winningPlayerIndex: source.winningPlayerIndex.value,
  }
}
