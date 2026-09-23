// The two local variants use the same LLM hook protocol and action matching keys.
// Keep one request/answer correlator; the classic engine supplies its own windows.
import {
  createLotusLegacyDecisionSink,
  type LotusLegacyDecisionSink,
  type LotusLegacyDecisionSinkOptions,
} from './lotusLegacyAdapter'

export type LotusClassicDecisionSink = LotusLegacyDecisionSink

export function createLotusClassicDecisionSink(options: LotusLegacyDecisionSinkOptions): LotusClassicDecisionSink {
  return createLotusLegacyDecisionSink({ ...options, fallbackStrategy: 'classic-local-ai' })
}
