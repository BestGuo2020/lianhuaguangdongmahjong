// 翻精癞子的赛后复现数据：**纯函数**部分（P1 §2／§3）。
//
// 分两层是刻意的：
// - 这个文件是纯的（无 Vue、无引擎、无定时器），因此快照口径与交叉校验判据能在 vitest 里直接断言；
// - 真正"重跑一局"的驱动器在 `reproduceLotusLegacy.ts` —— 它必须开一个真实 `useLotusGame`
//   实例，而那是 Vue composable（watch／定时器／音效全在里面），只能在浏览器夹具里跑（§3.5）。
//
// 一句话：**这一层决定"记录里该有什么、缺什么算不合格"，那一层负责把记录喂回引擎。**
import { commandEntryFromAction, type AnalysisCommandEntry, type CommandEntryOptions } from './commandEntry'
import { actionMatchKey, toLotusActionLike } from './lotusLegacyAdapter'
import type { AnalysisReproduction } from './types'

// ─────────────────────────────── 开局快照（每局一次） ───────────────────────────────

/**
 * 快照的输入：**分两处取**，因为它们是两件事（§3.2）：
 *
 * - 重跑**输入**（`ringWall` / `dice` / `dealer`）：由开局时间线在"牌墙与两颗骰子都定下来"时交出
 *   （那一刻之后牌墙会被移出翻精墩、按开牌断点重排、发出去，局末再读 `state.wall` 拿到的是
 *   **终局牌墙**，不是复现起点）；
 * - 开局**读数**（`openingScores` / `postDealHands` / 翻精结果）：在 `beginTurn` 那一刻取 ——
 *   发牌完成、还没进入第一手决策。局末读 `state.players` 拿到的是终局手牌与终局分数，
 *   拿它当"起始状态"就是血流踩过的那个坑。
 */
export interface LotusReproductionInput {
  /** 本局在整场里的序号（1 起，与展示回放同一套口径，见 `lotusLegacyAdapter.roundIdOf`）。 */
  roundIndex: number
  /** 环状牌墙 136 张（**牌码**，如 `m1`/`south`）。 */
  ringWall: readonly string[]
  /** 两对骰子：重跑必须给，否则会被重抽。 */
  dice: { first?: readonly number[]; second?: readonly number[] }
  dealer: number
  /** 当局开局分数（四家）：不记它，第 2 局以后的结束分数永远对不上（重跑只能从初始分起步）。 */
  openingScores: readonly number[]
  /** 发牌后的四家手牌：**交叉校验**用，不是重跑输入。 */
  postDealHands: readonly (readonly string[])[]
  /** 翻出的指示牌（精）；由牌墙+骰子推出，记下来只作交叉校验。 */
  flipTile?: string | null
  jokers: readonly string[]
  flipSeat?: number | null
  flipStack?: number | null
  /** 牌山断点（`state.wall[0]` 的物理张位）。 */
  wallBreakIndex: number
  /** 本局的权威动作序列（与 P0 决策记录同源、同顺序，顺序判据是 `windowId`）。 */
  commands: readonly AnalysisCommandEntry[]
  /** 数据来源：本机权威引擎（单机）。 */
  origin?: 'local' | 'authority'
}

/**
 * 组装一条复现数据。**只做转写，不做补造**：缺的字段不写，也不填默认值 ——
 * 缺项由 `reproductionDeficiencies`（`reproductionCapability.ts`）在读取侧如实列出。
 */
export function buildLotusReproduction(input: LotusReproductionInput): AnalysisReproduction {
  return {
    roundIndex: input.roundIndex,
    available: true,
    origin: input.origin ?? 'local',
    variant: 'lotus-legacy',
    ringWall: [...input.ringWall],
    dice: {
      ...(input.dice.first ? { first: [...input.dice.first] } : {}),
      ...(input.dice.second ? { second: [...input.dice.second] } : {}),
    },
    dealer: input.dealer,
    openingScores: [...input.openingScores],
    postDealHands: input.postDealHands.map((hand) => [...hand]),
    ...(typeof input.flipTile === 'string' ? { flipTile: input.flipTile } : {}),
    jokers: [...input.jokers],
    ...(typeof input.flipSeat === 'number' ? { flipSeat: input.flipSeat } : {}),
    ...(typeof input.flipStack === 'number' ? { flipStack: input.flipStack } : {}),
    wallBreakIndex: input.wallBreakIndex,
    commands: input.commands.map((entry) => ({ ...entry })),
  }
}

