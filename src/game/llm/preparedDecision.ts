import {isConditionalReasoningSuppressed, requestLlmDecision, type PromptPair} from './client'
import type {LlmProviderConfig} from './config'
import type {LlmControllerStats} from './llmController'
import {ConditionalReasoningCoordinator, type ReasoningDecision} from './conditionalReasoning'
import {hasMandatoryReasoning,resolveReasoningPolicy} from './reasoningPolicy'

const SAFE_REASONING_STAGES = ['正在观察公开牌局','正在整理规则约束','正在比较可行动作','正在评估攻守节奏','正在复核最终选择'] as const
export function safeReasoningStatus(sequence:number):string {
  return `思考中 · ${SAFE_REASONING_STAGES[(Math.max(1,Math.floor(sequence))-1)%SAFE_REASONING_STAGES.length]}`
}

/** User budget intersected with an authority deadline; no variant-specific default. */
export function configuredDecisionBudget(config:LlmProviderConfig, remainingMs=Infinity):number {
  return Math.max(0,Math.min(config.timeoutEnabled===false?Infinity:config.timeoutMs,remainingMs))
}

/** Shared request lifecycle. Candidate legality and committing an action stay with callers. */
export async function requestPreparedDecision(options:{
  config:LlmProviderConfig; decision:ReasoningDecision; messages:PromptPair; seat:number
  stats:LlmControllerStats; reasoning:ConditionalReasoningCoordinator
  signal?:AbortSignal; budgetMs?:number; remainingAuthorityMs?:number
  onStatus?:(active:boolean,text?:string)=>void|Promise<void>
  request?:typeof requestLlmDecision
}) {
  const {stats,reasoning,config}=options
  const quickPolicy=resolveReasoningPolicy(config)
  const policy=resolveReasoningPolicy(config,true)
  const alwaysThinking=hasMandatoryReasoning(quickPolicy)
  // A thinking-only model with no supported effort tier (e.g. Kimi K3 on DashScope)
  // must not enter a capped deep request that cannot actually increase its strength.
  const adjustable=quickPolicy.mode!==policy.mode
    || JSON.stringify(quickPolicy.requestBody)!==JSON.stringify(policy.requestBody)
  const supports=(policy.mode==='explicit-on'||policy.mode==='always-on')
    &&adjustable&&!isConditionalReasoningSuppressed(config)
  // The existing coordinator reserves 45s around a 40s deep request. A shorter
  // authority window never gains that reserve or extends its actual deadline.
  const reserve=Math.max(0,reasoning.config.minRemainingBudgetMs-reasoning.config.deadlineMs)
  // Admission uses the configured tier, so a few milliseconds of feature work
  // do not disable the default 40s tier. The request still receives only the
  // unspent budget below, and the authority deadline always limits admission.
  const remaining=options.budgetMs===undefined?reasoning.config.minRemainingBudgetMs
    :Math.min(options.remainingAuthorityMs??Infinity,configuredDecisionBudget(config)+reserve)
  const useReasoning=supports&&reasoning.admit(options.decision,options.seat,remaining).enabled
  let sequence=0,statusActive=useReasoning||policy.mode==='reasoning-only',thinkingCounted=false
  const notify=async(active:boolean,text?:string)=>{try{await options.onStatus?.(active,text)}catch{/* display only */}}
  const countThinking=()=>{if(!thinkingCounted){thinkingCounted=true;stats.thinkingRequests=(stats.thinkingRequests??0)+1}}
  stats.requests++
  if(alwaysThinking)countThinking()
  if(useReasoning){stats.reasoningRequests=(stats.reasoningRequests??0)+1;stats.enhancedReasoningRequests=(stats.enhancedReasoningRequests??0)+1;countThinking()}
  if(statusActive)await notify(true,policy.mode==='reasoning-only'?safeReasoningStatus(++sequence):undefined)
  let stopAbortWait=()=>{}
  try {
    if(options.signal?.aborted)throw new DOMException('Request cancelled','AbortError')
    const budget=options.budgetMs===undefined&&options.remainingAuthorityMs===undefined?undefined
      :configuredDecisionBudget(config,Math.min(options.budgetMs??Infinity,options.remainingAuthorityMs??Infinity))
    const pending=(options.request??requestLlmDecision)({
      config:budget===undefined?config:{...config,timeoutMs:budget,timeoutEnabled:Number.isFinite(budget)},
      messages:options.messages,candidateIds:options.decision.candidates.map(c=>c.id),signal:options.signal,
      reasoning:useReasoning,
      deadlineMs:useReasoning?Math.min(reasoning.config.deadlineMs,budget??Infinity):undefined,
      onReasoningProgress:()=>{if(options.signal?.aborted)return;countThinking();statusActive=true;void notify(true,safeReasoningStatus(++sequence))},
    })
    if(!options.signal)return await pending
    const signal=options.signal
    const cancelled=new Promise<never>((_,reject)=>{
      const abort=()=>reject(new DOMException('Request cancelled','AbortError'))
      signal.addEventListener('abort',abort,{once:true})
      stopAbortWait=()=>signal.removeEventListener('abort',abort)
      if(signal.aborted)abort()
    })
    return await Promise.race([pending,cancelled])
  } finally {stopAbortWait();if(statusActive)await notify(false)}
}
