import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import type { BloodFlowSeatView } from '../src/game/variants/lotus/bloodFlow/seatView'
import { BLOOD_FLOW_AI, BLOOD_FLOW_LLM_AI } from '../src/game/variants/lotus/bloodFlow/config'
import { decideBloodFlowActionEv } from '../src/game/variants/lotus/bloodFlow/ai'

const readRecord = (name: string) => JSON.parse(readFileSync(`docs/blood-flow/records/${name}-2026-09-20.json`, 'utf8'))
const protocol = readRecord('source-v2-final-protocol')
const normalized = (value: unknown) => JSON.parse(JSON.stringify(value))
const rollback = process.env.VITE_BLOOD_FLOW_SOURCE_FORECAST === 'off'

it.skipIf(rollback)('ships the exact accepted candidate and replays archived slow public views', () => {
  expect(normalized(BLOOD_FLOW_AI)).toEqual(protocol.candidate)
  expect(BLOOD_FLOW_LLM_AI.chainForecast).toBe('legacy')
  expect(BLOOD_FLOW_LLM_AI.opportunityCalibration).toBeUndefined()
  for (const rep of [0, 1, 2]) {
    for (const { view, record } of readRecord(`source-v2-final-engineering-${rep}`).slow) {
      expect(decideBloodFlowActionEv(view as BloodFlowSeatView, BLOOD_FLOW_AI)).toEqual(record.candidate)
    }
  }
}, 30_000)

it.skipIf(!rollback)('rolls back only the forecast and reproduces the frozen formal control', () => {
  expect(normalized(BLOOD_FLOW_AI)).toEqual(protocol.control)
  for (const { view, record } of readRecord('source-v2-final-engineering-0').slow) {
    expect(decideBloodFlowActionEv(view as BloodFlowSeatView, BLOOD_FLOW_AI)).toEqual(record.control)
  }
}, 30_000)
