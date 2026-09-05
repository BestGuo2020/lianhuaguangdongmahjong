import { BLOOD_FLOW_AVAILABILITY } from './config'

export function bloodFlowEnabled(surface: 'local' | 'p2p') {
  return BLOOD_FLOW_AVAILABILITY[surface] || (surface === 'local' && import.meta.env.DEV
    && typeof location !== 'undefined' && new URLSearchParams(location.search).get('bloodFlow') === '1')
}
