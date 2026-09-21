import { describe, expect, it } from 'vitest'
import { TILE_TYPES } from '../../core/rules/tiles'
import { buildRingWall } from '../../variants/lotus/lotusWall'
import {
  buildLotusReproduction, commandEntryMatchKey, compareLotusOpeningExtras, comparePostDealHands,
  lotusCommandEntry, ringWallDeficiencies,
} from './lotusReproduction'
import { reproductionDeficiencies, isRingWallReproduction } from './reproductionCapability'

// 翻精癞子 P1（赛后复现）的**纯函数**验收点（方案 §4 的单测那几项）：
// 1. 快照字段口径：环状牌墙 136 张、每种牌各 4 张、全是牌码；开局分四家、骰子两对、庄家与局号都在；
// 2. 交叉校验（§3.3）：把 `postDealHands` 改一张 ⇒ 报"发牌算法变了或记录与引擎不一致"并点名位置；
//    记录里没带这一项 ⇒ `checked: false`（**不默认放行**）；
// 3. 权威动作日志（§2.2）：与 `AnalysisCommandEntry` 同型、`windowId` 齐全、载荷（下标/组合/碰后弃牌）
//    一个都不许漏 —— 漏了重跑就会分叉；
// 4. 向后兼容（§3.1）：没有新字段的旧记录（血流口径）仍然读得动，不报"翻精癞子缺字段"。
// 真正"重跑一局"的驱动器在 `reproduceLotusLegacy.ts`，只能在浏览器夹具里跑（§3.5），见 e2e。

/** 一副合格的环状牌墙（真实建墙函数），用于口径断言。 */
const realRing = () => buildRingWall()

const snapshotInput = () => ({
  roundIndex: 3,
  ringWall: realRing(),
  dice: { first: [1, 2] as const, second: [3, 4] as const },
  dealer: 2,
  openingScores: [2000, 1900, 2100, 2000],
  postDealHands: [['m1'], ['m2'], ['m3'], ['m4']],
  flipTile: 'm1',
  jokers: ['m1', 'east'],
  flipSeat: 1,
  flipStack: 5,
  wallBreakIndex: 9,
  // 一局至少有庄家起手那一手（`beginTurn` 一定会开一个摸牌回合窗口），所以空命令日志本身就是缺陷。
  commands: [{ seat: 2, kind: 'discard', at: 1, handIndex: 13, windowId: 'round-3/window/1', windowKind: 'draw-turn' }],
})

describe('翻精癞子 P1：开局快照口径（§2.1、§3.2）', () => {
  it('环状牌墙 136 张、每种牌各 4 张、全是牌码', () => {
    const ring = realRing()
    expect(ring, '牌墙张数必须是 136（34 种 × 4）').toHaveLength(136)
    expect(ringWallDeficiencies(ring, TILE_TYPES), '真实建墙结果应当零缺陷').toEqual([])
    const counts = TILE_TYPES.map((tile) => ring.filter((entry) => entry === tile).length)
    expect(new Set(counts), '每种牌都恰好 4 张').toEqual(new Set([4]))
  })

  it('快照原样带走牌码与骰子，不换算成中文显示名、不补默认值', () => {
    const input = snapshotInput()
    const record = buildLotusReproduction(input)
    expect(record.ringWall).toHaveLength(136)
    // 牌码口径：墙里的每一张都必须是 TILE_TYPES 里的码（不是「一万」这类显示名）
    expect(record.ringWall!.every((tile) => TILE_TYPES.includes(tile as never))).toBe(true)
    expect(record.variant, '读取侧据此选校验器').toBe('lotus-legacy')
    expect(record.dice).toEqual({ first: [1, 2], second: [3, 4] })
    expect(record.dealer).toBe(2)
    expect(record.roundIndex).toBe(3)
    expect(record.openingScores, '当局开局分四家，且与传进来的完全一致（不是初始分）').toEqual([2000, 1900, 2100, 2000])
    expect(record.postDealHands, '四家手牌只用于交叉校验').toEqual([['m1'], ['m2'], ['m3'], ['m4']])
    expect(record.commands, '权威动作日志随记录带走').toHaveLength(1)
    expect(reproductionDeficiencies(record), '字段齐了就不该有缺失项').toEqual([])
  })

  it('改一张墙、少一颗骰子都会被读取侧点名（缺就是缺，不填默认值）', () => {
    const broken = buildLotusReproduction({ ...snapshotInput(), ringWall: realRing().slice(0, 135), dice: { first: [1, 2] } })
    const issues = reproductionDeficiencies(broken)
    expect(issues.join(' ')).toContain('ringWall')
    expect(issues.join(' ')).toContain('dice.second')
  })

  it('缺 commands 与 postDealHands 也算不可复现（后者是交叉校验的前提）', () => {
    const full = buildLotusReproduction(snapshotInput())
    expect(reproductionDeficiencies({ ...full, commands: [] }).join(' ')).toContain('commands')
    expect(reproductionDeficiencies({ ...full, postDealHands: [] }).join(' ')).toContain('postDealHands')
    expect(reproductionDeficiencies({ ...full, available: false, unavailableReason: '联机态拿不到牌墙' }).join(' '))
      .toContain('联机态拿不到牌墙')
  })
})

