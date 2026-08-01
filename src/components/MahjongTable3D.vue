<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { sortTiles, TILE_TYPES, tileFaceFile } from '../game/tiles'
import { meldSourceTileIndex } from '../game/rules'

const props = defineProps({
  players: { type: Array, default: () => [] },
  currentPlayer: { type: Number, default: -1 },
  lastDiscard: { type: Object, default: null },
  wallCount: { type: Number, default: 0 },
  revealHands: Boolean,
  dealAnimation: { type: Object, default: () => ({ playerIndex: -1, count: 0, serial: 0 }) },
  openingStage: { type: String, default: null },
  diceValues: { type: Array, default: () => [1, 1] },
})

const canvas = ref(null)
let renderer
let scene
let camera
let resizeObserver
let animationFrame
let destroyed = false
let dynamicGroups = []
let dealTweens = []
let diceGroup
let diceStartedAt = 0
const staticResources = []
const dynamicResources = []
const faceMaterials = new Map()
const PLAY_AREA_OFFSET_Z = -.5

function own(resource) {
  staticResources.push(resource)
  return resource
}

function ownDynamic(resource) {
  dynamicResources.push(resource)
  return resource
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = reject
    image.src = url
  })
}

function makeDiceTexture(value) {
  const surface = document.createElement('canvas')
  surface.width = 192
  surface.height = 192
  const ctx = surface.getContext('2d')
  const gradient = ctx.createLinearGradient(0, 0, 192, 192)
  gradient.addColorStop(0, '#fffef5')
  gradient.addColorStop(1, '#d9d9cd')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, 192, 192)
  const positions = {
    1: [[96, 96]],
    2: [[55, 55], [137, 137]],
    3: [[52, 52], [96, 96], [140, 140]],
    4: [[54, 54], [138, 54], [54, 138], [138, 138]],
    5: [[52, 52], [140, 52], [96, 96], [52, 140], [140, 140]],
    6: [[55, 45], [137, 45], [55, 96], [137, 96], [55, 147], [137, 147]],
  }
  ctx.fillStyle = value === 1 ? '#b42629' : '#17251f'
  positions[value].forEach(([x, y]) => {
    ctx.beginPath()
    ctx.arc(x, y, 17, 0, Math.PI * 2)
    ctx.fill()
  })
  const texture = own(new THREE.CanvasTexture(surface))
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

function addDice() {
  const materials = Array.from({ length: 6 }, (_, index) => own(new THREE.MeshStandardMaterial({
    map: makeDiceTexture(index + 1),
    roughness: .5,
    metalness: 0,
  })))
  // BoxGeometry 面顺序：右、左、上、下、前、后。
  const faceMaterials = [materials[1], materials[4], materials[0], materials[5], materials[2], materials[3]]
  const geometry = own(new RoundedBoxGeometry(1.02, 1.02, 1.02, 6, .16))
  diceGroup = new THREE.Group()
  for (let index = 0; index < 2; index += 1) {
    const die = new THREE.Mesh(geometry, faceMaterials)
    die.castShadow = true
    die.receiveShadow = true
    diceGroup.add(die)
  }
  diceGroup.visible = props.openingStage === 'dice'
  if (diceGroup.visible) diceStartedAt = performance.now()
  scene.add(diceGroup)
}

function settledDiceQuaternion(value) {
  const rotations = {
    1: [0, 0, 0],
    2: [0, 0, Math.PI / 2],
    3: [-Math.PI / 2, 0, 0],
    4: [Math.PI / 2, 0, 0],
    5: [0, 0, -Math.PI / 2],
    6: [Math.PI, 0, 0],
  }
  return new THREE.Quaternion().setFromEuler(new THREE.Euler(...rotations[value]))
}

function rollingDiceQuaternion(index, progress) {
  return new THREE.Quaternion().setFromEuler(new THREE.Euler(
    progress * Math.PI * (index === 0 ? 9 : 8),
    progress * Math.PI * (index === 0 ? 7 : -9),
    progress * Math.PI * (index === 0 ? -5 : 6),
  ))
}

