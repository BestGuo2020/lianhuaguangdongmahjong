import { expect, it, vi } from 'vitest'
import { createRoom, reserveLlmSeat } from './roomApi'
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

it('reserves an empty seat for a server-side model (creator identity + target seat)', async () => {
  vi.mocked(request).mockResolvedValue({ roomId: 'R3', reservedSeats: [] })
  await reserveLlmSeat('R3', 0, 'CODE', 1, 'kimi', '高冷')
  expect(request).toHaveBeenCalledWith('/api/rooms/R3/llm-seats', expect.objectContaining({
    method: 'POST',
    body: JSON.stringify({ seat: 0, rejoinCode: 'CODE', reserveSeat: 1, providerId: 'kimi', style: '高冷' }),
  }))
})

it('clears a reservation by omitting the provider id (seat back to 自动选择)', async () => {
  vi.mocked(request).mockResolvedValue({ roomId: 'R3', reservedSeats: [] })
  await reserveLlmSeat('R3', 0, 'CODE', 1, null, null)
  expect(request).toHaveBeenLastCalledWith('/api/rooms/R3/llm-seats', expect.objectContaining({
    body: JSON.stringify({ seat: 0, rejoinCode: 'CODE', reserveSeat: 1 }),
  }))
})
