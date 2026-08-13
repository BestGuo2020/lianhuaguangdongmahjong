import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { isHorseForSeat, sortTilesWithJokers } from '../../../game/core/rules/tiles'
import { meldDisplayTiles, meldSourceTileIndex } from '../../../game/core/rules/rules'
import { addedKongTileOffset } from '../../../game/core/presentation/tableLayout'
import { wallBreakIndex, wallStackSlot, wallTilePlacement, WALL_TOTAL } from '../../../game/core/rules/wallLayout'
import { splitWinningTile } from '../../../game/core/presentation/winEffect'
import type { TableActionEvent, TileType } from '../../../game/core/contracts/types'
import type { TileInstanceRenderer } from './tileInstanceRenderer'
import type { ResolvedTableProps, TableTransform } from './tableRenderTypes'
import type { createStaticTableScene } from './staticTableScene'

type TableScene = Pick<ReturnType<typeof createStaticTableScene>,
  'makeDimmedHorseTile' | 'makeGoldGlow' | 'makeGoldVerticalGlow'>

interface InstanceTween {
  baseIndex: number
  capIndex: number
  capMesh: THREE.InstancedMesh
  quat: THREE.Quaternion
  startedAt: number
  duration: number
}

interface DealTween extends InstanceTween {
  origin: THREE.Vector3
  target: THREE.Vector3
}

interface MeldTween extends InstanceTween {
  baseX: number
  baseZ: number
  targetY: number
  extraY?: number
}

interface TableTilePresenterOptions {
  props: Readonly<ResolvedTableProps>
  scene: THREE.Scene
  dynamicGroups: THREE.Object3D[]
  ownDynamic<T>(resource: T): T
  clearDynamicScene(): void
  makeFaceTile(tile: TileType): THREE.Group
  tableScene: TableScene
  tileInstances: TileInstanceRenderer
  tileLayerZ: number
  playAreaOffsetZ: number
  tileGapOffset: number
  pointGapOffset: number
  meldHandGap: number
  meldUpMove: number
  wallDealOriginY: number
  addWinEffect(): void
  addWinningDisplayTile(): void
}