function animateDice(time) {
  if (!diceGroup?.visible) return
  const progress = Math.min(1, Math.max(0, (time - diceStartedAt) / 1050))
  const travel = 1 - (1 - progress) ** 2
  diceGroup.children.forEach((die, index) => {
    const side = index === 0 ? -1 : 1
    die.position.x = side * (1.15 + .35 * travel)
    die.position.z = 5.2 - 4.1 * travel + side * .12
    const arc = Math.sin(Math.PI * Math.min(progress / .82, 1)) * 3.2
    const bounceProgress = Math.max(0, (progress - .82) / .18)
    const bounce = bounceProgress > 0 ? Math.abs(Math.sin(bounceProgress * Math.PI * 2)) * .3 * (1 - bounceProgress) : 0
    die.position.y = .55 + arc + bounce
    const settleStart = .72
    if (progress < settleStart) {
      die.quaternion.copy(rollingDiceQuaternion(index, progress))
    } else {
      const from = rollingDiceQuaternion(index, settleStart)
      const target = settledDiceQuaternion(props.diceValues[index] || 1)
      die.quaternion.copy(from).slerp(target, (progress - settleStart) / (1 - settleStart))
    }
  })
}

function makeBackTexture() {
  const surface = document.createElement('canvas')
  surface.width = 192
  surface.height = 256
  const ctx = surface.getContext('2d')
  const gradient = ctx.createRadialGradient(62, 42, 8, 96, 128, 170)
  gradient.addColorStop(0, '#66ca53')
  gradient.addColorStop(.48, '#2d9d37')
  gradient.addColorStop(1, '#126728')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, 192, 256)
  ctx.strokeStyle = 'rgba(224,244,210,.88)'
  ctx.lineWidth = 8
  ctx.roundRect(12, 12, 168, 232, 14)
  ctx.stroke()
  ctx.strokeStyle = 'rgba(8,76,29,.32)'
  ctx.lineWidth = 1.5
  for (let x = -260; x < 360; x += 18) {
    ctx.beginPath()
    ctx.moveTo(x, 256)
    ctx.lineTo(x + 256, 0)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x + 256, 256)
    ctx.stroke()
  }
  ctx.strokeStyle = 'rgba(210,244,193,.46)'
  ctx.lineWidth = 3
  ctx.roundRect(23, 23, 146, 210, 9)
  ctx.stroke()
  ctx.save()
  ctx.translate(96, 128)
  ctx.rotate(Math.PI / 4)
  ctx.strokeStyle = 'rgba(225,250,211,.34)'
  ctx.lineWidth = 5
  ctx.roundRect(-29, -29, 58, 58, 9)
  ctx.stroke()
  ctx.restore()
  const texture = own(new THREE.CanvasTexture(surface))
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), 8)
  return texture
}

function makeFaceMaterial(tile) {
  if (faceMaterials.has(tile)) return faceMaterials.get(tile)
  const image = scene.userData.tileImages.get(tile) || scene.userData.tileImages.get('white')
  const surface = document.createElement('canvas')
  surface.width = 150
  surface.height = 200
  const ctx = surface.getContext('2d')
  const faceGradient = ctx.createLinearGradient(0, 0, 150, 200)
  faceGradient.addColorStop(0, '#fffef7')
  faceGradient.addColorStop(.58, '#f3f2e8')
  faceGradient.addColorStop(1, '#e5e8dd')
  ctx.fillStyle = faceGradient
  ctx.fillRect(0, 0, surface.width, surface.height)
  if (image) ctx.drawImage(image, 8, 8, 134, 184)
  const texture = own(new THREE.CanvasTexture(surface))
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), 8)
  const material = own(new THREE.MeshStandardMaterial({
    map: texture,
    color: 0xd2d5cc,
    roughness: .66,
    metalness: 0,
  }))
  faceMaterials.set(tile, material)
  return material
}

