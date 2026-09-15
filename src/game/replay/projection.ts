// 回放投影：把「锚点 + 事件流」折叠成任意一帧，并映射为 3D 牌桌的只读属性。
//
// 折叠是纯覆盖（每步都带变化者的真实手牌/副露），不重跑规则引擎，因此不会与当时的对局漂移。
// 座位约定（与实时牌桌一致）：players 按本家在前排序、localSeat = 本家绝对座位，
// 其余座位索引类属性（currentPlayer / dealerIndex / lastDiscard.from / winnerIndex）都用本地索引。
import type { GamePlayer, Meld, TableActionEvent, TileType } from '../core/contracts/types'
import type { LastDiscard } from '../core/contracts/gamePort'
import type { TableProps } from '../../components/table/three/tableRenderTypes'
import { sortTilesWithJokers } from '../core/rules/tiles'
import type { ReplayMatch, ReplayRound, ReplayStep } from './types'

export interface ReplayFrame {
  /** 直接喂给 <MahjongTable3D>。 */
  table: TableProps
  /** 本家手牌：3D 牌桌不画本家手牌（presenter 对座位 0 直接返回），由 DOM 手牌架绘制。 */
  hand: TileType[]
  drawnTileIndex: number
  /** 帧序号：0 = 开局帧，1..n = 各动作，n+1 = 局末亮牌帧。 */
  index: number
  /** 巡目（1 起，每 4 次出牌一巡）。 */
  turn: number
  /** 本帧对应的动作；开局帧与局末帧为 null。 */
  step: ReplayStep | null
  actionType: TableActionEvent['type'] | null
  actorSeat: number | null
  /** 本家是否为本帧动作的发起者。 */
  actorIsLocal: boolean
  /** 局末亮牌帧。 */
  settled: boolean
  winnerIndex: number
  wallLeft: number
  currentPlayer: number
  scores: number[]
  roundLabel: string
}

export interface ReplayFrameOptions {
  /** true = 全知视角（四家明牌）；false = 按当时所见（他家暗牌）。 */
  revealAll: boolean
}

const NEUTRAL_DEAL_ANIMATION = { playerIndex: -1, count: 0, serial: 0 }

function cloneMeld(meld: Meld): Meld {
  return { ...meld, tiles: [...meld.tiles] }
}

/** 点炮胡：赢家手牌不含和牌张，亮牌要把和牌张补回手牌末尾。 */
function completeWinningHand(round: ReplayRound, winnerSeat: number, winTile?: TileType): TileType[] {
  const hand = [...(round.final?.hands[winnerSeat] ?? [])]
  if (!winTile || hand.includes(winTile)) return hand
  const drawWin = round.final?.winType === 'discard' || round.final?.winType === 'robbed-kong'
  return drawWin ? [...hand, winTile] : hand
}