export function createTableTilePresenter(options: TableTilePresenterOptions) {
  const { props, scene, dynamicGroups, ownDynamic, clearDynamicScene, makeFaceTile, tableScene } = options
  const { tileInstances } = options
  const TILE_LAYER_Z = options.tileLayerZ
  const PLAY_AREA_OFFSET_Z = options.playAreaOffsetZ
  const TILE_GAP_OFFSET = options.tileGapOffset
  const POINT_GAP_OFFSET = options.pointGapOffset
  const MELD_HAND_GAP = options.meldHandGap
  const MELD_UP_MOVE = options.meldUpMove
  const WALL_DEAL_ORIGIN_Y = options.wallDealOriginY
  const dealTweens: DealTween[] = []
  const meldTweens: MeldTween[] = []
  const discardTweens: DealTween[] = []
  let animatedDiscardId = -1
  let animatedTableActionId = -1
  let pendingTableActionAnimation: TableActionEvent | null = null
  const beginTableInstances = tileInstances.begin
  const addTableTile = tileInstances.add
  const finishTableInstances = tileInstances.finish

function addConcealedHand(playerIndex) {
  if (playerIndex === 0) return
  const position = ['bottom', 'right', 'top', 'left'][playerIndex]
  const rawHand = props.players[playerIndex]?.hand ?? []
  const presentation = props.winPresentation?.winnerIndex === playerIndex
    ? props.winPresentation
    : null
  const displayedHand = splitWinningTile(rawHand, presentation).hand
  const concealedCount = props.players[playerIndex]?.concealedTileCount ?? displayedHand.length
  const total = Math.min(props.revealHands ? displayedHand.length : concealedCount, 14)
  const gap = TILE_GAP_OFFSET // 三家手牌间隙
  // 摸牌位：只要手牌比基准（13 - 3×非花副露数）多出一张，就把多出的那张视为「摸牌」并留间隙。
  // drawnTileIndex 有效时用它；否则取末张（本地/服务端都把摸的牌放在末尾）。
  const meldCount = (props.players[playerIndex]?.melds ?? []).filter((m) => m.type !== 'flower').length
  const baseHand = 13 - 3 * meldCount
  const rawDrawn = props.players[playerIndex]?.drawnTileIndex ?? -1
  const drawnTileIndex = rawDrawn >= 0 && rawDrawn < total
    ? rawDrawn
    : (displayedHand.length > baseHand ? displayedHand.length - 1 : -1)
  const layoutDrawnTileIndex = props.revealHands ? -1 : drawnTileIndex
  const drawnGap = .28
  const arrangedTotal = layoutDrawnTileIndex >= 0 ? total - 1 : total
  const melds = props.players[playerIndex]?.melds || []
  const revealedHand = props.revealHands ? sortTilesWithJokers(displayedHand, props.jokerTiles) : []
  // 牌面按每位玩家自身视角从左到右排列；副露固定在右手边，因此邻近副露的是字牌。
  const reverseRevealedFaces = position === 'top' || position === 'right' || melds.length > 0
  const exposedSpan = melds.reduce((span, meld, meldIndex) => {
    const laidTiles = meldDisplayTiles(meld)
    const sourceTileIndex = meldSourceTileIndex({ ...meld, tiles: laidTiles }, playerIndex)
    const meldSpan = laidTiles.reduce(
      (width, _, tileIndex) => width + (tileIndex === sourceTileIndex ? 1.025 : gap),
      0,
    )
    return span + meldSpan + (meldIndex > 0 ? .18 : 0)
  }, 0)
  const animatedFromIndex = Math.max(0, total - (props.dealAnimation.count || 0))
  const dealThisHand = props.dealAnimation.playerIndex === playerIndex
  // 副露带逼近手牌（半个牌宽内）→ 手牌让位到副露带外侧；否则手牌保持居中。
  // 对家/左右三家统一此规则（本家不在此函数内处理）。meldClear = 手牌 index 0 的让位起点。
  const tileHalf = .34
  let meldClear = null
  if (melds.length) {
    if (position === 'top') {
      const handNear = -(arrangedTotal - 1) / 2 * gap
      if (-9 + exposedSpan + tileHalf >= handNear - tileHalf) {
        meldClear = -9 + exposedSpan + MELD_HAND_GAP
      }
    } else if (position === 'right') {
      // 下家副露逼近时手牌让位：meldClear 以副露实际轨道（-6.1 - MELD_UP_MOVE）为基准，
      // 使手牌与副露间距 = MELD_HAND_GAP（与上家/对家一致），避免副露上移后让位过多留出大缝。
      const handNear = -(arrangedTotal - 1) / 2 * gap
      if (-6.1 - MELD_UP_MOVE + exposedSpan + tileHalf >= handNear - tileHalf) {
        meldClear = -6.1 - MELD_UP_MOVE + exposedSpan + MELD_HAND_GAP
      }
    } else if (position === 'left') {
      const handNear = (arrangedTotal - 1) / 2 * gap
      if (6.1 - exposedSpan - tileHalf <= handNear + tileHalf) {
        // 副露在左家手牌上端：手牌整体下移，index 0 起点 = 副露下缘下方 - 手牌跨度
        meldClear = 6.1 - exposedSpan - MELD_HAND_GAP - (arrangedTotal - 1) * gap
      }
    }
  }

  for (let index = 0; index < total; index += 1) {
    const faceIndex = reverseRevealedFaces ? total - 1 - index : index
    const face = props.revealHands ? revealedHand[faceIndex] : null
    const tileY = props.revealHands ? .28 : .56
    let x
    let z
    let rotationY
    if (position === 'top') {
      if (meldClear != null && layoutDrawnTileIndex >= 0) {
        const slot = index === layoutDrawnTileIndex ? 0 : index + 1
        x = meldClear + slot * gap + (index === layoutDrawnTileIndex ? 0 : drawnGap)
      } else if (meldClear != null) {
        x = meldClear + index * gap
      } else if (index === layoutDrawnTileIndex) {
        x = -(arrangedTotal - 1) / 2 * gap - gap - drawnGap
      } else {
        x = (index - (arrangedTotal - 1) / 2) * gap
      }
      // 对家固定使用远端后场，避免中后局牌河向后扩展时覆盖暗牌。
      // 对家手牌整体向后（远离本家）移一个牌深（0.94）。
      z = -8.69
      rotationY = props.revealHands ? Math.PI : 0
    } else {
      rotationY = props.revealHands
        ? (position === 'left' ? -Math.PI / 2 : Math.PI / 2)
        : (position === 'left' ? Math.PI / 2 : -Math.PI / 2)
      x = position === 'left' ? -9.15 : 9.15
      if (meldClear != null) {
        // 副露逼近手牌：手牌沿排布轴让位到副露带外侧，避开副露。
        // 下家（右）摸牌位在右侧（-z 顶端，与无副露时一致）；上家/其他摸牌位在手牌末尾。
        const isDrawn = index === layoutDrawnTileIndex
        z = position === 'right' && isDrawn
          ? meldClear - gap - drawnGap
          : meldClear + index * gap + (isDrawn ? drawnGap : 0)
      } else {
        const centeredZ = (index - (arrangedTotal - 1) / 2) * gap
        if (index === layoutDrawnTileIndex) {
          z = position === 'right'
            ? -(arrangedTotal - 1) / 2 * gap - gap - drawnGap
            : (arrangedTotal - 1) / 2 * gap + gap + drawnGap
        } else {
          z = centeredZ
        }
      }
    }
    const pos = new THREE.Vector3(x, tileY, z + TILE_LAYER_Z)
    // 暗手为背面朝玩家的立牌：makeHiddenTile 内部 body 绕 X 转 -90°，合批时折进实例矩阵。
    const quat = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rotationY, 0))
    if (!props.revealHands) quat.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0)))
    if (dealThisHand && index >= animatedFromIndex) {
      // 发牌从牌山 head 槽位（下一张要摸的牌所在处）飞出，而不是从中控台上方。
      const head = wallDrawHeadPos()
      const origin = new THREE.Vector3(head.x, WALL_DEAL_ORIGIN_Y, head.z)
      const inst = addTableTile(pos, quat, face, 1, origin)
      dealTweens.push({
        baseIndex: inst.baseIndex,
        capIndex: inst.capIndex,
        capMesh: inst.capMesh,
        origin,
        target: pos.clone(),
        quat,
        startedAt: performance.now(),
        duration: props.dealAnimation.count === 4 ? 230 : 125,
      })
    } else {
      addTableTile(pos, quat, face)
    }
  }
}


