import { expect, it } from 'vitest'
import type { Meld, TileType } from '../../../core/contracts/types'
import { evaluateHandWaits } from './handWaits'

const groups: TileType[][] = [['m1','m2','m3'],['p1','p2','p3'],['s1','s2','s3'],['m4','m5','m6']]
const jokers: TileType[] = ['red','green']
it.each([0,1,2,3,4])('offers discard-to-ready hints with %i exposed melds and no draw marker', n => {
  const melds: Meld[] = groups.slice(0,n).map(tiles => ({type:'chi',tile:tiles[0],tiles}))
  const concealed: TileType[] = [...groups.slice(n).flat(),'east','north']
  const result = evaluateHandWaits({concealed,melds,jokers,drawnTileIndex:-1,locked:false})
  expect(result.current).toEqual([])
  expect(result.discards.find(item=>item.discard==='north')?.waits.map(w=>w.tile)).toContain('east')
  expect(result.discards.find(item=>item.discard==='east')?.waits.map(w=>w.tile)).toContain('north')
})
it('retains the waiting hand while other players act, and keeps previews separate after a draw',()=>{
  const concealed: TileType[]=[...groups.flat(),'east']
  const before=evaluateHandWaits({concealed,melds:[],jokers,drawnTileIndex:-1,locked:false})
  const after=evaluateHandWaits({concealed:[...concealed,'north'],melds:[],jokers,drawnTileIndex:13,locked:false})
  expect(before.current.map(w=>w.tile)).toContain('east')
  expect(after.current).toEqual(before.current)
  expect(after.discards.find(item=>item.discard==='east')?.waits.map(w=>w.tile)).toContain('north')
})
it('a locked hand only offers the actual drawn tile, including a duplicate face',()=>{
  const result=evaluateHandWaits({concealed:[...groups.flat(),'east','east'],melds:[],jokers,drawnTileIndex:13,locked:true})
  expect(result.discards.map(item=>item.discard)).toEqual(['east'])
  expect(result.current.map(w=>w.tile)).toContain('east')
})