describe('翻精癞子 P1：交叉校验（§3.3）', () => {
  it('四家手牌逐张相同 ⇒ 通过', () => {
    const hands = [['m1', 'm2'], ['p1'], ['s9', 'east'], ['white']]
    expect(comparePostDealHands(hands, hands)).toEqual({ checked: true, ok: true, reason: null })
  })

  it('改一张 ⇒ 报「发牌算法变了或记录与引擎不一致」，并点名第几家第几张', () => {
    const recorded = [['m1', 'm2'], ['p1'], ['s9', 'east'], ['white']]
    const actual = [['m1', 'm2'], ['p1'], ['s9', 'south'], ['white']]
    const verdict = comparePostDealHands(recorded, actual)
    expect(verdict.checked).toBe(true)
    expect(verdict.ok, '不一致时必须判不合格（校验器据此停止重跑）').toBe(false)
    expect(verdict.reason).toContain('发牌算法变了或记录与引擎不一致')
    expect(verdict.reason, '要能直接看出差在哪一家哪一张').toContain('第 2 家第 2 张')
  })

  it('张数不同也判不合格（手牌顺序同样是发牌算法的一部分）', () => {
    expect(comparePostDealHands([['m1']], [['m1', 'm2']]).ok).toBe(false)
    expect(comparePostDealHands([['m1'], ['m2']], [['m1']]).reason).toContain('家数对不上')
  })

  it('记录里没有 postDealHands ⇒ checked=false，不默认放行', () => {
    const verdict = comparePostDealHands(undefined, [['m1'], ['m2'], ['m3'], ['m4']])
    expect(verdict.checked).toBe(false)
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toContain('无法交叉校验')
  })

  it('翻精/精牌/开牌断点由牌墙+骰子推出，不一致同样是"记录与引擎不一致"', () => {
    const record = buildLotusReproduction(snapshotInput())
    const same = { flipTile: 'm1', jokers: ['east', 'm1'], flipStack: 5, flipSeat: 1, wallBreakIndex: 9 }
    expect(compareLotusOpeningExtras(record, same)).toEqual({ checked: true, ok: true, reason: null })
    expect(compareLotusOpeningExtras(record, { ...same, flipTile: 'm9' }).reason).toContain('翻精指示牌对不上')
    expect(compareLotusOpeningExtras(record, { ...same, jokers: ['m1'] }).reason).toContain('精牌集合对不上')
    expect(compareLotusOpeningExtras(record, { ...same, wallBreakIndex: 8 }).reason).toContain('开牌断点对不上')
    // 记录里没带的项不比（不猜），但还是要有"比过至少一项"的痕迹
    expect(compareLotusOpeningExtras({ roundIndex: 1, available: true }, same).checked).toBe(false)
  })
})

