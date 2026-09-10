import { expect, it } from 'vitest'
import type { TileType } from '../../../core/contracts/types'
import {
  chainEvEst, estimateWinIncome, isAnyTileWait, patternPotentials, patternPotentialTotal,
  waitingTilesCached,
} from './patternPotentials'

const NO_MELDS: [] = []

it('ranks a one-suit hand toward pure-suit and keeps honors out of it', () => {
  const clean: TileType[] = ['m1', 'm1', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9', 'm9', 'm9']
  const cleanDirections = patternPotentials(clean, NO_MELDS, [])
  expect(cleanDirections.find(d => d.id === 'pure-suit')?.progress).toBe(1)
  expect(cleanDirections.find(d => d.id === 'mixed-suit')).toBeUndefined()

  const withHonor: TileType[] = [...clean.slice(0, 12), 'east']
  const honorDirections = patternPotentials(withHonor, NO_MELDS, [])
  expect(honorDirections.find(d => d.id === 'pure-suit')).toBeUndefined()
  expect(honorDirections.find(d => d.id === 'mixed-suit')).toBeDefined()
})

it('measures triplet-based directions with melds and jokers', () => {
  const hand: TileType[] = ['m1', 'm1', 'm1', 'p2', 'p2', 'p2', 's3', 's3', 's3', 'white']
  const directions = patternPotentials(hand, NO_MELDS, ['white'])
  const triplets = directions.find(d => d.id === 'all-triplets')
  expect(triplets).toBeDefined()
  expect(triplets!.progress).toBeGreaterThanOrEqual(0.8)
  expect(patternPotentialTotal(hand, NO_MELDS, ['white'])).toBeGreaterThanOrEqual(2)
})

it('detects a lone-joker any-tile wait and prices the chain', () => {
  // 4 melds + 单精：听任意 34 种。
  const anyWait: TileType[] = ['m1', 'm1', 'm1', 'm2', 'm3', 'm4', 'm5', 'm5', 'm5', 'p9', 'p9', 'p9', 'white']
  const waits = waitingTilesCached(anyWait, 0, ['white'])
  expect(isAnyTileWait(waits)).toBe(true)
  const chain = chainEvEst(anyWait, NO_MELDS, ['white'], anyWait, 60)
  expect(chain).toBeGreaterThan(500)

  // 普通窄听：单吊 s7 只有一种听口，连锁期望远低于任意听。
  const narrow: TileType[] = ['m1', 'm1', 'm1', 'm2', 'm3', 'm4', 'm5', 'm5', 'm5', 'p9', 'p9', 'p9', 's7', 's7']
  expect(chainEvEst(narrow, NO_MELDS, [], narrow, 60)).toBeLessThan(chain)
})

it('estimates income with event multipliers, hard-win and the per-payer cap', () => {
  const pure: TileType[] = ['m1', 'm1', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm8', 'm8', 'm9', 'm9']
  // 清一色 4 倍 × 自摸 2 × 硬胡 2 = 16 倍 → 160/人，共 480。
  expect(estimateWinIncome(pure, NO_MELDS, [], 'self-draw')).toEqual({
    paymentPerPayer: 160, total: 480, multiplier: 16, hardLikely: true,
  })
  // 点炮：事件 ×1 → 8 倍 → 80/人，单家共 80。
  expect(estimateWinIncome(pure, NO_MELDS, [], 'discard').total).toBe(80)

  // 1112345678999 + m1 = 九莲宝灯 16 倍 × 自摸 2 × 硬胡 2 = 64 → 封顶 640/人。
  const nineGates: TileType[] = ['m1', 'm1', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9', 'm9', 'm9', 'm1']
  expect(estimateWinIncome(nineGates, NO_MELDS, [], 'self-draw')).toEqual({
    paymentPerPayer: 640, total: 1920, multiplier: 64, hardLikely: true,
  })

  // 含精牌 → 不硬胡：清一色 4 × 自摸 2 × 1 = 8 倍。
  const withJoker: TileType[] = ['m1', 'm1', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm8', 'm8', 'm9', 'white']
  const jokerEstimate = estimateWinIncome(withJoker, NO_MELDS, ['white'], 'self-draw')
  expect(jokerEstimate.hardLikely).toBe(false)
  expect(jokerEstimate.paymentPerPayer).toBe(80)
})

it('keeps cached waits consistent with a direct call', () => {
  const hand: TileType[] = ['m1', 'm1', 'm1', 'm2', 'm3', 'm4', 'm5', 'm5', 'm5', 'p9', 'p9', 'p9', 'white']
  expect(waitingTilesCached(hand, 0, ['white'])).toEqual(waitingTilesCached(hand, 0, ['white']))
})
