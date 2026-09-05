import {expect,it} from 'vitest'
import {createBloodFlowActionSpeech,actionSpeechMatches} from './bloodFlowSpeech'
import {BloodFlowEngine} from '../variants/lotus/bloodFlow/engine'
import {bloodFlowSeatView} from '../variants/lotus/bloodFlow/seatView'
import {seededRandom} from '../variants/lotus/bloodFlow/simulation'
import type {LlmProviderPreset} from './config'
const provider={id:'p',name:'p',apiKey:'private',baseUrl:'https://example.test',model:'m',style:'稳健',timeoutMs:40000} as LlmProviderPreset
function view(){const v=bloodFlowSeatView(new BloodFlowEngine({authorityEpoch:'e',roundId:'r',random:seededRandom(23),now:()=>0}),0);v.window!.deadlineAt=Infinity;v.ownScore=null;v.ownActions=[{kind:'discard',index:0},{kind:'discard',index:1}];return v}
it('waits for the selected discard, filters Hu/private claims, and emits only once',()=>{
  const speech=createBloodFlowActionSpeech(()=> 'llm',()=>0),before=view(),action={kind:'discard' as const,index:0}
  speech.plan('one',before,action,provider,'我胡了，我手里有清一色','llm')
  expect(speech.observe(before)).toEqual([])
  const after=structuredClone(before);after.version++;after.lastDiscardAction={id:'committed-tile',kind:'discard',seat:0,tile:before.players[0].hand[0]}
  after.window={...after.window!,id:'next'}
  const lines=speech.observe(after)
  expect(lines).toHaveLength(1);expect(lines[0].text).not.toMatch(/胡|清一色|手里/)
  expect(actionSpeechMatches(lines[0],after)).toBe(true);expect(JSON.stringify(lines)).not.toContain('private')
  expect(speech.observe(after)).toEqual([])
})
it('a claim that loses priority cannot announce completion; a committed peng can',()=>{
  const speech=createBloodFlowActionSpeech(()=> 'llmAnime',()=>0),before=view()
  before.window={...before.window!,kind:'win',source:{id:'tile',kind:'discard',seat:1,tile:'m1'}}
  before.ownActions=[{kind:'peng'},{kind:'pass'}]
  speech.plan('lost',before,{kind:'peng'},provider,'我碰了','llmAnime')
  expect(speech.observe(before)).toEqual([])
  const lost=structuredClone(before);lost.version++;lost.window={...lost.window!,id:'after-other-win'}
  expect(speech.observe(lost)).toEqual([])
  const committed=structuredClone(before);committed.version++;committed.actionEvents.push({id:99,type:'peng',actorIndex:0,sourceIndex:1,tile:'m1',meldIndex:0});committed.window={...committed.window!,id:'after-peng'}
  expect(speech.observe(committed)).toEqual([])
  speech.plan('accepted',before,{kind:'peng'},provider,'我碰了','llmAnime')
  expect(speech.observe(committed)[0]).toMatchObject({text:'我碰了',eventKind:'action',eventId:'99',actionType:'peng'})
})
it('win offers, other themes, and a changed theme never admit ordinary commentary',()=>{
  let theme='llm';const speech=createBloodFlowActionSpeech(()=>theme,()=>0),before=view()
  before.ownActions=[{kind:'win'},{kind:'pass'}]
  speech.plan('hu',before,{kind:'win'},provider,'我胡了','llm');expect(speech.observe(before)).toEqual([])
  const normal=view();speech.plan('normal',normal,{kind:'discard',index:0},provider,'先打这张','llm');theme='jade'
  const after=structuredClone(normal);after.lastDiscardAction={id:'d',kind:'discard',seat:0,tile:normal.players[0].hand[0]};after.version++
  expect(speech.observe(after)).toEqual([])
  speech.plan('jade',normal,{kind:'discard',index:0},provider,'先打这张','jade');expect(speech.observe(after)).toEqual([])
})
