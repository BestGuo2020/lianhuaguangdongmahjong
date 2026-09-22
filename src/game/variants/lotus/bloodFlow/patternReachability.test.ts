// 7b8276db east-2/window215: public-seat fixture only, no opponent hands or future wall.
import {bloodFlowDefensePolicy} from './ai'
import {describe,expect,it} from 'vitest'
import type {Meld,TileType} from '../../../core/contracts/types'
import {patternPotentials,patternPotentialTotal,patternPotentialEv,estimateWinIncome} from './patternPotentials'
import {buildBloodFlowDecisionInput} from '../../../llm/bloodFlowDecisionInput'
import {BLOOD_FLOW_LLM_AI} from './config'
import type {BloodFlowSeatView} from './seatView'
import fixture from '../../../llm/fixtures/bloodFlow-meld-potential.json'
const peng=(tile:TileType):Meld=>({type:'peng',tile,tiles:[tile,tile,tile]})
const chi:Meld={type:'chi',tile:'m4',tiles:['m3','m4','m5']}
const fixed:Meld[]=[chi,peng('m8')]
const after:TileType[]=['p5','s4','red','red','red','green','green']
const ids=(hand:TileType[],melds:Meld[],jokers:TileType[]=[])=>patternPotentials(hand,melds,jokers,'ev').map(d=>d.id)
describe('fixed melds constrain potential, not just its display',()=>{
  it('removes impossible directions in the recorded east-2 reform while preserving small dragons',()=>{
    const result=ids(after,fixed,['p4','p5'])
    expect(result).not.toContain('big-three-dragons')
    expect(result).not.toContain('four-concealed-triplets')
    expect(result).not.toContain('three-concealed-triplets')
    expect(result).toContain('little-three-dragons')
    // Only small dragons remains here: weight16 * (2/3)^2, used by both floor and development EV.
    expect(patternPotentialTotal(after,fixed,['p4','p5'],'ev')).toBeCloseTo(16*4/9)
    expect(patternPotentialEv(after,fixed,['p4','p5'],21,'ev')).toBeCloseTo(10*16*4/9)
    expect(bloodFlowDefensePolicy(structuredClone(fixture) as unknown as BloodFlowSeatView,BLOOD_FLOW_LLM_AI).own.ceilingMultiplier).toBe(16)
  })
  it('does not tell the model that an existing chi/peng hand can develop big dragons or four concealed triplets',()=>{
    const v=structuredClone(fixture) as unknown as BloodFlowSeatView
    const b=buildBloodFlowDecisionInput(v,'meld-regression',{},BLOOD_FLOW_LLM_AI)
    const reform=b.candidates.find(c=>c.action.kind==='discard'&&v.players[v.seat].hand[c.action.index]==='s4')!
    expect(reform.features.ev!.reform!.patterns).not.toContain('大三元')
    expect(reform.features.ev!.reform!.patterns).not.toContain('四暗刻')
  })
  it('does not reinterpret fixed meld suits in the fast income estimate',()=>{
    const hand:TileType[]=['p5','s4','s4','red','red','green','green','red']
    // No mixed suit: the concealed suited tiles are sou, while fixed melds are man.
    // Keep the legacy no-recognized-pattern baseline; this is not an exact scorer assertion.
    expect(estimateWinIncome(hand,fixed,['p4','p5'],'self-draw','ev').paymentPerPayer).toBe(20)
  })
})

