import {it,expect} from 'vitest'
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {execFileSync} from 'node:child_process'
const panels=['legacy','attack','defensive','mixed']
function fixture(name:string,gain:number,change?:(r:any,i:number)=>void){
  const cwd=resolve('work/source-v2-final-metric-tests',name),dir=join(cwd,'work/source-v2-final')
  mkdirSync(dir,{recursive:true})
  const matches=panels.map((panel,i)=>({panel,seeds:Array.from({length:64},(_,n)=>4100001+i*1000+n)}))
  writeFileSync(join(dir,'protocol.json'),JSON.stringify({fingerprint:'fixture',matches}))
  writeFileSync(join(dir,'engineering-gate.json'),JSON.stringify({pass:true,fingerprint:'fixture'}))
  let index=0
  for(const group of matches){
    const shard=join(dir,`${group.panel}-0`);mkdirSync(shard,{recursive:true})
    const rows=group.seeds.flatMap(seed=>[0,1,2,3].map(focal=>{
      const row={panel:group.panel,seed,focal,rounds:4,controlNet:1000,currentNet:1000+gain,delta:gain,controlRank:2,currentRank:2}
      change?.(row,index++);return row
    }))
    writeFileSync(join(shard,'metadata.json'),JSON.stringify({panel:group.panel,seeds:group.seeds,fingerprint:'fixture'}))
    writeFileSync(join(shard,'done.json'),JSON.stringify({fingerprint:'fixture',rows}))
  }
  execFileSync(process.execPath,[resolve('scripts/analyze-blood-flow-final.mjs'),'payoff',...panels.map(p=>`${p}-0`)],{cwd,stdio:'pipe'})
  return JSON.parse(readFileSync(join(dir,'payoff-verdict.json'),'utf8'))
}
it('uses paired increment rather than positive absolute score, and enforces the +50 threshold',()=>{
  const pass=fixture('gain50',50);expect(pass.score.mean).toBe(50);expect(pass.pass).toBe(true)
  const fail=fixture('gain49',49);expect(fail.score.mean).toBe(49);expect(fail.checks.score).toBe(false);expect(fail.pass).toBe(false)
})
it('rejects first-place deterioration or a severe-loss increase above one percentage point',()=>{
  const rank=fixture('rank',100,(r,i)=>{if(i===0){r.controlRank=1;r.currentRank=2}})
  expect(rank.checks.firstPlace).toBe(false);expect(rank.pass).toBe(false)
  const loss=fixture('loss',100,(r,i)=>{if(i<11){r.currentNet=-1000;r.delta=-2000}})
  expect(loss.checks.score).toBe(true)
  expect(loss.severe.mean).toBe(11/1024);expect(loss.checks.severeLoss).toBe(false);expect(loss.pass).toBe(false)
},60_000)
