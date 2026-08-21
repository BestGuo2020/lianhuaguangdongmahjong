// v1.1 LLM 适配层的共享「局况 + 可见牌 + 请求版本」构建器。
// 只做只读汇总：现有 Human/Ai 控制器与编排器完全忽略这些字段；
// LLM 控制器/适配器（schema、prompt、golden fixture）消费它们构建规范请求。
// 参考 docs/llm-ai-design.md §6.2 与 §11 任务 1.1。
import type { TileType } from '../contracts/types'
import type { LocalGameState } from '../local/localGameState'
import { windForSeat } from '../presentation/tableLayout'

/** 一次决策请求的局况/可见/版本元数据（规范化协议字段的前端来源） */
export interface LlmContextMeta {
  /** 决策者座位（绝对索引） */
  playerIndex: number
  /** 各座位当前分数（按座位绝对索引，非相对座位） */
  scores: number[]
  /** 各座位公开弃牌与副露（按座位绝对索引；内容为只读副本） */
  peers: Array<{ discards: TileType[]; melds: Array<{ type: string; tile: TileType; tiles: TileType[] }> }>
  /** 本座位风（东/南/西/北，按庄家座位旋转） */
  seatWind: string
  /** 场风（东风场恒为东；半庄场前 4 局东、后 4 局南） */
  roundWind: string
  dealerIndex: number
  roundIndex: number
  /** 请求标识（kind-seat-seq，实例内单调递增）；陈旧响应检测用 */
  requestId: string
  /** 引擎状态指纹（round:phase:wall:headDrawn:current:tileCount）；状态变化即变化 */
  stateVersion: string
  /** 所有可见牌：己手+己副露+己牌河+他家公开弃牌/副露（他人暗手不含） */
  visibleTiles: TileType[]
  /** 全部公开弃牌与副露 */
  publicTiles: TileType[]
  /** 上家最近一次弃牌（跟打提示）；无则 null */
  upperLastDiscard: TileType | null
  /** 本座位弃牌 < 2 张（早巡） */
  earlyRound: boolean
  /** 剩余牌墙张数 */
  wallCount: number
  /** 万能/癞子牌面（广麻 = ['white']；莲花 = 翻精 jokerTiles） */
  jokerTiles: TileType[]
  /** 精的替代牌面（莲花 = ['white']；广麻 = []） */
  wildcardTiles: TileType[]
}

export interface LlmContextOptions {
  /** 万能/癞子牌面读取器（每请求调用） */
  jokerTiles: () => TileType[]
  /** 精的替代牌面读取器（每请求调用，默认无） */
  wildcardTiles?: () => TileType[]
}

export function createLlmContextSource(state: LocalGameState, options: LlmContextOptions) {
  let requestSeq = 0

  return {
    /** 生成一次决策请求的元数据；请求序列单调递增，状态变化时 stateVersion 随之变化 */
    meta(playerIndex: number, kind: 'turn' | 'claim'): LlmContextMeta {
      requestSeq += 1
      return {
        playerIndex,
        scores: state.players.map((player) => player.score),
        peers: state.players.map((player) => ({
          discards: [...player.discards],
          melds: player.melds.map((meld) => ({ type: meld.type, tile: meld.tile, tiles: [...meld.tiles] })),
        })),
        seatWind: windForSeat(playerIndex, state.dealer.value),
        roundWind: state.matchType.value === 'hanchan' && state.round.value > 4 ? '南' : '东',
        dealerIndex: state.dealer.value,
        roundIndex: state.round.value,
        requestId: `${kind}-${playerIndex}-${requestSeq}`,
        stateVersion: stateVersionOf(state),
        visibleTiles: visibleTilesFor(state, playerIndex),
        publicTiles: publicTilesFor(state),
        upperLastDiscard: upperLastDiscardFor(state, playerIndex),
        earlyRound: earlyRoundFor(state, playerIndex),
        wallCount: state.wall.value.length,
        jokerTiles: [...options.jokerTiles()],
        wildcardTiles: [...(options.wildcardTiles ? options.wildcardTiles() : [])],
      }
    },
  }
}

/** 引擎状态指纹：任一摸/打/副露/换局/阶段变化都会改变。 */
export function stateVersionOf(state: LocalGameState): string {
  const tileCount = state.players.reduce(
    (sum, player) => sum + player.hand.length + player.discards.length
      + player.melds.reduce((meldSum, meld) => meldSum + meld.tiles.length, 0),
    0,
  )
  return [
    state.round.value,
    state.phase.value,
    state.wall.value.length,
    state.wallHeadDrawn.value,
    state.currentPlayer.value,
    tileCount,
  ].join(':')
}

/** 该玩家可见的所有牌：自己=手牌+副露+牌河；他人=弃牌+副露（对齐莲花 visibleTilesFor）。 */
export function visibleTilesFor(state: LocalGameState, playerIndex: number): TileType[] {
  return state.players.flatMap((player, index) => index === playerIndex
    ? [...player.hand, ...player.melds.flatMap((meld) => meld.tiles), ...player.discards]
    : [...player.discards, ...player.melds.flatMap((meld) => meld.tiles)])
}

/** 全部公开弃牌与副露（对齐莲花 publicTilesFor）。 */
export function publicTilesFor(state: LocalGameState): TileType[] {
  return state.players.flatMap((player) => [
    ...player.discards,
    ...player.melds.flatMap((meld) => meld.tiles),
  ])
}

/** 上家最近一次弃牌；无则 null。 */
export function upperLastDiscardFor(state: LocalGameState, playerIndex: number): TileType | null {
  const upperIndex = (playerIndex - 1 + state.players.length) % state.players.length
  const upper = state.players[upperIndex]
  if (!upper || upper.discards.length === 0) return null
  return upper.discards[upper.discards.length - 1]
}

/** 该玩家弃牌 < 2 张（早巡）。 */
export function earlyRoundFor(state: LocalGameState, playerIndex: number): boolean {
  return (state.players[playerIndex]?.discards.length ?? 0) < 2
}