function makeMachineTexture() {
  const surface = document.createElement('canvas')
  surface.width = 512
  surface.height = 512
  const texture = own(new THREE.CanvasTexture(surface))
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), 8)
  scene.userData.machineSurface = surface
  scene.userData.machineTexture = texture
  updateMachineTexture()
  return texture
}

function updateMachineTexture() {
  const surface = scene?.userData.machineSurface
  const texture = scene?.userData.machineTexture
  if (!surface || !texture) return
  const ctx = surface.getContext('2d')
  const gradient = ctx.createRadialGradient(256, 256, 30, 256, 256, 340)
  gradient.addColorStop(0, '#18201e')
  gradient.addColorStop(1, '#070908')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, 512, 512)
  ctx.strokeStyle = '#62573f'
  ctx.lineWidth = 8
  ctx.strokeRect(22, 22, 468, 468)
  ctx.strokeStyle = 'rgba(223,191,105,.26)'
  ctx.lineWidth = 3
  ctx.strokeRect(47, 47, 418, 418)

  const edge = Math.max(props.currentPlayer, 0)
  const edges = [
    [126, 470, 386, 470],
    [470, 126, 470, 386],
    [126, 42, 386, 42],
    [42, 126, 42, 386],
  ]
  const [x1, y1, x2, y2] = edges[edge]
  ctx.strokeStyle = '#f2c75f'
  ctx.shadowColor = '#e9b63d'
  ctx.shadowBlur = 18
  ctx.lineWidth = 15
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.moveTo(x1, y1)
  ctx.lineTo(x2, y2)
  ctx.stroke()
  ctx.shadowBlur = 0

  ctx.fillStyle = '#050706'
  ctx.fillRect(142, 142, 228, 228)
  ctx.strokeStyle = '#8a7345'
  ctx.lineWidth = 3
  ctx.strokeRect(142, 142, 228, 228)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = '#f1ce67'
  ctx.font = '700 120px Georgia, serif'
  ctx.fillText(String(props.wallCount), 256, 262)
  ctx.fillStyle = '#c8b47e'
  ctx.font = '800 50px "Microsoft YaHei", serif'
  ctx.fillText('西', 256, 86)
  ctx.fillText('南', 424, 256)
  ctx.fillText('东', 256, 426)
  ctx.fillText('北', 86, 256)
  texture.needsUpdate = true
}

function addStaticMesh(geometry, material, x, y, z) {
  own(geometry)
  const item = new THREE.Mesh(geometry, material)
  item.position.set(x, y, z)
  item.castShadow = true
  item.receiveShadow = true
  scene.add(item)
  return item
}

