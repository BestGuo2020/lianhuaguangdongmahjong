// Deterministic presentation fixture; real-engine recording is covered by replay.spec.ts.
import { createReplayStorage } from '../../../src/game/replay/storage'
import { defaultAvatarForSeat } from '../../../src/game/core/presentation/avatar'
import type { ReplayMatch, ReplayRound, ReplayStep } from '../../../src/game/replay/types'
import type { TileType } from '../../../src/game/core/contracts/types'

const rulesetId = (new URLSearchParams(location.search).get('ruleset') ?? 'lotus-classic') as ReplayMatch['rulesetId']
const match: ReplayMatch = {
  id: 'mobile-layout', schemaVersion: 1, rulesetId, rulesetName: '移动端回放验收',
  matchType: 'east', matchName: '东风场', gameMode: 'local', themeName: 'jade', humanSeat: 0,
  players: [0, 1, 2, 3].map(seat => ({ seat, name: `玩家${seat}的完整长昵称`, avatar: defaultAvatarForSeat(seat), startScore: 2000 })),
  startedAt: Date.now(), endedAt: Date.now(), status: 'finished', roundCount: 2, myRank: 1, summary: '布局验收',
}
const hands: TileType[][] = [
  ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'p1', 'p2', 'p3', 's1', 's2', 's3', 'east'],
  ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'p1', 'p2', 'p3', 's1', 's2', 's3', 'south'],
  ['m7', 'm8', 'm9', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9', 's4', 's5', 's6', 'west'],
  ['m7', 'm8', 'm9', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9', 's4', 's5', 's6', 'north'],
]
const storage = createReplayStorage({ onError: error => { throw error } })
await storage.saveMatch(match)
for (const roundIndex of [1, 2]) {
  const steps: ReplayStep[] = Array.from({ length: 16 }, (_, i) => {
    const seat = Math.floor(i / 2) % 4
    return { t: i % 2 ? 'discard' : 'draw', seat, tile: 's9', wallLeft: 83 - Math.floor(i / 2),
      headDrawn: 52 + Math.ceil(i / 2), currentPlayer: seat,
      state: { hand: i % 2 ? hands[seat] : [...hands[seat], 's9'], melds: [],
        discards: i % 2 ? ['s9'] : [], drawnTileIndex: i % 2 ? -1 : 13, redCount: 0 } }
  })
  const round: ReplayRound = {
    id: `${match.id}:${roundIndex}`, matchId: match.id, roundIndex, round: roundIndex, roundLabel: `东${roundIndex}局`,
    dealer: 0, honba: 0, matchType: 'east', dice: { first: [3, 4] }, diceThrowerIndex: 0,
    flipTile: null, jokerTiles: ['white'], wildcardTiles: [], wallBreakIndex: 0, flipStack: null,
    scoresBefore: [2000, 2000, 2000, 2000],
    anchor: { hands, melds: [[], [], [], []], discards: [[], [], [], []], drawnTileIndex: [-1, -1, -1, -1],
      redCount: [0, 0, 0, 0], scores: [2000, 2000, 2000, 2000], wallLeft: 84, headDrawn: 52, currentPlayer: 0 },
    steps, final: { hands, melds: [[], [], [], []], discards: [[], [], [], []], drawnTileIndex: [-1, -1, -1, -1],
      redCount: [0, 0, 0, 0], scores: [2000, 2000, 2000, 2000], draw: true }, landedAt: Date.now(),
  }
  await storage.saveRound(round)
}
document.body.dataset.fixture = 'ready'
