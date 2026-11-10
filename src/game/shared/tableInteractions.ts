export const QUICK_CHAT_PAGES = [
  {
    id: 'common', label: '常用',
    phrases: [
      { id: 'listen', text: '听没听啊～' },
      { id: 'hurry', text: '快点吧，我等的花都谢了' },
      { id: 'praise', text: '你的牌打得太好了' },
      { id: 'think', text: '让我再想想' },
      { id: 'let-chi', text: '好歹让我吃一个嘛~' },
    ],
  },
  {
    id: 'vibe', label: '气氛',
    phrases: [
      { id: 'hello', text: '大家好，很高兴见到各位' },
      { id: 'stay', text: '朋友，不要走，再打几盘吧' },
      { id: 'let-draw', text: '还让不让我摸牌了！' },
      { id: 'feed-peng', text: '打一张来碰嘛' },
      { id: 'hurt', text: '来呀互相伤害呀' },
      { id: 'oops-hu', text: '哎呀一不小心就胡了' },
      { id: 'no-friends', text: '你这样以后没朋友' },
      { id: 'hundred-ways', text: '我有一百种办法胡你，而你却无可奈何' },
    ],
  },
] as const

export type QuickChatPhrase = (typeof QUICK_CHAT_PAGES)[number]['phrases'][number]
export type QuickChatId = QuickChatPhrase['id']
const phrases: readonly QuickChatPhrase[] = [...QUICK_CHAT_PAGES[0].phrases, ...QUICK_CHAT_PAGES[1].phrases]

export function quickChatPhrase(id: unknown) {
  return phrases.find(phrase => phrase.id === id)
}

export const TABLE_EMOTES = [
  { id: 'tomato', label: '番茄', image: 'tomato.png' },
  { id: 'egg', label: '鸡蛋', image: 'egg.png' },
  { id: 'pan', label: '平底锅', image: 'pan.png' },
  { id: 'banana', label: '香蕉皮', image: 'banana-peel.png' },
  { id: 'kiss', label: '亲吻', image: 'kiss.png' },
  { id: 'like', label: '点赞', image: 'like.png' },
] as const

export type TableEmote = (typeof TABLE_EMOTES)[number]
export type TableEmoteId = TableEmote['id']

export function tableEmote(id: unknown) {
  return TABLE_EMOTES.find(emote => emote.id === id)
}

export type TableInteraction =
  | { type: 'quick_chat'; phraseId: QuickChatId }
  | { type: 'emote'; emote: TableEmoteId; targetSeat: number }

export interface TableInteractionEvent {
  kind: 'table_interaction'
  scope: string
  id: number
  fromSeat: number
  action: TableInteraction
}

export interface TableInteractionRequest {
  kind: 'table_interaction_request'
  scope: string
  action: TableInteraction
}

export function isTableSeat(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < 4
}

export function readTableInteraction(value: unknown, fromSeat: number): TableInteraction | null {
  const action = value as { type?: unknown; phraseId?: unknown; emote?: unknown; targetSeat?: unknown } | null
  if (action?.type === 'quick_chat') {
    const phrase = quickChatPhrase(action.phraseId)
    return phrase ? { type: 'quick_chat', phraseId: phrase.id } : null
  }
  if (action?.type !== 'emote' || !isTableSeat(action.targetSeat) || action.targetSeat === fromSeat) return null
  const emote = tableEmote(action.emote)
  return emote ? { type: 'emote', emote: emote.id, targetSeat: action.targetSeat } : null
}

export function readTableInteractionEvent(value: unknown, scope: string | undefined): TableInteractionEvent | null {
  const event = value as Partial<TableInteractionEvent> | null
  if (!scope || event?.kind !== 'table_interaction' || event.scope !== scope || !isTableSeat(event.fromSeat)
    || typeof event.id !== 'number' || !Number.isSafeInteger(event.id) || event.id <= 0) return null
  const action = readTableInteraction(event.action, event.fromSeat)
  return action ? { kind: 'table_interaction', scope, id: event.id, fromSeat: event.fromSeat, action } : null
}

export function isTableInteractionPacket(value: unknown) {
  const kind = (value as { kind?: unknown } | null)?.kind
  return kind === 'table_interaction' || kind === 'table_interaction_request'
}

export function tableInteractionsActive(phase: string) {
  return !['lobby', 'revealing', 'win-effect', 'settled', 'finished'].includes(phase)
}

export function tableHandScope(matchId: string, round: number, honba: number) {
  return `${matchId}:${round}:${honba}`
}

/** UI 和房主共用冷却口径。联机只在当前权威回显时播放。 */
export function createTableInteractionLimiter(now = () => performance.now()) {
  const chat = new Map<number, { phraseId: QuickChatId; at: number }>()
  const emotes = new Map<number, number>()

  function allows(seat: number, action: TableInteraction, at: number) {
    if (action.type === 'emote') return at - (emotes.get(seat) ?? -Infinity) >= 350
    const last = chat.get(seat)
    return !last || at - last.at >= (action.phraseId === last.phraseId ? 5_000 : 700)
  }

  return {
    send(seat: number, action: TableInteraction, deliver: () => boolean) {
      const at = now()
      if (!isTableSeat(seat) || !allows(seat, action, at) || !deliver()) return false
      if (action.type === 'emote') emotes.set(seat, at)
      else chat.set(seat, { phraseId: action.phraseId, at })
      return true
    },
    clear() {
      chat.clear()
      emotes.clear()
    },
  }
}
