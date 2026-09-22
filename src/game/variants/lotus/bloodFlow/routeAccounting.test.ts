import { describe, expect, it } from 'vitest'
import { BLOOD_FLOW_BIG_HAND_ROUTE, detectBigHandRoute } from './bigHandRoute'
import { BLOOD_FLOW_CONFIG } from './config'
import type { TileType } from '../../../core/contracts/types'
const config={...BLOOD_FLOW_BIG_HAND_ROUTE,mode:'llm' as const}
const orphans:TileType[]=['m1','m9','p1','p9','s1','s9','east','south','west','north','red','green','white']
describe('route accounting uses physical tiles and canonical pattern values',()=>{
  it('uses current scoring values for thirteen orphans and nine gates',()=>{
    expect(detectBigHandRoute([...orphans,'m5'],[],[],config)?.weight).toBe(BLOOD_FLOW_CONFIG.patterns.thirteenOrphans.weight)
    const nine:TileType[]=['p1','p1','p1','p2','p3','p4','p5','p6','p7','p8','p9','p9','p9','east']
    expect(detectBigHandRoute(nine,[],[],config)?.weight).toBe(BLOOD_FLOW_CONFIG.patterns['nine-gates'].weight)
  })
  it('does not count green/white both as orphan kinds and as extra wildcard kinds (east 3 window 173)',()=>{
    const hand:TileType[]=['green','white','m1','m4','m9','p2','p9','s1','s9','east','south','west','north','p5']
    expect(detectBigHandRoute(hand,[],['green','white'],config)).toBeNull()
  })
  it('using a wildcard to replace its own missing kind does not preserve an additional lost kind',()=>{
    const full=detectBigHandRoute([...orphans,'m5'],[],['white'],config)!
    const less=detectBigHandRoute([...orphans.filter(t=>t!=='m1'),'m5'],[],['white'],config)!
    expect(full.progress).toBe(1)
    expect(less.progress).toBeCloseTo(12/13)
  })
  it('non-joker white cannot cover an arbitrary missing orphan',()=>{
    const hand:TileType[]=['m1','m9','p9','s1','s9','east','south','west','north','red','white','white','m4','p2']
    expect(detectBigHandRoute(hand,[],['p4','p5'],config)).toBeNull()
  })
})
