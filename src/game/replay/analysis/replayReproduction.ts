// §10.6 的判据：用赛后复现数据把一局重跑一遍，看是否到达同一结束状态。
//
// 做法：复现数据 → 引擎开局（openingFromReproduction，缺字段直接失败）→ 依序把记录里的命令
// 还原成当时的合法动作并提交 → 读结束分数与记录比对。
//
// 三条不许含糊的原则：
// 1. 命令与当时的合法动作对不上 ⇒ 报"对不上"，绝不跳过这条命令继续跑；
// 2. 命令用尽而牌局未结束 ⇒ 报"记录不足"（当时可能有窗口靠超时推进），绝不假装成功；
// 3. 记录里没有期望分数时，`scoresMatch` 返回 null（只证明"能跑完"，不谎称"结果一致"）。
import { SEATS } from '../../variants/lotus/bloodFlow/state'
/** 座位类型从真实常量派生，避免依赖某个未导出的类型名。 */
type Seat = (typeof SEATS)[number]
import { BloodFlowEngine } from '../../variants/lotus/bloodFlow/engine'
import { bloodFlowSeatView } from '../../variants/lotus/bloodFlow/seatView'
import { tileName } from '../../core/rules/tiles'
import { openingFromReproduction } from './openingFromReproduction'
import type { AnalysisReproduction } from './types'

export interface ReproductionCommand {
  seat: number
  kind: string
  tile?: string
  handIndex?: number
  from?: number | null
  meldIndex?: number
  /** 见 AnalysisReproduction.commands：'auto' 权威机器人代决、'expire' 靠超时推进。 */
  resolution?: 'command' | 'auto' | 'expire'
}

export interface ReplayVerification {
  ok: boolean
  reason: string | null
  submitted: number
  recorded: number
  finalScores: number[]
  expectedScores: number[] | null
  /** null = 没有可比对的期望分数（只验证能跑完）。 */
  scoresMatch: boolean | null
}

export interface ReplayReproductionInput {
  reproduction: AnalysisReproduction
  commands: readonly ReproductionCommand[]
  expectedScores?: readonly number[] | null
  /** 推进上限，避免畸形数据把校验挂住。 */
  maxSteps?: number
}

function actionMatches(
  action: { kind: string; tile?: unknown; index?: unknown; from?: unknown; meldIndex?: unknown },
  command: ReproductionCommand,
): boolean {
  if (action.kind !== command.kind) return false
  if (command.tile !== undefined && tileName(action.tile as never) !== command.tile) return false
  if (command.handIndex !== undefined && action.index !== command.handIndex) return false
  if (command.from !== undefined && command.from !== null && action.from !== command.from) return false
  if (command.meldIndex !== undefined && action.meldIndex !== command.meldIndex) return false
  return true
}

export function replayReproduction(input: ReplayReproductionInput): ReplayVerification {
  const recorded = input.commands.length
  const expected = input.expectedScores && input.expectedScores.length === 4 ? [...input.expectedScores] : null
  const restored = openingFromReproduction(input.reproduction)
  if (!restored.opening) {
    return { ok: false, reason: restored.reason, submitted: 0, recorded, finalScores: [], expectedScores: expected, scoresMatch: null }
  }

  // 时钟必须可推进：expire 记录要把"当时靠超时推进"这件事重演出来
  let clock = 0
  const engine = new BloodFlowEngine({
    authorityEpoch: 'verify',
    roundId: `verify/${input.reproduction.roundIndex}`,
    opening: restored.opening,
    now: () => clock,
    winBeatMs: 0,
  })

  const maxSteps = Math.max(1, input.maxSteps ?? 20_000)
  let cursor = 0
  let steps = 0
  const scoresNow = () => engine.players.map(player => player.score)

  while (!engine.result && steps < maxSteps) {
    steps += 1
    const command = input.commands[cursor]
    if (!command) {
      return {
        ok: false, submitted: cursor, recorded, finalScores: scoresNow(), expectedScores: expected, scoresMatch: null,
        reason: `命令序列不完整：牌局未结束但已无第 ${cursor + 1} 条命令（当时可能有窗口靠超时推进，记录不足以精确复现）`,
      }
    }
    const seat = command.seat as Seat
    if (command.resolution === 'expire') {
      // 该窗口没人决定、靠超时推进：把时钟推过截止时间再推进，否则状态会与当时分叉
      const current = engine.window
      if (!current) {
        return {
          ok: false, submitted: cursor, recorded, finalScores: scoresNow(), expectedScores: expected, scoresMatch: null,
          reason: `第 ${cursor + 1} 条记录标记为 expire，但当前没有窗口可推进（记录与实际不符）`,
        }
      }
      clock = current.deadlineAt + 1
      engine.expire(clock, current.id)
      cursor += 1
      continue
    }
    if (command.resolution === 'auto') {
      // 该窗口当时由权威机器人（或超时）代决，记录里不含它的选择：说清原因，不笼统报"命令不足"
      return {
        ok: false, submitted: cursor, recorded, finalScores: scoresNow(), expectedScores: expected, scoresMatch: null,
        reason: `第 ${cursor + 1} 条记录标记为 auto：该窗口当时没有本端决策（由权威机器人或超时决定），记录不含其选择，无法复现`,
      }
    }
    if (!SEATS.includes(seat)) {
      return {
        ok: false, submitted: cursor, recorded, finalScores: scoresNow(), expectedScores: expected, scoresMatch: null,
        reason: `第 ${cursor + 1} 条命令的座位非法：${command.seat}`,
      }
    }
    const view = bloodFlowSeatView(engine, seat)
    const action = view.ownActions.find(candidate => actionMatches(candidate as never, command))
    if (!action) {
      const offered = view.ownActions.map(candidate => candidate.kind).join('/') || '（该座位此刻没有合法动作）'
      return {
        ok: false, submitted: cursor, recorded, finalScores: scoresNow(), expectedScores: expected, scoresMatch: null,
        reason: `第 ${cursor + 1} 条命令与当时的合法动作对不上（seat=${command.seat} kind=${command.kind}${command.tile ? ` tile=${command.tile}` : ''}${command.handIndex !== undefined ? ` index=${command.handIndex}` : ''}；当时的合法动作：${offered}）`,
      }
    }
    engine.submit(engine.command(seat, action))
    cursor += 1
    // 把可能的窗口过期交给引擎，避免在同一个窗口上死等
    const windowId = view.window?.id ?? engine.window?.id
    if (windowId) engine.expire(0, windowId)
  }

  const finalScores = scoresNow()
  if (!engine.result) {
    return {
      ok: false, submitted: cursor, recorded, finalScores, expectedScores: expected, scoresMatch: null,
      reason: `推进超过上限 ${maxSteps}，牌局仍未结束`,
    }
  }
  const scoresMatch = expected ? expected.every((score, seat) => score === finalScores[seat]) : null
  return {
    ok: scoresMatch !== false, submitted: cursor, recorded, finalScores, expectedScores: expected, scoresMatch,
    reason: scoresMatch === false ? `结束分数不一致：记录 ${expected!.join('/')} ≠ 重跑 ${finalScores.join('/')}` : null,
  }
}