function addTable() {
  const felt = own(new THREE.MeshStandardMaterial({ color: 0x16563d, roughness: .94, metalness: 0 }))
  const dark = own(new THREE.MeshStandardMaterial({ color: 0x080a09, roughness: .7, metalness: .12 }))
  const bronze = own(new THREE.MeshStandardMaterial({ color: 0x5f4728, roughness: .68, metalness: .28 }))
  const machine = own(new THREE.MeshStandardMaterial({ color: 0x151817, roughness: .45, metalness: .3 }))
  scene.userData.tileSide = own(new THREE.MeshStandardMaterial({ color: 0xe9ede2, roughness: .5, metalness: 0 }))
  scene.userData.faceSide = own(new THREE.MeshStandardMaterial({ color: 0x45a937, roughness: .57, metalness: 0 }))
  scene.userData.tileBottom = own(new THREE.MeshStandardMaterial({ color: 0xcfd6c9, roughness: .64, metalness: 0 }))
  scene.userData.backMaterial = own(new THREE.MeshStandardMaterial({ map: makeBackTexture(), roughness: .58, metalness: 0 }))
  scene.userData.highlightMaterial = own(new THREE.MeshStandardMaterial({ color: 0xe3b948, emissive: 0x7d4d08, emissiveIntensity: .8, roughness: .4 }))

  // 近端保持不动，只向对家方向延伸桌面，给远端手牌和副露留出更多纵深。
  addStaticMesh(new THREE.BoxGeometry(21.8, .52, 17.3), dark, 0, -.36, -1.65)
  addStaticMesh(new THREE.BoxGeometry(21, .24, 16.6), felt, 0, -.05, -1.6)
  addStaticMesh(new THREE.BoxGeometry(21.8, .7, .48), bronze, 0, -.1, -10.2)
  addStaticMesh(new THREE.BoxGeometry(21.8, .7, .48), bronze, 0, -.1, 7)
  addStaticMesh(new THREE.BoxGeometry(.48, .7, 17.3), bronze, -10.65, -.1, -1.65)
  addStaticMesh(new THREE.BoxGeometry(.48, .7, 17.3), bronze, 10.65, -.1, -1.65)
  const machineTop = own(new THREE.MeshStandardMaterial({ map: makeMachineTexture(), roughness: .42, metalness: .12 }))
  const machineBottom = own(new THREE.MeshStandardMaterial({ color: 0x070908, roughness: .62, metalness: .18 }))
  const machineGeometry = own(new THREE.BoxGeometry(3.35, .28, 3.35, 2, 1, 2))
  const machineMesh = new THREE.Mesh(machineGeometry, [machine, machine, machineTop, machineBottom, machine, machine])
  machineMesh.position.set(0, .21, PLAY_AREA_OFFSET_Z)
  machineMesh.castShadow = true
  machineMesh.receiveShadow = true
  scene.add(machineMesh)
}

function clearDynamicScene() {
  dynamicGroups.forEach((group) => scene.remove(group))
  dynamicGroups = []
  dealTweens = []
  dynamicResources.splice(0).forEach((resource) => resource.dispose?.())
}

function makeHiddenTile() {
  const side = scene.userData.tileSide
  const back = scene.userData.backMaterial
  const geometry = ownDynamic(new RoundedBoxGeometry(.72, 1.12, .46, 4, .075))
  const tile = new THREE.Mesh(geometry, [side, side, side, side, back, back])
  tile.castShadow = true
  tile.receiveShadow = true
  return tile
}

function makeTableTile(topMaterial, highlighted = false) {
  const tile = new THREE.Group()
  const green = scene.userData.faceSide
  const white = scene.userData.tileSide
  const bottom = scene.userData.tileBottom
  const baseGeometry = ownDynamic(new RoundedBoxGeometry(.74, .34, 1.02, 4, .09))
  const base = new THREE.Mesh(baseGeometry, green)
  base.castShadow = true
  base.receiveShadow = true
  tile.add(base)

  const capGeometry = ownDynamic(new RoundedBoxGeometry(.69, .22, .95, 4, .065))
  const cap = new THREE.Mesh(capGeometry, [white, white, topMaterial, bottom, white, white])
  cap.position.y = .19
  cap.castShadow = true
  cap.receiveShadow = true
  tile.add(cap)
  if (highlighted) {
    const marker = new THREE.Mesh(
      ownDynamic(new RoundedBoxGeometry(.76, .045, 1.02, 2, .02)),
      scene.userData.highlightMaterial,
    )
    marker.position.y = -.205
    marker.receiveShadow = true
    tile.add(marker)
  }
  return tile
}

function makeFaceTile(tileName, highlighted = false) {
  return makeTableTile(makeFaceMaterial(tileName), highlighted)
}

function makeFaceDownTile() {
  return makeTableTile(scene.userData.backMaterial)
}

