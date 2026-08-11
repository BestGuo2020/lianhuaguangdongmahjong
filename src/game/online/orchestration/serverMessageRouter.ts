import type { ServerMessage } from '../protocol/messages'

export type ServerMessageKind = ServerMessage['kind']
export type ServerMessageOf<K extends ServerMessageKind> = Extract<ServerMessage, { kind: K }>
export type ServerMessageHandlers = {
  [K in ServerMessageKind]: (message: ServerMessageOf<K>) => void
}

function hasMessageKind(value: unknown): value is { kind: string } {
  return typeof value === 'object'
    && value !== null
    && typeof (value as { kind?: unknown }).kind === 'string'
}

export function createServerMessageRouter(handlers: ServerMessageHandlers) {
  return function routeServerMessage(raw: unknown): boolean {
    if (!hasMessageKind(raw) || !Object.prototype.hasOwnProperty.call(handlers, raw.kind)) return false
    const message = raw as ServerMessage
    const handler = handlers[message.kind] as (value: ServerMessage) => void
    handler(message)
    return true
  }
}