function discardTransform(playerIndex, index) {
  // 四家牌河统一：1-3 行每行 6 张，第 4 行起每行 10 张。
  // 宽行与窄行左对齐（共用 -2.5 起点），向右延伸，避免中心线跳动；
  // 因此宽行的前 6 张与前三行的 6 张位置完全一致，只向右多出 4 张。
  const wideStart = 18   // 前三行 6×3=18 张后进入 10 张/行
  const isWide = index >= wideStart
  const columnCount = isWide ? 10 : 6
  const rowIndex = isWide ? index - wideStart : index
  const column = rowIndex % columnCount
  const discardGap = 0.95   // 牌河行间隙
  const row = isWide ? 3 + Math.floor(rowIndex / columnCount) : Math.floor(rowIndex / columnCount)
  const lateral = (column - 2.5) * TILE_GAP_OFFSET
  if (playerIndex === 0) return { x: lateral, z: 2.48 + row * discardGap, rotation: 0 }
  if (playerIndex === 1) return { x: 2.64 + row * discardGap, z: -lateral, rotation: Math.PI / 2 }
  if (playerIndex === 2) return { x: -lateral, z: -2.48 - row * discardGap, rotation: Math.PI }
  return { x: -2.64 - row * discardGap, z: lateral, rotation: -Math.PI / 2 }
}

