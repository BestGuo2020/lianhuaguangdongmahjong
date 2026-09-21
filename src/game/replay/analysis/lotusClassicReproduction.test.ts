import { describe, expect, it } from 'vitest'
import { createWall, TILE_TYPES } from '../../core/rules/tiles'
import {
  buildLotusClassicReproduction, commandEntryMatchKey, compareLotusClassicOpeningExtras, comparePostDealHands,
  lotusClassicCommandEntry, ringWallDeficiencies,
} from './lotusClassicReproduction'
import { reproductionDeficiencies, reproductionComplete } from './reproductionCapability'

// 莲花广麻 P1（赛后复现）的**纯函数**验收点（差异清单 §4 的单测那几项）：
// 1. 快照字段口径：环状牌墙 136 张、每种牌各 4 张、全是牌码；开局分四家、骰子一对、庄家与断点都在；
//    **并且**：广麻没有翻精 ⇒ 快照里**没有** `flipTile`/`jokers`/`flipSeat`/`flipStack`/`dice.second`
//    （不是漏取，是玩法里就没有这一套；补空值会让读取侧以为"翻精没翻出来"）；
// 2. 交叉校验（§3.3）：`postDealHands` 改一张 ⇒ 报"发牌算法变了或记录与引擎不一致"并点名位置；
//    记录里没带这一项 ⇒ `checked: false`（**不默认放行**）；
// 3. 权威动作日志（§2.2）：与 `AnalysisCommandEntry` 同型、`windowId` 齐全、载荷（下标/组合/碰后弃牌）
//    一个都不许漏 —— 尤其碰带的 `discardIndex`，漏了重跑会以为碰完还要再摸一张；
// 4. 判据分派（§3.1）：`variant: 'lotus-classic'` 走广麻清单，**不**拿翻精癞子的清单要求精牌。
// 真正"重跑一局"的驱动器在 `reproduceLotusClassic.ts`（浏览器/假时钟），见 replayLotusClassicRound.test.ts。
//
// ⚠️ 这个文件**只测纯函数**：一局真跑的端到端重跑在 `replayLotusClassicRound.test.ts`（假时钟 + 真引擎）。

/** 一副合格的环状牌墙（真实的建墙函数：34 种 × 4 张 = 136）。 */
const realRing = () => createWall() as string[]

const snapshotInput = () => ({
  roundIndex: 3,
  ringWall: realRing(),
  dice: { first: [1, 2] as const },
  dealer: 2,
  openingScores: [2000, 1900, 2100, 2000],
  postDealHands: [['m1'], ['m2'], ['m3'], ['m4']],
  wallBreakIndex: 9,
  // 一局至少有庄家起手那一手（`beginTurn` 一定会开一个摸牌回合窗口），所以空命令日志本身就是缺陷。
  commands: [{ seat: 2, kind: 'discard', at: 1, handIndex: 13, windowId: 'round-3/window/1', windowKind: 'draw-turn' }],
})

