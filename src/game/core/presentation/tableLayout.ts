import { wallStackSlot } from '../rules/wallLayout'
export function addedKongTileOffset(playerIndex, inset = .72) {
  if (playerIndex === 0) return { x: 0, z: -inset }
  if (playerIndex === 1) return { x: -inset, z: 0 }
  if (playerIndex === 2) return { x: 0, z: inset }
  return { x: inset, z: 0 }
}

export function pointFromSeat(playerIndex, lateral, forward) {
  if (playerIndex === 1) return { x: forward, z: -lateral }
  if (playerIndex === 2) return { x: -lateral, z: -forward }
  if (playerIndex === 3) return { x: -forward, z: lateral }
  return { x: lateral, z: forward }
}

const SEAT_WINDS = ['东', '南', '西', '北'] as const

export function windForSeat(playerIndex: number, dealerIndex: number) {
  const offsetFromDealer = (playerIndex - dealerIndex + SEAT_WINDS.length) % SEAT_WINDS.length
  return SEAT_WINDS[offsetFromDealer]
}

// All positions are in the tile layer's coordinates (the renderer adds -1 to z).
// Local right/outward axes are shared by melds, hands and winning tiles.
export const TABLE_LAYOUT = Object.freeze({ tilePitch: .685, sourcePitch: .965,
  groupGap: .18, handGap: 1.24, meldRetreat: 1.1, pilePitch: .73, layerHeight: .46 })
export function seatTableLayout(seat: number) {
  const index = seat >= 0 && seat < 4 ? seat : 0
  const right = [ {x:1,z:0}, {x:0,z:-1}, {x:-1,z:0}, {x:0,z:1} ][index]
  const outward = [ {x:0,z:1}, {x:1,z:0}, {x:0,z:-1}, {x:-1,z:0} ][index]
  const rotation = [0, Math.PI/2, Math.PI, -Math.PI/2][index]
  const start = [{x:9,z:6.79},{x:8.9,z:-8.14},{x:-9,z:-8.29},{x:-8.9,z:6.1}][index]
  const meld = {x:start.x + outward.x*TABLE_LAYOUT.meldRetreat,
    z:start.z + outward.z*TABLE_LAYOUT.meldRetreat, rotation}
  // Reserve the entire row before any wins arrive; neither wall consumption nor count moves it.
  const near = wallStackSlot(0), far = wallStackSlot(34), side = wallStackSlot(51)
  const layerZ = -1
  const corner = [
    {x:near.x + 1.76,z:near.z - .03 - layerZ},
    {x:side.x - 1.08,z:far.z + .43 - layerZ},
    {x:far.x - .91,z:far.z + .03 - layerZ},
    {x:-side.x + .03,z:near.z - .18 - layerZ},
  ][index]
  return { right, outward, meld, win:{...corner,y:.31,rotation},
    pileAlong:right }
}
export function meldTrackTransform(seat:number, offset:number) {
  const {meld,right}=seatTableLayout(seat)
  return {...meld,x:meld.x-right.x*offset,z:meld.z-right.z*offset}
}
/** Start of the concealed row in its existing increasing world-axis ordering. */
export function concealedMeldClear(seat:number, span:number, count:number, pitch:number=TABLE_LAYOUT.tilePitch) {
  const {meld,right}=seatTableLayout(seat)
  const start=seat===2?meld.x:meld.z, direction=seat===2?-right.x:-right.z
  const halfHand=(count-1)*pitch/2, end=start+direction*span
  if (direction>0) return end+.68 >= -halfHand ? end+TABLE_LAYOUT.handGap : null
  return end-.68 <= halfHand ? end-TABLE_LAYOUT.handGap-2*halfHand : null
}


/** Keep the full reserved region and arbitrary tower heights in the public camera. */
export function winRegionFrame(top = .31) {
  const height = Math.max(0, top - 1.2)
  return { distance: 1.5 + height * .05, lookAtY: height * .1 }
}
export function meldTileSpan(source:boolean) {
  return source ? TABLE_LAYOUT.sourcePitch : TABLE_LAYOUT.tilePitch
}
export function meldTileCenter(offset:number, span:number) {
  return offset + (span - TABLE_LAYOUT.tilePitch) / 2
}