function addConcealedHand(group, playerIndex) {
  if (playerIndex === 0) return
  const position = ['bottom', 'right', 'top', 'left'][playerIndex]
  const total = Math.min(props.players[playerIndex]?.hand.length ?? 0, 14)
  const gap = .725
  const drawnTileIndex = props.players[playerIndex]?.drawnTileIndex ?? -1
  const layoutDrawnTileIndex = props.revealHands ? -1 : drawnTileIndex
  const drawnGap = .28
  const arrangedTotal = layoutDrawnTileIndex >= 0 ? total - 1 : total
  const melds = props.players[playerIndex]?.melds || []
  const revealedHand = props.revealHands ? sortTiles(props.players[playerIndex].hand) : []
  // 牌面按每位玩家自身视角从左到右排列；副露固定在右手边，因此邻近副露的是字牌。
  const reverseRevealedFaces = position === 'top' || position === 'right' || melds.length > 0
  const exposedTiles = melds.reduce((count, meld) => count + meld.tiles.length, 0)
  const exposedSpan = exposedTiles * gap + Math.max(0, melds.length - 1) * .18
  for (let index = 0; index < total; index += 1) {
    const faceIndex = reverseRevealedFaces ? total - 1 - index : index
    const tile = props.revealHands
      ? makeFaceTile(revealedHand[faceIndex])
      : makeHiddenTile()
    const tileY = props.revealHands ? .28 : .56
    if (position === 'top') {
      let x
      if (layoutDrawnTileIndex >= 0 && melds.length) {
        const slot = index === layoutDrawnTileIndex ? 0 : index + 1
        x = -9 + exposedSpan + .62 + slot * gap + (index === layoutDrawnTileIndex ? 0 : drawnGap)
      } else if (index === layoutDrawnTileIndex) {
        x = -(arrangedTotal - 1) / 2 * gap - gap - drawnGap
      } else {
        x = melds.length
          ? -9 + exposedSpan + .62 + index * gap
          : (index - (arrangedTotal - 1) / 2) * gap
      }
      // 对家固定使用远端后场，避免中后局牌河向后扩展时覆盖暗牌。
      tile.position.set(x, tileY, -7.75)
      if (props.revealHands) tile.rotation.y = Math.PI
    } else {
      tile.rotation.y = position === 'left' ? -Math.PI / 2 : Math.PI / 2
      const centeredZ = (index - (arrangedTotal - 1) / 2) * gap
      let z
      if (layoutDrawnTileIndex >= 0 && melds.length) {
        const slot = index === layoutDrawnTileIndex ? 0 : index + 1
        z = position === 'right'
          ? -6.1 + exposedSpan + .62 + slot * gap + (index === layoutDrawnTileIndex ? 0 : drawnGap)
          : 6.1 - exposedSpan - .62 - slot * gap - (index === layoutDrawnTileIndex ? 0 : drawnGap)
      } else if (index === layoutDrawnTileIndex) {
        z = position === 'right'
          ? -(arrangedTotal - 1) / 2 * gap - gap - drawnGap
          : (arrangedTotal - 1) / 2 * gap + gap + drawnGap
      } else {
        z = !melds.length
          ? centeredZ
          : position === 'right'
            ? -6.1 + exposedSpan + .62 + index * gap
            : 6.1 - exposedSpan - .62 - index * gap
      }
      tile.position.set(position === 'left' ? -9.15 : 9.15, tileY, z)
    }
    const animatedFromIndex = Math.max(0, total - (props.dealAnimation.count || 0))
    if (props.dealAnimation.playerIndex === playerIndex && index >= animatedFromIndex) {
      const target = tile.position.clone()
      tile.position.set(0, 3.4, .5)
      dealTweens.push({
        tile,
        origin: new THREE.Vector3(0, 3.4, .5),
        target,
        startedAt: performance.now(),
        duration: props.dealAnimation.count === 4 ? 230 : 125,
      })
    }
    group.add(tile)
  }
  if (props.currentPlayer === playerIndex) {
    const glow = new THREE.PointLight(0xf2c65d, 9, 4.5, 2)
    if (position === 'top') glow.position.set(0, 1.4, -7.2)
    else glow.position.set(position === 'left' ? -8.6 : 8.6, 1.4, 0)
    group.add(glow)
  }
}

