import type { Meld, TileType } from '../../../core/contracts/types'
import type { PatternId } from '../patterns/types'
import { DRAGONS, WINDS, isHonor, isTerminal } from '../patterns/catalog'

const GREEN = new Set<TileType>(['s2', 's3', 's4', 's6', 's8', 'green'])
const isTriplet = (m: Readonly<Meld>) => !m.windKong && (m.type === 'peng' || m.type === 'gang' || m.type === 'angang')

/** Necessary structural conditions only. True does not promise live tiles, completion or profit.
 * Declared groups cannot be dismantled or reinterpret their joker faces (decompose.validateWinInput).
 */
export function canDevelopPatternWithMelds(id: PatternId, melds: readonly Readonly<Meld>[]): boolean {
  if (!melds.length) return true
  const free = Math.max(0, 4 - melds.length)
  const fixed = melds.flatMap(m => m.tiles)
  const honorGroupsFit = (tiles: readonly TileType[], required: number, needsPair: boolean) => {
    const held = new Set(melds.filter(m => isTriplet(m) && tiles.includes(m.tile)).map(m => m.tile))
    // Small honor patterns need a pair of a DIFFERENT honor, not another already-declared triplet.
    return held.size + free >= required && (!needsPair || (held.size <= required && held.size < tiles.length))
  }
  switch (id) {
    case 'sevenPairs': case 'luxury-seven-pairs': case 'shiSanLan': case 'qiXing':
    case 'thirteenOrphans': case 'nine-gates':
      // Even a concealed kong occupies a group; these decompositions require no declared groups.
      return false
    case 'big-three-dragons': return honorGroupsFit(DRAGONS, 3, false)
    case 'little-three-dragons': return honorGroupsFit(DRAGONS, 2, true)
    case 'big-four-winds': return honorGroupsFit(WINDS, 4, false)
    case 'little-four-winds': return honorGroupsFit(WINDS, 3, true)
    case 'three-concealed-triplets': case 'four-concealed-triplets': {
      const maximum = free + melds.filter(m => m.type === 'angang' && !m.windKong).length
      return maximum >= (id === 'three-concealed-triplets' ? 3 : 4)
    }
    case 'three-kongs': case 'four-kongs':
      // Pungs may become added kongs; sequences and wind kongs cannot become ordinary kongs.
      return free + melds.filter(isTriplet).length >= (id === 'three-kongs' ? 3 : 4)
    case 'all-triplets': return melds.every(isTriplet)
    case 'pure-terminals': return melds.every(isTriplet) && fixed.every(isTerminal)
    case 'mixed-terminals': return melds.every(isTriplet) && fixed.every(t => isHonor(t) || isTerminal(t))
    case 'all-honors': return fixed.every(isHonor)
    case 'all-green': return fixed.every(t => GREEN.has(t))
    case 'pure-suit': return !fixed.some(isHonor) && new Set(fixed.map(t => t[0])).size <= 1
    case 'mixed-suit': return new Set(fixed.filter(t => !isHonor(t)).map(t => t[0])).size <= 1
    case 'all-simples': return fixed.every(t => !isHonor(t) && !isTerminal(t))
    case 'all-with-terminals': return melds.every(m => m.tiles.some(t => isHonor(t) || isTerminal(t)))
    case 'concealed-hand': return melds.every(m => m.type === 'angang')
    case 'pinghu': return melds.every(m => m.type === 'chi')
    default: return true
  }
}
