import { describe, expect, it } from 'vitest'
import { bloodFlowScoreCardItems } from './bloodFlowScoreCard'
import { BLOOD_FLOW_CONFIG } from '../../game/variants/lotus/bloodFlow/config'
import { scorePatterns } from '../../game/variants/lotus/patterns/score'
import { BloodFlowPresentationQueue } from '../../game/variants/lotus/bloodFlow/presentation'
import type { KongLedgerEntry, WinBatch } from '../../game/variants/lotus/bloodFlow/types'

function kong(kind: KongLedgerEntry['kongKind'], sequence = 1, actor: KongLedgerEntry['actor'] = 0): KongLedgerEntry {
  return { kind: 'kong', id: `kong-${sequence}-${actor}`, sequence, actor, kongKind: kind,
    authorityEpoch: 'test', roundId: 'round', sourceSeat: kind === 'discard' ? 1 : null,
    deltas: [0, 0, 0, 0], scoresAfter: [2000, 2000, 2000, 2000] }
}

describe('血流计分卡杠番', () => {
  it.each([
    ['discard', '明杠', { exposed: 1, concealed: 0, wind: 0 }, 1],
    ['added', '明杠', { exposed: 1, concealed: 0, wind: 0 }, 1],
    ['concealed', '暗杠', { exposed: 0, concealed: 1, wind: 0 }, 2],
    ['wind', '风杠', { exposed: 0, concealed: 0, wind: 1 }, 1],
  ] as const)('鸡胡的 %s 只显示 %s，但胡牌特效仍是鸡胡', (kind, label, counts, weight) => {
    const score = scorePatterns(['chicken'], false, 'discard', null, BLOOD_FLOW_CONFIG, counts)
    const original = JSON.stringify(score)
    expect(bloodFlowScoreCardItems(score, { winner: 0, sequence: 2, events: [kong(kind)] }))
      .toEqual([{ id: `kong-${kind === 'discard' || kind === 'added' ? 'exposed' : kind}`, label, weight }])
    const batch: WinBatch = { authorityEpoch: 'test', sequence: 2, roundId: 'round', ruleVersion: 'lotus-blood-flow-v1',
      batchId: 'batch', windowId: 'window', source: { id: 'tile', kind: 'discard', seat: 1, tile: 'm1' },
      deltas: [10, -10, 0, 0], scoresAfter: [2010, 1990, 2000, 2000], nextAction: { kind: 'draw', seat: 2 },
      winners: [{ id: 'win', batchId: 'batch', winner: 0, ordinal: 1, sourceEventId: 'tile', score, deltas: [10, -10, 0, 0] }] }
    const queue = new BloodFlowPresentationQueue()
    queue.enqueue(batch, 0)
    expect(queue.next(0)?.title).toBe('鸡胡')
    expect(JSON.stringify(score)).toBe(original)
  })

  it('无杠鸡胡保留半番；普通番型显示额外杠番', () => {
    expect(bloodFlowScoreCardItems(scorePatterns(['chicken'], false, 'discard')))
      .toEqual([{ id: 'chicken', label: '鸡胡', weight: 0.5 }])
    const score = scorePatterns(['mixed-suit'], false, 'discard', null, BLOOD_FLOW_CONFIG, { exposed: 1, concealed: 0, wind: 0 })
    expect(bloodFlowScoreCardItems(score, { winner: 0, sequence: 2, events: [kong('discard')] }).map(i => [i.label, i.weight]))
      .toEqual([['混一色', 4], ['明杠', 1]])
  })

  it('按胡牌时刻取本家的杠，忽略他家、后续杠及重复记录', () => {
    const score = scorePatterns(['chicken'], false, 'discard', null, BLOOD_FLOW_CONFIG, { exposed: 1, concealed: 0, wind: 1 })
    const events = [kong('discard'), kong('discard'), kong('wind', 2), kong('concealed', 3, 1), kong('concealed', 5)]
    expect(bloodFlowScoreCardItems(score, { winner: 0, sequence: 4, events }).map(i => [i.label, i.weight]))
      .toEqual([['明杠', 1], ['风杠', 1]])
    expect(bloodFlowScoreCardItems(scorePatterns(['chicken'], false, 'discard'), { winner: 0, sequence: 1, events }))
      .toEqual([{ id: 'chicken', label: '鸡胡', weight: 0.5 }])
  })

  it('三杠四杠不重复列出杠番；缺明细时显示账本的总加成', () => {
    const score = scorePatterns(['three-kongs'], false, 'discard', null, BLOOD_FLOW_CONFIG, { exposed: 3, concealed: 0, wind: 0 })
    expect(bloodFlowScoreCardItems(score)).toEqual([{ id: 'three-kongs', label: '三杠', weight: 12 }])
    const chicken = scorePatterns(['chicken'], false, 'discard', null, BLOOD_FLOW_CONFIG, { exposed: 0, concealed: 1, wind: 0 })
    expect(bloodFlowScoreCardItems(chicken)).toEqual([{ id: 'kong-bonus', label: '杠加成', weight: 2 }])
  })
})
