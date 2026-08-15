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
import type { PlayerController } from '../../core/controllers/playerController'
import { RemotePlayerController } from './remotePlayerController'
import { serializeStateToSnapshot, type SnapshotContext, type SnapshotSource } from './localStateToSnapshot'
import type { RoundStartMessage } from '../protocol/messages'
import type { RuleVariant } from '../../core/rules/ruleVariants'

export interface HostGameRunnerOptions {
  room: VibeHubSDK.Room
  rulesetId: RuleVariant
  /** peerId → 座位（seat 0 为房主自己，不在本映射中）。 */
  seatByPeer: Map<string, number>
  /** 本地引擎工厂：传入非本家座位控制器，返回 GamePort（同时作为快照源）。 */
  createGame: (remoteControllers: Array<PlayerController | undefined>) => GamePort & SnapshotSource
  /** 快照广播间隔（ms）。 */
  broadcastIntervalMs?: number
}

export function startHostGame(options: HostGameRunnerOptions): { game: GamePort & SnapshotSource; stop(): void } {
  const { room, rulesetId, seatByPeer, createGame, broadcastIntervalMs = 200 } = options

  // 构建远端控制器（seat 1-3 对应远端 peer；未映射座位留 undefined → 引擎回退 AI）
  const remoteControllers: Array<PlayerController | undefined> = [undefined, undefined, undefined]
  for (const [peerId, seat] of seatByPeer) {
    if (seat >= 1 && seat <= 3) remoteControllers[seat - 1] = new RemotePlayerController(room, peerId)
  }

  const game = createGame(remoteControllers)
  const context: SnapshotContext = { roomId: room.roomId, rulesetId }

  function broadcastAll() {
    for (const [peerId, seat] of seatByPeer) {
      room.send(serializeStateToSnapshot(game, seat, context), peerId)
    }
  }

  // 周期快照广播：对局状态下每帧兜底同步（客户端 reconciler 取最新快照，幂等）。
  const intervalId = window.setInterval(broadcastAll, broadcastIntervalMs)

  // round_start：轮次变化时广播（触发客户端发牌/骰点动画）。
  let lastRound = game.round.value
  const stopWatch = watch(() => game.round.value, (round) => {
    if (round === lastRound) return
    lastRound = round
    const dice = game.diceValues.value
    const message: RoundStartMessage = {
      kind: 'round_start',
      matchStarted: round === 1,
      round,
      dealer: game.dealer.value,
      honba: game.honba.value,
      dice: [dice[0] ?? 1, dice[1] ?? 1] as [number, number],
      secondDice: game.secondDice?.value ?? undefined,
      flipTile: game.flipTile?.value ?? undefined,
      flipStack: game.flipStack?.value ?? undefined,
    }
    room.send(message)
    broadcastAll()
  })

  return {
    game,
    stop() {
      window.clearInterval(intervalId)
      stopWatch()
    },
  }
}