import {canDevelopPatternWithMelds} from './patternReachability'
import {evaluateWin} from '../patterns/evaluate'
const kong=(tile:TileType,concealed=true):Meld=>({type:concealed?'angang':'gang',tile,tiles:[tile,tile,tile,tile]})
const wind:Meld={type:'angang',tile:'east',tiles:['east','south','west','north'],windKong:true}
it('counts existing target honor pungs toward capacity and reserves a different pair for small hands',()=>{
  expect(canDevelopPatternWithMelds('big-three-dragons',[peng('red'),chi])).toBe(true)
  expect(canDevelopPatternWithMelds('big-three-dragons',[chi,peng('m8')])).toBe(false)
  expect(canDevelopPatternWithMelds('little-three-dragons',[chi,peng('m8')])).toBe(true)
  expect(canDevelopPatternWithMelds('little-three-dragons',[peng('red'),peng('green'),peng('white')])).toBe(false)
  expect(canDevelopPatternWithMelds('big-four-winds',[peng('east'),chi])).toBe(false)
  expect(canDevelopPatternWithMelds('little-four-winds',[peng('east'),chi])).toBe(true)
  expect(canDevelopPatternWithMelds('big-four-winds',[peng('east'),peng('south'),peng('west')])).toBe(true)
  expect(canDevelopPatternWithMelds('little-four-winds',[peng('east'),peng('south'),peng('west'),peng('north')])).toBe(false)
})
it('preserves genuine small-dragons completion with the same two fixed melds',()=>{
  const concealed:TileType[]=['red','red','red','green','green','green','white']
  const scored=evaluateWin({concealed,melds:fixed,jokers:[],winningTile:'white',source:'self-draw',opening:null})!
  expect(scored.score.items.map(p=>p.id)).toContain('little-three-dragons')
  expect(ids([...concealed,'white'],fixed)).toContain('little-three-dragons')
})
it('keeps concealed kongs eligible for four concealed triplets; an exposed pung only permits three',()=>{
  const concealed:TileType[]=['p1','p1','p1','s1','s1','s1','east','east','east','white']
  const hidden=[kong('m1')],open=[peng('m1')]
  expect(evaluateWin({concealed,melds:hidden,jokers:[],winningTile:'white',source:'self-draw',opening:null})!.score.items.map(p=>p.id)).toContain('four-concealed-triplets')
  expect(ids([...concealed,'white'],hidden)).toContain('four-concealed-triplets')
  expect(evaluateWin({concealed,melds:open,jokers:[],winningTile:'white',source:'self-draw',opening:null})!.score.items.map(p=>p.id)).toContain('three-concealed-triplets')
  expect(ids([...concealed,'white'],open)).toContain('three-concealed-triplets')
  expect(ids([...concealed,'white'],open)).not.toContain('four-concealed-triplets')
})
it('wind kong retains concealed-hand status but is neither a concealed triplet nor an ordinary kong',()=>{
  const hand:TileType[]=['p1','p1','p1','s1','s1','s1','m2','m4','p2','p4']
  const potential=patternPotentials(hand,[wind],[],'ev')
  expect(potential.find(p=>p.id==='three-concealed-triplets')?.progress).toBeCloseTo(2/3)
  expect(potential.some(p=>p.id==='four-concealed-triplets')).toBe(false)
  expect(canDevelopPatternWithMelds('concealed-hand',[wind])).toBe(true)
  expect(canDevelopPatternWithMelds('three-kongs',[wind])).toBe(true)
  expect(canDevelopPatternWithMelds('four-kongs',[wind])).toBe(false)
  expect(canDevelopPatternWithMelds('little-four-winds',[wind])).toBe(true)
})
it('leaves added-kong routes open but rejects too many fixed sequences',()=>{
  expect(canDevelopPatternWithMelds('four-kongs',[peng('m1'),kong('p1')])).toBe(true)
  expect(canDevelopPatternWithMelds('three-kongs',[chi,kong('p1')])).toBe(true)
  expect(canDevelopPatternWithMelds('four-kongs',[chi,kong('p1')])).toBe(false)
  expect(canDevelopPatternWithMelds('three-kongs',[chi,chi,kong('p1')])).toBe(false)
  expect(ids(['white','p2','p2','s3','s3'],[chi,chi,kong('p1')],['white'])).not.toContain('three-kongs')
})
it.each(['sevenPairs','luxury-seven-pairs','shiSanLan','qiXing','thirteenOrphans','nine-gates'] as const)('%s requires no declared group, including concealed kongs',id=>{
  expect(canDevelopPatternWithMelds(id,[])).toBe(true)
  expect(canDevelopPatternWithMelds(id,[chi])).toBe(false)
  expect(canDevelopPatternWithMelds(id,[kong('p1')])).toBe(false)
})
it('does not reinterpret declared joker faces to bypass a fixed color or tile restriction',()=>{
  expect(canDevelopPatternWithMelds('all-green',[peng('red')])).toBe(false)
  expect(ids(['s2','s3','s4','s6','s6','s6','s8','s8','green','green'],[peng('red')],['red'])).not.toContain('all-green')
  expect(canDevelopPatternWithMelds('pure-suit',[peng('east')])).toBe(false)
  expect(canDevelopPatternWithMelds('mixed-suit',[chi,peng('p8')])).toBe(false)
  expect(canDevelopPatternWithMelds('pure-terminals',[wind])).toBe(false)
  expect(canDevelopPatternWithMelds('all-triplets',[wind])).toBe(false)
})
