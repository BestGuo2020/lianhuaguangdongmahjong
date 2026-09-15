// 血流回放录制：把 worker 的「本地旁观视角」快照折成回放事件。
//
// 血流的权威引擎跑在 worker 里，客户端只拿得到视角快照，因此录制点与其他玩法不同：
// 每次状态更新请求一份旁观视角（四家明牌 + 累计弃牌流水），与上一份快照比对后按顺序补录事件。
// 引擎的弃牌流水与动作流水都是累计数组，采样再粗也不会漏事件（只影响单步粒度的观感）。
import type { MatchType, TileType } from '../core/contracts/types'
import type { RoundResult } from '../core/contracts/gamePort'
import type { BloodFlowSeatView } from '../variants/lotus/bloodFlow/seatView'
import { roundLabelFor } from './format'
import type { ReplayFrameSource, ReplayRecorderHooks } from './types'

export interface BloodFlowRecordContext {
  matchType: MatchType
  round: number
  dealer: number
  honba: number
  firstDice?: number[]
  secondDice?: number[]
  diceThrowerIndex: number
  wildcardTiles?: TileType[]
}

export interface BloodFlowRecordState {
  roundId: string
  /** 已录制的弃牌流水下标。 */
  discardCount: number
  /** 已录制的桌动作 id。 */
  actionId: number
  ended: boolean
  /** 已收尾的 roundId（幂等：旁观视角与座位视角两条链都会触发收尾）。 */
  settledRoundIds: string[]
  hands: TileType[][]
}

export function createBloodFlowRecordState(): BloodFlowRecordState {
  return { roundId: '', discardCount: 0, actionId: 0, ended: false, settledRoundIds: [], hands: [[], [], [], []] }
}

function frameOf(spectator: BloodFlowSeatView, context: BloodFlowRecordContext): ReplayFrameSource {
  return {
    players: spectator.players,
    wallLeft: spectator.wallCount,
    headDrawn: spectator.headDrawn,
    currentPlayer: spectator.currentPlayer,
    round: context.round,
    dealer: context.dealer,
    honba: context.honba,
    matchType: context.matchType,
    diceValues: context.secondDice ? [...context.secondDice] : [],
    firstDice: context.firstDice ? [...context.firstDice] : undefined,
    diceThrowerIndex: context.diceThrowerIndex,
    wallBreakIndex: spectator.wallBreakIndex,
    flipTile: spectator.flipTile,
    jokerTiles: [...spectator.jokers],
    wildcardTiles: [...(context.wildcardTiles ?? [])],
    flipStack: spectator.flipStack,
  }
}

/** 摸牌 best-effort：与上一份快照相比正好一家手牌 +1，即认为该家摸了一张。 */
function detectDraw(
  previous: TileType[][],
  next: BloodFlowSeatView,
): { seat: number; tile: TileType } | null {
  let found: { seat: number; tile: TileType } | null = null
  for (let seat = 0; seat < next.players.length; seat += 1) {
    const before = previous[seat] ?? []
    const player = next.players[seat]
    if (!player || player.hand.length !== before.length + 1) continue
    if (found) return null   // 多家同时变化（鸣牌/结算）：不猜测摸牌
    const index = player.drawnTileIndex >= 0 && player.drawnTileIndex < player.hand.length
      ? player.drawnTileIndex
      : player.hand.length - 1
    found = { seat, tile: player.hand[index] }
  }
  return found
}

function resultOf(spectator: BloodFlowSeatView, context: BloodFlowRecordContext): RoundResult {
  const round = spectator.public.roundResult
  const opening = round?.openingScores ?? spectator.players.map((player) => player.score)
  const ending = round?.endingScores ?? spectator.players.map((player) => player.score)
  const scoreChanges = spectator.players.map((player, seat) => ({
    playerIndex: seat,
    name: player.name,
    avatar: player.avatar,
    characterId: player.characterId,
    playerKind: player.playerKind,
    isLlm: player.isLlm,
    score: ending[seat] ?? player.score,
    delta: (ending[seat] ?? player.score) - (opening[seat] ?? player.score),
  }))
  const winCounts = round?.winCounts ?? spectator.players.map(() => 0)
  // 血流一局可能多次胡牌：把各家胡牌次数写进 details，回放结算帧照实展示。
  const details = winCounts
    .map((count, seat) => ({ label: `${spectator.players[seat]?.name ?? `座位${seat + 1}`} 胡 ${count} 次`, points: undefined }))
    .filter((detail, seat) => winCounts[seat] > 0)
  return {
    draw: winCounts.every((count) => count === 0),
    roundLabel: roundLabelFor(context.round, context.matchType),
    scoreChanges,
    details,
  }
}

