import type { ServerMessage } from '../protocol/messages'
import { decodeServerMessage } from '../protocol/decoder'

export type ServerMessageKind = ServerMessage['kind']
export type ServerMessageOf<K extends ServerMessageKind> = Extract<ServerMessage, { kind: K }>
export type ServerMessageHandlers = {
  [K in ServerMessageKind]: (message: ServerMessageOf<K>) => void
}

export function createServerMessageRouter(handlers: ServerMessageHandlers) {
  return function routeServerMessage(raw: unknown): boolean {
    const message = decodeServerMessage(raw)
    if (!message || !Object.prototype.hasOwnProperty.call(handlers, message.kind)) return false
    const handler = handlers[message.kind] as (value: ServerMessage) => void
    handler(message)
    return true
  }
}
