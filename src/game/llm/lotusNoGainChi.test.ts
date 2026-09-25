import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TileType } from '../core/contracts/types'
import { waitingTiles, type ChiMeld } from '../variants/lotus/lotusRules'
import type { LotusClaimContext, LotusChiContext } from '../variants/lotus/lotusControllers'
import { LotusLlmController } from './llmController'
import type { LlmProviderConfig } from './config'
import { keepUsefulLotusChiOptions } from './lotusNoGainChi'

const hand: TileType[] = ['west', 'm6', 'm7', 'm7', 'm8', 'm9', 'p3', 'p5', 's2', 's3', 's4', 'white', 'white']
const jokers: TileType[] = ['south', 'west']
const emptyChi: ChiMeld = { kind: 'sequence', tiles: ['s2', 's3', 's4'] }

const claim: LotusClaimContext = {
  hand, exposedMelds: 0, canPeng: false, canGang: false,
  tile: 's4', from: 1, chiOptions: [emptyChi], jokers,
}

const provider: LlmProviderConfig = {
  baseUrl: 'https://example.invalid/v1', apiKey: 'test', model: 'test',
  style: '稳健', timeoutMs: 1000,
}

afterEach(() => vi.unstubAllGlobals())

describe('莲花麻将 LLM 确定性空吃拦截', () => {
  it('复现千问对局：已听牌，吃 4 条后最佳弃牌仍是原有 4 条，听口完全不变', () => {
    const before = waitingTiles(hand, 0, jokers)
    const after = waitingTiles(
      hand.filter((_, index) => ![8, 9, 10].includes(index)),
      1,
      jokers,
    )
    expect(before).toEqual(['m5', 'm8', 'p4', 'south', 'west'])
    expect(after).toEqual(before)
    expect(keepUsefulLotusChiOptions({
      hand, exposedMelds: 0, claimedTile: 's4', chiOptions: [emptyChi], jokers,
    })).toEqual([])
  })

  it('候选全被拦时直接过，不发送模型请求；两个吃牌入口一致', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const controller = new LotusLlmController(provider)
    expect(await controller.requestClaim(claim)).toEqual({ kind: 'pass' })
    expect(await controller.requestChi({
      hand, tile: 's4', from: 1, chiOptions: [emptyChi], jokers,
    } satisfies LotusChiContext)).toEqual({ kind: 'pass' })
    expect(fetch).not.toHaveBeenCalled()
    expect(controller.stats.requests).toBe(0)
    expect(claim.chiOptions).toEqual([emptyChi])
  })

  it('未听牌的正常吃法保留给模型判断', () => {
    const developingHand: TileType[] = ['m2', 'm3', 'm5', 'm6', 'm7', 'p1', 'p2', 'p3', 'p5', 'p6', 'p7', 's1', 's2']
    const option: ChiMeld = { kind: 'sequence', tiles: ['m2', 'm3', 'm4'] }
    expect(waitingTiles(developingHand, 0, ['white', 'red'])).toEqual([])
    expect(keepUsefulLotusChiOptions({
      hand: developingHand, exposedMelds: 0, claimedTile: 'm4',
      chiOptions: [option], jokers: ['white', 'red'],
    })).toEqual([option])
  })

  it('已听牌但吃后出现新听口时仍保留候选', () => {
    const readyHand = [...hand]
    readyHand[10] = 'm5'
    expect(waitingTiles(readyHand, 0, jokers)).toEqual(['p4', 's1', 's4', 'south', 'west'])
    expect(keepUsefulLotusChiOptions({
      hand: readyHand, exposedMelds: 0, claimedTile: 's4',
      chiOptions: [emptyChi], jokers,
    })).toEqual([emptyChi])
  })
})
