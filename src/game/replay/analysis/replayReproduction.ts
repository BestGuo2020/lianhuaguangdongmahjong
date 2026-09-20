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
  /** 吃/杠等组合动作的牌集合（与记录一致，做集合比较）。 */
  tiles?: string[]
  handIndex?: number
  from?: number | null
  meldIndex?: number
  /** 见 AnalysisReproduction.commands：'auto' 权威机器人代决、'expire' 靠超时推进。 */
  resolution?: 'command' | 'auto' | 'expire'
  /** 所属窗口：用于消解记录顺序（同窗口有真命令时丢弃过期的 expire）。 */
  windowId?: string
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
  action: { kind: string; tile?: unknown; index?: unknown; from?: unknown; meldIndex?: unknown; tiles?: unknown; meld?: unknown },
  command: ReproductionCommand,
): boolean {
  if (action.kind !== command.kind) return false
  // 牌种：候选动作不带单张牌时（暗杠/吃等由 meld/tiles 表达）不做比较，否则会假性不匹配
  // —— 实测暗杠 `concealed-kong tile=m7` 明明在合法动作里却被判"对不上"。
  if (command.tile !== undefined) {
    const candidates = [
      ...(action.tile !== undefined ? [tileName(action.tile as never)] : []),
      ...(Array.isArray(action.tiles) ? (action.tiles as unknown[]).map(entry => tileName(entry as never)) : []),
      ...(Array.isArray(action.meld) ? (action.meld as unknown[]).map(entry => tileName(entry as never)) : []),
    ]
    if (candidates.length && !candidates.includes(command.tile)) return false
  }
  // 组合动作（吃/杠）：记录里有牌集合时，候选的牌集合必须完全一致（顺序无关），
  // 否则只能按 kind 取第一个候选 —— 实测会吃错组合、牌型走偏、重放提前二十步胡牌。
  if (command.tiles?.length) {
    const candidateTiles = [
      ...(Array.isArray(action.tiles) ? (action.tiles as unknown[]).map(entry => tileName(entry as never)) : []),
      ...(Array.isArray(action.meld) ? (action.meld as unknown[]).map(entry => tileName(entry as never)) : []),
    ]
    if (candidateTiles.length) {
      const wanted = [...command.tiles].sort().join(',')
      const offered = [...candidateTiles].sort().join(',')
      if (wanted !== offered) return false
    }
  }
  // 组合动作（暗杠/吃等）在引擎里按"牌集合"枚举，同一组牌可能有多个 index 写法 ⇒ 有牌集合时不比 index，
  // 否则会假性失配（实测：concealed-kong tile=s6 明明在候选里、手里也有三张 s6，却被判对不上）。
  const isCombination = Array.isArray(action.tiles) || Array.isArray(action.meld)
  if (!isCombination && command.handIndex !== undefined && action.index !== undefined && action.index !== command.handIndex) return false
  if (command.from !== undefined && command.from !== null && action.from !== undefined && action.from !== command.from) return false
  if (command.meldIndex !== undefined && action.meldIndex !== undefined && action.meldIndex !== command.meldIndex) return false
  return true
}

