import { onScopeDispose, shallowRef } from 'vue'
import { createTableInteractionLimiter, quickChatPhrase, readTableInteraction,
  type TableEmoteId, type TableInteraction, type TableInteractionEvent } from '../../game/shared/tableInteractions'

interface InteractionAudio {
  pause(): void
  __releaseEffect?(): void
}

export interface TableChatBubble {
  id: number
  text: string
}

export interface TableEmoteCue {
  id: number
  emote: TableEmoteId
  fromSeat: number
  targetSeat: number
}

export function useTableInteractions(
  playEffect: (file: string, volume?: number, onFinish?: () => void) => InteractionAudio | null,
) {
  const bubbles = shallowRef<Record<number, TableChatBubble>>({})
  const cues = shallowRef<readonly TableEmoteCue[]>([])
  const limiter = createTableInteractionLimiter()
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const voices = new Map<number, InteractionAudio>()
  const seen = new Set<string>()
  let serial = 0

  function later(ms: number, run: () => void) {
    const timer = setTimeout(() => {
      timers.delete(timer)
      run()
    }, ms)
    timers.add(timer)
  }

  function stopVoice(seat: number) {
    const voice = voices.get(seat)
    voices.delete(seat)
    voice?.pause()
    voice?.__releaseEffect?.()
  }

  function show(seat: number, action: TableInteraction) {
    const id = ++serial
    if (action.type === 'quick_chat') {
      const text = quickChatPhrase(action.phraseId)!.text
      bubbles.value = { ...bubbles.value, [seat]: { text, id } }
      later(Math.max(2_600, text.length * 150 + 650), () => {
        if (bubbles.value[seat]?.id !== id) return
        const next = { ...bubbles.value }
        delete next[seat]
        bubbles.value = next
      })
      stopVoice(seat)
      let voice: InteractionAudio | null = null
      voice = playEffect(`sounds/chat-${action.phraseId}.mp3`, 0.95, () => {
        if (voices.get(seat) === voice) voices.delete(seat)
      })
      if (voice) voices.set(seat, voice)
      return
    }

    cues.value = [...cues.value, { id, emote: action.emote, fromSeat: seat, targetSeat: action.targetSeat }].slice(-6)
    later(1_800, () => { cues.value = cues.value.filter(cue => cue.id !== id) })
    const sound = `sounds/emote-${action.emote}.ogg`
    if (action.emote === 'banana') {
      playEffect('sounds/emote-throw.ogg', 0.78)
      later(480, () => { playEffect(sound, 0.9) })
    } else {
      playEffect(sound, 0.9)
    }
  }

  function send(seat: number, action: TableInteraction, relay?: (action: TableInteraction) => boolean) {
    const validated = readTableInteraction(action, seat)
    return Boolean(validated && limiter.send(seat, validated, () => {
      if (relay) return relay(validated)
      show(seat, validated)
      return true
    }))
  }

  function receive(event: TableInteractionEvent) {
    const key = `${event.scope}:${event.id}`
    if (seen.has(key)) return
    seen.add(key)
    if (seen.size > 64) seen.delete(seen.values().next().value!)
    show(event.fromSeat, event.action)
  }

  function clear() {
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
    for (const seat of voices.keys()) stopVoice(seat)
    seen.clear()
    limiter.clear()
    bubbles.value = {}
    cues.value = []
  }

  onScopeDispose(clear)
  return { bubbles, cues, send, receive, clear }
}
