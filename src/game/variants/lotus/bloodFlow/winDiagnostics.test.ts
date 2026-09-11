import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TileType } from '../../../core/contracts/types'
import { createWall } from '../../../core/rules/tiles'
import { evaluateWin } from '../patterns/evaluate'
import { BLOOD_FLOW_CONFIG } from './config'
import { BloodFlowEngine } from './engine'
import { clearWinDiagnostics, explainWin, printWinExplanation, recordWinEvaluation, winDiagnosticLog, winDiagnosticsEnabled } from './winDiagnostics'
import type { WinDiagnosticEntry } from './winDiagnostics'
import type { WinEvaluationInput } from './types'

const JOKERS: TileType[] = ['m1', 'm2']
const entry = (concealed: TileType[], winningTile: TileType): WinDiagnosticEntry => {
  const input: WinEvaluationInput = { concealed, melds: [], winningTile, source: 'self-draw', jokers: JOKERS, opening: null }
  const evaluated = evaluateWin(input)
  if (!evaluated) throw new Error('fixture hand must be a win')
  return { at: 0, seat: 0, input, reported: evaluated.score }
}
const tiles = (value: string) => value.split(' ') as TileType[]

describe('DEV 胡牌诊断', () => {
  beforeEach(() => clearWinDiagnostics())

  it('DEV 下留档最近一次胡牌，并在超出上限后丢弃最旧记录', () => {
    expect(winDiagnosticsEnabled()).toBe(true)
    for (let n = 0; n < 25; n += 1) recordWinEvaluation({ ...entry(tiles('red red red green green green m4 m5 m6 m9 m9 m1 m2'), 'm2'), at: n })
    const log = winDiagnosticLog()
    expect(log).toHaveLength(20)
    expect(log[0].at).toBe(24)
    expect(log[19].at).toBe(5)
  })

  it('余牌凑不出面子+将时，摊开全部拆解并明确「没有含大三元的拆解」', () => {
    // 三个精补第三个三元刻后，余牌 3m5m6m+9m9m 不是「面子+将」→ 大三元不成立。
    const record = entry(tiles('red red red green green green m3 m5 m6 m9 m9 m1 m2'), 'm2')
    recordWinEvaluation(record)
    const explanation = explainWin()
    expect(explanation?.bigThree.found).toBe(false)
    expect(explanation?.bigThree.bestPayment).toBeNull()
    expect(explanation?.decompositions.length).toBeGreaterThan(0)
    expect(explanation?.decompositions.every(row => row.hasBigThreeDragons === false)).toBe(true)
    expect(explanation?.decompositions.map(row => row.paymentPerPayer)).toEqual(
      [...(explanation?.decompositions ?? [])].map(row => row.paymentPerPayer).sort((a, b) => b - a))
  })

  it('余牌成面子+将时，拆解表里能直接看到大三元以及它的收付', () => {
    // 只把 3m5m6m 换成 4m5m6m：余牌成为「面子+将」→ 大三元成立。
    const record = entry(tiles('red red red green green green m4 m5 m6 m9 m9 m1 m2'), 'm2')
    recordWinEvaluation(record)
    const explanation = explainWin()
    expect(explanation?.bigThree.found).toBe(true)
    expect(explanation?.bigThree.items).toContain('大三元')
    expect(explanation?.reported).toContain('大三元')
    expect(explanation?.bigThree.bestPayment).toBe(BLOOD_FLOW_CONFIG.basePoints * explanation!.decompositions[0].finalMultiplier)
  })

  it('打印入口返回结构化结果，空留档时不抛错', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      expect(printWinExplanation()).toBeNull()
      recordWinEvaluation(entry(tiles('red red red green green green m4 m5 m6 m9 m9 m1 m2'), 'm2'))
      const printed = printWinExplanation()
      expect(printed?.bigThree.found).toBe(true)
      expect(spy).toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })

  it('引擎胡牌评估自动留档（__bfExplainWin 的数据来源）', () => {
    // 用真实引擎跑一次点炮胡：庄家打出 east，座位 1 单吊 east 胡牌。
    const pool = createWall()
    const remove = (tile: TileType) => { const index = pool.indexOf(tile); if (index >= 0) pool.splice(index, 1) }
    const dealer: TileType[] = ['m7', 'm8', 'm9', 'p4', 'p5', 'p6', 's4', 's5', 's6', 'p7', 'p8', 's7', 's8', 'east']
    const supplier: TileType[] = ['m1', 'm2', 'm3', 'p1', 'p2', 'p3', 's1', 's2', 's3', 'm4', 'm5', 'm6', 'east']
    const quiet: TileType[] = ['m1', 'm2', 'm3', 'p1', 'p2', 'p3', 's1', 's2', 's3', 'east', 'south', 'west', 'north']
    const hands = [dealer, supplier, quiet, quiet]
    const flipTiles: [TileType, TileType] = ['p9', 'white']
    ;[...flipTiles, ...hands.flat()].forEach(remove)
    const players = [0, 1, 2, 3].map(seat => ({
      seat, name: `P${seat}`, avatar: '', score: 2000, hand: [...hands[seat]],
      melds: [], discards: [], redCount: 0, drawnTileIndex: -1,
    }))
    const engine = new BloodFlowEngine({ authorityEpoch: 'test', roundId: 'round-diag', now: () => 0, winBeatMs: 0,
      opening: { players, wall: pool, flipTiles, jokers: ['red', 'green'], headDrawn: 134 - pool.length,
        dealerDrawnIndex: players[0].hand.length - 1, flipStack: 0, flipSeat: 0, wallBreakIndex: 2 } })
    engine.submit(engine.command(0, { kind: 'discard', index: engine.players[0].hand.indexOf('east') }))
    expect(engine.window?.options[1].some(action => action.kind === 'win')).toBe(true)
    const log = winDiagnosticLog()
    expect(log.length).toBeGreaterThan(0)
    // 同一张 east 也有人能靠「乱风顺」胡（座位 3），所以按座位取而不是取最新一条。
    const seatOne = log.find(item => item.seat === 1)
    expect(seatOne).toBeDefined()
    const explanation = explainWin(seatOne)
    expect(explanation?.reported).toContain('座位1')
    expect(explanation?.decompositions.length).toBeGreaterThan(0)
  })
})
