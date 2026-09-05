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

function room() {
  let now = 0
  const backend = createDirectAuthorityBackend(() => now, { winBeatMs: 0 })
  const queued: { peer: string; packet: BloodFlowPacket }[] = []
  const sync = vi.fn()
  const replicas = SEATS.map(seat => new BloodFlowReplica('room', 'p0', seat, sync))
  const settled = vi.fn()
  const host = new BloodFlowAuthority({ roomId: 'room', authorityEpoch: 'epoch', hostPeer: 'p0', mode: 'east', backend,
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
  it('refuses unknown versions and refuses start before every human has a compatible client', async () => {
    const r = room()
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
