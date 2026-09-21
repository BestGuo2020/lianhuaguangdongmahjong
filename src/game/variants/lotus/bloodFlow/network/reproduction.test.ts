// §6 联机路径的赛后私有复现数据：**权威端在局后产出的那份数据，必须真的能把这一局重跑到同一结束状态**。
//
// 这是联机分析记录的地基：客户端自己没有牌墙与对手暗手，能复现到什么程度完全取决于权威端给的这份数据。
// 因此这里的判据与单机路径（§10.6）用同一个校验器 `replayReproduction`，只是数据来源换成权威端产出。
//
// 覆盖四件事：
// 1. 四家真实提交着打完一局 → 权威端产出的数据可精确复现（分数一致、窗口类型零错位）；
// 2. 整局都靠超时推进 → 同样可复现（enumerate 的 expire 条目是重跑的唯一依据，§11）；
// 3. 进行中的局**拿不到**（§6：局后提供，进行中提供就是泄露）；
// 4. 权威已推进到下一局、或引擎没开命令记录时，如实返回 null（绝不给错局快照或缺命令的数据）。
import { describe, expect, it } from 'vitest'
import { BloodFlowAuthority } from './authority'
import { createDirectAuthorityBackend } from './backends'
import { BloodFlowReplica } from './replica'
import type { BloodFlowPacket } from './protocol'
import { decodeBloodFlowPacket } from './protocol'
import { SEATS } from '../state'
import { seededRandom } from '../simulation'
import { buildRingWall } from '../../lotusWall'
import { decideBloodFlowAction } from '../ai'
import { replayReproduction } from '../../../../replay/analysis/replayReproduction'
import { reproductionFromPayload, unavailableReproduction } from '../../../../replay/analysis/onlineReproduction'

function room(options: { recordCommands?: boolean; analysisMatchId?: string | null } = {}) {
  let now = 0
  const backend = createDirectAuthorityBackend(() => now, { winBeatMs: 0, recordCommands: options.recordCommands !== false })
  const queued: { peer: string; packet: BloodFlowPacket }[] = []
  const replicas = SEATS.map(seat => new BloodFlowReplica('room', 'p0', seat, () => {}))
  const host = new BloodFlowAuthority({ roomId: 'room', authorityEpoch: 'epoch', hostPeer: 'p0', mode: 'east', backend,
    seatByPeer: new Map(SEATS.map(s => [`p${s}`, s])), now: () => now,
    prepareOpening: async round => ({ initialWall: buildRingWall(seededRandom(47 + round)), firstDice: [2, 3], secondDice: [3, 4] }),
    ...(options.analysisMatchId === undefined ? {} : { analysisMatchId: () => options.analysisMatchId ?? null }),
    send: (peer, packet) => queued.push({ peer, packet }) })
  const flush = () => {
    const packets = queued.splice(0)
    for (const { peer, packet } of packets) replicas[Number(peer.slice(1))]?.receive(packet, 'p0')
    return packets
  }
  return { backend, host, replicas, flush, time: (n: number) => { now = n } }
}

async function start(r: ReturnType<typeof room>) {
  for (const seat of [1, 2, 3]) await r.host.receive(r.replicas[seat].hello(), `p${seat}`)
  await r.host.start()
  const packets = r.flush()
  for (const seat of SEATS) {
    await r.host.receive({ ...r.replicas[seat].hello(), kind: 'blood_flow_opening_done', authorityEpoch: 'epoch', round: 1 }, `p${seat}`)
  }
  packets.push(...r.flush())
  return packets
}

/** 四个座位各自按自己的视角提交动作，把这一局打完（与 network.test.ts 的四端用例同一驱动方式）。 */
async function playByCommands(r: ReturnType<typeof room>) {
  let steps = 0
  while (!r.backend.engine.result) {
    if (++steps > 3_000) throw new Error('stalled')
    const engine = r.backend.engine, window = engine.window!
    const seat = SEATS.find(s => window.options[s].length && !window.decisions[s])!
    const action = decideBloodFlowAction(r.replicas[seat].view!)
    expect(action).toBeTruthy()
    await r.host.receive({ ...r.replicas[seat].hello(), kind: 'blood_flow_command', command: engine.command(seat, action!) }, `p${seat}`)
    r.flush()
  }
}