describe('广麻 P1：开局快照口径（§2.1、§3.2）', () => {
  it('环状牌墙 136 张、每种牌各 4 张、全是牌码', () => {
    const ring = realRing()
    expect(ring).toHaveLength(136)
    expect(ringWallDeficiencies(ring, TILE_TYPES)).toEqual([])
    for (const tile of TILE_TYPES) expect(ring.filter((entry) => entry === tile)).toHaveLength(4)
  })

  it('牌墙不合格时逐项点名（少一张 / 不是牌码）', () => {
    const short = realRing().slice(0, 135)
    expect(ringWallDeficiencies(short, TILE_TYPES).join('｜')).toContain('张数不是 136')
    const withName = [...realRing().slice(0, 135), '一万']
    const problems = ringWallDeficiencies(withName, TILE_TYPES).join('｜')
    expect(problems).toContain('不是牌码：一万')
    // 被替换掉的是最后一张（white）⇒ white 只剩 3 张；'一万' 不是牌码、不顶替 m1
    expect(problems).toContain('white 有 3 张')
    expect(problems).not.toContain('m1 有 3 张')
    expect(ringWallDeficiencies(undefined, TILE_TYPES)).toContain('张数不是 136（实为 0）')
  })

  it('快照原样带走牌码与骰子，不换算成中文显示名、不补默认值', () => {
    const record = buildLotusClassicReproduction(snapshotInput())
    expect(record.variant).toBe('lotus-classic')
    expect(record.available).toBe(true)
    expect(record.origin).toBe('local')
    expect(record.roundIndex).toBe(3)
    expect(record.ringWall).toEqual(realRing())
    expect(record.dice).toEqual({ first: [1, 2] })
    expect(record.dealer).toBe(2)
    expect(record.openingScores).toEqual([2000, 1900, 2100, 2000])
    expect(record.postDealHands).toEqual([['m1'], ['m2'], ['m3'], ['m4']])
    expect(record.wallBreakIndex).toBe(9)
    expect(record.commands).toHaveLength(1)
    // 转写必须是**副本**：记录里改了不该动到调用方的数组
    expect(record.ringWall).not.toBe(snapshotInput().ringWall)
  })

  it('**没有翻精** ⇒ 快照里没有精牌/指示牌/方位/墩位/第二次掷骰这些字段（不编造）', () => {
    const record = buildLotusClassicReproduction(snapshotInput())
    // 这几项在翻精癞子的记录里有；广麻没有翻精，所以这里必须是 undefined 而不是空数组/null。
    expect(record.flipTile).toBeUndefined()
    expect(record.jokers).toBeUndefined()
    expect(record.flipSeat).toBeUndefined()
    expect(record.flipStack).toBeUndefined()
    expect(record.flipTiles).toBeUndefined()
    expect(record.dice?.second).toBeUndefined()
    // 反向确认"不是整份字段都没写"：广麻自己的必填项一个不少
    expect(reproductionDeficiencies(record)).toEqual([])
    expect(reproductionComplete(record)).toBe(true)
  })

  it('缺项由读取侧点名：少骰子 / 少发牌后手牌 / 少命令 / 缺断点都算不可复现', () => {
    const base = buildLotusClassicReproduction(snapshotInput())
    const drop = (patch: Partial<typeof base>) => reproductionDeficiencies({ ...base, ...patch })
    expect(drop({ dice: {} }).join('｜')).toContain('dice.first')
    expect(drop({ postDealHands: [[], [], []] }).join('｜')).toContain('postDealHands')
    expect(drop({ commands: [] }).join('｜')).toContain('commands')
    expect(drop({ wallBreakIndex: undefined }).join('｜')).toContain('wallBreakIndex')
    expect(drop({ openingScores: [2000] }).join('｜')).toContain('openingScores')
    expect(drop({ ringWall: realRing().slice(0, 100) }).join('｜')).toContain('ringWall')
  })

  it('广麻清单不要求翻精字段：判据按 variant 分派，不拿翻精癞子那套套过来', () => {
    const record = buildLotusClassicReproduction(snapshotInput())
    // 同一份内容若被标成翻精癞子，就会因为缺 jokers/flipTile/dice.second 被判"缺 3 项"——
    // 这正是必须先认 `variant` 的原因（两个玩法的重跑起点同为环状牌墙，光看 ringWall 分不开）。
    expect(reproductionDeficiencies({ ...record, variant: 'lotus-legacy' }).length).toBeGreaterThan(0)
    expect(reproductionDeficiencies(record)).toEqual([])
  })
})

describe('广麻 P1：交叉校验（§3.3）', () => {
  const hands = [['m1', 'm2', 'm3'], ['p1', 'p2'], ['s1'], ['east']]

  it('四家手牌逐张相同 ⇒ 通过', () => {
    expect(comparePostDealHands(hands, hands.map((hand) => [...hand]))).toEqual({ checked: true, ok: true, reason: null })
  })

  it('改一张 ⇒ 报「发牌算法变了或记录与引擎不一致」，并点名第几家第几张', () => {
    const actual = hands.map((hand) => [...hand])
    actual[2] = ['s2']
    const check = comparePostDealHands(hands, actual)
    expect(check.checked).toBe(true)
    expect(check.ok).toBe(false)
    expect(check.reason).toContain('发牌算法变了或记录与引擎不一致')
    expect(check.reason).toContain('第 2 家第 1 张')
  })

  it('只改顺序、不改牌的多重集合 ⇒ 仍判不合格（按位置比，不按集合比）', () => {
    const check = comparePostDealHands(hands, [['m3', 'm1', 'm2'], ['p1', 'p2'], ['s1'], ['east']])
    expect(check.ok).toBe(false)
    expect(check.reason).toContain('第 0 家第 1 张')
  })

  it('张数不同也判不合格（手牌顺序同样是发牌算法的一部分）', () => {
    const check = comparePostDealHands(hands, [['m1', 'm2'], ['p1', 'p2'], ['s1'], ['east']])
    expect(check.ok).toBe(false)
    expect(check.reason).toContain('张数对不上')
  })

  it('记录里没有 postDealHands ⇒ checked=false，不默认放行', () => {
    const check = comparePostDealHands(undefined, hands)
    expect(check.checked).toBe(false)
    expect(check.ok).toBe(false)
    expect(check.reason).toContain('无法交叉校验发牌')
  })

  it('开牌断点由牌墙+骰子推出：不一致同样是"记录与引擎不一致"', () => {
    const record = buildLotusClassicReproduction(snapshotInput())
    expect(compareLotusClassicOpeningExtras(record, { wallBreakIndex: 9 })).toEqual({ checked: true, ok: true, reason: null })
    const wrong = compareLotusClassicOpeningExtras(record, { wallBreakIndex: 8 })
    expect(wrong.ok).toBe(false)
    expect(wrong.reason).toContain('开牌断点对不上')
    // 记录里没带断点 ⇒ 不比（不猜），也不算通过
    expect(compareLotusClassicOpeningExtras({ ...record, wallBreakIndex: undefined }, { wallBreakIndex: 8 }))
      .toEqual({ checked: false, ok: true, reason: null })
  })
})