/**
 * 局末收尾（幂等）。两道保险都会调用它：
 * 1) 旁观视角流里看到 roundResult；
 * 2) `useBloodFlowGame.apply()` 里座位视角看到 roundResult（结算态下引擎会亮出四家手牌，
 *    因此座位视角本身也够用）——避免任何一条采样链漏掉局末。
 */
export function recordBloodFlowSettle(
  hooks: ReplayRecorderHooks,
  spectator: BloodFlowSeatView,
  context: BloodFlowRecordContext,
  state: BloodFlowRecordState,
): void {
  // 幂等按 roundId 判定：不依赖 ended 标志与调用顺序，任何一条采样链先到都能收尾。
  if (state.settledRoundIds.includes(spectator.roundId)) return
  if (state.roundId !== spectator.roundId) {
    // 极端情况：该 roundId 的首份快照就已经是结算态 —— 先补开局锚点再收尾。
    hooks.roundStart(frameOf(spectator, context))
    state.roundId = spectator.roundId
    state.discardCount = spectator.discardActions?.length ?? 0
    state.actionId = spectator.actionEvents.at(-1)?.id ?? 0
    state.hands = spectator.players.map((player) => [...player.hand])
  }
  state.settledRoundIds.push(spectator.roundId)
  state.ended = true
  hooks.roundEnd(resultOf(spectator, context), frameOf(spectator, context))
}

/**
 * 把一份旁观视角折成回放事件；同一 roundId 的快照会按累计流水补齐。
 * 返回是否记录到了内容（便于调用方统计）。
 */
export function recordBloodFlowView(
  hooks: ReplayRecorderHooks,
  spectator: BloodFlowSeatView,
  context: BloodFlowRecordContext,
  state: BloodFlowRecordState,
): void {
  const frame = frameOf(spectator, context)

  if (state.roundId !== spectator.roundId) {
    hooks.roundStart(frame)
    state.roundId = spectator.roundId
    state.discardCount = 0
    state.actionId = 0
    state.hands = spectator.players.map((player) => [...player.hand])
    state.ended = false
    // 首份快照即结算态时不能提前返回，否则这一局的局末会被整段吞掉。
    if (spectator.public.roundResult) {
      recordBloodFlowSettle(hooks, spectator, context, state)
      return
    }
    return
  }

  if (!state.ended) {
    const drawn = detectDraw(state.hands, spectator)
    if (drawn) hooks.draw({ seat: drawn.seat, tile: drawn.tile, fromTail: false }, frame)
  }

  // 弃牌：按累计流水顺序补录（漏采样也不丢牌）。
  const discards = spectator.discardActions ?? []
  for (let index = state.discardCount; index < discards.length; index += 1) {
    const action = discards[index]
    if (!action) continue
    hooks.discard({ seat: action.seat, tile: action.tile, id: index + 1 }, frame)
  }
  state.discardCount = discards.length

  // 鸣牌 / 胡牌：按累计动作流水的 id 递增补录。
  for (const action of spectator.actionEvents) {
    if (action.id <= state.actionId) continue
    state.actionId = action.id
    hooks.tableAction({
      type: action.type,
      actorIndex: action.actorIndex,
      sourceIndex: action.sourceIndex,
      tile: action.tile,
      meldIndex: action.meldIndex,
    }, frame)
  }

  state.hands = spectator.players.map((player) => [...player.hand])

  if (spectator.public.roundResult) recordBloodFlowSettle(hooks, spectator, context, state)
}
