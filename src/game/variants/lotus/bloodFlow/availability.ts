import { BLOOD_FLOW_AVAILABILITY } from './config'

export type BloodFlowSurface = keyof typeof BLOOD_FLOW_AVAILABILITY

export function bloodFlowEnabled(surface: BloodFlowSurface) {
  return BLOOD_FLOW_AVAILABILITY[surface] || (import.meta.env.DEV
    && typeof location !== 'undefined' && new URLSearchParams(location.search).get('bloodFlow') === '1')
}
