import { applyKongScore } from '../rules/rules'
import { createKongActionExecutor } from '../../shared/runtime/kongActionExecutor'
import { PACE_MS } from './localGameConfig'

export function createLocalKongActionExecutor(options: Omit<Parameters<typeof createKongActionExecutor>[0], 'scoreKong' | 'addedKongDelay'>) {
  return createKongActionExecutor({ ...options, scoreKong: applyKongScore, addedKongDelay: PACE_MS.afterKongSettle })
}