// 出牌动画的起点 = 各家手牌位置（牌从手牌方向飞向牌河）。
// 本家为底部 2D 手牌（屏幕底部 → 近桌沿），其余三家为各自立牌手牌中心。
function discardSourcePos(playerIndex) {
  if (playerIndex === 0) return new THREE.Vector3(0, .56, 8.5)
  if (playerIndex === 1) return new THREE.Vector3(9.15, .56, -2.15)
  if (playerIndex === 2) return new THREE.Vector3(0, .56, -9.69)
  return new THREE.Vector3(-9.15, .56, -1.0)
}

function addDiscards(playerIndex) {
  const discards = props.players[playerIndex]?.discards || []
  discards.forEach((tileName, index) => {
    const highlighted = props.lastDiscard?.from === playerIndex && index === discards.length - 1
    const transform = discardTransform(playerIndex, index)
    const y = highlighted ? .48 : .28
    // 牌河保持原位（不与手牌一起向本家偏移）
    const pos = new THREE.Vector3(transform.x, y, transform.z + PLAY_AREA_OFFSET_Z)
    const quat = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, transform.rotation, 0))
    // 最新一张弃牌：从手牌方向飞向牌河（带弧度 + 落地微弹），其余牌直接放置。
    const isNewDiscard = highlighted && props.lastDiscard?.id !== animatedDiscardId
    if (isNewDiscard) {
      animatedDiscardId = props.lastDiscard?.id
      const origin = discardSourcePos(playerIndex)
      const inst = addTableTile(pos, quat, tileName, 1, origin)
      discardTweens.push({
        baseIndex: inst.baseIndex,
        capIndex: inst.capIndex,
        capMesh: inst.capMesh,
        origin,
        target: pos.clone(),
        quat,
        startedAt: performance.now(),
        duration: 360,
      })
    } else {
      addTableTile(pos, quat, tileName)
    }
    if (highlighted) {
      // 最新一张弃牌的高亮垫片保持独立 mesh（仅 1 张，无需合批）。
      const marker = new THREE.Mesh(
        ownDynamic(new RoundedBoxGeometry(.76, .045, 1.02, 2, .02)),
        scene.userData.highlightMaterial,
      )
      marker.position.set(transform.x, y - .205, transform.z + PLAY_AREA_OFFSET_Z)
      marker.rotation.y = transform.rotation
      marker.receiveShadow = true
      scene.add(marker)
      dynamicGroups.push(marker)
    }
  })
}

function meldTransform(playerIndex: number, trackOffset: number): TableTransform {
  // 和参考界面一致：每家只有一条副露带，从玩家右手端连续排向手牌。
  // 本家副露整体下移一个牌深（0.94），与牌河拉开距离。
  // 下家（右）副露往右移、上家（左）副露往左移各一个牌宽（0.68），远离中间牌河/副露区。
  if (playerIndex === 0) return { x: 9 - trackOffset, z: 6.79, rotation: 0 }
  if (playerIndex === 1) return { x: 8.9, z: -6.1 - MELD_UP_MOVE + trackOffset, rotation: Math.PI / 2 }
  // 对家副露随手牌一起向后（远离本家）移一个牌深（0.94）。
  if (playerIndex === 2) return { x: -9 + trackOffset, z: -8.29, rotation: Math.PI }
  return { x: -8.9, z: 6.1 - trackOffset, rotation: -Math.PI / 2 }
}

