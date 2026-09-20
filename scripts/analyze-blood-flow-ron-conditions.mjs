import {readFileSync,writeFileSync} from 'node:fs'
const tags=process.argv.slice(2)
if(!tags.length||tags.some(t=>!/^[a-z0-9-]+$/.test(t)))throw new Error('Pass completed condition batches')
const read=p=>JSON.parse(readFileSync(p,'utf8')),sum=(rows,f)=>rows.reduce((n,r)=>n+f(r),0)
const seen=new Set(),fingerprints=new Set()
const batches=tags.map(tag=>{
  const dir=`work/blood-flow-ron/${tag}`,metadata=read(`${dir}/metadata.json`),done=read(`${dir}/done.json`)
  if(JSON.stringify(metadata)!==JSON.stringify(done))throw new Error('Incomplete batch')
  fingerprints.add(metadata.fingerprint)
  const rows=[]
  for(let seed=metadata.from;seed<metadata.from+metadata.rounds;seed++){
    if(seen.has(seed))throw new Error('Duplicate source seed');seen.add(seed)
    const data=read(`${dir}/seed-${seed}.json`),keys=new Set()
    for(const r of data){
      const key=`${r.sourceId}/${r.target}`
      if(keys.has(key)||r.seed!==seed||r.target===r.actor||r.realized<0||!Number.isFinite(r.predicted)
        ||(r.realized!==0&&r.realized!==r.legalIncome)||Math.abs(Object.values(r.categoryProbabilities).reduce((a,b)=>a+b,0)-1)>1e-9)throw new Error('Invalid observation')
      keys.add(key)
    }
    rows.push(...data.map(r=>({...r,panel:metadata.panel})))
  }
  return {metadata,rows}
})
if(fingerprints.size!==1)throw new Error('Mixed observation implementation')
const rows=batches.flatMap(b=>b.rows)
function summary(rows){
  const seeds=new Map()
  for(const r of rows){const a=seeds.get(r.seed)??{n:0,actual:0,predicted:0,conditional:0};a.n++;a.actual+=r.realized;a.predicted+=r.predicted;a.conditional+=r.conditionalPrediction;seeds.set(r.seed,a)}
  const totals=[...seeds.values()],n=rows.length,positives=rows.filter(r=>r.realized>0)
  let state=912701
  const random=()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return(state>>>0)/4294967296}
  const boot=[]
  if(totals.length>=2)for(let b=0;b<2000;b++){
    let count=0,residual=0
    for(let i=0;i<totals.length;i++){const t=totals[Math.floor(random()*totals.length)];count+=t.n;residual+=t.actual-t.predicted}
    boot.push(residual/count)
  }
  boot.sort((a,b)=>a-b)
  const sorted=rows.map(r=>r.realized).sort((a,b)=>a-b)
  return {observations:n,sourceSeeds:totals.length,positive:positives.length,
    legal:rows.filter(r=>r.legalIncome>0).length,legalButUnpaid:rows.filter(r=>r.legalIncome>0&&!r.realized).length,
    legalIncome:sum(rows,r=>r.legalIncome),realizedIncome:sum(rows,r=>r.realized),
    unpaidLegalIncome:sum(rows,r=>r.legalIncome>0&&!r.realized?r.legalIncome:0),
    hitRate:positives.length/n,mean:sum(rows,r=>r.realized)/n,positiveMean:positives.length?sum(positives,r=>r.realized)/positives.length:0,
    p95:sorted[Math.min(n-1,Math.floor(n*.95))],predictedMean:sum(rows,r=>r.predicted)/n,
    conditionalPredictionMean:sum(rows,r=>r.conditionalPrediction)/n,
    actualMinusPredictedCI95:boot.length?[boot[49],boot[1949]]:null,sparse:totals.length<8||positives.length<10,
    // Preserve cluster sufficient statistics, not falsely independent rows.
    clusters:[...seeds.entries()].map(([seed,t])=>({seed,...t}))}
}
function groupBy(key){const groups=new Map();for(const r of rows){const k=key(r);groups.set(k,[...(groups.get(k)??[]),r])}return [...groups.entries()].map(([key,data])=>({key,...summary(data)}))}
const categories=['wildcard-face','honor','terminal','middle']
const composition=[]
for(const locked of [false,true])for(const valueBand of [...new Set(rows.map(r=>r.valueBand))]){
  const data=rows.filter(r=>r.opponentLocked===locked&&r.valueBand===valueBand)
  if(!data.length)continue
  composition.push({locked,valueBand,observations:data.length,categories:categories.map(category=>({category,
    observed:data.filter(r=>r.category===category).length/data.length,
    uniformUnseen:sum(data,r=>r.categoryProbabilities[category])/data.length}))})
}
const result={scope:'Descriptive frozen-policy locked-recipient exposures. Multiple recipients/source and multiple discards/game are dependent. Bootstrap resamples entire source games and recomputes per-exposure means. No model fitted; observed category conditioning is post-discard, not a next-tile predictor. Sparse cells and multiple comparisons are exploratory.',
  batches:batches.map(b=>b.metadata),overall:summary(rows),byLock:groupBy(r=>String(r.opponentLocked)),
  byValue:groupBy(r=>r.valueBand),byCategory:groupBy(r=>r.category),
  cells:groupBy(r=>`${r.opponentLocked}/${r.category}/${r.valueBand}`),
  byPanel:groupBy(r=>r.panel),composition}
writeFileSync('work/blood-flow-ron/analysis.json',JSON.stringify(result,null,2))
console.log(JSON.stringify({overall:{...result.overall,clusters:undefined},byLock:result.byLock.map(r=>({...r,clusters:undefined})),byValue:result.byValue.map(r=>({...r,clusters:undefined})),byCategory:result.byCategory.map(r=>({...r,clusters:undefined}))},null,2))