/** 牌墙口径的自检：136 张、每种牌各 4 张、全部是牌码。返回缺失/异常的原因（空数组 = 合格）。 */
export function ringWallDeficiencies(ringWall: readonly string[] | undefined, tileTypes: readonly string[]): string[] {
  const problems: string[] = []
  if (ringWall?.length !== 136) problems.push(`张数不是 136（实为 ${ringWall?.length ?? 0}）`)
  const known = new Set(tileTypes)
  const unknown = [...new Set((ringWall ?? []).filter((tile) => !known.has(tile)))]
  if (unknown.length) problems.push(`不是牌码：${unknown.join('、')}`)
  for (const tile of tileTypes) {
    const count = (ringWall ?? []).filter((entry) => entry === tile).length
    if (count !== 4) problems.push(`${tile} 有 ${count} 张（应为 4）`)
  }
  return problems
}

// ─────────────────────────────── 交叉校验（重跑之前） ───────────────────────────────

export interface LotusCrossCheck {
  /** 记录里有没有这项可比对的内容。 */
  checked: boolean
  ok: boolean
  /** 不合格的原因（`checked` 为真而 `ok` 为假时才有意义）。 */
  reason: string | null
}

const MISMATCH_HEAD = '发牌算法变了或记录与引擎不一致'

/**
 * 比对"重跑重新发牌得到的手牌"与记录里的 `postDealHands`。
 *
 * **这是本方案最重要的一道闸**：不一致就直接停 —— 否则重跑只是拿**另一副牌**跑了一遍，
 * 结束分数自然对不上，读方却会把它读成"牌流复现失败"（血流在"复现数据缺字段"上吃过同类亏）。
 * 逐张按牌面比较（不排序、不比集合）：手牌顺序也是发牌算法的一部分，同牌不同位同样是差异。
 */
export function comparePostDealHands(
  recorded: readonly (readonly string[])[] | undefined,
  actual: readonly (readonly string[])[],
): LotusCrossCheck {
  if (!recorded?.length) return { checked: false, ok: false, reason: '记录里没有 postDealHands，无法交叉校验发牌' }
  if (recorded.length !== actual.length) {
    return { checked: true, ok: false, reason: `${MISMATCH_HEAD}：家数对不上（记录 ${recorded.length} 家 vs 重跑 ${actual.length} 家）` }
  }
  for (let seat = 0; seat < recorded.length; seat += 1) {
    const want = recorded[seat] ?? []
    const got = actual[seat] ?? []
    if (want.length !== got.length) {
      return { checked: true, ok: false, reason: `${MISMATCH_HEAD}：第 ${seat} 家手牌张数对不上（记录 ${want.length} 张 vs 重跑 ${got.length} 张）` }
    }
    for (let index = 0; index < want.length; index += 1) {
      if (want[index] !== got[index]) {
        return {
          checked: true, ok: false,
          reason: `${MISMATCH_HEAD}：第 ${seat} 家第 ${index + 1} 张对不上（记录 ${want[index]} vs 重跑 ${got[index]}）`,
        }
      }
    }
  }
  return { checked: true, ok: true, reason: null }
}

/** 重跑侧读到的、由"牌墙 + 骰子"推出的开局读数。 */
export interface LotusOpeningExtras {
  flipTile: string | null
  jokers: readonly string[]
  flipStack: number | null
  flipSeat: number | null
  wallBreakIndex: number
}

/**
 * 比对"由牌墙 + 骰子推出的开局读数"（翻精/精牌/开牌断点）。
 *
 * 这几项**不是重跑输入**（引擎自己从牌墙与骰子推），所以它们一致就等于证明了
 * `resolveFlip` / `resolveOpeningStack` / `wallBreakIndexForOpeningStack` 这三条推算路径没变。
 * 记录里没带的项不比（不猜），逐项比对失败时直接点名是哪一项。
 */
