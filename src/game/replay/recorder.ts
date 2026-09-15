// 录制器：把引擎的录制点回调拼成「场次 + 局 + 事件流」记录，并交给存储落库。
//
// 与引擎解耦：引擎只通过 ReplayRecorderHooks 回调，录制器不认识任何引擎内部结构
// （所有状态都从 ReplayFrameSource 里取），因此单机三个玩法可以共用同一套录制逻辑。
import type { GamePlayer, Meld, TableActionType, TileType } from '../core/contracts/types'
import type { RoundResult } from '../core/contracts/gamePort'
import type { RuleVariant } from '../core/rules/ruleVariants'
import { MATCH_HANDS } from '../core/local/localGameConfig'
import type { TableThemeName } from '../../theme/themeIdentity'
import { roundLabelFor } from './format'
import { toPlain } from './plain'
import {
  REPLAY_SCHEMA_VERSION,
  type ReplayAnchor,
  type ReplayFrameSource,
  type ReplayMatch,
  type ReplayMeldKind,
  type ReplayPlayer,
  type ReplayRecorderHooks,
  type ReplayRound,
  type ReplayRoundFinal,
  type ReplaySeatState,
  type ReplayStanding,
  type ReplayStep,
} from './types'

/** 场次级元信息：由 App 层在开局时提供（玩法 / 主题 / 本家座位）。 */
export interface ReplayMatchMeta {
  rulesetId: RuleVariant
  rulesetName: string
  themeName: TableThemeName
  humanSeat: number
  /** local（默认）= 单机对局；remote = 联机对局的房主侧牌谱。 */
  gameMode?: 'local' | 'remote'
}

export interface ReplaySink {
  saveMatch(match: ReplayMatch): Promise<void> | void
  saveRound(round: ReplayRound): Promise<void> | void
}

export interface ReplayRecorder {
  /** 交给引擎的钩子（useGame / lotusGame 的可选 recorder 参数）。 */
  hooks: ReplayRecorderHooks
  /** 场次结束（含中途退出）落库；无有效数据时返回 null。 */
  finish(status: 'finished' | 'aborted', standings?: ReplayStanding[]): ReplayMatch | null
  /**
   * 自动判定收尾状态：已打完整场（含最后一局）记为 finished，否则记为 aborted。
   * 名次优先取传入的权威 standings，缺省时按最后一局的分数自行排名（中途退出也能给出位次）。
   */
  finishAuto(standings?: ReplayStanding[]): ReplayMatch | null
  /** 是否有进行中的场次。 */
  active(): boolean
  /** 当前内存中的记录快照（测试与调试用）。 */
  snapshot(): { match: ReplayMatch | null; rounds: ReplayRound[]; stats: ReplayRecorderStats }
}

/** 录制计数（诊断用：能直接看出事件是否被早退吃掉）。 */
export interface ReplayRecorderStats {
  roundStarts: number
  roundEnds: number
  /** roundEnd 时没有进行中的局（异常，正常情况下恒为 0）。 */
  roundEndsSkipped: number
  /** 因新场次开始而中途收尾的次数。 */
  matchesFinalized: number
}

export interface ReplayRecorderOptions {
  sink: ReplaySink
  meta: () => ReplayMatchMeta
  now?: () => number
  createId?: () => string
}

function defaultId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** 广麻以白板为癞子（与 App.vue 传给牌桌的兜底一致）；莲花麻将由引擎传入翻精结果。 */
const DEFAULT_JOKERS: TileType[] = ['white']

const MELD_KINDS: Partial<Record<TableActionType, ReplayMeldKind>> = {
  peng: 'peng',
  chi: 'chi',
  'discard-gang': 'gang-discard',
  'concealed-gang': 'gang-concealed',
  'added-gang': 'gang-added',
  'flower-gang': 'gang-flower',
  'wind-kong': 'gang-wind',
}

const WIN_ACTIONS: ReadonlySet<TableActionType> = new Set(['self-draw', 'discard-win', 'robbed-kong-win'])

/** 已带公共帧字段的步骤（墙/牌头/当前家由录制器统一补）。 */
type ReplayStepDraft = Omit<ReplayStep, 'wallLeft' | 'headDrawn' | 'currentPlayer'>

function cloneMeld(meld: Meld): Meld {
  return { ...meld, tiles: [...meld.tiles] }
}

/**
 * 结算结果转成纯对象再落库（见 plain.ts 的 toPlain）。
 * 引擎可能在类型之外挂运行时字段（莲花就挂了 `winHand`），因此不逐字段枚举；
 * 直接递归解包，既不丢字段也不带 Vue 代理。
 */

/** 落库调用一律不向引擎抛错：存储异常不得影响对局（同步抛与 Promise 拒绝都吞掉）。 */
function safeSave(work: () => Promise<void> | void) {
  try {
    const pending = work()
    if (pending && typeof pending.then === 'function') void pending.catch(() => {})
  } catch {
    /* 存储不可用：静默降级 */
  }
}

