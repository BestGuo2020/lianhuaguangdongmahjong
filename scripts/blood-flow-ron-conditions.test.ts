import { expect,it } from 'vitest'
import { readFileSync,writeFileSync,mkdirSync,existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { newRound,nextSeatToAct,submit } from './blood-flow-counterfactual'
import { opponentFor,panelCurrent,type PanelId } from './blood-flow-opponent-panel'
import { bloodFlowSeatView } from '../src/game/variants/lotus/bloodFlow/seatView'
import { forecastWinIncome } from '../src/game/variants/lotus/bloodFlow/incomeForecast'
import { tileCategory,ronFeatures } from './blood-flow-ron-conditions'

it('uses disjoint public tile categories, with wildcard faces taking precedence',()=>{
  expect(tileCategory('m1',['m1'])).toBe('wildcard-face')
  expect(tileCategory('white',[])).toBe('wildcard-face')
  expect(tileCategory('east',[])).toBe('honor')
  expect(tileCategory('s9',[])).toBe('terminal')
  expect(tileCategory('p5',[])).toBe('middle')
})

it.skipIf(process.env.BF_RON_RUN!=='1')('records pre-discard features and source-matched realized ron income',()=>{
  const from=Number(process.env.BF_RON_FROM??281001),rounds=Number(process.env.BF_RON_ROUNDS??32)
  const panel=(process.env.BF_RON_PANEL??'mixed') as PanelId
  if(!['mixed','defensive'].includes(panel)||!Number.isSafeInteger(from)||from<1||!Number.isSafeInteger(rounds)||rounds<1||rounds>128)throw new Error('Invalid run')
  const dir=`work/blood-flow-ron/${panel}-${from}`
  if(existsSync(dir))throw new Error('Fresh batch required')
  mkdirSync(dir,{recursive:true})
  const calibration=JSON.parse(readFileSync('docs/blood-flow/records/opportunity-calibration-2026-09-20.json','utf8')).calibration
  const files=['scripts/blood-flow-ron-conditions.ts','scripts/blood-flow-ron-conditions.test.ts',
    'src/game/variants/lotus/bloodFlow/incomeForecast.ts','src/game/variants/lotus/bloodFlow/engine.ts','src/game/variants/lotus/bloodFlow/ai.ts']
  const hash=()=>{const h=createHash('sha256');for(const f of files)h.update(f).update(readFileSync(f));return h.digest('hex')}
  const fingerprint=hash(),started=Date.now()
  const metadata={from,rounds,panel,calibration,fingerprint,scope:'Locked recipients only, all actual opponent discards including misses; features computed before discard; observed category is post-hoc conditioning, not a forecast of the next tile. Income labels source-ID matched after round. No fitting.'}
  writeFileSync(`${dir}/metadata.json`,JSON.stringify(metadata,null,2))
  for(let seed=from;seed<from+rounds;seed++){
    const engine=newRound(seed),rows:any[]=[]
    let commands=0
    while(!engine.result){
      if(++commands>2000)throw new Error('Stalled')
      const actor=nextSeatToAct(engine),acting=bloodFlowSeatView(engine,actor)
      const action=(actor===0?panelCurrent:opponentFor(panel,seed,0,actor))(acting)
      if(!action)throw new Error('No action')
      const pending:any[]=[]
      if(action.kind==='discard')for(const target of [0,1,2,3] as const){
        if(target===actor||!engine.seats[target].locked)continue
        const view=bloodFlowSeatView(engine,target),p=view.players[target]
        expect(view.players.every((p,i)=>i===target||!p.hand.length)).toBe(true)
        const features=ronFeatures(view,calibration.ronYield)
        // Actual tile is used ONLY for descriptive grouping and realized legality;
        // it never enters the pre-discard forecast or any acting policy.
        const tile=acting.players[actor].hand[action.index],category=tileCategory(tile,view.jokers),bucket=features.buckets[category]
        const legalIncome=forecastWinIncome(p.hand,p.melds,view.jokers,tile,'discard')
        pending.push({seed,actor,target,opponentLocked:view.public.seats[actor].locked,valueBand:features.valueBand,
          waitValue:features.waitValue,category,predicted:features.predicted,
          conditionalPrediction:bucket.mass?bucket.income/bucket.mass*calibration.ronYield:0,
          categoryValues:Object.fromEntries(Object.entries(features.buckets).map(([k,b])=>[k,b.mass?b.income/b.mass:0])),
          categoryProbabilities:Object.fromEntries(Object.entries(features.buckets).map(([k,b])=>[k,features.mass?b.mass/features.mass:0])),
          legalIncome,realized:0,wall:view.wallCount})
      }
      const discardsBefore=engine.discardActions.length
      submit(engine,actor,action)
      if(pending.length){
        expect(engine.discardActions.length).toBe(discardsBefore+1)
        const source=engine.discardActions.at(-1)!
        rows.push(...pending.map(r=>({...r,sourceId:source.id})))
      }
    }
    // rows were copied above; update labels on the final row records by source/target.
    const byKey=new Map(rows.map(r=>[`${r.sourceId}/${r.target}`,r]))
    let matchedIncome=0
    for(const entry of engine.ledger)if(entry.kind==='win'&&entry.batch.source.kind==='discard')for(const w of entry.batch.winners){
      const row=byKey.get(`${entry.batch.source.id}/${w.winner}`)
      if(row){row.realized+=w.deltas[w.winner];matchedIncome+=w.deltas[w.winner]}
    }
    expect(rows.reduce((n,r)=>n+r.realized,0)).toBe(matchedIncome)
    expect(rows.every(r=>r.realized===0||r.realized===r.legalIncome)).toBe(true)
    writeFileSync(`${dir}/seed-${seed}.json`,JSON.stringify(rows))
    writeFileSync(`${dir}/progress.json`,JSON.stringify({completed:seed-from+1,rounds,seconds:(Date.now()-started)/1000}))
  }
  expect(hash()).toBe(fingerprint)
  writeFileSync(`${dir}/done.json`,JSON.stringify(metadata,null,2))
},7_200_000)
