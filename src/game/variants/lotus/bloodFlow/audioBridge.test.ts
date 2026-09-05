import { expect, it, vi } from 'vitest'
import { createBloodFlowAudioBridge } from './audioBridge'
import type { TableActionEvent } from '../../../core/contracts/types'

it.each(['jade', 'rosewood', 'happyMahjong', 'llm', 'llmAnime'])('%s selects exactly one existing action voice route', async theme => {
  const play = vi.fn(), executeAction = vi.fn(async () => ({ fallbackAudioFile: null }))
  const bridge = createBloodFlowAudioBridge({ theme: () => theme, epoch: () => '1', player: () => ({ characterId: 'deepseek' }),
    fixed: { executeAction, cancel: vi.fn() } as any, play })
  const event: TableActionEvent = { id: 1, actorIndex: 0, type: 'self-draw', sourceIndex: null, tile: 'm1', meldIndex: -1 }
  bridge.present(event); bridge.present(event)
  await Promise.resolve()
  expect(executeAction).toHaveBeenCalledTimes(theme === 'llmAnime' ? 1 : 0)
  expect(play).toHaveBeenCalledTimes(theme === 'llmAnime' ? 0 : 1)
  if (theme !== 'llmAnime') expect(play).toHaveBeenCalledWith('zimo.mp3')
})
it('late fallback after a theme change cannot play, and unresolved TTS never returns a rule barrier', async () => {
  let theme = 'llmAnime', finish!: (value: any) => void
  const play = vi.fn(), fixed = { executeAction: () => new Promise(resolve => { finish = resolve }), cancel: vi.fn() }
  const bridge = createBloodFlowAudioBridge({ theme: () => theme, epoch: () => '1', player: () => ({}), fixed: fixed as any, play })
  expect(bridge.present({ id: 1, actorIndex: 0, type: 'discard-win', sourceIndex: 1, tile: 'm1', meldIndex: -1 })).toBeUndefined()
  theme = 'jade'; bridge.reset(); finish({ fallbackAudioFile: 'hu.mp3' })
  await Promise.resolve()
  expect(play).not.toHaveBeenCalled()
})
