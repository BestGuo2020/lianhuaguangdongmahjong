import { tableLiftSlots } from './tableLiftSlots'
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
  // Start from the approved straight corner rows. Reserve the full desktop row,
  // including when only one tile is present, outside the mechanical openings.
  const slots = tableLiftSlots()
  const near = slots.find(slot => slot.side === 'near')!
  const far = slots.find(slot => slot.side === 'far')!
  const left = slots.find(slot => slot.side === 'left')!
  const sideEndNear = left.centerZ + left.length / 2
  const sideEndFar = left.centerZ - left.length / 2
  const corner = [
    {x:near.length / 2 + .47, z:sideEndNear + .7},
    {x:far.length / 2 + 1.55, z:sideEndFar - .5},
    {x:-far.length / 2 - .47, z:sideEndFar - .7},
    {x:left.centerX - left.width / 2 - .606, z:near.centerZ - .18 - 3 * TABLE_LAYOUT.pilePitch},
  ][index]
  return { right, outward, meld, win:{...corner,z:corner.z + 1,y:.31,rotation},
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


export function meldTileSpan(source:boolean) {
  return source ? TABLE_LAYOUT.sourcePitch : TABLE_LAYOUT.tilePitch
}
export function meldTileCenter(offset:number, span:number) {
  return offset + (span - TABLE_LAYOUT.tilePitch) / 2
}

/** Later ten-tile rows remain centred, reserving the four winning corners. */
export function discardTileLayout(seat:number,index:number) {
  const wide=index>=18, columns=wide?10:6, slot=wide?index-18:index
  const row=(wide?3:0)+Math.floor(slot/columns)
  const lateral=(slot%columns-(columns-1)/2)*TABLE_LAYOUT.tilePitch
  const depth=(seat%2?2.64:2.48)+row*.95
  return {...pointFromSeat(seat,lateral,depth),rotation:[0,Math.PI/2,Math.PI,-Math.PI/2][seat]}
}

/** Keep revealed side hands clear of the reserved corner row as well as live walls. */
export function concealedSideX(seat: 1 | 3) {
  const radius = Math.max(9.15, Math.abs(seatTableLayout(seat).win.x) + 1.02 + .12)
  return seat === 3 ? -radius : radius
}