function alignMeldBottom(transform: TableTransform, playerIndex: number, rotated: boolean): TableTransform {
  if (!rotated) return transform
  // 牌面尺寸为 .72 x 1.02；横置后朝玩家方向缩短 .135，中心外移一半即可底边对齐。
  const edgeCompensation = .135
  if (playerIndex === 0) transform.z += edgeCompensation
  else if (playerIndex === 1) transform.x += edgeCompensation
  else if (playerIndex === 2) transform.z -= edgeCompensation
  else transform.x -= edgeCompensation
  return transform
}

function sourceTileRotationOffset(relativeSource: number) {
  // 来源牌长轴指向「出牌方」（国标麻将约定）：
  // - 下家（1，右侧出牌）→ +90°：长轴指向右侧
  // - 上家（3，左侧出牌）→ -90°：长轴指向左侧
  // - 对家（2）→ +90°：对家方向与副露带垂直，横摆后长轴只能指相邻一侧、指不到对家；保留近似
  if (relativeSource === 1) return Math.PI / 2
  if (relativeSource === 3) return -Math.PI / 2
  return Math.PI / 2
}

function addMelds(playerIndex) {
  const melds = props.players[playerIndex]?.melds || []
  let trackOffset = 0
  melds.forEach((meld, meldIndex) => {
    const animatesThisMeld = pendingTableActionAnimation?.actorIndex === playerIndex
      && pendingTableActionAnimation?.meldIndex === meldIndex
    const laidTiles = meldDisplayTiles(meld)
    const sourceTileIndex = meldSourceTileIndex({ ...meld, tiles: laidTiles }, playerIndex)
    const relativeSource = ['peng', 'gang', 'chi'].includes(meld.type) && Number.isInteger(meld.from)
      ? (meld.from - playerIndex + 4) % 4
      : -1
    let sourcePlacement = null
    laidTiles.forEach((tileName, tileIndex) => {
      const concealed = meld.type === 'angang' && (tileIndex === 0 || tileIndex === laidTiles.length - 1)
      const pointsToSource = tileIndex === sourceTileIndex
      const face = concealed ? null : tileName
      const tileSpan = pointsToSource ? POINT_GAP_OFFSET : TILE_GAP_OFFSET
      const centerOffset = trackOffset + (tileSpan - .725) / 2
      const sourceRot = pointsToSource ? sourceTileRotationOffset(relativeSource) : 0
      const transform = alignMeldBottom(
        meldTransform(playerIndex, centerOffset),
        playerIndex,
        sourceRot !== 0,  // 仅横摆的来源牌需要底边对齐补偿
      )
      // 来源牌相对副露带基准旋转（长轴指向出牌方），其余牌保持副露带基准方向
      const rotationY = transform.rotation + sourceRot
      // 暗杠首尾两张背朝上：makeFaceDownTile 内部 body 绕 X 转 180° 并上抬 .13，合批时折进矩阵。
      const bodyOffsetY = concealed ? .13 : 0
      const quat = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rotationY, 0))
      if (concealed) quat.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI, 0, 0)))
      const pos = new THREE.Vector3(transform.x, .28 + bodyOffsetY, transform.z + TILE_LAYER_Z)
      if (pointsToSource) {
        sourcePlacement = {
          x: transform.x,
          z: transform.z,
          rotation: rotationY,
        }
      }
      if (animatesThisMeld && pendingTableActionAnimation.type !== 'added-gang') {
        const inst = addTableTile(pos, quat, face, 1, new THREE.Vector3(pos.x, pos.y + .72, pos.z), .78)
        meldTweens.push({
          baseIndex: inst.baseIndex,
          capIndex: inst.capIndex,
          capMesh: inst.capMesh,
          baseX: pos.x,
          baseZ: pos.z,
          targetY: .28,
          extraY: bodyOffsetY,
          quat,
          startedAt: performance.now(),
          duration: 430,
        })
      } else {
        addTableTile(pos, quat, face)
      }
      trackOffset += tileSpan
    })
    if (meld.added && sourcePlacement) {
      // 补杠牌与原横牌同样横摆，平放在它靠牌桌中心的一侧，形成 T/L 形。
      const addedOffset = addedKongTileOffset(playerIndex, TILE_GAP_OFFSET)
      const pos = new THREE.Vector3(
        sourcePlacement.x + addedOffset.x,
        .28,
        sourcePlacement.z + addedOffset.z + TILE_LAYER_Z,
      )
      const quat = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, sourcePlacement.rotation, 0))
      if (animatesThisMeld && pendingTableActionAnimation.type === 'added-gang') {
        const inst = addTableTile(pos, quat, meld.tile, 1, new THREE.Vector3(pos.x, pos.y + .72, pos.z), .78)
        meldTweens.push({
          baseIndex: inst.baseIndex,
          capIndex: inst.capIndex,
          capMesh: inst.capMesh,
          baseX: pos.x,
          baseZ: pos.z,
          targetY: pos.y,
          quat,
          startedAt: performance.now(),
          duration: 430,
        })
      } else {
        addTableTile(pos, quat, meld.tile)
      }
    }
    trackOffset += .18
  })
}

