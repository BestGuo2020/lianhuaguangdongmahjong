import { expect, it, vi } from 'vitest'
import { createRoom } from './roomApi'
import { request } from './httpClient'

vi.mock('./httpClient', () => ({ request: vi.fn() }))

it('forwards blood-flow rooms to the backend registry (ws path released)', async () => {
  vi.mocked(request).mockResolvedValue({ roomId: 'R', rulesetId: 'lotus-blood-flow' })
  await createRoom('east', 4, 'p1', 'lotus-blood-flow')
  expect(request).toHaveBeenCalledWith('/api/rooms', expect.objectContaining({
    method: 'POST',
    body: JSON.stringify({ mode: 'east', capacity: 4, playerId: 'p1', rulesetId: 'lotus-blood-flow' }),
  }))
})

it('keeps default ruleset for legacy callers', async () => {
  vi.mocked(request).mockResolvedValue({ roomId: 'R2' })
  await createRoom('east', 4, 'p1')
  expect(request).toHaveBeenCalledWith('/api/rooms', expect.objectContaining({
    body: JSON.stringify({ mode: 'east', capacity: 4, playerId: 'p1', rulesetId: 'lotus-classic' }),
  }))
})
