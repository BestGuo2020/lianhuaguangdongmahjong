import { expect, it, vi } from 'vitest'
import { createRoom } from './roomApi'
import { request } from './httpClient'

vi.mock('./httpClient', () => ({ request: vi.fn() }))
it('never sends a blood-flow key to the legacy WebSocket room backend', async () => {
  await expect(createRoom('east', 4, undefined, 'lotus-blood-flow')).rejects.toThrow('WebSocket')
  expect(request).not.toHaveBeenCalled()
})
