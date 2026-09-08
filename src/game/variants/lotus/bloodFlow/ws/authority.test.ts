import { expect, it } from 'vitest'
import { createBloodFlowWsAuthority } from './authority'

const VIEW = {
  authorityEpoch: 'bf-ROOM', roundId: 'round-0', version: 3, seat: 0 as const,
  players: [
    { name: '玩家1', avatar: '', score: 2000, seat: 0, hand: ['m1', 'm2'], concealedTileCount: 14,
      discards: [], melds: [], redCount: 0, drawnTileIndex: 13 },
    { name: '玩家2', avatar: '', score: 2000, seat: 1, hand: [], concealedTileCount: 13,
      discards: [], melds: [], redCount: 0, drawnTileIndex: -1 },
    { name: '玩家3', avatar: '', score: 2000, seat: 2, hand: [], concealedTileCount: 13,
      discards: [], melds: [], redCount: 0, drawnTileIndex: -1 },
    { name: '玩家4', avatar: '', score: 2000, seat: 3, hand: [], concealedTileCount: 13,
      discards: [], melds: [], redCount: 0, drawnTileIndex: -1 },
  ],
  currentPlayer: 0, wallCount: 80, headDrawn: 53, flipTile: 'p9', jokers: ['red', 'green'],
  flipStack: 0, flipSeat: 0, wallBreakIndex: 2,
  window: { id: 'round-0/window/3', version: 3, kind: 'turn', deadlineAt: 999, opensAt: 0,
    source: { id: 's', kind: 'draw', tile: 'm2', seat: 0 } },
  ownActions: [{ kind: 'discard', index: 13 }, { kind: 'discard', index: 0 }],
  ownScore: null, waitingSeats: [0],
  public: { ruleVersion: 'lotus-blood-flow-v1', roundId: 'round-0', status: 'playing',
    seats: [{ winCount: 0, locked: false, firstWinSequence: null, recordIds: [] },
      { winCount: 0, locked: false, firstWinSequence: null, recordIds: [] },
      { winCount: 0, locked: false, firstWinSequence: null, recordIds: [] },
      { winCount: 0, locked: false, firstWinSequence: null, recordIds: [] }],
    batches: [], roundResult: null },
  actionEvents: [], lastDiscardAction: null, kongEvents: [],
}

it('feeds bf_snapshot views with meta and ignores malformed payloads', () => {
  const views: unknown[] = []
  const authority = createBloodFlowWsAuthority({
    transport: { send: () => true },
    onView: (view, meta) => views.push({ view, meta }),
  })
  authority.feed({ kind: 'bf_snapshot', view: VIEW, round: 2, mode: 'hanchan', dealer: 1, matchFinished: false })
  expect(views).toHaveLength(1)
  expect((views[0] as { meta: Record<string, unknown> }).meta).toEqual({
    round: 2, mode: 'hanchan', dealer: 1, matchFinished: false,
  })
  authority.feed({ kind: 'bf_snapshot', view: { not: 'a view' }, round: 0, mode: 'east', dealer: 0 })
  authority.feed({ kind: 'rejoin_ok' })
  authority.feed('junk')
  expect(views).toHaveLength(1)
})

it('sends engine commands as authoritative action messages', () => {
  const sent: Record<string, unknown>[] = []
  const authority = createBloodFlowWsAuthority({
    transport: { send: (message) => { sent.push(message); return true } },
    onView: () => {},
  })
  expect(authority.send({
    authorityEpoch: 'bf-ROOM', roundId: 'round-0', windowId: 'round-0/window/3',
    stateVersion: 3, seat: 0, action: { kind: 'discard', index: 13 },
  })).toBe(true)
  expect(sent).toEqual([{
    kind: 'action', windowId: 'round-0/window/3', stateVersion: 3,
    action: { kind: 'discard', index: 13 },
  }])
})

it('reports backend error codes and silences after close', () => {
  const errors: string[] = []
  const authority = createBloodFlowWsAuthority({
    transport: { send: () => true },
    onView: () => {},
    onError: (code) => errors.push(code),
  })
  authority.feed({ kind: 'error', code: 'STALE_ACTION' })
  expect(errors).toEqual(['STALE_ACTION'])
  authority.close()
  authority.feed({ kind: 'error', code: 'INVALID_ACTION' })
  expect(errors).toEqual(['STALE_ACTION'])
})