// 牌山断点：莲花麻将由开局翻精计算（翻精墩移出、两次骰子定开门），
// 现行玩法仍按骰子规则计算。
function resolveBreakIndex() {
  return props.wallBreakIndex ?? wallBreakIndex(props.diceValues)
}

// 牌山 head 位置 = 下一张要摸的牌所在处：wall[0] 经 wallHeadDrawn 沿环顺时针推进。
function wallDrawHeadPos() {
  const headOffset = props.wallHeadDrawn ?? 0
  const breakIndex = resolveBreakIndex()
  if (props.flipStack != null) {
    const physical = wallPhysicalIndex(headOffset, breakIndex)
    const slot = wallStackSlot(Math.floor(physical / 2))
    return { x: slot.x, z: slot.z }
  }
  const { stackIndex } = wallTilePlacement(0, (breakIndex + headOffset) % WALL_TOTAL, props.wall?.length ?? 0, headOffset)
  const slot = wallStackSlot(stackIndex)
  return { x: slot.x, z: slot.z }
}

/**
 * 莲花麻将牌山张位映射：从 head 沿环推进 index 张，跳过翻精墩的 2 个物理张位，
 * 使翻精墩在环上留出空位（供指示牌翻出）。
 */
function wallPhysicalIndex(index: number, head: number): number {
  const flip = props.flipStack
  if (flip == null) return (head + index) % WALL_TOTAL
  const skipA = flip * 2
  let physical = head
  while (physical === skipA || physical === skipA + 1) {
    physical = (physical + 1) % WALL_TOTAL
  }
  for (let step = 0; step < index; step += 1) {
    do { physical = (physical + 1) % WALL_TOTAL } while (physical === skipA || physical === skipA + 1)
  }
  return physical
}

/** 精指示牌：翻出牌面朝上，与牌墙顶层对齐（y=0.88）。
 * 翻精墩底层牌仍保留显示（视觉上牌山完整）；翻精阶段（openingStage==='flip'）指示牌从墙内升起。 */
function addFlipIndicator() {
  const tile = props.flipTile
  if (!tile || props.flipStack == null) return
  const slot = wallStackSlot(props.flipStack)
  // 翻精墩底层牌保留在牌山上（背朝上，与周围牌墙一致），避免翻出后少一张
  const baseQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, slot.rotationY, 0))
  baseQuat.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI, 0, 0)))
  addTableTile(new THREE.Vector3(slot.x, .41, slot.z), baseQuat, null)
  // 指示牌翻出：牌面朝上，对齐牌墙顶层（y=0.88）
  const quat = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, slot.rotationY, 0))
  const pos = new THREE.Vector3(slot.x, .88, slot.z)
  if (props.openingStage === 'flip') {
    // 从墙内（底层之下）升起，模拟「翻出来」
    const origin = new THREE.Vector3(slot.x, .1, slot.z)
    const inst = addTableTile(pos, quat, tile, 1, origin)
    dealTweens.push({
      baseIndex: inst.baseIndex,
      capIndex: inst.capIndex,
      capMesh: inst.capMesh,
      origin,
      target: pos.clone(),
      quat,
      startedAt: performance.now(),
      duration: 520,
    })
  } else {
    addTableTile(pos, quat, tile)
  }
}

