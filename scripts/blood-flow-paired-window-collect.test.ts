import {it,expect} from 'vitest'
import {mkdirSync,writeFileSync,existsSync,readFileSync,readdirSync} from 'node:fs'
import {serialize} from 'node:v8'
import {createHash} from 'node:crypto'
import {join} from 'node:path'
import {newRound,nextSeatToAct,submit,snapshotEngine} from './blood-flow-counterfactual'
import {rankingDecision} from './blood-flow-ranking-policy'
import {WINDOW_BASE,WINDOW_MODEL,windowPolicy} from './blood-flow-paired-window'
import {bloodFlowSeatView} from '../src/game/variants/lotus/bloodFlow/seatView'
import {bloodFlowSafetyExposure} from '../src/game/variants/lotus/bloodFlow/ai'
export function pairedFingerprint(){
  const hash=createHash('sha256')
  const visit=(dir:string)=>{for(const e of readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
    const path=join(dir,e.name);if(e.isDirectory())visit(path);else if(path.endsWith('.ts'))hash.update(path).update(readFileSync(path))
  }}
  visit('src/game')
  for(const name of ['paired-window','paired-window-collect.test','ranking-policy','counterfactual'])hash.update(readFileSync(`scripts/blood-flow-${name}.ts`))
  return hash.digest('hex')
}
it.skipIf(process.env.BF_PAIR_COLLECT!=='1')('freezes first eligible disagreement per independent source before any outcome',()=>{
  const from=Number(process.env.BF_PAIR_FROM??310001),rounds=Number(process.env.BF_PAIR_ROUNDS??128)
  if(!Number.isSafeInteger(from)||from<1||!Number.isSafeInteger(rounds)||rounds<1||rounds>512)throw new Error('Invalid budget')
  const dir=`work/blood-flow-paired/${from}`;if(existsSync(dir))throw new Error('Fresh batch required')
  mkdirSync(dir,{recursive:true})
  const fingerprint=pairedFingerprint(),windows:any[]=[],started=Date.now()
  writeFileSync(`${dir}/metadata.json`,JSON.stringify({from,rounds,fingerprint,base:WINDOW_BASE,model:WINDOW_MODEL,
    scope:'All four seats use frozen source-v2. First qualified ranking disagreement per source round only. Candidate actions and public features frozen before rollout. No outcome-dependent filtering.'},null,2))
  for(let seed=from;seed<from+rounds;seed++){
    const e=newRound(seed),budget=2000;let commands=0
    while(!e.result){
      if(++commands>budget)throw new Error('Collection stalled')
      const seat=nextSeatToAct(e),view=bloodFlowSeatView(e,seat),decision=rankingDecision(view,WINDOW_BASE,WINDOW_MODEL,[])
      if('gap' in decision&&decision.eligible&&decision.original?.kind==='discard'&&decision.raw?.kind==='discard'){
        const exposure=bloodFlowSafetyExposure(view,WINDOW_BASE),hand=view.players[seat].hand
        const plan={seed,seat,wall:view.wallCount,view,
          old:{index:decision.original.index,tile:hand[decision.original.index],grossPrediction:decision.newOldValue,riskProxy:exposure(hand[decision.original.index])},
          proposed:{index:decision.raw.index,tile:hand[decision.raw.index],grossPrediction:decision.newValue,riskProxy:exposure(hand[decision.raw.index])},
          predictedGrossGap:decision.gap}
        const checkpoint=serialize(snapshotEngine(e))
        writeFileSync(`${dir}/seed-${seed}.v8`,checkpoint)
        writeFileSync(`${dir}/seed-${seed}-plan.json`,JSON.stringify(plan,null,2))
        windows.push({seed,seat,checkpointHash:createHash('sha256').update(checkpoint).digest('hex')})
        break
      }
      const action=windowPolicy(view);if(!action)throw new Error('Missing action');submit(e,seat,action)
    }
    writeFileSync(`${dir}/progress.json`,JSON.stringify({completed:seed-from+1,rounds,windows:windows.length,seconds:(Date.now()-started)/1000}))
  }
  expect(pairedFingerprint()).toBe(fingerprint)
  writeFileSync(`${dir}/manifest.json`,JSON.stringify({from,rounds,fingerprint,windows},null,2))
},7_200_000)