export function compareLotusOpeningExtras(
  record: AnalysisReproduction,
  actual: LotusOpeningExtras,
): LotusCrossCheck {
  let checked = false
  if (typeof record.flipTile === 'string') {
    checked = true
    if (record.flipTile !== actual.flipTile) {
      return { checked, ok: false, reason: `${MISMATCH_HEAD}：翻精指示牌对不上（记录 ${record.flipTile} vs 重跑 ${actual.flipTile ?? '（无）'}）` }
    }
  }
  if (record.jokers?.length) {
    checked = true
    const want = [...record.jokers].sort().join(',')
    const got = [...actual.jokers].sort().join(',')
    if (want !== got) {
      return { checked, ok: false, reason: `${MISMATCH_HEAD}：精牌集合对不上（记录 [${record.jokers.join(' ')}] vs 重跑 [${actual.jokers.join(' ')}]）` }
    }
  }
  if (typeof record.wallBreakIndex === 'number') {
    checked = true
    if (record.wallBreakIndex !== actual.wallBreakIndex) {
      return { checked, ok: false, reason: `${MISMATCH_HEAD}：开牌断点对不上（记录 ${record.wallBreakIndex} vs 重跑 ${actual.wallBreakIndex}）` }
    }
  }
  if (typeof record.flipStack === 'number') {
    checked = true
    if (record.flipStack !== actual.flipStack) {
      return { checked, ok: false, reason: `${MISMATCH_HEAD}：翻精墩位对不上（记录 ${record.flipStack} vs 重跑 ${actual.flipStack ?? '（无）'}）` }
    }
  }
  if (typeof record.flipSeat === 'number') {
    checked = true
    if (record.flipSeat !== actual.flipSeat) {
      return { checked, ok: false, reason: `${MISMATCH_HEAD}：翻精方位对不上（记录 ${record.flipSeat} vs 重跑 ${actual.flipSeat ?? '（无）'}）` }
    }
  }
  return { checked, ok: true, reason: null }
}

// ─────────────────────────────── 权威动作日志（每局一次） ───────────────────────────────

/**
 * 把控制器的返回值折成**可重跑的命令条目**（形状 = `AnalysisCommandEntry`，与 P0 决策记录同源）。
 *
 * 两处必须按这个玩法的实际情况处理，不能照抄血流：
 * 1. 控制器返回的动作有**三套形状**（回合/鸣牌的动作对象、吃的 `ChiMeld`、抢杠的**裸字符串**）
 *    ⇒ 先用 `toLotusActionLike` 归一，否则抢杠的 `'pass'` 会被记成 `kind: 'unknown'`；
 * 2. **碰带的 `discardIndex` 必须记**（见 `AnalysisReproduction.commands[].discardIndex` 的说明）：
 *    编排层把"碰完立刻弃哪张"折在碰动作里、不另开决策窗口，漏了它重跑会以为这次碰之后要重新摸牌。
 */
export function lotusCommandEntry(
  seat: number,
  action: unknown,
  options: CommandEntryOptions = {},
): AnalysisCommandEntry {
  const picked = toLotusActionLike(action)
  const raw = (action && typeof action === 'object' ? action : {}) as { discardIndex?: unknown }
  return commandEntryFromAction(seat, {
    kind: picked?.kind ?? 'unknown',
    ...(picked?.tile !== undefined ? { tile: picked.tile } : {}),
    // `handIndex` 是归一后的名字，`commandEntryFromAction` 两种写法都认（见那里的注释）。
    ...(picked?.handIndex !== undefined ? { handIndex: picked.handIndex } : {}),
    // 吃的组合在归一后是 `meld`（牌面数组），条目里叫 `tiles`：与血流的组合动作同一个字段。
    ...(picked?.meld?.length ? { tiles: picked.meld } : {}),
    ...(picked?.meldIndex !== undefined ? { meldIndex: picked.meldIndex } : {}),
    ...(typeof raw.discardIndex === 'number' ? { discardIndex: raw.discardIndex } : {}),
  }, options)
}

/**
 * 命令条目的**区分键**：靠它把记录里的动作对回"重跑此刻的合法动作"。
 *
 * 复用适配层那套（`actionMatchKey`）而不是另写一套：弃牌看手牌下标、补杠看副露下标、暗杠看牌、
 * 吃看组合（排序后比）。唯一的差别是**字段名** —— 条目里组合叫 `tiles`（血流的写法），
 * 合法动作里叫 `meld`（`AnalysisLegalAction` 的写法），所以在调用前统一一次。
 */
export function commandEntryMatchKey(entry: { kind: string; tile?: string; handIndex?: number; meldIndex?: number; tiles?: readonly string[] }): string {
  return actionMatchKey({
    kind: entry.kind,
    ...(entry.tile !== undefined ? { tile: entry.tile } : {}),
    ...(entry.handIndex !== undefined ? { handIndex: entry.handIndex } : {}),
    ...(entry.meldIndex !== undefined ? { meldIndex: entry.meldIndex } : {}),
    ...(entry.tiles?.length ? { meld: entry.tiles } : {}),
  })
}