// 四边环状牌山（参考欢乐麻将）：wall[i] → 物理槽 (breakIndex + headOffset + i) % 136。
// 每墩 2 张上下叠，牌径向放置（长边指向桌中心），X-180° 翻转让绿色牌背朝上。
// headOffset = wallHeadDrawn（从牌头累计摸走的张数），使 head 顺时针推进（抓牌顺时针）；
// 开杠/红中从牌尾补张（pop）不计入，因此牌尾端会正确地随之缩短。
// 莲花麻将：翻精墩整体移出牌墙，牌墙张位跳过翻精墩，并在该墩翻出指示牌。
function addWall() {
  const tiles = props.wall || []
  if (!tiles.length) return
  const breakIndex = resolveBreakIndex()
  const headOffset = props.wallHeadDrawn ?? 0
  const hasFlip = props.flipStack != null
  tiles.forEach((_, index) => {
    const { stackIndex, layer } = hasFlip
      ? (() => {
        const tailDrawn = Math.max(0, WALL_TOTAL - 2 - headOffset - tiles.length)
        // 补走一张顶层牌后，同墩剩余的底层牌仍应留在原物理张位。
        const physicalIndex = tailDrawn % 2 === 1 && index === tiles.length - 1 ? index + 1 : index
        const physical = wallPhysicalIndex(headOffset + physicalIndex, breakIndex)
        return {
          stackIndex: Math.floor(physical / 2),
          layer: 1 - (physical % 2),
        }
      })()
      : wallTilePlacement(index, (breakIndex + headOffset) % WALL_TOTAL, tiles.length, headOffset)
    const slot = wallStackSlot(stackIndex)
    const y = .41 + layer * .47
    const quat = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, slot.rotationY, 0))
    // 背朝上：绕 X 转 180°，使 base 底面的牌背（backMaterial）朝上（与暗杠首尾一致）。
    quat.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI, 0, 0)))
    addTableTile(new THREE.Vector3(slot.x, y, slot.z), quat, null)
  })
  addFlipIndicator()
}

// 买马：胡牌后把 8 张马牌显示到赢家牌河里（续接在赢家弃牌河之后）。
// 中马按胡牌者相对庄家的座位判定；中马牌正常牌面 + 四周金光（金色发光边框），未中则整牌 75% 透明。
function addHorses() {
  const horses = props.horses || []
  if (!horses.length) return
  const winnerIndex = props.winnerIndex
  if (winnerIndex < 0) return
  const relativeSeat = (((winnerIndex - props.dealerIndex) + 4) % 4) as 0 | 1 | 2 | 3
  const discardCount = props.players[winnerIndex]?.discards.length ?? 0
  horses.forEach((tile, index) => {
    const hit = isHorseForSeat(tile, relativeSeat)
    const transform = discardTransform(winnerIndex, discardCount + index)
    const pos = new THREE.Vector3(transform.x, .28, transform.z + PLAY_AREA_OFFSET_Z)
    const tileObj = hit ? makeFaceTile(tile) : tableScene.makeDimmedHorseTile(tile)
    tileObj.position.copy(pos)
    tileObj.rotation.y = transform.rotation
    scene.add(tileObj)
    dynamicGroups.push(tileObj)
    if (hit) {
      // 中马：四周金光（金色柔光晕铺在牌下方，光从牌底溢出）+ 一点向上的竖光。
      const glow = tableScene.makeGoldGlow()
      glow.position.set(transform.x, .09, transform.z + PLAY_AREA_OFFSET_Z)
      scene.add(glow)
      dynamicGroups.push(glow)
      const vGlow = tableScene.makeGoldVerticalGlow()
      // Sprite 中心：让光柱底部（亮端）落在牌顶附近
      vGlow.position.set(transform.x, .55 + .75, transform.z + PLAY_AREA_OFFSET_Z)
      scene.add(vGlow)
      dynamicGroups.push(vGlow)
    }
  })
}

