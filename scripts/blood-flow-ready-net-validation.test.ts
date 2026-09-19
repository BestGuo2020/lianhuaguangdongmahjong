import { expect,it } from 'vitest'
import { readFileSync,mkdirSync,writeFileSync } from 'node:fs'
import { deserialize } from 'node:v8'
import { restoreEngine } from './blood-flow-counterfactual'
import { bloodFlowSeatView } from '../src/game/variants/lotus/bloodFlow/seatView'
import { readyControl,readyCandidate,readyCanDiffer } from './blood-flow-ready-net-policy'
import { pairedContest } from './blood-flow-route-opportunity'

it('records the new choice at both saved, legal diagnostic windows',()=>{
  const rows=['1100001-peng','1100008-peng'].map(key=>{
    const {checkpoint,seat}=deserialize(readFileSync(`work/blood-flow-meld-counterfactual/screen-v1/${key}.bin`))
    const view=bloodFlowSeatView(restoreEngine(checkpoint),seat),before=structuredClone(view)
    const control=readyControl(view),candidate=readyCandidate(view)
    expect(view.ownActions).toContainEqual(candidate)
    expect(view).toEqual(before)
    return {key,wall:view.wallCount,control,candidate}
  })
  mkdirSync('work/blood-flow-ready-net',{recursive:true})
  writeFileSync('work/blood-flow-ready-net/cases.json',JSON.stringify(rows,null,2))
})

it('new-current-control A/A is exactly zero',()=>{
  expect(pairedContest(1300001,4,true,readyControl,readyControl).rows.map(r=>r.deltaVsControl)).toEqual([0,0,0,0])
},120_000)

it('eligibility shortcut preserves complete match outcomes and all decision changes',()=>{
  const full=pairedContest(1400001,4,true,readyCandidate,readyControl)
  const fast=pairedContest(1400001,4,true,readyCandidate,readyControl,readyCanDiffer)
  expect(full.rows.some(r=>r.diverged)).toBe(true)
  expect(fast).toEqual(full)
},240_000)
