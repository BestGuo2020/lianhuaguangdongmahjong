import { createTableInteractionLimiter, isTableInteractionPacket, isTableSeat, readTableInteraction, readTableInteractionEvent,
  type TableInteraction, type TableInteractionEvent, type TableInteractionRequest } from '../../shared/tableInteractions'
import { sendChunked } from '../transport/vibeRoomTransport'

interface Options {
  getRoom: () => VibeHubSDK.Room | null | undefined
  getScope: () => string | undefined
  getSeat: () => number
  getPeerSeat: (peer: string) => number | undefined
  isHost: () => boolean
  acceptHost: (room: VibeHubSDK.Room, peer: string) => boolean
  onEvent?: (event: TableInteractionEvent) => void
}

/** Guest requests are directed to the host. Only its canonical echo is presented. */
export function createVibeTableInteractionChannel(options: Options) {
  const attached = new WeakSet<VibeHubSDK.Room>()
  const limiter = createTableInteractionLimiter()
  let scopeAtLastSend = ''
  let id = 0

  function transmit(room: VibeHubSDK.Room, packet: TableInteractionEvent | TableInteractionRequest, peer?: string) {
    try { return sendChunked(room, packet, peer) }
    catch { return false }
  }

  function publish(room: VibeHubSDK.Room, scope: string, seat: number, action: TableInteraction) {
    if (room.peerId !== room.hostId) return false
    if (scopeAtLastSend !== scope) {
      scopeAtLastSend = scope
      limiter.clear()
    }
    return limiter.send(seat, action, () => {
      const event: TableInteractionEvent = { kind: 'table_interaction', scope, id: ++id, fromSeat: seat, action }
      if (!transmit(room, event)) return false
      options.onEvent?.(event)
      return true
    })
  }

  function attach(room: VibeHubSDK.Room) {
    if (attached.has(room)) return
    attached.add(room)
    room.onMessage((raw, peer) => {
      if (!isTableInteractionPacket(raw) || options.getRoom() !== room) return
      const scope = options.getScope()
      if (!scope) return
      if (!options.isHost()) {
        const event = readTableInteractionEvent(raw, scope)
        if (event && options.acceptHost(room, peer)) options.onEvent?.(event)
        return
      }

      const packet = raw as Partial<TableInteractionRequest> | null
      if (packet?.kind !== 'table_interaction_request' || packet.scope !== scope) return
      const seat = options.getPeerSeat(peer)
      if (!isTableSeat(seat)) return
      const action = readTableInteraction(packet.action, seat)
      if (action) publish(room, scope, seat, action)
    })
  }

  function send(action: TableInteraction) {
    const room = options.getRoom()
    const scope = options.getScope()
    const seat = options.getSeat()
    if (!room || !scope || !isTableSeat(seat)) return false
    const valid = readTableInteraction(action, seat)
    if (!valid) return false
    if (options.isHost()) return publish(room, scope, seat, valid)
    return Boolean(room.hostId && transmit(room, { kind: 'table_interaction_request', scope, action: valid }, room.hostId))
  }

  return { attach, send }
}