export function replayReproduction(input: ReplayReproductionInput): ReplayVerification {
  // 顺序消歧：同一窗口若既有 expire 又有真命令，以命令为准（机器人命令要等权威回传才知道内容，
  // 可能排在超时计时器压入的 expire 之后）。
  // 对照实验记录：第 56 轮（单次运行）与第 72 轮（两次运行，且已有编号相对判定）各测过一次"停用本过滤"，
  // 两次都未改善 ⇒ 保留。若未来要再动它，务必按 2~3 次复跑判定（每次 e2e 都是不同的随机牌局）。
  const windowsWithCommand = new Set(
    input.commands.filter(entry => (entry.resolution ?? 'command') === 'command' && entry.windowId).map(entry => entry.windowId!),
  )
  // 关键：**按窗口编号稳定排序后再消费**。记录是异步压入的（机器人动作要等权威回传），
  // 因此条目顺序与引擎的窗口顺序并不一致（实测：窗口 77 的座位 1 弃牌被排在座位 0 的后续动作之后）。
  // 同窗口内保持原有相对顺序（稳定排序），编号缺失的排在最后。
  const commands = input.commands
    .filter(entry => entry.resolution !== 'expire' || !entry.windowId || !windowsWithCommand.has(entry.windowId))
    .map((entry, index) => ({ entry, index, no: entry.windowId ? Number(entry.windowId.split('/').pop()) : Number.NaN }))
    .sort((a, b) => {
      const an = Number.isFinite(a.no) ? a.no : Number.MAX_SAFE_INTEGER
      const bn = Number.isFinite(b.no) ? b.no : Number.MAX_SAFE_INTEGER
      return an - bn || a.index - b.index
    })
    .map(item => item.entry)
  const recorded = commands.length
  /** expire 判定计数：应用 / 因编号更小丢弃 / 因同窗口有命令被前置过滤丢弃。 */
  let expireApplied = 0
  let expireSkippedByNumber = 0
  /** 已经推进过的窗口编号：同一窗口常有多条 expire（主线程按计时器各压一条），只允许推进一次。 */
  let lastExpiredNo = Number.NaN
  const expireSkippedByFilter = input.commands.length - commands.length
  const expected = input.expectedScores && input.expectedScores.length === 4 ? [...input.expectedScores] : null
  const restored = openingFromReproduction(input.reproduction)
  if (!restored.opening) {
    return { ok: false, reason: restored.reason, submitted: 0, recorded, finalScores: [], expectedScores: expected, scoresMatch: null }
  }

  // 时钟必须可推进：expire 记录要把"当时靠超时推进"这件事重演出来
  let clock = 0
  let engine: BloodFlowEngine
  try {
    engine = new BloodFlowEngine({
      authorityEpoch: 'verify',
      roundId: `verify/${input.reproduction.roundIndex}`,
      opening: restored.opening,
      // 庄家是构造参数（引擎是 options.dealer ?? 0）：不传就"默认庄家 0"，
      // 于是引擎会把真庄家的第 14 张下标从座位 0 的手里删掉（实测报 Seat 0 has 12 effective tiles）。
      dealer: (input.reproduction.dealer ?? 0) as never,
      now: () => clock,
      winBeatMs: 0,
    })
  } catch (error) {
    // 开局数据不合格（例如庄家第 14 张的下标与手牌不一致、有效牌数不对）：
    // 引擎会拒绝重建 —— 这里如实报告原因，绝不让异常逃出去（校验器的职责是给出结论，不是抛错）。
    return {
      ok: false, submitted: 0, recorded, finalScores: [], expectedScores: expected, scoresMatch: null,
      reason: `开局数据不合格，引擎拒绝重建：${String(error).slice(0, 140)}`,
    }
  }

  const maxSteps = Math.max(1, input.maxSteps ?? 20_000)
  let cursor = 0
  let steps = 0
  const scoresNow = () => engine.players.map(player => player.score)
  // 窗口轨迹对照：重放实际见过的窗口集合 vs 已消费记录里涉及的窗口集合
  const seenWindows = new Set<string>()
  const windowTrace: string[] = []
  const pairedTrace: string[] = []
  /** 每个窗口编号被"进入"的次数：>1 说明重放在该窗口上多推进了一次（+1 偏移的直接证据）。 */
  const windowEntries = new Map<number, number>()
  let lastEntryNo = Number.NaN
  const recordedWindowsUpTo = (upTo: number) => new Set(
    commands.slice(0, upTo).map(entry => entry.windowId).filter((id): id is string => Boolean(id)),
  )

  while (!engine.result && steps < maxSteps) {
    steps += 1
    // 转场（结算演出等）会挡住下一个窗口：它不是隐藏信息，可由引擎状态推出，直接推进即可 ——
    // 否则重放会卡在转场里，下一条命令就报"该座位此刻没有合法动作"（实测四局都停在第 3 条）。
    if (!engine.window && engine.transition) { engine.advance(engine.transition.id); continue }
    if (engine.window) {
      seenWindows.add(engine.window.id)
      const noNow = Number(String(engine.window.id).split('/').pop())
      if (noNow !== lastEntryNo) {
        lastEntryNo = noNow
        if (Number.isFinite(noNow)) windowEntries.set(noNow, (windowEntries.get(noNow) ?? 0) + 1)
      }
      // 逐窗口轨迹（kind + 有合法动作的座位）：用来定位"重放在哪一步多推进了一次"
      if (windowTrace.length < 400) {
        const current = engine.window
        windowTrace.push(`${(current as { kind?: string }).kind ?? '?'}[${SEATS.filter(seat => current.options[seat].length > 0).join('')}]`)
      }
    }
    const command = commands[cursor]
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
      // 对照实验（第 61 轮）：曾试过"下一条真命令能落在当前窗口上就跳过这条 expire"，
      // 结果第 1 局从复现成功退回失败 ⇒ 记录里的 expire 是必需的，不能按这个规则跳过。已回退。
      // 相对编号判定：两侧窗口 id 末尾都是单调递增的编号（记录 round-1/window/39、重放 verify/1/window/42），
      // 因此用编号判断"这条 expire 说的是不是已经走过的窗口"。若它属于更早的窗口（编号更小），
      // 说明重放已经推进过它了，再应用一次就会多走窗口（此前观测到的 +3/+5 累积偏移）。
      const recordNo = command.windowId ? Number(command.windowId.split('/').pop()) : Number.NaN
      const replayNo = Number(String(current.id).split('/').pop())
      // 只应用"正好属于当前窗口"的 expire：编号更小 ⇒ 已经走过；**编号更大 ⇒ 属于还没走到的窗口**，
      // 提前应用会把引擎向前推（实测这正是残余偏移与提前胡牌的来源：重放比记录多走窗口）。
      if (Number.isFinite(recordNo) && Number.isFinite(replayNo) && recordNo !== replayNo) {
        expireSkippedByNumber += 1
        cursor += 1
        continue
      }
      // 同一窗口的重复 expire 只能推进一次：记录里常有三条（按座位/计时器各压一条），
      // 逐条应用会把引擎连推多次（实测残余偏移即此）。
      if (Number.isFinite(recordNo) && recordNo === lastExpiredNo) {
        expireSkippedByNumber += 1
        cursor += 1
        continue
      }
      if (Number.isFinite(recordNo)) lastExpiredNo = recordNo
      expireApplied += 1
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
      // 同 kind 候选的完整字段：直接看出是哪一项判否（tile/tiles/index/from/meldIndex），不再猜
      const sameKind = view.ownActions.filter(candidate => (candidate as { kind?: string }).kind === command.kind)
      const sameKindDump = sameKind.length
        ? sameKind.slice(0, 3).map(candidate => JSON.stringify(candidate)).join(' | ')
        : '（无同类候选）'
      // 状态分叉诊断：打印重放当时该座位的手牌与副露，便于与记录期望的动作对照
      // （记录里这一手的 index/tile 如果根本不在手牌里，说明状态在更早处已经分叉，而不是匹配不精确）。
      // 注意：座位视图只在 revealAll/engine.result 时暴露**他人**手牌，且顶层没有 hand 字段——
      // 此前读顶层 hand 恒为 0，产生过一次假信号（"该座位手牌 0 张"）。本家手牌在 players[seat].hand。
      const seatPlayer = (view as { players?: Array<{ hand?: string[]; melds?: unknown[] }> }).players?.[command.seat]
      const seatHand = seatPlayer?.hand ?? []
      const seatMelds = seatPlayer?.melds?.length ?? 0
      // 分叉点上下文：把"重放窗口"摊开，便于判断是窗口归属不同还是推进语义不同
      const current = engine.window
      const context = current
        ? ` 当前窗口 kind=${(current as { kind?: string }).kind ?? '?'} id=${current.id}`
          + ` 有合法动作的座位=[${SEATS.filter(candidate => current.options[candidate].length > 0).join(',')}]`
        : ' 当前没有窗口（可能处在转场中）'
      return {
        ok: false, submitted: cursor, recorded, finalScores: scoresNow(), expectedScores: expected, scoresMatch: null,
        reason: `第 ${cursor + 1} 条命令与当时的合法动作对不上（seat=${command.seat} kind=${command.kind}${command.tile ? ` tile=${command.tile}` : ''}${command.handIndex !== undefined ? ` index=${command.handIndex}` : ''}${command.windowId ? ` windowId=${command.windowId}` : ''}；当时的合法动作：${offered}；同类候选=${sameKindDump}；记录条目=${JSON.stringify(command)}；该座位手牌(${seatHand.length}张)=[${seatHand.join(' ')}] 副露=${seatMelds}；${context}；窗口轨迹：重放见过 ${seenWindows.size} 个窗口 / 已消费记录涉及 ${recordedWindowsUpTo(cursor + 1).size} 个窗口；expire 判定：应用 ${expireApplied} / 编号更小丢弃 ${expireSkippedByNumber} / 前置过滤丢弃 ${expireSkippedByFilter}；重入窗口=[${[...windowEntries].filter(([, count]) => count > 1).map(([no, count]) => `${no}×${count}`).join(' ') || '无'}]；该窗口在记录中的条目=[${(() => {
        const nowNo = engine.window ? Number(String(engine.window.id).split('/').pop()) : Number.NaN
        const owned = Number.isFinite(nowNo)
          ? commands.filter(entry => entry.windowId && Number(entry.windowId.split('/').pop()) === nowNo)
          : []
        return owned.length ? owned.map(entry => `${entry.seat}:${entry.kind}${entry.resolution ? `(${entry.resolution})` : ''}@${entry.windowId}`).join(' ') : '（空）'
      })()}]；配对轨迹=[${pairedTrace.slice(-30).join(' ')}]）`,
      }
    }
    engine.submit(engine.command(seat, action))
    // 配对轨迹：记录条目 → 应用时重放所处的窗口（kind + 有合法动作的座位）。人眼对齐两侧轨迹太慢，
    // 这里直接成对记录，失败时输出开头若干对，第一条对不上的地方就是偏移起点。
    if (pairedTrace.length < 60) {
      const current = engine.window
      pairedTrace.push(`${command.seat}:${command.kind}→${current ? `${(current as { kind?: string }).kind ?? '?'}[${SEATS.filter(s => current.options[s].length > 0).join('')}]` : 'none'}`)
    }
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
  // 提前终局：牌局结束了却还有未消费的记录条目 ⇒ 与记录不一致，不能算复现成功
  // （此前这种情况可能被判为 ok=true，只因"跑完了"；这在语义上是错的）。
  if (cursor < commands.length) {
    return {
      ok: false, submitted: cursor, recorded, finalScores, expectedScores: expected, scoresMatch: null,
      reason: `重放提前结束：只消费了 ${cursor}/${recorded} 条记录；牌墙剩余 ${engine.wall.length}，终局=${Boolean(engine.result)}`,
    }
  }
  const scoresMatch = expected ? expected.every((score, seat) => score === finalScores[seat]) : null
  return {
    ok: scoresMatch !== false, submitted: cursor, recorded, finalScores, expectedScores: expected, scoresMatch,
    reason: scoresMatch === false ? `结束分数不一致：记录 ${expected!.join('/')} ≠ 重跑 ${finalScores.join('/')}` : null,
  }
}
