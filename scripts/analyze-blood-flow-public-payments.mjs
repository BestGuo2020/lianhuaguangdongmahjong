import {readFileSync,writeFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
const bytes=readFileSync('work/blood-flow-public-payments/models.json'),model=JSON.parse(bytes)
const held=JSON.parse(readFileSync('work/blood-flow-public-payments/holdout.json','utf8'))
if(createHash('sha256').update(bytes).digest('hex')!==held.modelHash)throw new Error('Frozen model mismatch')
const rows=held.rows,mean=v=>v.reduce((a,b)=>a+b,0)/v.length
function stat(values){
  let state=912701;const random=()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return(state>>>0)/4294967296}
  const boot=Array.from({length:4000},()=>mean(values.map(()=>values[Math.floor(random()*values.length)]))).sort((a,b)=>a-b)
  return {sourceWindows:values.length,mean:mean(values),ci95:[boot[99],boot[3899]]}
}
const immediateGain=(power)=>stat(rows.map(r=>mean(['old','proposed'].map(key=>{
  const actual=r.original[key].immediate,reference=model.scalar*r[key].riskProxy
  const prediction=key==='old'?r.prediction.oldImmediate:r.prediction.newImmediate
  return Math.abs(reference-actual)**power-Math.abs(prediction-actual)**power
}))))
const result={modelHash:held.modelHash,scope:'Additional fixed-baseline diagnostics of already-frozen predictions; no refitting or model selection.',
  immediateVsNewScalar:model.scalar===null?null:{maeGain:immediateGain(1),mseGain:immediateGain(2)},
  originalFull:stat(rows.map(r=>r.original.delta.full)),permutedFull:stat(rows.map(r=>r.permuted.delta.full)),
  originalTailReversals:rows.filter(r=>r.original.delta.horizon*r.original.delta.full<0).map(r=>({seed:r.seed,horizon:r.original.delta.horizon,tail:r.original.delta.tail,full:r.original.delta.full})),
  heldoutTailWindows:rows.filter(r=>r.permuted.old.tail!==0||r.permuted.proposed.tail!==0).length,
  largestTailErrors:[...rows].sort((a,b)=>Math.abs(b.prediction.tail-b.permuted.delta.tail)-Math.abs(a.prediction.tail-a.permuted.delta.tail)).slice(0,3)
    .map(r=>({seed:r.seed,wall:r.wall,predicted:r.prediction.tail,actual:r.permuted.delta.tail,original:r.original.delta.tail})),
  laterCoefficients:model.later.weights.map((v,i)=>({feature:model.featureNames.paired[i],standardizedWeight:v})),
  tailCoefficients:model.tail.weights.map((v,i)=>({feature:model.featureNames.paired[i],standardizedWeight:v}))}
const heads={
  frozenImmediate:r=>r.prediction.gross-model.oldScalar*(r.proposed.riskProxy-r.old.riskProxy),
  refitImmediate:r=>r.prediction.gross-(model.scalar??0)*(r.proposed.riskProxy-r.old.riskProxy),
  publicImmediate:r=>r.prediction.gross-r.prediction.immediateGap,
  publicH8:r=>r.prediction.netH8,
  allComponents:r=>r.prediction.netFull,
}
result.shadowDiagnostics=Object.entries(heads).map(([name,score])=>({name,
  changedWindows:rows.filter(r=>score(r)<=0).length,
  permutedGainVsAlwaysNew:stat(rows.map(r=>score(r)>0?0:-r.permuted.delta.full)),
  originalGainVsAlwaysNew:stat(rows.map(r=>score(r)>0?0:-r.original.delta.full))}))
writeFileSync('work/blood-flow-public-payments/diagnostics.json',JSON.stringify(result,null,2))
console.log(JSON.stringify({...result,laterCoefficients:undefined,tailCoefficients:undefined},null,2))