describe('广麻 P1：权威动作日志形状（§2.2）', () => {
  it('弃牌/补杠/暗杠/过牌都是同型的条目，windowId 与 windowKind 齐全', () => {
    const options = { windowId: 'round-1/window/2', windowKind: 'draw-turn', legalActionId: 'round-1/window/2/0', at: 7 }
    const discard = lotusClassicCommandEntry(1, { kind: 'discard', handIndex: 5 }, options)
    expect(discard).toEqual({
      seat: 1, kind: 'discard', at: 7, handIndex: 5,
      windowId: 'round-1/window/2', windowKind: 'draw-turn', legalActionId: 'round-1/window/2/0',
    })
    // 形状就是 `AnalysisCommandEntry`：`tile` 等可选载荷**没传就不写**（不填 undefined 冒充字段）
    expect(Object.keys(discard).sort()).toEqual(
      ['at', 'handIndex', 'kind', 'legalActionId', 'seat', 'windowId', 'windowKind'].sort(),
    )
    expect(lotusClassicCommandEntry(1, { kind: 'added-kong', meldIndex: 1 }, options).meldIndex).toBe(1)
    expect(lotusClassicCommandEntry(1, { kind: 'concealed-kong', tile: 'm1' }, options).tile).toBe('m1')
    expect(lotusClassicCommandEntry(1, { kind: 'pass' }, options).kind).toBe('pass')
  })

  it('碰带的 discardIndex 必须记下来（漏了重跑会以为碰完要重新摸牌）', () => {
    const entry = lotusClassicCommandEntry(2, { kind: 'peng', discardIndex: 4 }, { windowId: 'round-1/window/9', windowKind: 'claim' })
    expect(entry.kind).toBe('peng')
    expect(entry.discardIndex).toBe(4)
    expect(entry.windowId).toBe('round-1/window/9')
    // 不带 discardIndex 的碰同样合法（编排层会开一个 skipDraw 的回合窗口）
    expect(lotusClassicCommandEntry(2, { kind: 'peng' }, {}).discardIndex).toBeUndefined()
  })

  it('抢杠的**裸字符串**也认得（不会记成 unknown）', () => {
    expect(lotusClassicCommandEntry(3, 'win', { windowId: 'round-1/window/4', windowKind: 'rob-kong' }).kind).toBe('win')
    expect(lotusClassicCommandEntry(3, 'pass', {}).kind).toBe('pass')
    // 认不出来的东西如实记 unknown，不猜（重跑侧会因此报"对不上"）
    expect(lotusClassicCommandEntry(3, undefined, {}).kind).toBe('unknown')
    expect(lotusClassicCommandEntry(3, { kind: 'peng', discardIndex: '4' }, {}).discardIndex).toBeUndefined()
  })

  it('命令的区分键与合法动作同一套：弃牌看下标、补杠看副露下标、暗杠看牌，其余按 kind', () => {
    expect(commandEntryMatchKey({ kind: 'discard', handIndex: 3 })).toBe('discard|3')
    expect(commandEntryMatchKey({ kind: 'discard', handIndex: 3 })).not.toBe(commandEntryMatchKey({ kind: 'discard', handIndex: 4 }))
    expect(commandEntryMatchKey({ kind: 'added-kong', meldIndex: 0 })).not.toBe(commandEntryMatchKey({ kind: 'added-kong', meldIndex: 1 }))
    expect(commandEntryMatchKey({ kind: 'concealed-kong', tile: 'm1' })).toBe('concealed-kong|m1')
    // 中文显示名（LLM 表：阿拉伯数字）也折回牌码，两侧不会假性失配
    expect(commandEntryMatchKey({ kind: 'concealed-kong', tile: '1万' })).toBe('concealed-kong|m1')
    // 碰/过/胡在一个窗口里至多一个 ⇒ 按 kind 就是唯一的
    expect(commandEntryMatchKey({ kind: 'peng' })).toBe('peng')
    expect(commandEntryMatchKey({ kind: 'pass' })).toBe('pass')
    expect(commandEntryMatchKey({ kind: 'win' })).toBe('win')
  })
})