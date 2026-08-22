import type { GamePhase, LastDiscard, RefLike } from '../../core/contracts/gamePort'
import type { GamePlayer, TileType } from '../../core/contracts/types'
import { sortTiles, tileAudioFile } from '../../core/rules/tiles'
import type { FollowDealerTracker } from './followDealer'
import { isLocalLlmSeat } from '../../core/presentation/localLlmVoiceRegistry'

interface TileFlowState {
  players: GamePlayer[]
  wall: RefLike<TileType[]>
  wallHeadDrawn: RefLike<number>
  phase: RefLike<GamePhase>
  lastDiscard: RefLike<LastDiscard | null>
  lastDiscardSound: RefLike<Promise<void> | null>
}
interface TurnFlow {
  markDrawSource(playerIndex: number, fromTail: boolean): void
  clearDrawSource(): void
  routeDiscard(playerIndex: number, tile: TileType): unknown
}
interface TileFlowOptions {
  state: TileFlowState
  controllers: Array<{ onDiscarded?(): void }>
  getTurnFlow(): TurnFlow
  endDraw(): unknown
  playSound(name: string, volume?: number): unknown
  playSoundAndWait?: (name: string, volume?: number) => Promise<void>
  sortHand?: (hand: TileType[]) => TileType[]
  later(callback: () => void, delay: number): number
  stopCountdown(): void
  handleSpecialDraw?: (
    playerIndex: number,
    tile: TileType,
    drawAgain: () => Promise<boolean>,
  ) => Promise<boolean | undefined>
  takeTailTile?: (wall: TileType[], headDrawn: number) => TileType | null
  initialWallSize?: number
  /** 跟庄规则跟踪器：每次出牌后、响应编排前调用（可选）。 */
  followDealer?: FollowDealerTracker
}

/**
 * 从当前牌尾按物理墩补摸：每墩数组顺序为「上、下」，所以首次取倒数第二张，
 * 再取同墩最后一张。牌头、牌尾交汇到只剩一张时仍能正常取完，不保留王牌。
 */
export function takeStackTailTile(
  wall: TileType[],
  headDrawn: number,
  initialWallSize: number,
): TileType | null {
  if (!wall.length) return null
  const tailDrawn = Math.max(0, initialWallSize - headDrawn - wall.length)
  const index = tailDrawn % 2 === 0 && wall.length >= 2 ? wall.length - 2 : wall.length - 1
  return wall.splice(index, 1)[0] ?? null
}

export function createTileFlowExecutor(options: TileFlowOptions) {
  const { state } = options
  function takeTile(fromTail = false) {
    if (!state.wall.value.length) return null
    if (!fromTail) state.wallHeadDrawn.value += 1
    if (!fromTail) return state.wall.value.shift() ?? null
    return options.takeTailTile?.(state.wall.value, state.wallHeadDrawn.value)
      ?? takeStackTailTile(state.wall.value, state.wallHeadDrawn.value, options.initialWallSize ?? 136)
  }
  async function drawFor(playerIndex: number, fromTail = false): Promise<boolean> {
    const player = state.players[playerIndex]
    options.getTurnFlow().markDrawSource(playerIndex, fromTail)
    const tile = takeTile(fromTail)
    if (!tile) {
      options.endDraw()
      return false
    }
    const specialResult = await options.handleSpecialDraw?.(playerIndex, tile, () => drawFor(playerIndex, true))
    if (specialResult !== undefined) return specialResult
    player.hand = [...player.hand, tile]
    // 摸牌必须先保留在最右侧，牌桌和 HUD 都据此绘制摸牌间隙；
    // 等出牌/吃碰杠收尾时再统一整理手牌，避免相同牌排序后把间隙挪到牌组中间。
    player.drawnTileIndex = player.hand.length - 1
    options.playSound('give.mp3', 0.7)
    return true
  }
  function discardTile(playerIndex: number, requestedIndex: number) {
    const player = state.players[playerIndex]
    const handIndex = Math.min(requestedIndex, player.hand.length - 1)
    const [tile] = player.hand.splice(handIndex, 1)
    if (!tile) return
    player.hand = options.sortHand?.(player.hand) ?? sortTiles(player.hand)
    player.drawnTileIndex = -1
    options.getTurnFlow().clearDrawSource()
    player.discards.push(tile)
    options.controllers[playerIndex].onDiscarded?.()
    state.lastDiscard.value = { tile, from: playerIndex, id: Date.now() }
    options.playSound('dapai.mp3', 0.8)
    if (isLocalLlmSeat(playerIndex)) {
      // 大模型仍有实体落牌声；牌名由动态吐槽 TTS 取代。
      state.lastDiscardSound.value = Promise.resolve()
      state.phase.value = 'checking'
      options.stopCountdown()
      options.followDealer?.onDiscard(playerIndex, tile)
      options.getTurnFlow().routeDiscard(playerIndex, tile)
      return
    }
    state.lastDiscardSound.value = new Promise<void>((resolve) => {
      // 牌名音效原本通过 later 延迟 80ms；这里使用独立计时器，避免点炮结算
      // 清理回合定时器时把“正在报牌”的音效一起取消。
      globalThis.setTimeout(() => {
        try {
          const playback = options.playSoundAndWait?.(tileAudioFile(tile))
          if (playback) {
            void playback.then(resolve, resolve)
            return
          }
          options.playSound(tileAudioFile(tile))
        } catch {
          // 音频资源异常不应阻塞牌局结算。
        }
        resolve()
      }, 80)
    })
    state.phase.value = 'checking'
    options.stopCountdown()
    // 跟庄：出牌已落定，先做跟庄检测（可能触发庄家给付），再进入响应编排。
    options.followDealer?.onDiscard(playerIndex, tile)
    options.getTurnFlow().routeDiscard(playerIndex, tile)
  }
  return { takeTile, drawFor, discardTile }
}
