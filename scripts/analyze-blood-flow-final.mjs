import {readFileSync,writeFileSync} from 'node:fs'
const dir='work/source-v2-final',read=p=>JSON.parse(readFileSync(p,'utf8')),protocol=read(`${dir}/protocol.json`)
if(process.argv[2]==='engineering'){
  const runs=[0,1,2].map(i=>read(`${dir}/engineering-${i}.json`))
  if(runs.some((r,i)=>r.rep!==i||r.fingerprint!==protocol.fingerprint||!r.correctnessPassed))throw new Error('Invalid engineering result')
  const ratios=runs.map(r=>r.ratio).sort((a,b)=>a-b),ratio=ratios[1]
  const result={fingerprint:protocol.fingerprint,pass:ratio<=protocol.engineering.p95RatioLimit,medianP95Ratio:ratio,limit:1.5,
    repetitions:runs.map(({rep,uniqueDecisions,controlP95,candidateP95,ratio,controlMax,candidateMax,node,cpu})=>({rep,uniqueDecisions,controlP95,candidateP95,ratio,controlMax,candidateMax,node,cpu})),
    decision:ratio<=1.5?'Proceed to the locked 256 source seeds':'Reject candidate; stop this route; do not run payoff matches or retune'}
  writeFileSync(`${dir}/engineering-gate.json`,JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2))
}else if(process.argv[2]==='payoff'){
  const gate=read(`${dir}/engineering-gate.json`);if(!gate.pass)throw new Error('Engineering gate failed; payoff is not authorized by protocol')
  const shardArgs=process.argv.slice(3),rows=[],seen=new Set()
  for(const tag of shardArgs){
    if(!/^(legacy|attack|defensive|mixed)-\d+$/.test(tag))throw new Error('Bad shard')
    const m=read(`${dir}/${tag}/metadata.json`),done=read(`${dir}/${tag}/done.json`)
    if(m.fingerprint!==protocol.fingerprint||done.fingerprint!==protocol.fingerprint)throw new Error('Mixed frozen code')
    for(const seed of m.seeds){
      const key=`${m.panel}/${seed}`;if(seen.has(key))throw new Error('Duplicate seed');seen.add(key)
      if(!protocol.matches.find(g=>g.panel===m.panel).seeds.includes(seed))throw new Error('Unregistered seed')
      const batch=done.rows.filter(r=>r.seed===seed)
      if(batch.length!==4||new Set(batch.map(r=>r.focal)).size!==4||batch.some(r=>r.rounds!==4||r.panel!==m.panel||r.currentNet-r.controlNet!==r.delta))throw new Error('Bad paired accounting')
      rows.push(...batch)
    }
  }
  if(seen.size!==256||rows.length!==1024)throw new Error('The complete fixed sample is required')
  const mean=v=>v.reduce((a,b)=>a+b,0)/v.length
  function summary(metric){
    const strata=protocol.matches.map(g=>g.seeds.map(seed=>mean(rows.filter(r=>r.panel===g.panel&&r.seed===seed).map(metric))))
    let state=912701;const random=()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return(state>>>0)/4294967296}
    const boot=Array.from({length:10000},()=>mean(strata.map(values=>mean(values.map(()=>values[Math.floor(random()*values.length)]))))).sort((a,b)=>a-b)
    return {mean:mean(strata.map(mean)),ci95:[boot[249],boot[9749]]}
  }
  const score=summary(r=>r.delta),first=summary(r=>Number(r.currentRank===1)-Number(r.controlRank===1))
  const severe=summary(r=>Number(r.currentNet<=-1000)-Number(r.controlNet<=-1000))
  const checks={score:score.mean>=50&&score.ci95[0]>0,firstPlace:first.mean>=0&&first.ci95[0]>=-.02,severeLoss:severe.mean<=.01}
  const result={fingerprint:protocol.fingerprint,sourceSeeds:256,pairedMatches:1024,score,first,severe,checks,
    pass:Object.values(checks).every(Boolean),rows}
  writeFileSync(`${dir}/payoff-verdict.json`,JSON.stringify(result,null,2));console.log(JSON.stringify({...result,rows:undefined},null,2))
}else throw new Error('Use engineering or payoff with all completed shard tags')
