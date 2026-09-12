// LLM 候选特征：对手牌型风险定价进入弃牌候选与 prompt（广麻无普通点炮 → 不出现）。
import { describe, expect, it } from 'vitest'
import { buildDecisionRequest, type DecisionInput } from './candidates'
import { buildPrompt } from './prompt'
import type { TileType } from '../core/contracts/types'

const peng = (tile: TileType) => ({ type: 'peng', tile, tiles: [tile, tile, tile] as TileType[], from: 1 })

function input(ruleCode: DecisionInput['ruleCode'], opponentMelds = [peng('p4'), peng('p7')]): DecisionInput {
  const hand: TileType[] = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'p1', 'p2', 'p3', 's7', 's7', 's7', 'white']
  const peers = [0, 1, 2, 3].map(index => ({ discards: [] as TileType[], melds: index === 1 ? opponentMelds : [] }))
  return {
    ruleCode, decision: 'turn', playerIndex: 0, hand, melds: [], exposedMelds: 0,
    visibleTiles: [...hand, 'east', 'east'], publicTiles: ['east', 'east'], peers, wallCount: 40,
    jokerTiles: [], wildcardTiles: ['white'], scores: [2000, 2000, 2000, 2000],
    requestId: 'risk-1', stateVersion: 'risk-1',
  }
}

const paymentOf = (request: ReturnType<typeof buildDecisionRequest>['request'], label: string) => (
  request!.candidates.find(candidate => candidate.label === label)?.features.opponentRisk?.payment ?? null
)

describe('LLM 候选的对手风险定价', () => {
  it('莲花/血流：每个弃牌候选都带风险赔付，嫌疑花色更贵', () => {
    const { request } = buildDecisionRequest(input('lotus-legacy'))
    const discards = request!.candidates.filter(candidate => candidate.action.kind === 'discard')
    expect(discards.length).toBeGreaterThan(0)
    expect(discards.every(candidate => candidate.features.opponentRisk?.tier === '中')).toBe(true)
    const tong = paymentOf(request, '出1筒')
    const wan = paymentOf(request, '出1万')
    expect(tong).toBeGreaterThan(0)
    expect(wan).toBeGreaterThan(0)
    expect(tong!).toBeGreaterThan(wan!)
  })

  it('prompt 里出现风险赔付档，并且与候选特征同源', () => {
    const { request } = buildDecisionRequest(input('lotus-legacy'))
    const { user } = buildPrompt('稳健', request!)
    expect(user).toContain('风险赔付：约')
    expect(user).toMatch(/风险赔付：约\d+点（中/)
  })

  it('广麻没有普通点炮，候选恒不带风险定价', () => {
    const { request } = buildDecisionRequest(input('lotus-classic'))
    expect(request!.candidates.every(candidate => candidate.features.opponentRisk === undefined)).toBe(true)
    expect(buildPrompt('稳健', request!).user).not.toContain('风险赔付')
  })

  it('对手没有大牌信号时不产生该特征（保持旧行为）', () => {
    const { request } = buildDecisionRequest(input('lotus-legacy', []))
    expect(request!.candidates.every(candidate => candidate.features.opponentRisk === undefined)).toBe(true)
  })

  it("开关 'off' 时候选不产出风险定价（与引擎建议的回退口径一致）", () => {
    const { request } = buildDecisionRequest({ ...input('lotus-legacy'), opponentPatternRisk: 'off' })
    expect(request!.candidates.every(candidate => candidate.features.opponentRisk === undefined)).toBe(true)
    expect(buildPrompt('稳健', request!).user).not.toContain('风险赔付')
  })
})
