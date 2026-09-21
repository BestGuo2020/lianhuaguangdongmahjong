// 莲花广麻（`lotus-classic`）的赛后复现数据：**纯函数**部分（P1 §2／§3）。
//
// 结构刻意与 `lotusReproduction.ts`（翻精癞子）平行，但**不是复制粘贴**：两个玩法的重跑起点
// 虽然同为"环状牌墙 136 张"，开局读数却**不一样** ——
//   - 翻精癞子有翻精：`flipTile` / `jokers` / `flipSeat` / `flipStack` 都要交叉校验；
//   - 广麻**没有翻精**（`localOpeningTimeline` 只掷一次骰、只按庄家拆墙），所以快照里
//     **就是没有那些字段**。为了"和翻精癞子长得一样"去补一组空值是编造（差异清单 §3.2）。
//
// 分两层与翻精癞子同款：
// - 这个文件是纯的（无 Vue、无引擎、无定时器），快照口径与交叉校验判据能在 vitest 里直接断言；
// - 真正"重跑一局"的驱动器在 `reproduceLotusClassic.ts` —— 它必须开一个真实 `useGame`
//   实例（Vue composable），在浏览器夹具/假时钟里跑（§3.5）。
//
// 一句话：**这一层决定"记录里该有什么、缺什么算不合格"，那一层负责把记录喂回引擎。**
import { commandEntryFromAction, type AnalysisCommandEntry, type CommandEntryOptions } from './commandEntry'
import type { AnalysisReproduction } from './types'
import { actionMatchKey, type LotusActionKeyLike } from './lotusActionKey'

// ─────────────────────────────── 开局快照（每局一次） ───────────────────────────────

/**
 * 快照的输入：**分两处取**，因为它们是两件事（§3.2）。
 *
 * - 重跑**输入**（`ringWall` / `dice` / `dealer`）：由开局时间线的 `onRoundPrepared` 在
 *   "骰子掷完、牌墙按庄家拆开、**还没发牌**"那一刻交出。为什么非要那一刻：
 *   `state.wall` 随即会被发出去、局末再读它拿到的是**终局牌墙**，不是复现起点
 *   （血流在同一个地方踩过坑）。
 * - 开局**读数**（`openingScores` / `postDealHands`）：在 `beginTurn` 那一刻取 ——
 *   发牌完成、还没进入第一手决策。局末读 `state.players` 拿到的是终局手牌与终局分数，
 *   拿它当"起始状态"就是那个坑。
 */
export interface LotusClassicReproductionInput {
  /** 本局在整场里的序号（1 起，与展示回放同一套口径）。 */
  roundIndex: number
  /** 环状牌墙 136 张（**牌码**，如 `m1`/`south`）：**未发牌、未按庄家重排**的那一份。 */
  ringWall: readonly string[]
  /** 开局骰子（两粒）：重跑必须给，否则会被重抽。 */
  dice: { first?: readonly number[] }
  dealer: number
  /** 当局开局分数（四家）：不记它，第 2 局以后的结束分数永远对不上（重跑只能从初始分起步）。 */
  openingScores: readonly number[]
  /** 发牌后的四家手牌：**交叉校验**用，不是重跑输入。 */
  postDealHands: readonly (readonly string[])[]
  /** 牌山断点（`state.wall[0]` 的物理张位）——广麻里由庄家与骰子推出。 */
  wallBreakIndex: number
  /** 本局的权威动作序列（与 P0 决策记录同源、同顺序，顺序判据是 `windowId`）。 */
  commands: readonly AnalysisCommandEntry[]
  /** 数据来源：本机权威引擎（单机）。 */
  origin?: 'local' | 'authority'
}

/**
 * 组装一条复现数据。**只做转写，不做补造**：缺的字段不写，也不填默认值 ——
 * 缺项由 `reproductionDeficiencies`（`reproductionCapability.ts`）在读取侧如实列出。
 *
 * 广麻**没有翻精** ⇒ 这里**不写** `flipTile` / `jokers` / `flipSeat` / `flipStack`。
 * 读取侧因此能如实看出"这份记录里就是没有这些项"，而不是读到一组空值以为是"翻精没翻出来"。
 */
export function buildLotusClassicReproduction(input: LotusClassicReproductionInput): AnalysisReproduction {
  return {
    roundIndex: input.roundIndex,
    available: true,
    origin: input.origin ?? 'local',
    variant: 'lotus-classic',
    ringWall: [...input.ringWall],
    dice: {
      ...(input.dice.first ? { first: [...input.dice.first] } : {}),
    },
    dealer: input.dealer,
    openingScores: [...input.openingScores],
    postDealHands: input.postDealHands.map((hand) => [...hand]),
    wallBreakIndex: input.wallBreakIndex,
    commands: input.commands.map((entry) => ({ ...entry })),
  }
}