function discardTransform(playerIndex, index) {
  // 本家前两行保持每行 6 张；从第 3 行开始每行 11 张，减少后续行被手牌遮挡。
  const isUserWideRow = playerIndex === 0 && index >= 12
  const columnCount = isUserWideRow ? 11 : 6
  const rowIndex = isUserWideRow ? index - 12 : index
  const column = rowIndex % columnCount
  const row = isUserWideRow ? 2 + Math.floor(rowIndex / columnCount) : Math.floor(rowIndex / columnCount)
  // 宽行沿用前两行的左侧起点，再向右扩展，避免每行中心线变化造成跳动。
  const lateral = (column - 2.5) * .72
  if (playerIndex === 0) return { x: lateral, z: 2.48 + row * 1.02, rotation: 0 }
  if (playerIndex === 1) return { x: 2.64 + row * 1.02, z: -lateral, rotation: Math.PI / 2 }
  if (playerIndex === 2) return { x: -lateral, z: -2.48 - row * 1.02, rotation: Math.PI }
  return { x: -2.64 - row * 1.02, z: lateral, rotation: -Math.PI / 2 }
}

function addDiscards(group, playerIndex) {
  const discards = props.players[playerIndex]?.discards || []
  discards.forEach((tileName, index) => {
    const highlighted = props.lastDiscard?.from === playerIndex && index === discards.length - 1
    const tile = makeFaceTile(tileName, highlighted)
    const transform = discardTransform(playerIndex, index)
    tile.position.x = transform.x
    tile.position.z = transform.z
    tile.position.y = highlighted ? .38 : .28
    tile.rotation.y = transform.rotation
    group.add(tile)
  })
}

function meldTransform(playerIndex, trackOffset) {
  // 和参考界面一致：每家只有一条副露带，从玩家右手端连续排向手牌。
  if (playerIndex === 0) return { x: 9 - trackOffset, z: 5.85, rotation: 0 }
  if (playerIndex === 1) return { x: 7.78, z: -6.1 + trackOffset, rotation: Math.PI / 2 }
  if (playerIndex === 2) return { x: -9 + trackOffset, z: -7.35, rotation: Math.PI }
  return { x: -7.78, z: 6.1 - trackOffset, rotation: -Math.PI / 2 }
}

function alignMeldBottom(transform, playerIndex, pointsToSource) {
  if (!pointsToSource) return transform
  // 牌面尺寸为 .72 x 1.02；横置后朝玩家方向缩短 .30，中心外移一半即可底边对齐。
  const edgeCompensation = .15
  if (playerIndex === 0) transform.z += edgeCompensation
  else if (playerIndex === 1) transform.x += edgeCompensation
  else if (playerIndex === 2) transform.z -= edgeCompensation
  else transform.x -= edgeCompensation
  return transform
}

function addMelds(group, playerIndex) {
  const melds = props.players[playerIndex]?.melds || []
  let trackOffset = 0
  melds.forEach((meld) => {
    const sourceTileIndex = meldSourceTileIndex(meld, playerIndex)
    meld.tiles.forEach((tileName, tileIndex) => {
      const concealed = meld.type === 'angang' && (tileIndex === 0 || tileIndex === meld.tiles.length - 1)
      const pointsToSource = tileIndex === sourceTileIndex
      const tile = concealed ? makeFaceDownTile() : makeFaceTile(tileName)
      const tileSpan = pointsToSource ? 1.025 : .725
      const centerOffset = trackOffset + (tileSpan - .725) / 2
      const transform = alignMeldBottom(
        meldTransform(playerIndex, centerOffset),
        playerIndex,
        pointsToSource,
      )
      tile.position.set(transform.x, .28, transform.z)
      tile.rotation.y = transform.rotation + (pointsToSource ? Math.PI / 2 : 0)
      group.add(tile)
      trackOffset += tileSpan
    })
    trackOffset += .18
  })
}

