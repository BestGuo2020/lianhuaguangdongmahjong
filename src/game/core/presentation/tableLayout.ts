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
  groupGap: .18, handGap: 1.24, meldRetreat: 1.1, pilePitch: .685, layerHeight: .47 })
export function seatTableLayout(seat: number) {
  const index = seat >= 0 && seat < 4 ? seat : 0
  // 本家副露带回到近墙外侧横排（把近槽右端的角缝让给盖楼）；对家副露带沿远墙内侧横排；
  // 下家/上家保持原轨道方向。
  const right = [ {x:1,z:0}, {x:0,z:-1}, {x:-1,z:0}, {x:0,z:1} ][index]
  const outward = [ {x:0,z:1}, {x:1,z:0}, {x:0,z:-1}, {x:-1,z:0} ][index]
  const rotation = [0, Math.PI/2, Math.PI, -Math.PI/2][index]
  // 副露带锚点：本家贴右端横排；对家贴远墙外侧靠远缘（与上家/下家贴 ±10 桌缘同款）；下家贴远角（右上）；上家贴近角（左下）。
  const start = [{x:9,z:6.79},{x:8.9,z:-8.45},{x:-9,z:-9.57},{x:-9.24,z:7.3}][index]
  const meld = {x:start.x + outward.x*TABLE_LAYOUT.meldRetreat,
    z:start.z + outward.z*TABLE_LAYOUT.meldRetreat, rotation}
  // 四角胡牌位（本家右下、下家右上、对家左上、上家左下），与各自升牌槽为"左右关系"（同高度带、在槽的外侧）。
  // 盖楼方向（屏幕）：本家从左往右；下家从下往上（竖排贴右墙）；对家从右往左；上家从右往左（特殊，横排避开手牌列）。
  // 朝向：每条（三条=箭头）指向各自对面玩家——本家→对家(0)、下家→上家(π/2)、对家→本家(π)、上家→下家(-π/2)。
  const corner = [
    {x:6.7, z:5.25},
    {x:8.0, z:-7.5},
    {x:-8.0, z:-8.55},
    {x:-6.95, z:5.2},
  ][index]
  const pileRotation = [0, Math.PI/2, Math.PI, -Math.PI/2][index]
  const pileAlong = [{x:1,z:0},{x:0,z:-1},{x:-1,z:0},{x:-1,z:0}][index]
  return { right, outward, meld, win:{x:corner.x,z:corner.z + 1,y:.31,rotation:pileRotation},
    pileAlong }

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

/** 盖楼列距：上家牌长边沿墙（朝向对面），列距按牌长 + 0.005（与本家同层间隙一致），其余三家短边相接。 */
export function pilePitch(seat:number) {
  return seat === 3 ? .945 : TABLE_LAYOUT.pilePitch
}
/** 盖楼每层张数：上家固定 3 张/层（参考标注"一层横着放3个"），其余桌面 4 / 小屏 3。 */
export function pileColumnsPerLevel(seat:number, compact:boolean) {
  return seat === 3 ? 3 : compact ? 3 : 4
}

/** 前三行6张，后续每行10张；共用左端起点，向玩家右侧延伸成原来的L型。 */
export function discardTileLayout(seat:number,index:number) {
  const wide=index>=18, columns=wide?10:6, slot=wide?index-18:index
  const row=(wide?3:0)+Math.floor(slot/columns)
  const lateral=(slot%columns-2.5)*TABLE_LAYOUT.tilePitch
  const depth=(seat%2?2.64:2.48)+row*.95
  return {...pointFromSeat(seat,lateral,depth),rotation:[0,Math.PI/2,Math.PI,-Math.PI/2][seat]}
}

/** Keep revealed side hands clear of the reserved corner row as well as live walls. */
export function concealedSideX(seat: 1 | 3) {
  // 侧家手牌向桌面中心内移（9.05）：下家侧牌边 8.54 距其盖楼 8.51 留 0.03；上家侧与盖楼 z 带分开，无碰撞。
  const radius = 9.05
  return seat === 3 ? -radius : radius
}
