import { describe, expect, it, vi } from 'vitest'
import { BloodFlowAuthority } from './authority'
import { createDirectAuthorityBackend } from './backends'
import { BloodFlowReplica } from './replica'
import { decodeBloodFlowPacket } from './protocol'
import type { BloodFlowPacket } from './protocol'
import { BLOOD_FLOW_CONFIG } from '../config'
import { SEATS } from '../state'
import type { Seat } from '../types'
import { seededRandom } from '../simulation'
import { buildRingWall } from '../../lotusWall'
import { decideBloodFlowAction } from '../ai'

function room(extra: Partial<ConstructorParameters<typeof BloodFlowAuthority>[0]> = {}) {
  let now = 0
  const backend = createDirectAuthorityBackend(() => now, { winBeatMs: 0 })
  const queued: { peer: string; packet: BloodFlowPacket }[] = []
  const sync = vi.fn()
  const replicas = SEATS.map(seat => new BloodFlowReplica('room', 'p0', seat, sync))
  const settled = vi.fn()
  const host = new BloodFlowAuthority({ ...extra, roomId: 'room', authorityEpoch: 'epoch', hostPeer: 'p0', mode: 'east', backend,
    seatByPeer: new Map(SEATS.map(s => [`p${s}`, s])), now: () => now,
    prepareOpening: async round => ({ initialWall: buildRingWall(seededRandom(47 + round)), firstDice: [2, 3], secondDice: [3, 4] }),
    send: (peer, packet) => queued.push({ peer, packet }), onRoundSettled: settled })
  const flush = (reverse = false) => {
    const packets = queued.splice(0); if (reverse) packets.reverse()
    for (const { peer, packet } of packets) replicas[Number(peer.slice(1))]?.receive(packet, 'p0')
    return packets
  }
  return { backend, host, replicas, flush, queued, settled, sync, time: (n: number) => { now = n } }
}
async function start(r: ReturnType<typeof room>) {
  for (const seat of [1, 2, 3]) await r.host.receive(r.replicas[seat].hello(), `p${seat}`)
  await r.host.start(); r.flush()
  for (const seat of SEATS) await r.host.receive({ ...r.replicas[seat].hello(), kind: 'blood_flow_opening_done', authorityEpoch: 'epoch', round: 1 }, `p${seat}`)
  r.flush()
}
describe('E06 four-endpoint authority and recovery', () => {
  it('projects committed kong receipts in an optional envelope without changing the legacy seat view shape',async()=>{
    const r=room();await start(r)
    const e=r.backend.engine
    const receipt={kind:'kong' as const,id:'round-1/kong/1',authorityEpoch:'epoch',roundId:e.options.roundId,sequence:1,actor:0 as const,kongKind:'concealed' as const,sourceSeat:null,
      deltas:[60,-20,-20,-20] as const,scoresAfter:[2060,1980,1980,1980] as const}
    e.ledger.push(receipt);e.players.forEach((p,i)=>{p.score=receipt.scoresAfter[i]})
    await r.host.receive({...r.replicas[0].hello(),kind:'blood_flow_auto',authorityEpoch:'epoch',enabled:true},'p0')
    const messages=r.flush()
    const frame=messages.find(m=>m.peer==='p0'&&m.packet.kind==='blood_flow_snapshot')!.packet as Extract<BloodFlowPacket,{kind:'blood_flow_snapshot'}>
    expect(frame.kongEvents).toEqual([receipt]);expect(frame.view).not.toHaveProperty('kongEvents')
    expect(r.replicas[2].view?.kongEvents).toEqual([receipt])
    const bad=structuredClone(frame);bad.kongEvents=[{...receipt,deltas:[60,-20,-20,0]}]
    expect(decodeBloodFlowPacket(bad)).toBeNull()
  })
  it('expires an overdue AI turn instead of repeatedly submitting rejected bot decisions', async () => {
    const r = room(); await start(r)
    r.host.aiSeats.add(0)
    const id = r.backend.engine.window!.id
    const bot = vi.spyOn(r.backend, 'bot')
    r.time(r.backend.engine.window!.deadlineAt)
    await r.host.tick()
    expect(bot).not.toHaveBeenCalled()
    expect(r.backend.engine.window?.id).not.toBe(id)
    expect([...r.backend.engine.jokers,'white']).not.toContain(r.backend.engine.discardActions.at(-1)?.tile)
    r.backend.engine.assertConservation()
  })
  // 2026-09-14 自愈：decide 是权威链里唯一等外部的 await（大模型请求可能很慢甚至不返回）。
  // 它挂住时整条串行链（窗口过期、快照广播、命令校验）都排不上队，线上表现为"双方停在等待、只剩托管"。
  it('挂死的机器人决策不再冻结权威链：超时后回落引擎机器人策略并继续推进', async () => {
    const hanging = new Promise<never>(() => {})
    const r = room({ decide: () => hanging, botDecisionTimeoutMs: 20 })
    await start(r)
    r.host.aiSeats.add(0)
    const id = r.backend.engine.window!.id
    const bot = vi.spyOn(r.backend, 'bot')
    await r.host.tick()
    expect(r.host.botDecisionTimeouts).toBe(1)
    expect(bot).toHaveBeenCalled()
    expect(r.backend.engine.window?.id).not.toBe(id)
    r.backend.engine.assertConservation()
  })

  it('预算内的正常决策仍被采用（不误判为超时）', async () => {
    let decide: (() => Promise<import('../state').BloodFlowAction | null>) | null = null
    const r = room({ decide: () => decide!(), botDecisionTimeoutMs: 1_000 })
    await start(r)
    r.host.aiSeats.add(0)
    const actions = r.backend.engine.window!.options[0]
    const chosen = actions.find(a => a.kind !== 'pass') ?? actions[0]
    const spy = vi.fn(async () => chosen)
    decide = spy
    const bot = vi.spyOn(r.backend, 'bot')
    await r.host.tick()
    expect(spy).toHaveBeenCalled()
    expect(r.host.botDecisionTimeouts).toBe(0)
    expect(bot).not.toHaveBeenCalled()
    r.backend.engine.assertConservation()
  })

  // 2026-09-14 第二轮自愈：线上 trace 实测（房间 G626L9）卡死时权威的最后一条 tick 停在
  // window 79、引擎已走到 window 80，卡住前最后发生的是"一次 45KB 快照分 12 片广播"，
  // 而决策超时计数为 0 —— 说明冻住的是引擎/传输 await（view/expire/command/bot/publish），
  // 不是决策。这里把每个这类调用都做成有界：超时跳过本次、下一轮重试，链永远有界推进。
  it('读视图挂死时权威链仍有界推进（超时跳过 + 计数 + 下一轮恢复）', async () => {
    const traces: string[] = []
    const r = room({ workerTimeoutMs: 20, trace: message => traces.push(message) })
    await start(r)
    const base = r.backend
    const original = base.view.bind(base)
    let hang = true
    base.view = (seat: Seat) => (hang ? new Promise<never>(() => {}) : original(seat))
    const id = r.backend.engine.window!.id
    r.host.aiSeats.add(0)
    await r.host.tick()
    expect(traces.join(' | '), traces.join(' | ')).toContain('超时')
    expect(r.host.workerCallTimeouts).toBeGreaterThan(0)
    // 关键：即使读不到该座位的视图，机器人回落（backend.bot）仍把这一手打完，窗口照常推进。
    expect(r.backend.engine.window?.id).not.toBe(id)
    r.backend.engine.assertConservation()
    // 视图恢复后：连续 tick 不再超时（链健康、无残留阻塞）。后续窗口属于真人座位，
    // 需要真人的 blood_flow_command 才推进，所以这里只断言"不再超时"。
    hang = false
    const timeoutsBefore = r.host.workerCallTimeouts
    for (let round = 0; round < 3; round += 1) await r.host.tick()
    expect(r.host.workerCallTimeouts).toBe(timeoutsBefore)
    r.backend.engine.assertConservation()
  })

  it('过期操作挂死时也不会冻结链：tick 有界返回，下一轮继续', async () => {
    const traces: string[] = []
    const r = room({ workerTimeoutMs: 20, trace: message => traces.push(message) })
    await start(r)
    const base = r.backend
    const originalExpire = base.expire.bind(base)
    let hang = true
    let lastWindowId = ''
    base.expire = (windowId: string) => {
      lastWindowId = windowId
      return hang ? new Promise<never>(() => {}) : originalExpire(windowId)
    }
    r.host.aiSeats.add(0)
    const id = r.backend.engine.window!.id
    r.time(r.backend.engine.window!.deadlineAt)
    await r.host.tick()
    expect(traces.join(' | '), traces.join(' | ')).toContain('超时')
    expect(r.host.workerCallTimeouts).toBeGreaterThan(0)
    expect(lastWindowId).toBe(id)
    hang = false
    await r.host.tick()
    expect(r.backend.engine.window?.id).not.toBe(id)
    r.backend.engine.assertConservation()
  })

  it('refuses unknown versions and refuses start before every human has a compatible client', async () => {    const r = room()
    await r.host.receive({ kind: 'blood_flow_hello', roomId: 'room', ruleVersion: 'old' }, 'p1')
    expect(r.queued[0].packet).toMatchObject({ kind: 'blood_flow_error', code: 'INCOMPATIBLE_RULE_VERSION' })
    await expect(r.host.start()).rejects.toThrow('INCOMPATIBLE_RULE_VERSION')
  })
  it('rejects peer-seat impersonation, unknown peers and stale epochs before mutation', async () => {
    const r = room(); await start(r)
    const command = r.backend.engine.command(0, r.backend.engine.window!.options[0][0])
    const packet = { ...r.replicas[0].hello(), kind: 'blood_flow_command', command }
    const before = JSON.stringify(r.backend.engine.players)
    await r.host.receive(packet, 'p1'); await r.host.receive(packet, 'intruder')
    await r.host.receive({ ...packet, command: { ...command, authorityEpoch: 'old' } }, 'p0')
    expect(JSON.stringify(r.backend.engine.players)).toBe(before)
    expect(r.replicas[1].receive(r.flush()[0]?.packet, 'p2')).toBe(false)
  })
  it('four views complete a round through alternating snapshot-first/batch-first delivery and duplicates', async () => {
    const r = room(); await start(r)
    let steps = 0
    while (!r.backend.engine.result) {
      if (++steps > 2000) throw new Error('stalled')
      const e = r.backend.engine, w = e.window!
      const seat = SEATS.find(s => w.options[s].length && !w.decisions[s])!
      const moves = r.replicas[seat].view!.ownActions
      const action = decideBloodFlowAction(r.replicas[seat].view!)!
      const command = e.command(seat, action)
      const packet = { ...r.replicas[seat].hello(), kind: 'blood_flow_command', command }
      await r.host.receive(packet, `p${seat}`)
      const delivered = r.flush(steps % 2 === 0)
      for (const d of delivered) r.replicas[Number(d.peer.slice(1))].receive(d.packet, 'p0')
      await r.host.receive(packet, `p${seat}`) // response replay cannot pay again
      r.flush()
      for (const replica of r.replicas) {
        expect(replica.view!.players.map(p => p.score)).toEqual(e.players.map(p => p.score))
        expect(replica.view!.public.batches.map(b => b.batchId)).toEqual(e.publicState().batches.map(b => b.batchId))
      }
    }
    expect(r.settled).toHaveBeenCalledTimes(1)
    expect(r.replicas.map(c => c.completedRounds.size)).toEqual([1, 1, 1, 1])
    expect(r.replicas[0].view!.public.batches.length).toBeGreaterThan(0)
    const replay = r.replicas[1].view!
    await r.host.receive({ ...r.replicas[1].hello(), kind: 'blood_flow_sync' }, 'p1')
    r.flush()
    expect(r.replicas[1].view).toEqual(replay)
    expect(r.settled).toHaveBeenCalledTimes(1)
    await r.host.receive({...r.replicas[0].hello(),kind:'blood_flow_continue',authorityEpoch:'epoch',round:1},'p0')
    const ready=r.flush().find(d=>d.peer==='p0'&&d.packet.kind==='round_settled')!.packet as Extract<BloodFlowPacket,{kind:'round_settled'}>
    expect(ready.continuation).toEqual({requiredSeats:[0,1,2,3],readySeats:[0]})
    expect(r.backend.engine.options.roundId).toBe(replay.roundId)
  }, 20_000) // Full four-replica round plus common AI; independent from a single decision's deadline.
  it('waits out Relay recovery grace and pauses all moves during host interruption', async () => {
    const r = room(); await start(r)
    r.host.peerDisconnected('p1'); r.time(11_999); await r.host.tick()
    expect(r.host.aiSeats.has(1)).toBe(false)
    await r.host.receive(r.replicas[1].hello(), 'p1')
    expect(r.host.disconnected.has('p1')).toBe(false)
    await r.host.pause(); r.flush()
    const before = r.backend.engine.version
    r.time(100_000); await r.host.tick()
    expect(r.backend.engine.version).toBe(before)
    expect(r.replicas[0].view!.ownActions).toHaveLength(0)
    await r.host.resume(); r.flush()
    expect(r.backend.engine.window!.deadlineAt).toBeGreaterThan(100_000)
    const ledger = r.replicas[0].view!.public.batches
    r.host.interrupt(); r.flush()
    r.replicas[0].interrupt()
    expect(r.replicas[0].view!.public.batches).toEqual(ledger)
    expect(r.replicas[0].view!.public.roundResult).toBeNull()
  })
  it('rejects a snapshot containing an opponent concealed hand or private scoring evidence', async () => {
    const r = room(); await start(r)
    await r.host.receive({ ...r.replicas[1].hello(), kind: 'blood_flow_sync' }, 'p1')
    const packet = structuredClone(r.queued[0].packet) as any
    expect(decodeBloodFlowPacket(packet)).not.toBeNull()
    packet.view.players[0].hand = ['m1']
    expect(decodeBloodFlowPacket(packet)).toBeNull()
    packet.view.players[0].hand = []
    packet.view.public.privateEvidence = { hand: ['m1'] }
    expect(decodeBloodFlowPacket(packet)).toBeNull()
  })
})
