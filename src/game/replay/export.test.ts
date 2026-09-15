import { describe, expect, it } from 'vitest'
import { buildReplayExport, downloadReplayExport, replayExportFilename } from './export'
import type { ReplayMatch, ReplayRound } from './types'

const MATCH: ReplayMatch = {
  id: '3f8a1c2e-9b7d-4e5f-8a10-1234567890ab',
  schemaVersion: 1,
  rulesetId: 'lotus-classic',
  rulesetName: '莲花广麻',
  matchType: 'east',
  matchName: '东风场',
  gameMode: 'local',
  themeName: 'jade',
  players: [{ seat: 0, name: '本家', avatar: '', startScore: 1000 }],
  humanSeat: 0,
  startedAt: 1_700_000_000_000,
  endedAt: 1_700_000_900_000,
  status: 'finished',
  roundCount: 2,
  myRank: 1,
  myScore: 1300,
  summary: '东2局 本家自摸（本家）',
}

function round(roundIndex: number, label: string): ReplayRound {
  return {
    id: `${MATCH.id}:${roundIndex}`,
    matchId: MATCH.id,
    roundIndex,
    round: roundIndex,
    roundLabel: label,
    dealer: 0,
    honba: 0,
    matchType: 'east',
    dice: { second: [3, 4] },
    diceThrowerIndex: 0,
    flipTile: null,
    jokerTiles: ['white'],
    wildcardTiles: [],
    wallBreakIndex: 0,
    flipStack: null,
    scoresBefore: [1000, 1000, 1000, 1000],
    anchor: {
      hands: [[], [], [], []],
      melds: [[], [], [], []],
      discards: [[], [], [], []],
      drawnTileIndex: [-1, -1, -1, -1],
      redCount: [0, 0, 0, 0],
      scores: [1000, 1000, 1000, 1000],
      wallLeft: 83,
      headDrawn: 0,
      currentPlayer: 0,
    },
    steps: [{ t: 'discard', seat: 0, tile: 'm5', wallLeft: 82, headDrawn: 0, currentPlayer: 1 }],
    final: null,
    landedAt: 1,
  }
}

describe('牌谱导出', () => {
  it('打包场次与各局，并按局号升序（文件内容可比对）', () => {
    const payload = buildReplayExport(MATCH, [round(2, '东2局'), round(1, '东1局')], 1_700_000_950_000)
    expect(payload.kind).toBe('lianhua-replay')
    expect(payload.schemaVersion).toBe(MATCH.schemaVersion)
    expect(payload.exportedAt).toBe(1_700_000_950_000)
    expect(payload.match.id).toBe(MATCH.id)
    expect(payload.rounds.map((item) => item.roundIndex)).toEqual([1, 2])
    expect(payload.rounds[0].steps).toHaveLength(1)
    // 导出内容必须是纯数据（可结构化克隆 / 可 JSON 序列化）
    expect(() => structuredClone(payload)).not.toThrow()
    expect(JSON.parse(JSON.stringify(payload)).rounds).toHaveLength(2)
  })

  it('文件名带玩法、本地时间与场次短 id，且跨平台安全', () => {
    const name = replayExportFilename(MATCH, 1_700_000_950_000)
    expect(name).toMatch(/^replay-lotus-classic-\d{8}-\d{4}-3f8a1c2e\.json$/)
    expect(name).not.toMatch(/[\s:/\\?*"<>|]/)
  })

  it('无 DOM 环境（测试/SSR）下导出返回 false 而不抛错', () => {
    const payload = buildReplayExport(MATCH, [round(1, '东1局')])
    expect(downloadReplayExport(payload, 'x.json')).toBe(false)
  })
})
