import { expect, it } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { deserialize } from 'node:v8'
import { decideClaim } from '../src/game/variants/lotus/lotusAi'
import { patternPotentialEv } from '../src/game/variants/lotus/bloodFlow/patternPotentials'
import { BLOOD_FLOW_AI } from '../src/game/variants/lotus/bloodFlow/config'
import { bloodFlowSeatView, visibleTiles } from '../src/game/variants/lotus/bloodFlow/seatView'
import { restoreEngine } from './blood-flow-counterfactual'
import type { Meld } from '../src/game/core/contracts/types'

it.skipIf(process.env.BF_MELD_AUDIT !== '1')('records whether claim evaluation receives the newly declared meld', () => {
  const records = ['1100001-peng', '1100008-peng'].map(key => {
    const { checkpoint, seat } = deserialize(readFileSync(`work/blood-flow-meld-counterfactual/screen-v1/${key}.bin`))
    const view = bloodFlowSeatView(restoreEngine(checkpoint), seat), player = view.players[seat], source = view.window!.source
    const peng: Meld = { type: 'peng', tile: source.tile, tiles: [source.tile, source.tile, source.tile], from: source.seat }
    const calls: { handLength: number; meldCount: number; effectiveTiles: number; originalValue: number; withNewMeldValue: number }[] = []
    const decision = decideClaim({ hand: player.hand, exposedMelds: player.melds.length, melds: player.melds,
      tile: source.tile, from: source.seat, canGang: false, canPeng: true, chiOptions: [], jokers: view.jokers,
      visibleTiles: visibleTiles(view), wallCount: view.wallCount,
      patternBonus: (hand, melds) => {
        const originalValue = patternPotentialEv(hand, melds, view.jokers, view.wallCount, BLOOD_FLOW_AI.sevenPairsModel, BLOOD_FLOW_AI)
        const withNewMeldValue = hand.length === player.hand.length ? originalValue
          : patternPotentialEv(hand, [...player.melds, peng], view.jokers, view.wallCount, BLOOD_FLOW_AI.sevenPairsModel, BLOOD_FLOW_AI)
        calls.push({ handLength: hand.length, meldCount: melds.length, effectiveTiles: hand.length + 3 * melds.length, originalValue, withNewMeldValue })
        return originalValue // observe actual callback inputs; do not change the decision calculation
      } })
    expect(calls.length).toBeGreaterThan(1)
    return { key, decision, calls, malformedProjectedCalls: calls.filter(c => c.effectiveTiles !== 13).length,
      caveat: 'Structural callback audit only; the alternative values do not prove that correcting meld projection improves full-game net.' }
  })
  writeFileSync('work/blood-flow-meld-counterfactual/projection-audit.json', JSON.stringify(records, null, 2))
}, 30_000)