describe('§6 权威端产出的赛后私有复现数据', () => {
  it('四家提交打完一局：权威端产出的数据可重跑到同一结束状态', async () => {
    const r = room(); await start(r)
    await playByCommands(r)
    const settled = r.backend.engine.result!
    expect(r.backend.engine.recordedCommands.length).toBeGreaterThan(10)
    // 局后（已结算）才拿得到
    const payload = await r.host.reproduction('m-1', 1)
    expect(payload).not.toBeNull()
    expect(payload!.roundIndex).toBe(1)
    expect(payload!.matchId).toBe('m-1')
    expect(payload!.initialWall.length).toBe(81)
    // 东 1 局的庄家是座位 0（权威按 (round-1)%4 定庄）：庄家手里 14 张，其余 13 张
    expect(payload!.initialHands.map(hand => hand.length)).toEqual([14, 13, 13, 13])
    expect(payload!.dealer).toBe(0)
    expect(payload!.dealerDrawnIndex).toBe(13)
    expect(payload!.openingScores).toEqual([2000, 2000, 2000, 2000])
    // 承诺洗牌给的骰子随数据一起记（§6 明列要存骰子）
    expect(payload!.dice).toEqual({ first: [2, 3], second: [3, 4] })

    const verification = replayReproduction({
      reproduction: reproductionFromPayload(payload!),
      commands: payload!.commands,
      expectedScores: settled.endingScores,
    })
    expect(verification.reason).toBeNull()
    expect(verification.ok).toBe(true)
    expect(verification.scoresMatch).toBe(true)
    expect(verification.kindMismatches).toBe(0)
    expect(verification.submitted).toBe(verification.recorded)
  }, 30_000)

  it('整局都靠超时推进：expire 条目同样能重跑到同一结束状态', async () => {
    const r = room(); await start(r)
    let steps = 0
    while (!r.backend.engine.result) {
      if (++steps > 500) throw new Error('stalled')
      r.time((r.backend.engine.window?.deadlineAt ?? 0) + 1)
      await r.host.tick()
      r.flush()
    }
    const payload = await r.host.reproduction('m-1', 1)
    expect(payload).not.toBeNull()
    // 这一局没有任何座位提交过动作：全部推进都是 expire（重跑时按记录把时钟推过截止时间）
    expect(payload!.commands.every(entry => entry.resolution === 'expire')).toBe(true)
    expect(payload!.commands[0]!.windowKind).toBe('turn')
    const verification = replayReproduction({
      reproduction: reproductionFromPayload(payload!),
      commands: payload!.commands,
      expectedScores: r.backend.engine.result!.endingScores,
    })
    expect(verification.reason).toBeNull()
    expect(verification.ok).toBe(true)
    expect(verification.scoresMatch).toBe(true)
    expect(verification.metrics.expireApplied).toBeGreaterThan(0)
  }, 30_000)

  it('进行中的局拿不到复现数据（§6：只在局后提供）', async () => {
    const r = room(); await start(r)
    expect(await r.host.reproduction('m-1', 1)).toBeNull()
  })

  it('权威已推进到下一局后，旧局不再产出（不给错局快照）', async () => {
    const r = room(); await start(r)
    await playByCommands(r)
    expect(await r.host.reproduction('m-1', 1)).not.toBeNull()
    // 四家都回执继续 → 权威进入第 2 局；此时再要第 1 局的数据只能是错局快照，必须拒绝
    for (const seat of SEATS) {
      await r.host.receive({ ...r.replicas[seat].hello(), kind: 'blood_flow_continue', authorityEpoch: 'epoch', round: 1 }, `p${seat}`)
    }
    r.flush()
    expect(r.host.round).toBe(2)
    expect(await r.host.reproduction('m-1', 1)).toBeNull()
  }, 30_000)

  it('引擎没开命令记录时如实拿不到（不能给一份跑不动的"完整数据"）', async () => {
    const r = room({ recordCommands: false }); await start(r)
    await playByCommands(r)
    expect(r.backend.engine.recordedCommands).toEqual([])
    expect(await r.host.reproduction('m-1', 1)).toBeNull()
  }, 30_000)
})

describe('拿不到时的记录口径（§6：明确标记，不猜测补齐）', () => {
  it('标成不可用并保留原因，且不带任何"看似可用"的字段', () => {
    const record = unavailableReproduction(2, '权威端未提供赛后复现数据')
    expect(record).toEqual({ roundIndex: 2, available: false, unavailableReason: '权威端未提供赛后复现数据' })
    expect(record.initialWall).toBeUndefined()
    expect(record.commands).toBeUndefined()
  })

  it('分析场次 id 随快照下发，客机据此把自己的分析挂在同一场次下', async () => {
    const r = room({ analysisMatchId: 'match-9' })
    const frames = (await start(r)).filter(entry => entry.packet.kind === 'blood_flow_snapshot' || entry.packet.kind === 'round_settled')
    expect(frames.length).toBeGreaterThan(0)
    for (const frame of frames) expect((frame.packet as { analysisMatchId?: string }).analysisMatchId).toBe('match-9')
    // 客机收下的那份也要带上（replica 直接透传信封）
    expect(r.replicas[1].view).not.toBeNull()
    // 畸形场次 id（非字符串/空串）必须被报文校验拒收，不能让客机拿它去建分析区
    const broken = { ...(frames[0]!.packet as unknown as Record<string, unknown>), analysisMatchId: 7 }
    expect(decodeBloodFlowPacket(broken)).toBeNull()
  })

  it('房主没开分析记录时不下发场次 id（客机如实记"未提供"）', async () => {
    const frames = (await start(room({ analysisMatchId: null }))).filter(entry => entry.packet.kind === 'blood_flow_snapshot')
    expect(frames.length).toBeGreaterThan(0)
    for (const frame of frames) expect(frame.packet).not.toHaveProperty('analysisMatchId')
  })
})
