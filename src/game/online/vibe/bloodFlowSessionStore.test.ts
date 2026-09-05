import { expect, it } from 'vitest'
import { createBloodFlowSessionStore } from './bloodFlowSessionStore'
import { SESSION_TTL_MS } from '../session/remoteSessionStore'

it('keeps blood-flow identity and seat capability across reload without changing legacy sessions', () => {
  const data = new Map<string, string>()
  const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v) }, removeItem: (k: string) => { data.delete(k) } }
  const store = createBloodFlowSessionStore(() => storage, { namespace: 'peer' })
  store.saveSession({ roomId: 'ABC123', mode: 'east', nickname: 'test', playerId: 'guest', rulesetId: 'lotus-blood-flow', rejoinCode: '' })
  store.saveSeatToken('verified-capability')
  const restored = createBloodFlowSessionStore(() => storage, { namespace: 'peer' })
  expect(restored.loadSession()).toMatchObject({ rulesetId: 'lotus-blood-flow', seatToken: 'verified-capability', playerId: 'guest' })
  expect(restored.loadSession(() => Date.now() + SESSION_TTL_MS + 1)).toBeNull()
  store.saveSession({ roomId: 'DEF456', mode: 'hanchan', nickname: 'test', playerId: 'guest', rulesetId: 'lotus-legacy', rejoinCode: '' })
  expect(restored.loadSession()?.rulesetId).toBe('lotus-legacy')
})
