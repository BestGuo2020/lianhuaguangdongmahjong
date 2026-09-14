import type { TileType } from '../../../core/contracts/types'
import type { DecomposedGroup, PatternId, WinningDecomposition } from './types'

export const WINDS: readonly TileType[] = ['east', 'south', 'west', 'north']
export const DRAGONS: readonly TileType[] = ['red', 'green', 'white']
export const isHonor = (tile: TileType) => tile.length !== 2
export const isTerminal = (tile: TileType) => tile.length === 2 && (tile[1] === '1' || tile[1] === '9')

/**
 * 一组数字里是否存在 length 项、公差为 `steps` 中任一值的等差数列（同花色面子序列的番型判定）。
 *
 * 顺子族（一色三步高/四步高）**公差取 1 或 2**：国标把"依次递增一位"（123+234+345，素三步步高）
 * 与"依次递增二位"（123+345+567，素三连环扣）合称一色三步高，四步高同理（123+345+567+789）。
 * 因此 345+567+789（起始 3/5/7）这类"宽三步"必须成立，不能只认连续起始。
 *
 * 刻子族（一色三/四节高）**只有"依次递增一位"**，公差固定 1（见调用处的 [1]）。
 *
 * 同一数字重复出现只算一次：番型要的是 length 个**不同递增档位**的面子，重复档位不构成步高。
 */
function hasSteppedRun(numbers: readonly number[], length: number, steps: readonly number[] = [1, 2]): boolean {
  const unique = [...new Set(numbers.filter(n => Number.isFinite(n)))].sort((a, b) => a - b)
  if (unique.length < length) return false
  const present = new Set(unique)
  for (const step of steps) {
    for (const start of unique) {
      let matched = true
      for (let offset = 1; offset < length; offset += 1) {
        if (!present.has(start + step * offset)) { matched = false; break }
      }
      if (matched) return true
    }
  }
  return false
}

export function matchPatterns(hand: WinningDecomposition): PatternId[] {
  if (hand.shape !== 'standard' && hand.shape !== 'sevenPairs') return [hand.shape]
  const result: PatternId[] = hand.shape === 'sevenPairs' ? ['sevenPairs'] : []
  const tiles = hand.groups.flatMap(g => [...g.tiles])
  const suits = new Set(tiles.filter(t => !isHonor(t)).map(t => t[0]))
  const honors = tiles.some(isHonor)
  // 豪华七对：七对里含"四张相同"。2026-09-12 用户定案：**允许精牌替补**凑成那四张
  // （tiles 是 represented 牌面，精牌顶替后计入），因此不再要求整手全自然（hand.natural）。
  // 好处：不必真的摸到 4 张实体同牌，也不必为了它放弃开杠——精牌就能补齐，豪华七对因此可达。
  if (hand.shape === 'sevenPairs' && tiles.some(tile => tiles.filter(other => other === tile).length >= 4)) result.push('luxury-seven-pairs')
  if (suits.size === 1) result.push(honors ? 'mixed-suit' : 'pure-suit')
  if (tiles.every(isHonor)) result.push('all-honors')
  if (tiles.every(t => ['s2', 's3', 's4', 's6', 's8', 'green'].includes(t))) result.push('all-green')
  if (hand.shape === 'sevenPairs') return result
  const melds = hand.groups.filter(g => g.kind !== 'pair')
  const pair = hand.groups.find(g => g.kind === 'pair')!.tiles[0]
  const triplets = melds.filter(g => g.kind === 'triplet' || g.kind === 'kong')
  const sequences = melds.filter(g => g.kind === 'sequence')
  const allTriplets = triplets.length === 4
  if (allTriplets) result.push('all-triplets')
  const dragonCount = DRAGONS.filter(t => triplets.some(g => g.tiles[0] === t)).length
  const windCount = WINDS.filter(t => triplets.some(g => g.tiles[0] === t)).length
  if (dragonCount === 3) result.push('big-three-dragons')
  if (dragonCount === 2 && DRAGONS.includes(pair) && !triplets.some(g => g.tiles[0] === pair)) result.push('little-three-dragons')
  if (windCount === 4) result.push('big-four-winds')
  if (windCount === 3 && WINDS.includes(pair) && !triplets.some(g => g.tiles[0] === pair)) result.push('little-four-winds')
  if (allTriplets && tiles.every(isTerminal)) result.push('pure-terminals')
  if (allTriplets && honors && suits.size > 0 && tiles.every(t => isHonor(t) || isTerminal(t))) result.push('mixed-terminals')
  const concealed = triplets.filter(g => g.concealed).length
  if (concealed >= 3) result.push('three-concealed-triplets')
  if (concealed === 4) result.push('four-concealed-triplets')
  const kongs = melds.filter(g => g.kind === 'kong').length
  if (kongs >= 3) result.push('three-kongs')
  if (kongs === 4) result.push('four-kongs')
  if (suits.size === 1 && !honors && hand.groups.every(g => g.origin.kind === 'hand')) {
    const counts = Array.from({ length: 9 }, (_, n) => tiles.filter(t => Number(t[1]) === n + 1).length)
    if (counts.every((n, i) => n >= (i === 0 || i === 8 ? 3 : 1))) result.push('nine-gates')
  }
  // —— 2026-09-12 第二版番种表新增 ——
  // 断幺九：全部为 2~8 数牌。
  if (tiles.every(t => !isHonor(t) && !isTerminal(t))) result.push('all-simples')
  // 全带幺：每副面子与将牌都含幺九或字牌（允许 123 / 789 这类含幺的顺子）。
  if (hand.groups.every(g => g.tiles.some(t => isHonor(t) || isTerminal(t)))) result.push('all-with-terminals')
  // 一色步高 / 清龙：同花色顺子的起始数字关系（步高公差 1 或 2；清龙仍是 123/456/789 的 1/4/7）。
  const bySuit = (groups: readonly DecomposedGroup[]) => {
    const map = new Map<string, number[]>()
    for (const group of groups) {
      const tile = group.tiles[0]
      if (isHonor(tile)) continue
      map.set(tile[0], [...(map.get(tile[0]) ?? []), Number(tile[1])])
    }
    return map
  }
  for (const starts of bySuit(sequences).values()) {
    if (hasSteppedRun(starts, 4)) result.push('one-suit-four-steps')
    else if (hasSteppedRun(starts, 3)) result.push('one-suit-three-steps')
    if ([1, 4, 7].every(start => starts.includes(start))) result.push('pure-straight')
  }
  // 一色节高：同花色刻子/杠的数字连续（节高只有"依次递增一位"，公差固定 1）。
  for (const numbers of bySuit(triplets).values()) {
    if (hasSteppedRun(numbers, 4, [1])) result.push('one-suit-four-joints')
    else if (hasSteppedRun(numbers, 3, [1])) result.push('one-suit-three-joints')
  }
  // 门清平胡是**兜底本体**（方案B，2026-09-12 用户定案）：标准四面子一将、未副露、且不满足任何其他番种时，
  // 取代鸡胡作为兜底；**不与任何主体番种叠加**。七对/十三幺/十三烂/七星等特殊结构在函数开头已提前返回。
  const concealedHand = hand.groups.every(g => g.origin.kind === 'hand')
  return result.length ? result : [concealedHand ? 'concealed-hand' : 'pinghu']
}
