// 「这份复现数据能不能重跑」的**内容判据**（方案 §2.4、§9.5）。
//
// 为什么不能一刀切：P0 阶段两个玩法都如实标 `reproductionCapable: false` —— 那是
// **"这场根本没记复现数据"**这一件事的标注，不是对记录内容的判定。做完 P1 之后，同一份导出包里
// 完全可能有的局带了完整复现数据、有的局没带（例如那一局没进入第一手决策），
// 读方需要的是"**缺了哪一项**"，而不是一个笼统的 false，也不是"有 reproduction 记录就算齐"。
//
// 判据按**玩法口径**分开，因为两套重跑起点不是一回事（`AnalysisReproduction` 里的字段说明）：
// - 翻精癞子（`lotus-legacy`）：环状牌墙 136 张 + 两颗骰子 + 庄家；
// - 血流（不写 `variant`）：发牌后剩余牌墙 + 四家初始手牌 + 庄家第 14 张下标。
// 硬套一份清单必然把本来完整的记录判成缺失（缺的字段名甚至会张冠李戴）。
import type { AnalysisReproduction } from './types'

/** 这份复现数据是不是"环状牌墙"口径（翻精癞子）。 */
export function isRingWallReproduction(record: AnalysisReproduction): boolean {
  return record.variant === 'lotus-legacy' || Array.isArray(record.ringWall)
}

/**
 * 血流口径必需字段：与 `openingFromReproduction` 的检查清单**逐项对齐**（那是它重建开局的
 * 硬要求），再加 `openingScores`（没有它结束分数无从比对，校验器会直接报"不可比对"）。
 * 两处清单若不一致，"导出说可复现、校验器说缺字段"这种自相矛盾迟早会出现。
 */
function bloodFlowDeficiencies(record: AnalysisReproduction): string[] {
  const missing: string[] = []
  if (!record.initialWall?.length) missing.push('initialWall（发牌后牌墙）')
  if (!record.initialHands || record.initialHands.length !== 4) missing.push('initialHands（四家）')
  if (typeof record.dealer !== 'number') missing.push('dealer（庄家）')
  if (typeof record.dealerDrawnIndex !== 'number') missing.push('dealerDrawnIndex（庄家第 14 张下标）')
  if (!record.flipTiles || record.flipTiles.length !== 2) missing.push('flipTiles（两个翻精）')
  if (!record.jokers?.length) missing.push('jokers（精牌）')
  if (typeof record.flipStack !== 'number') missing.push('flipStack')
  if (typeof record.flipSeat !== 'number') missing.push('flipSeat')
  if (typeof record.wallBreakIndex !== 'number') missing.push('wallBreakIndex')
  if (!record.openingScores || record.openingScores.length !== 4) missing.push('openingScores（当局开局分）')
  return missing
}

/**
 * 翻精癞子口径必需字段：
 * - 重跑输入：`ringWall`(136) / `dice.first` / `dice.second` / `dealer` / `openingScores`(四家) / `commands`；
 * - 交叉校验输入：`postDealHands`(四家) / `jokers` / `flipTile` / `wallBreakIndex`。
 *
 * `postDealHands` 也算必需：校验器拿它证明"重跑与记录是同一副牌、同一个发牌算法"，
 * 缺了它就只能证明"能跑完",不能证明跑的是同一局 —— 按 §9.5 的口径，这种情况必须如实标成
 * 不可复现，而不是默认它没问题。
 */
function lotusLegacyDeficiencies(record: AnalysisReproduction): string[] {
  const missing: string[] = []
  if (record.ringWall?.length !== 136) missing.push(`ringWall（环状牌墙 136 张，实为 ${record.ringWall?.length ?? 0} 张）`)
  if (record.dice?.first?.length !== 2) missing.push('dice.first（第一次掷骰两枚）')
  if (record.dice?.second?.length !== 2) missing.push('dice.second（第二次掷骰两枚）')
  if (typeof record.dealer !== 'number') missing.push('dealer（庄家）')
  if (!record.openingScores || record.openingScores.length !== 4) missing.push('openingScores（当局开局分）')
  if (!record.commands?.length) missing.push('commands（权威动作日志）')
  if (!record.postDealHands || record.postDealHands.length !== 4) missing.push('postDealHands（发牌后的四家手牌，交叉校验用）')
  if (!record.jokers?.length) missing.push('jokers（精牌，交叉校验用）')
  if (typeof record.flipTile !== 'string') missing.push('flipTile（翻出的指示牌，交叉校验用）')
  if (typeof record.wallBreakIndex !== 'number') missing.push('wallBreakIndex（开牌断点，交叉校验用）')
  return missing
}

/**
 * 这条复现数据**缺什么**（空数组 = 重跑所需的内容齐了）。
 *
 * 口径（与 `openingFromReproduction` 同一句原则）：**绝不用默认值顶替缺失字段**。
 * 缺就是缺，如实列出字段名；不要因为"缺一项也能跑起来"就放行 —— 那样跑出来的是另一个局面，
 * 读方却会以为复现成功。
 */
export function reproductionDeficiencies(record: AnalysisReproduction | null | undefined): string[] {
  if (!record || typeof record !== 'object') return ['复现数据（记录为空）']
  if (record.available === false) {
    return [record.unavailableReason ? `复现数据不可用：${record.unavailableReason}` : '复现数据被标记为不可用']
  }
  return isRingWallReproduction(record) ? lotusLegacyDeficiencies(record) : bloodFlowDeficiencies(record)
}

/** 这条复现数据是否**内容完整**（能重跑 + 能交叉校验）。 */
export function reproductionComplete(record: AnalysisReproduction | null | undefined): boolean {
  return reproductionDeficiencies(record).length === 0
}