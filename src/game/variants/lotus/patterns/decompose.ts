import type { TileType } from '../../../core/contracts/types'
import { TILE_TYPES } from '../../../core/rules/tiles'
import type { WinEvaluationInput } from '../bloodFlow/types'
import { isQiXingShiSanLan, isShiSanLan, isThirteenOrphans } from '../lotusRules'
import { DRAGONS, WINDS, isHonor, isTerminal } from './catalog'
import type { DecomposedGroup, HandShape, TileAssignment, WinningDecomposition } from './types'

interface Template { kind: 'pair' | 'sequence' | 'triplet'; tiles: TileType[] }
const PAIRS: Template[] = TILE_TYPES.map(t => ({ kind: 'pair', tiles: [t, t] }))
const MELDS: Template[] = TILE_TYPES.map(t => ({ kind: 'triplet', tiles: [t, t, t] }))
for (const suit of ['m', 'p', 's']) for (let n = 1; n <= 7; n++) {
  MELDS.push({ kind: 'sequence', tiles: [0, 1, 2].map(i => `${suit}${n + i}` as TileType) })
}
for (const excluded of WINDS) MELDS.push({ kind: 'sequence', tiles: WINDS.filter(t => t !== excluded) })
MELDS.push({ kind: 'sequence', tiles: [...DRAGONS] })
const sorted = (tiles: readonly TileType[]) => [...tiles].sort().join(',')

/** Validate physical ownership only; virtual representatives may exceed four copies. */
export function validateWinInput(input: WinEvaluationInput): DecomposedGroup[] | null {
  if (input.melds.length > 4 || input.concealed.length + 1 + input.melds.length * 3 !== 14) return null
  const physical = [...input.concealed, input.winningTile, ...input.melds.flatMap(m => m.tiles)]
  if (physical.some(t => !TILE_TYPES.includes(t)) || input.jokers.some(t => !TILE_TYPES.includes(t))) return null
  if (TILE_TYPES.some(t => physical.filter(p => p === t).length > 4)) return null
  const groups: DecomposedGroup[] = []
  for (const [meldIndex, m] of input.melds.entries()) {
    if (m.pending || m.type === 'flower') return null
    let kind: DecomposedGroup['kind']
    if (m.windKong) {
      if (m.type !== 'angang' || sorted(m.tiles) !== sorted(WINDS)) return null
      kind = 'wind-kong'
    } else if (m.type === 'chi') {
      if (!MELDS.some(s => s.kind === 'sequence' && sorted(s.tiles) === sorted(m.tiles))) return null
      kind = 'sequence'
    } else {
      const count = m.type === 'peng' ? 3 : 4
      if (!['peng', 'gang', 'angang'].includes(m.type) || m.tiles.length !== count || m.tiles.some(t => t !== m.tile)) return null
      kind = count === 3 ? 'triplet' : 'kong'
    }
    groups.push({ kind, tiles: [...m.tiles], concealed: m.type === 'angang' && !m.windKong,
      origin: { kind: 'meld', meldIndex } })
  }
  return groups
}

interface Bucket { physical: TileType; indexes: number[]; allowed: readonly TileType[] }
function bucketsFor(input: WinEvaluationInput, natural: boolean): Bucket[] {
  const hand = [...input.concealed, input.winningTile]
  const buckets: Bucket[] = []
  for (const [index, physical] of hand.entries()) {
    const winning = index === hand.length - 1
    const ordinary = natural || (winning && (input.source === 'discard' || input.source === 'robbed-kong'))
    const allowed = ordinary ? [physical] : input.jokers.includes(physical) ? TILE_TYPES
      : physical === 'white' ? [...new Set<TileType>(['white', ...input.jokers])] : [physical]
    // Winning instance remains separate even from identical physical tiles.
    // Soft scoring depends on represented shapes, not which unrestricted joker face
    // fills a slot. Natural witnesses are exhaustively searched in the first pass.
    const same = !winning && buckets.find(b => sorted(b.allowed) === sorted(allowed))
    if (same) same.indexes.push(index)
    else buckets.push({ physical, indexes: [index], allowed })
  }
  return buckets.sort((a, b) => a.allowed.length - b.allowed.length || a.physical.localeCompare(b.physical))
}