/** 牌墙口径的自检：136 张、每种牌各 4 张、全部是牌码。返回缺失/异常的原因（空数组 = 合格）。 */
export function ringWallDeficiencies(
  ringWall: readonly string[] | undefined,
  tileTypes: readonly string[],
): string[] {
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

export interface LotusClassicCrossCheck {
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
): LotusClassicCrossCheck {
  if (!recorded?.length) return { checked: false, ok: false, reason: '记录里没有 postDealHands，无法交叉校验发牌' }
  if (recorded.length !== actual.length) {
    return {
      checked: true, ok: false,
      reason: `${MISMATCH_HEAD}：家数对不上（记录 ${recorded.length} 家 vs 重跑 ${actual.length} 家）`,
    }
  }
  for (let seat = 0; seat < recorded.length; seat += 1) {
    const want = recorded[seat] ?? []
    const got = actual[seat] ?? []
    if (want.length !== got.length) {
      return {
        checked: true, ok: false,
        reason: `${MISMATCH_HEAD}：第 ${seat} 家手牌张数对不上（记录 ${want.length} 张 vs 重跑 ${got.length} 张）`,
      }
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

/** 重跑侧读到的、由"牌墙 + 骰子 + 庄家"推出的开局读数（广麻只有牌山断点这一项）。 */
export interface LotusClassicOpeningExtras {
  wallBreakIndex: number
}

/**
 * 比对"由牌墙 + 骰子 + 庄家推出的开局读数"。
 *
 * 广麻的这一项只有 `wallBreakIndex`：**没有翻精**（`localOpeningTimeline` 里没有 `resolveFlip`
 * 那一套），所以这里**不比** `flipTile` / `jokers` / `flipSeat` / `flipStack` —— 那几项在广麻的
 * 记录里本来就不存在，去比它们只会把"缺失"当成失败（差异清单 §3.2：宁可如实少一项）。
 * 记录里没带的项不比（不猜），比对失败时直接点名是哪一项。
 */
export function compareLotusClassicOpeningExtras(
  record: AnalysisReproduction,
  actual: LotusClassicOpeningExtras,
): LotusClassicCrossCheck {
  let checked = false
  if (typeof record.wallBreakIndex === 'number') {
    checked = true
    if (record.wallBreakIndex !== actual.wallBreakIndex) {
      return {
        checked, ok: false,
        reason: `${MISMATCH_HEAD}：开牌断点对不上（记录 ${record.wallBreakIndex} vs 重跑 ${actual.wallBreakIndex}）`,
      }
    }
  }
  return { checked, ok: true, reason: null }
}

// ─────────────────────────────── 权威动作日志（每局一次） ───────────────────────────────

/**
 * 把控制器的返回值折成**可重跑的命令条目**（形状 = `AnalysisCommandEntry`，与 P0 决策记录同源）。
 *
 * 两处必须按广麻的实际情况处理，不能照抄血流：
 * 1. 抢杠的动作是**裸字符串**（`'win' | 'pass'`），不是 `{ kind }` 对象 ⇒ 先归一，
 *    否则抢杠的 `'pass'` 会被记成 `kind: 'unknown'`，重跑时在抢杠窗口里对不上任何合法动作；
 * 2. **碰带的 `discardIndex` 必须记**（`ClaimAction` 的 `{ kind:'peng', discardIndex? }`）：
 *    编排层把"碰完立刻弃哪张"折在碰动作里（`localTurnOrchestrator` 的 `case 'peng'`：带了
 *    `discardIndex` 就直接弃牌、**不另开决策窗口**），漏了它重跑会以为这次碰之后要重新摸牌，
 *    整局从此分叉、再也回不到同一个结束状态。
 */
export function lotusClassicCommandEntry(
  seat: number,
  action: unknown,
  options: CommandEntryOptions = {},
): AnalysisCommandEntry {
  // 抢杠是裸字符串（`'win' | 'pass'`）⇒ 包成 `{ kind }` 再交给共用的折法；
  // 对象形态原样透传（`discardIndex` 在第 2 条里是必需的）。
  const payload = typeof action === 'string' ? { kind: action } : action
  return commandEntryFromAction(seat, payload, options)
}

/**
 * 命令条目的**区分键**：靠它把记录里的动作对回"重跑此刻的合法动作"。
 *
 * 复用与翻精癞子**同一套**键函数（`lotusActionKey.ts`）而不是另写一套：两个玩法的动作区分语义
 * 完全一致（弃牌看手牌下标、补杠看副露下标、暗杠看牌、吃看组合、其余按 kind），
 * 分散成两份实现迟早会在"补杠下标"这种细节上漂移。唯一的差别是**字段名** ——
 * 条目里组合叫 `tiles`（血流的写法），合法动作里叫 `meld`（`AnalysisLegalAction` 的写法），
 * 所以在调用前统一一次。
 */
export function commandEntryMatchKey(entry: {
  kind: string
  tile?: string
  handIndex?: number
  meldIndex?: number
  tiles?: readonly string[]
}): string {
  return actionMatchKey({
    kind: entry.kind,
    ...(entry.tile !== undefined ? { tile: entry.tile } : {}),
    ...(entry.handIndex !== undefined ? { handIndex: entry.handIndex } : {}),
    ...(entry.meldIndex !== undefined ? { meldIndex: entry.meldIndex } : {}),
    ...(entry.tiles?.length ? { meld: entry.tiles } : {}),
  } satisfies LotusActionKeyLike)
}