function rebuildTableTiles({ reuseInstances = false }: { reuseInstances?: boolean } = {}) {
  if (!scene || !props.players.length || !scene.userData.tileImages) return
  const reuse = reuseInstances && tileInstances.canReuse()
  if (!reuse) clearDynamicScene()
  dealTweens.length = 0
  meldTweens.length = 0
  discardTweens.length = 0
  pendingTableActionAnimation = props.tableActionEvent?.id !== animatedTableActionId
    ? props.tableActionEvent
    : null
  beginTableInstances(reuse)
  for (let playerIndex = 0; playerIndex < 4; playerIndex += 1) {
    addConcealedHand(playerIndex)
    addDiscards(playerIndex)
    addMelds(playerIndex)
  }
  addWall()
  addHorses()
  finishTableInstances()
  if (pendingTableActionAnimation) animatedTableActionId = pendingTableActionAnimation.id
  pendingTableActionAnimation = null
  options.addWinEffect()
  options.addWinningDisplayTile()
}

  function animate(time: number, scratchVector: THREE.Vector3) {
    const keepDeal = dealTweens.filter((tween) => {
      const progress = Math.min(1, (time - tween.startedAt) / tween.duration)
      const eased = 1 - (1 - progress) ** 3
      scratchVector.lerpVectors(tween.origin, tween.target, eased)
      tileInstances.set(tween.baseIndex, tween.capMesh, tween.capIndex, scratchVector, tween.quat, 1)
      return progress < 1
    })
    dealTweens.splice(0, dealTweens.length, ...keepDeal)
    const keepMeld = meldTweens.filter((tween) => {
      const progress = Math.min(1, Math.max(0, (time - tween.startedAt) / tween.duration))
      const settled = 1 - (1 - progress) ** 3
      const bounce = Math.sin(progress * Math.PI) * (1 - progress) * .16
      const y = THREE.MathUtils.lerp(tween.targetY + .72, tween.targetY, settled) + bounce + (tween.extraY ?? 0)
      scratchVector.set(tween.baseX, y, tween.baseZ)
      tileInstances.set(tween.baseIndex, tween.capMesh, tween.capIndex, scratchVector, tween.quat, THREE.MathUtils.lerp(.78, 1, settled))
      return progress < 1
    })
    meldTweens.splice(0, meldTweens.length, ...keepMeld)
    const keepDiscard = discardTweens.filter((tween) => {
      const progress = Math.min(1, Math.max(0, (time - tween.startedAt) / tween.duration))
      const eased = 1 - (1 - progress) ** 3
      const arc = Math.sin(progress * Math.PI) * .32
      const bounce = Math.sin(progress * Math.PI) * (1 - progress) * .1
      scratchVector.lerpVectors(tween.origin, tween.target, eased)
      scratchVector.y = THREE.MathUtils.lerp(tween.origin.y, tween.target.y, eased) + arc + bounce
      tileInstances.set(tween.baseIndex, tween.capMesh, tween.capIndex, scratchVector, tween.quat, 1)
      return progress < 1
    })
    discardTweens.splice(0, discardTweens.length, ...keepDiscard)
  }

  return { rebuild: rebuildTableTiles, animate, meldTransform, alignMeldBottom, sourceTileRotationOffset }
}