/** Streaming exhaustive search; no maximum-solutions cutoff. Count states prune dead ends. */
export function visitDecompositions(input: WinEvaluationInput, visit: (d: WinningDecomposition) => void): void {
  const exposed = validateWinInput(input)
  if (!exposed) return
  const winningIndex = input.concealed.length
  const external = input.source === 'discard' || input.source === 'robbed-kong'
  const emitted = new Set<string>()
  const emit = (shape: HandShape, groups: DecomposedGroup[], assignments: TileAssignment[]) => {
    const natural = assignments.every(a => a.physical === a.represented)
    const key = `${shape}|${natural}|${groups.map(g => `${g.kind}:${sorted(g.tiles)}:${g.concealed}`).sort().join('|')}`
    if (emitted.has(key)) return
    emitted.add(key)
    visit({ shape, groups: [...groups], assignments: [...assignments].sort((a, b) => a.inputIndex - b.inputIndex),
      natural, winningTileGroupIndex: groups.findIndex(g => g.origin.kind === 'hand' && g.origin.inputIndexes.includes(winningIndex)) })
  }

  for (const naturalOnly of [true, false]) {
    const buckets = bucketsFor(input, naturalOnly)
    if (!naturalOnly && buckets.every(b => b.allowed.length === 1)) continue
    const counts = buckets.map(b => b.indexes.length)
    const assignments: TileAssignment[] = []
    const groups = [...exposed]
    const dead = new Set<string>()
    const visited = new Set<string>()
    const physicalHand = [...input.concealed, input.winningTile]

    function fill(template: Template, anchor: number, done: (indexes: number[]) => void) {
      const selected: number[] = []
      const resources: number[] = []
      function step(slot: number) {
        if (slot === template.tiles.length) {
          if (resources.includes(anchor)) done(selected)
          return
        }
        const represented = template.tiles[slot]
        for (let b = 0; b < buckets.length; b++) {
          if (!counts[b] || !buckets[b].allowed.includes(represented)) continue
          // Equal represented slots are an unordered multiset of physical resources.
          if (slot && represented === template.tiles[slot - 1] && b < resources[slot - 1]) continue
          const inputIndex = buckets[b].indexes[buckets[b].indexes.length - counts[b]]
          counts[b]--
          selected.push(inputIndex); resources.push(b)
          assignments.push({ inputIndex, physical: physicalHand[inputIndex], represented })
          step(slot + 1)
          assignments.pop(); resources.pop(); selected.pop(); counts[b]++
        }
      }
      step(0)
    }

    function search(pairs: number, melds: number, shape: HandShape): boolean {
      if (!pairs && !melds) { emit(shape, groups, assignments); return true }
      const signature = `${pairs}/${melds}/${counts.join(',')}`
      if (dead.has(signature)) return false
      const stateKey = `${signature}|${groups.map(g => `${g.kind}:${sorted(g.tiles)}:${g.concealed}`).sort().join('|')}`
      if (visited.has(stateKey)) return true
      visited.add(stateKey)
      const anchor = counts.findIndex(n => n > 0)
      if (anchor < 0) return false
      let found = false
      const templates = [...(pairs ? PAIRS : []), ...(melds ? MELDS : [])]
      for (const template of templates) {
        if (!template.tiles.some(t => buckets[anchor].allowed.includes(t))) continue
        fill(template, anchor, indexes => {
          groups.push({ kind: template.kind, tiles: template.tiles,
            concealed: !(external && template.kind === 'triplet' && indexes.includes(winningIndex)),
            origin: { kind: 'hand', inputIndexes: [...indexes] } })
          if (search(pairs - Number(template.kind === 'pair'), melds - Number(template.kind !== 'pair'), shape)) found = true
          groups.pop()
        })
      }
      if (!found) dead.add(signature)
      return found
    }
    search(1, 4 - exposed.length, 'standard')
    if (exposed.length === 0) {
      dead.clear()
      visited.clear()
      search(7, 0, 'sevenPairs')
      for (const shape of ['thirteenOrphans', 'qiXing', 'shiSanLan'] as const) {
        const hand = [...input.concealed, input.winningTile]
        const jokers = naturalOnly ? [] : [...input.jokers]
        const ordinary = external ? [input.winningTile] : []
        const substitutes: TileType[] = naturalOnly ? [] : ['white']
        const predicate = shape === 'thirteenOrphans' ? isThirteenOrphans : shape === 'qiXing' ? isQiXingShiSanLan : isShiSanLan
        if (!predicate(hand, jokers, ordinary, substitutes)) continue
        // Independent specials have no composable attributes. One witness per natural/soft
        // path is sufficient; enumerating equivalent witnesses cannot change their score.
        const represented: TileType[] = []
        const evidence: TileAssignment[] = []
        const slots = buckets.flatMap(b => b.indexes.map(inputIndex => ({ ...b, inputIndex, physical: physicalHand[inputIndex] })))
        const failed = new Set<string>()
        function special(index: number): boolean {
          if (index === slots.length) {
            if (!predicate(represented, [], [], [])) return false
            emit(shape, [], evidence)
            return true
          }
          const key = `${index}:${sorted(represented)}`
          if (failed.has(key)) return false
          const slot = slots[index]
          for (const tile of slot.allowed) {
            if (shape === 'thirteenOrphans') {
              if (!isHonor(tile) && !isTerminal(tile)) continue
              if (represented.filter(t => t === tile).length >= 2) continue
              if (represented.includes(tile) && new Set(represented).size < represented.length) continue
            } else if (represented.some(t => t === tile || (!isHonor(t) && !isHonor(tile) && t[0] === tile[0] && Math.abs(Number(t[1]) - Number(tile[1])) < 3))) continue
            represented.push(tile)
            evidence.push({ inputIndex: slot.inputIndex, physical: slot.physical, represented: tile })
            if (special(index + 1)) return true
            evidence.pop(); represented.pop()
          }
          failed.add(key)
          return false
        }
        special(0)
      }
    }
  }
}
