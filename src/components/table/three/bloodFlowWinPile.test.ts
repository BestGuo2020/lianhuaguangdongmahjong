import { winDisplayLayout } from '../../../game/core/presentation/winEffect'
import { describe, expect, it } from 'vitest'
import type { WinBatch } from '../../../game/variants/lotus/bloodFlow/types'
import { bloodFlowWinPiles } from './bloodFlowWinPile'
import { SEATS, vector } from '../../../game/variants/lotus/bloodFlow/state'
import { scorePatterns } from '../../../game/variants/lotus/patterns/score'

function batches(count: number): WinBatch[] {
  return Array.from({ length: count }, (_, ordinal) => SEATS.map((winner): WinBatch => {
    const batchId = `batch-${ordinal}-${winner}`, sourceEventId = `source-${ordinal}-${winner}`
    const deltas = vector(s => s === winner ? 120 : -40)
    return { authorityEpoch: 'fixture', roundId: '1', sequence: ordinal * 4 + winner,
      ruleVersion: 'lotus-blood-flow-v1', windowId: batchId, batchId,
      source: { id: sourceEventId, tile: 'm1', seat: winner, kind: 'draw' }, deltas, scoresAfter: [2000, 2000, 2000, 2000],
      nextAction: { kind: 'finish-round', reason: 'wall-exhausted' },
      winners: [{ id: `record-${ordinal}-${winner}`, batchId, winner, ordinal: ordinal + 1, sourceEventId,
        score: scorePatterns(['pinghu'], true, 'self-draw'), deltas }] }
  })).flat()
}
describe('E05 display references and capacities', () => {
  for (const compact of [false, true]) for (const viewer of [0, 1, 2, 3]) {
    it.each([0, 1, 4, 5, 13, 25, 41, 80])(`capacity %i / compact=${compact} viewer=${viewer}`, count => {
      const source = batches(count), before = JSON.stringify(source)
      const layout = bloodFlowWinPiles(source, viewer, compact)
      for (const pile of layout) {
        expect(pile.count).toBe(count)
        if(count) {
          const anchor=winDisplayLayout(pile.relativeSeat),first=pile.tiles[0]
          expect({x:first.x,y:first.y,z:first.z,rotation:first.rotation}).toEqual(anchor)
          const next=pile.tiles[compact?3:4]
          if(next) { expect(next.x).toBe(first.x);expect(next.z).toBe(first.z);expect(next.y-first.y).toBeCloseTo(.46) }
        }
        expect(pile.tiles).toHaveLength(count)
        expect(pile.levels).toBe(Math.ceil(count / (compact ? 3 : 4)))
        expect(pile.overflow + pile.tiles.length).toBe(count)
        expect(pile.absoluteSeat).toBe((pile.relativeSeat + viewer) % 4)
        for (const tile of pile.tiles) {
          expect(tile.record.winner).toBe(pile.absoluteSeat)
          expect(tile.sourceEventId).toBe(`source-${tile.record.ordinal - 1}-${tile.record.winner}`)
          expect(tile.tile).toBe('m1')
          expect(tile.level).toBe(Math.floor((tile.record.ordinal - 1) / (compact ? 3 : 4)))
        }
      }
      expect(JSON.stringify(source)).toBe(before)
      expect(bloodFlowWinPiles([...source, ...source], viewer, compact)).toEqual(layout)
    })
  }
})