function rebuildTableTiles() {
  if (!scene || !props.players.length || !scene.userData.tileImages) return
  updateMachineTexture()
  clearDynamicScene()
  for (let playerIndex = 0; playerIndex < 4; playerIndex += 1) {
    const group = new THREE.Group()
    addConcealedHand(group, playerIndex)
    addDiscards(group, playerIndex)
    addMelds(group, playerIndex)
    group.position.z = PLAY_AREA_OFFSET_Z
    scene.add(group)
    dynamicGroups.push(group)
  }
}

function resize() {
  if (!renderer || !canvas.value) return
  const width = canvas.value.clientWidth
  const height = canvas.value.clientHeight
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setSize(width, height, false)
  camera.aspect = width / Math.max(height, 1)
  camera.updateProjectionMatrix()
}

function render(time = 0) {
  if (!renderer) return
  animateDice(time)
  dealTweens = dealTweens.filter((tween) => {
    const progress = Math.min(1, (time - tween.startedAt) / tween.duration)
    const eased = 1 - (1 - progress) ** 3
    tween.tile.position.lerpVectors(tween.origin, tween.target, eased)
    return progress < 1
  })
  camera.position.x = Math.sin(time * .00035) * .035
  camera.lookAt(0, 0, -.25)
  renderer.render(scene, camera)
  animationFrame = requestAnimationFrame(render)
}

onMounted(async () => {
  renderer = new THREE.WebGLRenderer({ canvas: canvas.value, antialias: true, alpha: true, powerPreference: 'high-performance' })
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFShadowMap
  renderer.setClearColor(0x050706, 0)

  scene = new THREE.Scene()
  scene.fog = new THREE.Fog(0x07100c, 20, 34)
  camera = new THREE.PerspectiveCamera(39, 1, .1, 60)
  camera.position.set(0, 15, 11.8)
  scene.add(new THREE.HemisphereLight(0xe9f4df, 0x06100b, 2.7))
  const keyLight = new THREE.DirectionalLight(0xffefc6, 5.2)
  keyLight.position.set(-7, 13, 9)
  keyLight.castShadow = true
  keyLight.shadow.mapSize.set(2048, 2048)
  keyLight.shadow.camera.left = -12
  keyLight.shadow.camera.right = 12
  keyLight.shadow.camera.top = 10
  keyLight.shadow.camera.bottom = -10
  scene.add(keyLight)
  const rimLight = new THREE.DirectionalLight(0x55c889, 2.2)
  rimLight.position.set(8, 5, -8)
  scene.add(rimLight)
  addDice()

  const tileImages = await Promise.all(TILE_TYPES.map(async (tile) => [
    tile,
    await loadImage(`${import.meta.env.BASE_URL}tiles/${tileFaceFile(tile)}`),
  ]))
  scene.userData.tileImages = new Map(tileImages)
  if (destroyed) return
  addTable()
  rebuildTableTiles()
  resizeObserver = new ResizeObserver(resize)
  resizeObserver.observe(canvas.value)
  resize()
  render()
})

watch(
  () => props.players.map((player) => [
    player.hand.length,
    player.drawnTileIndex,
    player.discards.join(','),
    player.melds.map((meld) => `${meld.type}:${meld.from ?? '-'}:${meld.tiles.join(',')}`).join('|'),
  ]).flat().concat(
    props.currentPlayer,
    props.lastDiscard?.id,
    props.wallCount,
    props.revealHands,
    props.dealAnimation.serial,
  ),
  rebuildTableTiles,
)

watch(() => props.openingStage, (stage) => {
  if (!diceGroup) return
  diceGroup.visible = stage === 'dice'
  if (diceGroup.visible) diceStartedAt = performance.now()
})

onBeforeUnmount(() => {
  destroyed = true
  cancelAnimationFrame(animationFrame)
  resizeObserver?.disconnect()
  if (scene) clearDynamicScene()
  staticResources.forEach((resource) => resource.dispose?.())
  renderer?.dispose()
  renderer = null
})
</script>

<template>
  <canvas ref="canvas" class="mahjong-scene" aria-hidden="true"></canvas>
</template>
