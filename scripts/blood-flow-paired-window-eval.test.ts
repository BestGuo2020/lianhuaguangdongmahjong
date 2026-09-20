import {it,expect} from 'vitest'
import {readFileSync,writeFileSync,existsSync,readdirSync} from 'node:fs'
import {deserialize} from 'node:v8'
import {createHash} from 'node:crypto'
import {windowOutcome,WINDOW_BASE,WINDOW_MODEL} from './blood-flow-paired-window'
it.skipIf(process.env.BF_PAIR_EVAL!=='1')('labels frozen pairs with common continuations and equal scoring horizons',async()=>{
  const from=Number(process.env.BF_PAIR_FROM??310001),dir=`work/blood-flow-paired/${from}`
  const version='actual-draws-v2'
  if(existsSync(`${dir}/outcomes-${version}.json`))throw new Error('Outcomes already exist')
  const metadata=JSON.parse(readFileSync(`${dir}/metadata.json`,'utf8'))
  expect(WINDOW_BASE).toEqual(metadata.base);expect(WINDOW_MODEL).toEqual(metadata.model)
  const evaluationHash=()=>createHash('sha256').update(readFileSync('scripts/blood-flow-paired-window.ts'))
    .update(readFileSync('scripts/blood-flow-paired-window-eval.test.ts')).digest('hex')
  const evaluationFingerprint=evaluationHash()
  if(process.env.BF_PAIR_STREAM!=='1'&&!existsSync(`${dir}/manifest.json`))throw new Error('Collection not complete')
  const rows:any[]=[],started=Date.now(),completed=new Set<number>()
  while(true){
  for(const name of readdirSync(dir).filter(n=>n.endsWith('-plan.json')).sort()){
    // Each plan is frozen before this worker ever generates its labels. A streaming
    // reader may briefly encounter an unfinished write; retry it on the next poll.
    let plan:any
    try{plan=JSON.parse(readFileSync(`${dir}/${name}`,'utf8'))}catch(error){if(existsSync(`${dir}/manifest.json`))throw error;continue}
    if(completed.has(plan.seed))continue
    const bytes=readFileSync(`${dir}/seed-${plan.seed}.v8`),checkpointHash=createHash('sha256').update(bytes).digest('hex')
    const cachePath=`${dir}/seed-${plan.seed}-outcomes-${version}.json`
    if(existsSync(cachePath)){
      const cached=JSON.parse(readFileSync(cachePath,'utf8'))
      expect(cached.checkpointHash).toBe(checkpointHash);expect(cached.plan).toEqual(plan)
      rows.push(cached);completed.add(plan.seed);continue
    }
    const checkpoint=deserialize(bytes)
    const samples=[]
    for(let sample=-1;sample<8;sample++){
      const wallSeed=(Math.imul(plan.seed,31)+sample+1)>>>0
      const old=windowOutcome(checkpoint,plan.seat,plan.old.index,sample,wallSeed)
      const proposed=windowOutcome(checkpoint,plan.seat,plan.proposed.index,sample,wallSeed)
      for(const outcome of [old,proposed])for(const period of [outcome.horizon,outcome.full])
        expect(period.net).toBe(period.gross-period.discardPaid-period.otherWinPaid+period.kongNet)
      samples.push({sample,old,proposed})
    }
    rows.push({plan,samples,checkpointHash});completed.add(plan.seed)
    writeFileSync(cachePath,JSON.stringify(rows.at(-1)))
    writeFileSync(`${dir}/eval-progress-${version}.json`,JSON.stringify({completed:rows.length,seconds:(Date.now()-started)/1000}))
  }
  if(existsSync(`${dir}/manifest.json`)){
    const manifest=JSON.parse(readFileSync(`${dir}/manifest.json`,'utf8'))
    // Collection may finish while this worker evaluates an earlier plan list.
    // Load the newly published plans before performing the final count check.
    if(rows.length<manifest.windows.length)continue
    expect(rows.length).toBe(manifest.windows.length)
    for(const row of rows)expect(row.checkpointHash).toBe(manifest.windows.find((e:any)=>e.seed===row.plan.seed)?.checkpointHash)
    expect(evaluationHash()).toBe(evaluationFingerprint)
    writeFileSync(`${dir}/outcomes-${version}.json`,JSON.stringify({version,evaluationFingerprint,manifest,scope:'Labels only; policies receive public views. Original wall plus 8 paired wall permutations; other concealed hands fixed. Horizon is before ninth REAL own draw or round end; chi/peng turns excluded. Full is remainder of this round.',rows},null,2))
    break
  }
  await new Promise(resolve=>setTimeout(resolve,2000))
  }
},7_200_000)
