import { createKongActionExecutor } from '../../shared/runtime/kongActionExecutor'
import { PACE_MS } from './localGameConfig'
import { DEFAULT_RULESET, type RuleSet } from '../rules/ruleset'

export function createLocalKongActionExecutor(options: Omit<Parameters<typeof createKongActionExecutor>[0], 'scoreKong' | 'addedKongDelay'> & { ruleset?: RuleSet }) {
  const ruleset = options.ruleset ?? DEFAULT_RULESET
  return createKongActionExecutor({ ...options, scoreKong: ruleset.score.applyKongScore, addedKongDelay: PACE_MS.afterKongSettle })
}