function seatState(player: GamePlayer): ReplaySeatState {
  return {
    hand: [...player.hand],
    melds: player.melds.map(cloneMeld),
    drawnTileIndex: player.drawnTileIndex,
    redCount: player.redCount,
    discards: [...player.discards],
  }
}

function anchorOf(frame: ReplayFrameSource): ReplayAnchor {
  return {
    hands: frame.players.map((player) => [...player.hand]),
    melds: frame.players.map((player) => player.melds.map(cloneMeld)),
    discards: frame.players.map((player) => [...player.discards]),
    drawnTileIndex: frame.players.map((player) => player.drawnTileIndex),
    redCount: frame.players.map((player) => player.redCount),
    scores: frame.players.map((player) => player.score),
    wallLeft: frame.wallLeft,
    headDrawn: frame.headDrawn,
    currentPlayer: frame.currentPlayer,
  }
}

function matchPlayersOf(frame: ReplayFrameSource): ReplayPlayer[] {
  return frame.players.map((player, seat) => ({
    seat,
    name: player.name,
    avatar: player.avatar,
    characterId: player.characterId,
    playerKind: player.playerKind,
    isLlm: player.isLlm,
    startScore: player.score,
  }))
}

/** 红中花牌等「摸牌后立即易手」的情况：报出牌张与实际进张不一致时按手牌收敛。 */
function drawnTileOf(player: GamePlayer, reported: TileType): { tile: TileType; replaced: boolean } {
  if (player.hand.includes(reported)) return { tile: reported, replaced: false }
  const last = player.hand[player.hand.length - 1]
  return last ? { tile: last, replaced: true } : { tile: reported, replaced: false }
}

