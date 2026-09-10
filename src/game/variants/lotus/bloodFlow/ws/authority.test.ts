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

it('passes opening dice through to the view meta for the opening animation', () => {
  const views: Array<{ meta: { opening?: unknown } }> = []
  const authority = createBloodFlowWsAuthority({
    transport: { send: () => true },
    onView: (_view, meta) => views.push({ meta }),
  })
  authority.feed({ kind: 'bf_snapshot', view: VIEW, round: 0, mode: 'east', dealer: 0,
    opening: { firstDice: [3, 5], secondDice: [1, 6] } })
  authority.feed({ kind: 'bf_snapshot', view: VIEW, round: 0, mode: 'east', dealer: 0,
    opening: { firstDice: [3], secondDice: [1, 6] } })
  authority.feed({ kind: 'bf_snapshot', view: VIEW, round: 0, mode: 'east', dealer: 0 })
  expect(views[0].meta.opening).toEqual({ firstDice: [3, 5], secondDice: [1, 6] })
  expect(views[1].meta.opening).toBeUndefined()
  expect(views[2].meta.opening).toBeUndefined()
})

it('passes the settled continuation counter through to the view meta', () => {
  const metas: Array<Record<string, unknown>> = []
  const authority = createBloodFlowWsAuthority({
    transport: { send: () => true },
    onView: (_view, meta) => metas.push(meta as unknown as Record<string, unknown>),
  })
  authority.feed({ kind: 'bf_snapshot', view: VIEW, round: 0, mode: 'east', dealer: 0,
    continuation: { readySeats: [0, 2], requiredSeats: [0, 1, 2, 3] } })
  authority.feed({ kind: 'bf_snapshot', view: VIEW, round: 0, mode: 'east', dealer: 0,
    continuation: { readySeats: [9], requiredSeats: [0] } })
  expect(metas[0].continuation).toEqual({ readySeats: [0, 2], requiredSeats: [0, 1, 2, 3] })
  expect(metas[1].continuation).toBeUndefined()
})

it('sends opening_done acknowledgements for the ready barrier', () => {
  const sent: Record<string, unknown>[] = []
  const authority = createBloodFlowWsAuthority({
    transport: { send: (message) => { sent.push(message); return true } },
    onView: () => {},
  })
  authority.openingDone(2)
  expect(sent).toEqual([{ kind: 'opening_done', round: 2 }])
})

it('sends continue for the inter-round barrier using the latest round', () => {
  const sent: Record<string, unknown>[] = []
  const authority = createBloodFlowWsAuthority({
    transport: { send: (message) => { sent.push(message); return true } },
    onView: () => {},
  })
  authority.feed({ kind: 'bf_snapshot', view: VIEW, round: 2, mode: 'east', dealer: 0 })
  authority.continueRound()
  expect(sent).toEqual([{ kind: 'continue', round: 2 }])
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

it('routes server model speech and TTS audio, ignoring malformed payloads', () => {
  const speech: unknown[] = []
  const audio: unknown[] = []
  const authority = createBloodFlowWsAuthority({
    transport: { send: () => true },
    onView: () => {},
    onSpeech: (message) => speech.push(message),
    onAudio: (message) => audio.push(message),
  })
  authority.feed({ kind: 'llm_message', id: 7, seat: 1, text: '这张先走。', priority: 'normal',
    purpose: 'commentary', speechSource: 'model-message' })
  authority.feed({ kind: 'llm_message', id: 8, seat: 2, text: '胡了。', priority: 'important',
    purpose: 'action', speechSource: 'model-message', actionKind: 'win' })
  // 非法载荷：缺 id / 座位越界 / 空文本 / 缺音频地址。
  authority.feed({ kind: 'llm_message', seat: 1, text: 'x' })
  authority.feed({ kind: 'llm_message', id: 9, seat: 9, text: 'x' })
  authority.feed({ kind: 'llm_message', id: 10, seat: 1, text: '' })
  authority.feed({ kind: 'llm_audio', messageId: 11, seat: 1, audioUrl: '/api/local-tts/audio/a.mp3',
    priority: 'important', purpose: 'action', speechSource: 'model-message' })
  authority.feed({ kind: 'llm_audio', messageId: 12, seat: 1 })

  expect(speech).toEqual([
    { id: 7, seat: 1, text: '这张先走。', priority: 'normal', purpose: 'commentary',
      speechSource: 'model-message' },
    { id: 8, seat: 2, text: '胡了。', priority: 'important', purpose: 'action',
      speechSource: 'model-message', actionKind: 'win' },
  ])
  expect(audio).toEqual([{ messageId: 11, seat: 1, audioUrl: '/api/local-tts/audio/a.mp3',
    priority: 'important', purpose: 'action', speechSource: 'model-message' }])
})
