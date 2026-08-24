import { describe, expect, it, vi } from 'vitest'
import type { TileType } from '../../core/contracts/types'
import { TILE_TYPES } from '../../core/rules/tiles'
import { LotusLlmController } from '../../llm/llmController'
import type { LlmProviderConfig, LlmStyle } from '../../llm/config'
import { projectKongBloom, type KongProjectionInput } from './kongProjection'

const JOKERS: TileType[] = ['m3', 'm4']
const POST_KONG_ALL_WAIT: TileType[] = [
  'm1', 'm2', 'm3',
  'p1', 'p2', 'p3',
  'red', 'red', 'red',
  'white',
]
const STYLES: LlmStyle[] = ['激进', '稳健', '话痨', '高冷']

function projection(kind: KongProjectionInput['kind']): KongProjectionInput {
  if (kind === 'discard-gang') {
    const hand: TileType[] = [...POST_KONG_ALL_WAIT, 's9', 's9', 's9']
    return { kind, hand, exposedMelds: 0, jokers: JOKERS, tile: 's9', visibleTiles: [...hand, 's9'] }
  }
  if (kind === 'concealed-kong') {
    const hand: TileType[] = [...POST_KONG_ALL_WAIT, 's9', 's9', 's9', 's9']
    return { kind, hand, exposedMelds: 0, jokers: JOKERS, tile: 's9', visibleTiles: hand }
  }
  const hand: TileType[] = [...POST_KONG_ALL_WAIT, 'east', 'south', 'west', 'north']
  return { kind, hand, exposedMelds: 0, jokers: JOKERS, visibleTiles: hand }
}

function controller(style: LlmStyle) {
  const config: LlmProviderConfig = {
    baseUrl: 'https://example.com/v1', apiKey: 'unused', model: 'test', style, timeoutMs: 20_000,
  }
  return new LotusLlmController(config)
}

describe('杠后全听投影', () => {
  it.each(['discard-gang', 'concealed-kong', 'wind-kong'] as const)('%s 移除正确牌组后为 34 种全听', (kind) => {
    const result = projectKongBloom(projection(kind))
    expect(result.legal).toBe(true)
    expect(result.postKongHand).toEqual(POST_KONG_ALL_WAIT)
    expect(result.waits).toHaveLength(TILE_TYPES.length)
    expect(result.guaranteedKongBloom).toBe(true)
  })

  it.each(STYLES)('%s：大明杠、暗杠、风杠后全听时均直接博杠开', async (style) => {
    const fetchSpy = vi.fn(() => { throw new Error('全听强制策略不应请求 LLM') })
    vi.stubGlobal('fetch', fetchSpy)
    const llm = controller(style)
    const concealed = projection('concealed-kong')
    const wind = projection('wind-kong')
    const exposed = projection('discard-gang')

    await expect(llm.requestTurn({
      hand: concealed.hand, melds: [], exposedMelds: 0, kongBloom: false,
      skipDraw: false, isDealer: false, jokers: JOKERS, visibleTiles: concealed.visibleTiles,
    })).resolves.toEqual({ kind: 'concealed-kong', tile: 's9' })
    await expect(llm.requestTurn({
      hand: wind.hand, melds: [], exposedMelds: 0, kongBloom: false,
      skipDraw: false, isDealer: false, jokers: JOKERS, visibleTiles: wind.visibleTiles,
    })).resolves.toEqual({ kind: 'wind-kong' })
    await expect(llm.requestDiscardHu({
      hand: exposed.hand, exposedMelds: 0, canPeng: true, canGang: true,
      tile: 's9', from: 1, dihu: false, chiOptions: [], jokers: JOKERS,
      visibleTiles: exposed.visibleTiles,
    })).resolves.toEqual({ kind: 'gang' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('当前已经能胡但杠后并非全听时仍直接胡', async () => {
    const hand: TileType[] = [
      'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'p2', 'p3', 'p4',
      's7', 's7', 's7', 'east', 'east',
    ]
    await expect(controller('激进').requestTurn({
      hand, melds: [], exposedMelds: 0, kongBloom: false,
      skipDraw: false, isDealer: false, jokers: [], visibleTiles: hand,
    })).resolves.toEqual({ kind: 'win' })
  })
})