export function buildReplayFrames(
  match: ReplayMatch,
  round: ReplayRound,
  options: ReplayFrameOptions,
): ReplayFrame[] {
  const humanSeat = match.humanSeat
  const localOf = (seat: number) => ((seat - humanSeat) % 4 + 4) % 4
  const handOrder = [0, 1, 2, 3].map((index) => (humanSeat + index) % 4)

  const hands = round.anchor.hands.map((hand) => [...hand])
  const melds = round.anchor.melds.map((list) => list.map(cloneMeld))
  const discards = round.anchor.discards.map((list) => [...list])
  const drawn = [...round.anchor.drawnTileIndex]
  const redCount = [...round.anchor.redCount]
  let scores = [...round.anchor.scores]
  let wallLeft = round.anchor.wallLeft
  let headDrawn = round.anchor.headDrawn
  let currentPlayer = round.anchor.currentPlayer
  let lastDiscard: LastDiscard | null = null
  let discardCount = 0

  const frames: ReplayFrame[] = []

  const push = (input: {
    index: number
    turn: number
    step: ReplayStep | null
    settled?: boolean
    winnerIndex?: number
    horses?: TileType[]
    finalHands?: TileType[][]
    finalMelds?: Meld[][]
    finalDiscards?: TileType[][]
    finalDrawn?: number[]
    finalScores?: number[]
    winningTile?: TileType
    winPresentation?: TableProps['winPresentation']
  }) => {
    const frameHands = input.finalHands ?? hands
    const frameMelds = input.finalMelds ?? melds
    const frameDiscards = input.finalDiscards ?? discards
    const frameDrawn = input.finalDrawn ?? drawn
    const frameScores = input.finalScores ?? scores
    const revealHands = options.revealAll || Boolean(input.settled)
    const step = input.step
    const actorSeat = step ? step.seat : null
    const actionEvent: TableActionEvent | null = step?.actionType
      ? {
        id: input.index + 1,
        type: step.actionType,
        actorIndex: localOf(step.seat),
        sourceIndex: step.from == null ? null : localOf(step.from),
        tile: step.tile ?? 'east',
        meldIndex: step.meldIndex ?? -1,
      }
      : null

    const players: GamePlayer[] = handOrder.map((seat) => ({
      name: match.players[seat]?.name ?? `座位${seat + 1}`,
      avatar: match.players[seat]?.avatar ?? '',
      characterId: match.players[seat]?.characterId,
      playerKind: match.players[seat]?.playerKind,
      isLlm: match.players[seat]?.isLlm,
      score: frameScores[seat] ?? 0,
      seat,
      hand: [...frameHands[seat]],
      concealedTileCount: frameHands[seat].length,
      discards: [...frameDiscards[seat]],
      melds: frameMelds[seat].map(cloneMeld),
      redCount: redCount[seat] ?? 0,
      drawnTileIndex: frameDrawn[seat] ?? -1,
    }))

    const localHand = [...frameHands[humanSeat]]
    frames.push({
      table: {
        themeName: match.themeName,
        players,
        localSeat: humanSeat,
        currentPlayer: currentPlayer < 0 ? -1 : localOf(currentPlayer),
        lastDiscard: lastDiscard && {
          tile: lastDiscard.tile,
          from: localOf(lastDiscard.from),
          id: lastDiscard.id,
        },
        wall: Array.from({ length: Math.max(0, wallLeft) }, () => 'east' as TileType),
        wallHeadDrawn: headDrawn,
        wallCount: wallLeft,
        horses: input.horses ?? [],
        jokerTiles: [...round.jokerTiles],
        wildcardTiles: [...round.wildcardTiles],
        revealHands,
        winnerIndex: input.winnerIndex ?? -1,
        winEffect: null,
        winPresentation: input.winPresentation ?? null,
        dealAnimation: NEUTRAL_DEAL_ANIMATION,
        openingStage: null,
        diceValues: [...(round.dice.second ?? round.dice.first ?? [1, 1])],
        dealerIndex: localOf(round.dealer),
        diceThrowerIndex: localOf(round.diceThrowerIndex),
        tableActionEvent: actionEvent,
        wallBreakIndex: round.wallBreakIndex,
        flipTile: round.flipTile,
        flipStack: round.flipStack ?? undefined,
      },
      hand: options.revealAll ? sortTilesWithJokers(localHand, round.jokerTiles) : localHand,
      drawnTileIndex: frameDrawn[humanSeat] ?? -1,
      index: input.index,
      turn: input.turn,
      step,
      actionType: step?.actionType ?? null,
      actorSeat,
      actorIsLocal: actorSeat !== null && localOf(actorSeat) === 0,
      settled: Boolean(input.settled),
      winnerIndex: input.winnerIndex != null && input.winnerIndex >= 0 ? localOf(input.winnerIndex) : -1,
      wallLeft,
      currentPlayer: currentPlayer < 0 ? -1 : localOf(currentPlayer),
      scores: [...frameScores],
      roundLabel: round.roundLabel,
    })
  }

  // 开局帧（发牌完成、尚未行动）。
  push({ index: 0, turn: 1, step: null })

  round.steps.forEach((step, stepIndex) => {
    if (step.state) {
      hands[step.seat] = [...step.state.hand]
      melds[step.seat] = step.state.melds.map(cloneMeld)
      drawn[step.seat] = step.state.drawnTileIndex
      redCount[step.seat] = step.state.redCount
      if (step.state.discards) discards[step.seat] = [...step.state.discards]
    }
    if (step.t === 'meld' && step.from != null && step.sourceDiscards) {
      discards[step.from] = [...step.sourceDiscards]
    }
    if (step.t === 'discard' && step.tile) {
      if (!step.state?.discards) discards[step.seat] = [...discards[step.seat], step.tile]
      lastDiscard = { tile: step.tile, from: step.seat, id: step.lastDiscardId ?? stepIndex + 1 }
    } else if (step.t === 'meld' && step.from != null) {
      // 被碰/吃/杠的弃牌已离开牌河，旧的「最近弃牌」高亮必须失效。
      lastDiscard = null
    }
    if (step.scores) scores = [...step.scores]
    wallLeft = step.wallLeft
    headDrawn = step.headDrawn
    currentPlayer = step.currentPlayer

    const turn = Math.floor(discardCount / 4) + 1
    if (step.t === 'discard') discardCount += 1
    push({ index: stepIndex + 1, turn, step })
  })

  // 局末亮牌帧。
  const final = round.final
  if (final) {
    const winnerSeat = final.draw || final.winSeat == null ? -1 : final.winSeat
    const finalHands = final.hands.map((hand) => [...hand])
    if (winnerSeat >= 0) finalHands[winnerSeat] = completeWinningHand(round, winnerSeat, final.winTile)
    push({
      index: round.steps.length + 1,
      turn: Math.floor(discardCount / 4) + 1,
      step: null,
      settled: true,
      winnerIndex: winnerSeat,
      horses: final.horses,
      finalHands,
      finalMelds: final.melds.map((list) => list.map(cloneMeld)),
      finalDiscards: final.discards.map((list) => [...list]),
      finalDrawn: final.drawnTileIndex.map(() => -1),
      finalScores: final.scores,
      winningTile: final.winTile,
      winPresentation: winnerSeat >= 0 && final.winTile
        ? {
          winnerIndex: localOf(winnerSeat),
          tile: final.winTile,
          sourceIndex: Math.max(0, finalHands[winnerSeat].lastIndexOf(final.winTile)),
          robbedKong: final.winType === 'robbed-kong',
          discardWin: final.winType === 'discard',
          robbedKongPlayerIndex: final.result?.robbedKongPlayerIndex ?? -1,
          robbedKongMeldIndex: -1,
        }
        : null,
    })
  }

  return frames
}