describe('翻精癞子 P1：权威动作日志形状（§2.2）', () => {
  const options = { at: 7, windowId: 'round-3/window/12', windowKind: 'claim', legalActionId: 'round-3/window/12/4' }

  it('弃牌/补杠/暗杠/过牌都是同型的条目，windowId 与 windowKind 齐全', () => {
    expect(lotusCommandEntry(2, { kind: 'discard', handIndex: 5 }, options)).toEqual({
      seat: 2, kind: 'discard', at: 7, windowId: 'round-3/window/12', windowKind: 'claim',
      legalActionId: 'round-3/window/12/4', handIndex: 5,
    })
    expect(lotusCommandEntry(1, { kind: 'added-kong', meldIndex: 2 }, options)).toMatchObject({ kind: 'added-kong', meldIndex: 2 })
    expect(lotusCommandEntry(1, { kind: 'concealed-kong', tile: 'm5' }, options)).toMatchObject({ kind: 'concealed-kong', tile: 'm5' })
    expect(lotusCommandEntry(3, { kind: 'pass' }, options)).toMatchObject({ kind: 'pass' })
    expect(lotusCommandEntry(3, { kind: 'wind-kong' }, options)).toMatchObject({ kind: 'wind-kong' })
  })

  it('碰带的 discardIndex 必须记下来（漏了重跑会以为碰完要重新摸牌）', () => {
    const entry = lotusCommandEntry(2, { kind: 'peng', discardIndex: 8 }, options)
    expect(entry).toMatchObject({ kind: 'peng', discardIndex: 8 })
    expect(lotusCommandEntry(2, { kind: 'peng' }, options), '不带下标时不许编一个').not.toHaveProperty('discardIndex')
  })

  it('吃的组合进 tiles；抢杠的裸字符串也认得（不会记成 unknown）', () => {
    const chi = lotusCommandEntry(1, { kind: 'chi', meld: { kind: 'sequence', tiles: ['m1', 'm2', 'm3'] } }, options)
    expect(chi).toMatchObject({ kind: 'chi', tiles: ['m1', 'm2', 'm3'] })
    expect(lotusCommandEntry(1, 'win', options)).toMatchObject({ kind: 'win' })
    expect(lotusCommandEntry(1, 'pass', options)).toMatchObject({ kind: 'pass' })
    // 认不出来的动作如实记成 unknown（校验器会响亮地报出来），绝不静默丢弃这一条
    expect(lotusCommandEntry(1, { weird: true }, options)).toMatchObject({ kind: 'unknown' })
  })

  it('命令的区分键与合法动作同一套：弃牌看下标、补杠看副露下标、吃看组合（顺序无关）', () => {
    expect(commandEntryMatchKey({ kind: 'discard', handIndex: 5 })).toBe('discard|5')
    expect(commandEntryMatchKey({ kind: 'discard', handIndex: 4 })).not.toBe(commandEntryMatchKey({ kind: 'discard', handIndex: 5 }))
    expect(commandEntryMatchKey({ kind: 'added-kong', meldIndex: 1 })).toBe('added-kong|1')
    expect(commandEntryMatchKey({ kind: 'chi', tiles: ['m3', 'm1', 'm2'] }))
      .toBe(commandEntryMatchKey({ kind: 'chi', tiles: ['m1', 'm2', 'm3'] }))
    expect(commandEntryMatchKey({ kind: 'pass' })).toBe('pass')
  })
})

describe('翻精癞子 P1：记录类型向后兼容（§3.1）', () => {
  it('没有新字段的旧记录（血流口径）仍然读得动，且不按环状牌墙判缺字段', () => {
    const legacy = { roundIndex: 1, available: true, initialWall: ['m1'], initialHands: [[], [], [], []] }
    expect(isRingWallReproduction(legacy), '没有 ringWall/variant ⇒ 按血流口径读').toBe(false)
    const issues = reproductionDeficiencies(legacy)
    expect(issues.join(' '), '缺的是血流那套字段，不是"翻精癞子缺 ringWall"').not.toContain('ringWall')
    expect(issues.join(' ')).toContain('dealer')
  })

  it('环状牌墙口径由 variant 或 ringWall 二者之一即可认出（旧记录不会认成另一玩法）', () => {
    expect(isRingWallReproduction({ roundIndex: 1, available: true, variant: 'lotus-legacy' })).toBe(true)
    expect(isRingWallReproduction({ roundIndex: 1, available: true, ringWall: ['m1'] })).toBe(true)
    expect(isRingWallReproduction({ roundIndex: 1, available: true })).toBe(false)
    expect(reproductionDeficiencies({ roundIndex: 1, available: true, variant: 'lotus-legacy' }))
      .toContain('ringWall（环状牌墙 136 张，实为 0 张）')
  })
})