import { readTurnEnvironment } from '../../../scripts/turn-env.mjs'

const signalingUrl = process.env.E2E_SIGNALING_URL?.trim() ?? ''
if (signalingUrl && !/^wss?:\/\//.test(signalingUrl)) {
  throw new Error('E2E_SIGNALING_URL must use ws:// or wss://')
}
const turn = readTurnEnvironment(false)

export const selfHostEnvironment = {
  signalingUrl: encodeURIComponent(signalingUrl),
  turnUrl: encodeURIComponent(turn?.queryValue ?? ''),
  configured: Boolean(signalingUrl && turn),
}

export const selfHostEnvironmentHint =
  'Set E2E_SIGNALING_URL, TURN_HOST, TURN_USERNAME and TURN_PASSWORD (see docs/turn-environment.md)'
