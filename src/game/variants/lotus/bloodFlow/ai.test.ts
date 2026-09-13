import { afterEach, expect, it, vi } from 'vitest'
import type { TileType } from '../../../core/contracts/types'
import * as lotusAi from '../lotusAi'
import { BloodFlowEngine } from './engine'
import { bloodFlowSeatView } from './seatView'
import { seededRandom } from './simulation'
import { decideBloodFlowAction, bloodFlowAiActions } from './ai'
import { SEATS } from './state'

const hand: TileType[] = ['m1','m2','m4','m5','m7','m8','p1','p4','p7','s1','s4','white','red','green']
function view(tiles = hand) {
  const v = bloodFlowSeatView(new BloodFlowEngine({authorityEpoch:'test',roundId:'1',random:seededRandom(23),now:()=>0}),0)
  v.players[0].hand = [...tiles]; v.players[0].melds = []; v.players[0].drawnTileIndex = tiles.length - 1
  v.jokers = ['red','green']; v.wallCount = 50; v.ownScore = null
  v.ownActions = tiles.map((_,index)=>({kind:'discard',index})); return v
}
afterEach(() => vi.restoreAllMocks())

it('protects both jokers and white before the first win without changing the legal action list', () => {
  const v=view(), original=structuredClone(v.ownActions)
  const safe=bloodFlowAiActions(v)
  expect(safe).toHaveLength(11)
  for(const move of safe) if(move.kind==='discard') expect(['red','green','white']).not.toContain(v.players[0].hand[move.index])
  const decision=decideBloodFlowAction(v)
  expect(safe).toContainEqual(decision)
  expect(v.ownActions).toEqual(original)
})
it.each(['throw','bad-index'] as const)('the %s fallback still protects a joker drawn at the end', failure => {
  vi.spyOn(lotusAi,'decideTurn').mockImplementation(() => {
    if(failure==='throw') throw new Error('evaluation unavailable')
    return {kind:'discard',handIndex:13}
  })
  const v=view(), decision=decideBloodFlowAction(v)
  expect(decision?.kind).toBe('discard')
  if(decision?.kind==='discard') expect(['red','green','white']).not.toContain(v.players[0].hand[decision.index])
})
it('keeps forced locked discards and an all-protected legal hand playable', () => {
  const v=view()
  v.public={...v.public,seats:[{...v.public.seats[0],locked:true},v.public.seats[1],v.public.seats[2],v.public.seats[3]]}
  v.ownActions=[{kind:'discard',index:13}]
  expect(decideBloodFlowAction(v)).toEqual({kind:'discard',index:13})
  const protectedHand:TileType[]=['red','green','white','white']
  const unlocked=view(protectedHand)
  expect(unlocked.ownActions).toContainEqual(decideBloodFlowAction(unlocked))
})
it.each([['p6','pass'],['s5','peng']] as const)('compares the hand after peng with passing (%s)', (last,expected) => {
  const v=view(['m4','m4','m1','m2','m3','m7','m8','m9','p1','p2','p3','p5',last])
  v.jokers=['white','red']; v.ownActions=[{kind:'peng'},{kind:'pass'}]
  v.window={...v.window!,kind:'meld',source:{id:'source',kind:'discard',tile:'m4',seat:1}}
  expect(decideBloodFlowAction(v)?.kind).toBe(expected)
})
it('uses the common turn decision for kongs and passes the visible round context through', () => {
  const v=view(); v.players[3].discards=['north']
  v.ownActions=[...v.ownActions,{kind:'concealed-kong',tile:'m1'}]
  const common=vi.spyOn(lotusAi,'decideTurn').mockReturnValue({kind:'concealed-kong',tile:'m1'})
  expect(decideBloodFlowAction(v)).toEqual({kind:'concealed-kong',tile:'m1'})
  expect(common).toHaveBeenCalledWith(expect.objectContaining({hand:v.players[0].hand, upperLastDiscard:'north',
    earlyRound:true, wallCount:50, jokers:v.jokers}),expect.any(Function))
})
it('uses the common claim decision when another seat can hu in the same window', () => {
  const v=view()
  v.ownActions=[{kind:'peng'},{kind:'pass'}]
  v.window={...v.window!,kind:'win',source:{id:'source',kind:'discard',tile:'m4',seat:1}}
  const common=vi.spyOn(lotusAi,'decideClaim').mockReturnValue({kind:'peng'})
  expect(decideBloodFlowAction(v)).toEqual({kind:'peng'})
  expect(common).toHaveBeenCalledWith(expect.objectContaining({canPeng:true,tile:'m4'}))
})
it('keeps first-win automated discards protected across actual fixed-seed rounds', () => {
  let guardedDiscards=0
  for(let seed=1;seed<=12;seed++) {
    const engine=new BloodFlowEngine({authorityEpoch:'ai-rounds',roundId:`seed-${seed}`,random:seededRandom(seed),now:()=>0,winBeatMs:0})
    let steps=0
    while(!engine.result) {
      if(++steps>2000) throw new Error(`stalled seed ${seed}`)
      const window=engine.window!,seat=SEATS.find(s=>window.options[s].length&&!window.decisions[s])!
      const v=bloodFlowSeatView(engine,seat), action=decideBloodFlowAction(v)!
      if(action.kind==='discard'&&!v.public.seats[seat].locked) {
        const protectedTiles=[...v.jokers,'white']
        const hasOrdinary=v.ownActions.some(a=>a.kind==='discard'&&!protectedTiles.includes(v.players[seat].hand[a.index]))
        if(hasOrdinary) { guardedDiscards++; expect(protectedTiles).not.toContain(v.players[seat].hand[action.index]) }
      }
      expect(engine.submit(engine.command(seat,action))).toBe(true)
    }
    expect(engine.players.reduce((n,p)=>n+p.score,0)).toBe(8000)
  }
  expect(guardedDiscards).toBeGreaterThan(100)
  // 该用例跑 12 局固定种子全量对局（约 150s），机器负载高时 120s 不够；放宽到 300s 而非削减模拟量。
},300_000)