export function createReplayRecorder(options: ReplayRecorderOptions): ReplayRecorder {
  const now = options.now ?? (() => Date.now())
  const createId = options.createId ?? defaultId
  const rounds: ReplayRound[] = []
  let match: ReplayMatch | null = null
  let round: ReplayRound | null = null
  let knownScores: number[] = []
  const stats: ReplayRecorderStats = { roundStarts: 0, roundEnds: 0, roundEndsSkipped: 0, matchesFinalized: 0 }

  function newMatch(frame: ReplayFrameSource) {
    const meta = options.meta()
    match = {
      id: createId(),
      schemaVersion: REPLAY_SCHEMA_VERSION,
      rulesetId: meta.rulesetId,
      rulesetName: meta.rulesetName,
      matchType: frame.matchType,
      matchName: frame.matchType === 'hanchan' ? '半庄场' : '东风场',
      gameMode: meta.gameMode ?? 'local',
      themeName: meta.themeName,
      players: matchPlayersOf(frame),
      humanSeat: meta.humanSeat,
      startedAt: now(),
      endedAt: 0,
      status: 'aborted',
      roundCount: 0,
      summary: '',
    }
  }

  function pushStep(draft: ReplayStepDraft, frame: ReplayFrameSource) {
    if (!round) return
    const scores = frame.players.map((player) => player.score)
    if (scores.some((score, seat) => score !== knownScores[seat])) {
      draft.scores = scores
      knownScores = scores
    }
    round.steps.push({
      ...draft,
      wallLeft: frame.wallLeft,
      headDrawn: frame.headDrawn,
      currentPlayer: frame.currentPlayer,
    })
  }

  function summaryOf(recorded: ReplayRound[], players: ReplayPlayer[], humanSeat: number): string {
    const last = recorded[recorded.length - 1]
    if (!last?.final) return ''
    if (last.final.draw) return `${last.roundLabel} 荒庄`
    const winner = last.final.winSeat
    const kind = last.final.winType === 'discard' ? '点炮'
      : last.final.winType === 'robbed-kong' ? '抢杠'
        : last.final.winType === 'tianhu' ? '天胡'
          : last.final.winType === 'dihu' ? '地胡' : '自摸'
    const name = winner != null ? players[winner]?.name ?? '' : ''
    return `${last.roundLabel} ${name}${kind}${winner === humanSeat ? '（本家）' : ''}`
  }

  function computedStandings(current: ReplayMatch): ReplayStanding[] | undefined {
    const last = rounds[rounds.length - 1]
    if (!last?.final) return undefined
    return last.final.scores
      .map((score, seat) => ({ seat, name: current.players[seat]?.name ?? `座位${seat + 1}`, score, rank: 0 }))
      .sort((a, b) => b.score - a.score || a.seat - b.seat)
      .map((entry, index) => ({ ...entry, rank: index + 1 }))
  }

  function finalize(status: 'finished' | 'aborted', standings?: ReplayStanding[]): ReplayMatch | null {
    round = null
    const current = match
    match = null
    stats.matchesFinalized += 1
    // 一局都没打完（开局即退出）：不留空记录。
    if (!current || !rounds.length) return null
    const humanSeat = current.humanSeat
    // 名次：优先用引擎的权威 standings，缺省时按末局分数自行排名（中途退出也能给出位次）。
    const resolved = standings ?? computedStandings(current)
    const mine = resolved?.find((entry) => entry.seat === humanSeat)
    current.endedAt = now()
    current.status = status
    current.roundCount = rounds.length
    current.finalStandings = resolved
    current.myRank = mine?.rank
    current.myScore = mine?.score ?? rounds[rounds.length - 1].final?.scores[humanSeat]
    current.summary = summaryOf(rounds, current.players, humanSeat)
    const record = toPlain(current)
    safeSave(() => options.sink.saveMatch(record))
    return record
  }

  const hooks: ReplayRecorderHooks = {
    roundStart(frame) {
      stats.roundStarts += 1
      // 新场次判定：每场的第一局必为「东1局 本场0」；连庄只加本场、不重置局数。
      if (!match || (frame.round === 1 && frame.honba === 0)) {
        if (match) finalize('aborted')
        rounds.length = 0
        newMatch(frame)
      }
      const active = match!
      // 上一局若异常缺结算（例如中途重开），丢弃残留的进行中记录。
      round = {
        id: `${active.id}:${rounds.length + 1}`,
        matchId: active.id,
        roundIndex: rounds.length + 1,
        round: frame.round,
        roundLabel: roundLabelFor(frame.round, frame.matchType),
        dealer: frame.dealer,
        honba: frame.honba,
        matchType: frame.matchType,
        dice: {
          first: frame.firstDice ? [...frame.firstDice] : undefined,
          second: frame.diceValues.length ? [...frame.diceValues] : undefined,
        },
        diceThrowerIndex: frame.diceThrowerIndex,
        flipTile: frame.flipTile ?? null,
        jokerTiles: frame.jokerTiles?.length ? [...frame.jokerTiles] : [...DEFAULT_JOKERS],
        wildcardTiles: [...(frame.wildcardTiles ?? [])],
        wallBreakIndex: frame.wallBreakIndex ?? 0,
        flipStack: frame.flipStack ?? null,
        scoresBefore: frame.players.map((player) => player.score),
        anchor: anchorOf(frame),
        steps: [],
        final: null,
        landedAt: 0,
      }
      knownScores = round.scoresBefore
    },

    draw(event, frame) {
      if (!round) return
      const player = frame.players[event.seat]
      if (!player) return
      const { tile, replaced } = drawnTileOf(player, event.tile)
      pushStep({
        t: 'draw',
        seat: event.seat,
        tile,
        fromTail: event.fromTail || replaced,
        state: seatState(player),
      }, frame)
    },

    discard(event, frame) {
      if (!round) return
      const player = frame.players[event.seat]
      if (!player) return
      pushStep({
        t: 'discard',
        seat: event.seat,
        tile: event.tile,
        lastDiscardId: event.id,
        state: seatState(player),
      }, frame)
    },

    tableAction(event, frame) {
      if (!round) return
      const actor = frame.players[event.actorIndex]
      if (!actor) return
      const isWin = WIN_ACTIONS.has(event.type)
      pushStep({
        t: isWin ? 'win' : 'meld',
        seat: event.actorIndex,
        tile: event.tile,
        actionType: event.type,
        meldIndex: event.meldIndex,
        kind: isWin ? undefined : MELD_KINDS[event.type],
        from: event.sourceIndex,
        state: seatState(actor),
        sourceDiscards: event.sourceIndex != null
          ? [...(frame.players[event.sourceIndex]?.discards ?? [])]
          : undefined,
      }, frame)
    },

    roundEnd(result, frame) {
      stats.roundEnds += 1
      if (!round || !match) {
        stats.roundEndsSkipped += 1
        return
      }
      const final: ReplayRoundFinal = {
        hands: frame.players.map((player) => [...player.hand]),
        melds: frame.players.map((player) => player.melds.map(cloneMeld)),
        discards: frame.players.map((player) => [...player.discards]),
        drawnTileIndex: frame.players.map((player) => player.drawnTileIndex),
        redCount: frame.players.map((player) => player.redCount),
        scores: frame.players.map((player) => player.score),
        draw: Boolean(result.draw),
        winSeat: result.draw ? undefined : result.winnerIndex,
        winTile: result.winTile,
        winType: result.winType,
        horses: result.horses ? [...result.horses] : undefined,
        details: result.details?.map((detail) => ({ ...detail })),
        totalMultiplier: result.totalMultiplier ?? result.multiplier,
        points: result.points,
        result: toPlain(result),
      }
      round.final = final
      round.landedAt = now()
      knownScores = final.scores
      // 录制边界统一解包成纯数据：Vue 代理与引擎的运行时字段都不会污染落库。
      const record = toPlain(round)
      rounds.push(record)
      match.roundCount = rounds.length
      safeSave(() => options.sink.saveRound(record))
      round = null
    },
  }

  return {
    hooks,
    finish(status, standings) {
      return finalize(status, standings)
    },
    finishAuto(standings) {
      const current = match
      if (!current) return null
      const last = rounds[rounds.length - 1]
      const matchLength = MATCH_HANDS[current.matchType]
      const completed = Boolean(last && last.final && last.round >= matchLength)
      return finalize(completed ? 'finished' : 'aborted', standings)
    },
    active() {
      return match !== null
    },
    snapshot() {
      return { match, rounds: [...rounds], stats: { ...stats } }
    },
  }
}
