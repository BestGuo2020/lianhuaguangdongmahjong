// 房主权威对局编排（Phase 3）：开局后房主跑本地引擎 + 周期广播快照 + 桥接远端玩家输入。
//
// - 用 createGame 工厂创建本地引擎（useGame/useLotusGame），传入 remoteControllers（seat 1-3）
//   给远端真人座位；其余空席由引擎回退 AI。
// - 周期广播：把本地状态按「目标座位」脱敏后发给每个远端 peer（state-sync 模型）。
// - round_start：轮次变化时广播，触发客户端的发牌/骰点动画。
//
// 诚实说明：本模块是 host-authority 的核心骨架；hand_result / match_finished 等事件消息
// 与广播时机需在真机联调阶段按实际 phase 转换校准（详见 docs/vibehub-p2p-migration.md）。
import { watch } from 'vue'
import type { GamePort } from '../../core/contracts/gamePort'
import type { MatchType } from '../../core/contracts/types'
import { serializeStateToSnapshot, type SnapshotContext, type SnapshotSource } from './localStateToSnapshot'
import type { RoundStartMessage } from '../protocol/messages'
import type { RuleVariant } from '../../core/rules/ruleVariants'

export interface HostGameRunnerOptions<TController> {
  room: VibeHubSDK.Room
  rulesetId: RuleVariant
  /** 场次（east / hanchan）。 */
  mode: MatchType
  /** peerId → 座位（seat 0 为房主自己，不在本映射中）。 */
  seatByPeer: Map<string, number>
  /** 远端控制器工厂：广麻用 RemotePlayerController，莲花用 LotusRemotePlayerController。 */
  createController: (room: VibeHubSDK.Room, peerId: string) => TController
  /** 本地引擎工厂：传入非本家座位控制器，返回 GamePort（同时作为快照源）。 */
  createGame: (remoteControllers: Array<TController | undefined>) => GamePort & SnapshotSource
  /** seat → 昵称（覆盖默认 PLAYER_SEED；房主 + 远端真人）。 */
  seatNames?: Map<number, string>
  /** 快照广播间隔（ms）。 */
  broadcastIntervalMs?: number
}

export function startHostGame<TController>(options: HostGameRunnerOptions<TController>): { game: GamePort & SnapshotSource; stop(): void } {
  const { room, rulesetId, mode, seatByPeer, createController, createGame, seatNames, broadcastIntervalMs = 200 } = options

  // 构建远端控制器（seat 1-3 对应远端 peer；未映射座位留 undefined → 引擎回退 AI）
  const remoteControllers: Array<TController | undefined> = [undefined, undefined, undefined]
  for (const [peerId, seat] of seatByPeer) {
    if (seat >= 1 && seat <= 3) remoteControllers[seat - 1] = createController(room, peerId)
  }

  const game = createGame(remoteControllers)
  const context: SnapshotContext = { roomId: room.roomId, rulesetId }

  function broadcastAll() {
    for (const [peerId, seat] of seatByPeer) {
      const snapshot = serializeStateToSnapshot(game, seat, context)
      // 远端玩家回合：本地引擎 phase 是 thinking（等待其响应），但客户端需要 discard 才能出牌
      // （其 isUserTurn = currentPlayer===0 && phase==='discard'）。覆盖该玩家的快照相位。
      if (game.currentPlayer.value === seat && snapshot.phase === 'thinking') {
        snapshot.phase = 'discard'
      }
      room.send(snapshot, peerId)
    }
  }

  function sendRoundStart() {
    const dice = game.diceValues.value
    const message: RoundStartMessage = {
      kind: 'round_start',
      matchStarted: game.round.value === 1,
      round: game.round.value,
      dealer: game.dealer.value,
      honba: game.honba.value,
      dice: [dice[0] ?? 1, dice[1] ?? 1] as [number, number],
      secondDice: game.secondDice?.value ?? undefined,
      flipTile: game.flipTile?.value ?? undefined,
      flipStack: game.flipStack?.value ?? undefined,
    }
    room.send(message)
    broadcastAll()
  }

  // round_start：发牌完成后（phase 进入 opening，此时手牌已齐）广播，触发客户端发牌/骰点动画。
  // watch 须在 startGame 之前注册；用 phase 而非 round（round 首局恒为 1）或 openingStage
  // （instantOpening 下阶段瞬变，watch 会错过中间态）。
  let lastPhase = game.phase.value
  const stopWatch = watch(() => game.phase.value, (phase) => {
    if (phase === 'opening' && lastPhase !== 'opening') {
      sendRoundStart()
    }
    lastPhase = phase
  })

  // 启动本地引擎：instantOpening 下开局瞬间完成（发牌无动画），随后广播全量手牌快照。
  game.startGame(mode)
  // 用真实昵称覆盖默认 PLAYER_SEED（房主 + 远端真人；空席 AI 保留默认名）。
  if (seatNames) {
    for (const [seat, name] of seatNames) {
      const player = game.players[seat]
      if (player) player.name = name
    }
  }

  // 周期快照广播：对局状态下每帧兜底同步（客户端 reconciler 取最新快照，幂等）。
  const intervalId = window.setInterval(broadcastAll, broadcastIntervalMs)

  return {
    game,
    stop() {
      window.clearInterval(intervalId)
      stopWatch()
    },
  }
}
