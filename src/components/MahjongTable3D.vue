<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as THREE from 'three'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { sortTiles, TILE_TYPES, tileFaceFile } from '../game/core/tiles'
import { meldSourceTileIndex } from '../game/core/rules'
import { addedKongTileOffset, pointFromSeat, windForSeat } from '../game/core/tableLayout'
import { splitWinningTile, WIN_EFFECT_DURATION, winDisplayLayout } from '../game/core/winEffect'
import type { GamePlayer, TableActionEvent, TileType, WinPresentation } from '../game/core/types'

interface TableProps {
  players?: GamePlayer[]
  currentPlayer?: number
  lastDiscard?: { tile: TileType; from: number; id: number } | null
  wallCount?: number
  revealHands?: boolean
  winnerIndex?: number
  winEffect?: Record<string, any> | null
  winPresentation?: WinPresentation | null
  dealAnimation?: { playerIndex: number; count: number; serial: number }
  openingStage?: string | null
  diceValues?: number[]
  dealerIndex?: number
  tableActionEvent?: TableActionEvent | null
}

const props = withDefaults(defineProps<TableProps>(), {
  players: () => [], currentPlayer: -1, lastDiscard: null, wallCount: 0,
  revealHands: false, winnerIndex: -1, winEffect: null, winPresentation: null,
  dealAnimation: () => ({ playerIndex: -1, count: 0, serial: 0 }),
  openingStage: null, diceValues: () => [1, 1], dealerIndex: 0,
  tableActionEvent: null,
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
let meldTweens = []
let animatedTableActionId = -1
let pendingTableActionAnimation = null
let winEffectAnimation = null
let diceGroup
let diceStartedAt = 0
const staticResources = []
const dynamicResources = []
const faceMaterials = new Map()
const PLAY_AREA_OFFSET_Z = -.5
const DICE_SIZE = .5
const DICE_LANDING_Y = .62
const BASE_EXPOSURE = .92
const TILE_GAP_OFFSET = .685    // 手牌间隙和加杠偏移量
const POINT_GAP_OFFSET = 0.965  // 副露指向的偏移量

// 渲染分辨率上限（清晰度 vs 帧率）：默认 3 取设备原生 DPR，真机实测本设备 2.2 vs 2.0 帧率无差，原生清晰免费。
// URL 带 ?pr=<数字> 可覆盖。
const DEFAULT_PIXEL_RATIO_CAP = 3
let pixelRatioCap = parseFloat(new URLSearchParams(window.location.search).get('pr') ?? '') || DEFAULT_PIXEL_RATIO_CAP

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
  const geometry = own(new RoundedBoxGeometry(DICE_SIZE, DICE_SIZE, DICE_SIZE, 6, .08))
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
    const throwPoint = pointFromSeat(
      props.dealerIndex,
      side * (.58 + .22 * travel),
      THREE.MathUtils.lerp(5.2, .2, travel) + side * .1,
    )
    die.position.x = throwPoint.x
    die.position.z = throwPoint.z
    const arc = Math.sin(Math.PI * Math.min(progress / .82, 1)) * 2.6
    const bounceProgress = Math.max(0, (progress - .82) / .18)
    const bounce = bounceProgress > 0 ? Math.abs(Math.sin(bounceProgress * Math.PI * 2)) * .14 * (1 - bounceProgress) : 0
    die.position.y = DICE_LANDING_Y + arc + bounce
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
  surface.width = 256
  surface.height = 352
  const ctx = surface.getContext('2d')
  const gradient = ctx.createLinearGradient(22, 8, 232, 344)
  gradient.addColorStop(0, '#3eb34a')
  gradient.addColorStop(.46, '#26983a')
  gradient.addColorStop(1, '#176d2b')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, surface.width, surface.height)
  const highlight = ctx.createRadialGradient(42, 35, 4, 54, 52, 86)
  highlight.addColorStop(0, 'rgba(255,255,244,.24)')
  highlight.addColorStop(.3, 'rgba(255,255,244,.08)')
  highlight.addColorStop(1, 'rgba(255,255,244,0)')
  ctx.fillStyle = highlight
  ctx.fillRect(0, 0, surface.width, surface.height)
  const texture = own(new THREE.CanvasTexture(surface))
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), 8)
  return texture
}

// 在 ctx 上以 (x,y,w,h) 画一张牌的牌面：浅色底 + 牌面图 + 投影，单张纹理与图集共用。
function drawTileFace(ctx, tile, x, y, w, h) {
  const image = scene.userData.tileImages.get(tile) || scene.userData.tileImages.get('white')
  const faceGradient = ctx.createLinearGradient(x, y, x + w, y + h)
  faceGradient.addColorStop(0, '#e9e8df')
  faceGradient.addColorStop(.58, '#dad9d0')
  faceGradient.addColorStop(1, '#c9ccc2')
  ctx.fillStyle = faceGradient
  ctx.fillRect(x, y, w, h)
  if (image) {
    ctx.save()
    ctx.shadowColor = 'rgba(40,30,18,.24)'
    ctx.shadowBlur = 2.4
    ctx.shadowOffsetX = .7
    ctx.shadowOffsetY = 1.2
    const insetX = w * 20 / 384
    const insetY = h * 20 / 512
    ctx.drawImage(image, x + insetX, y + insetY, w - insetX * 2, h - insetY * 2)
    ctx.restore()
  }
}

function makeFaceMaterial(tile) {
  if (faceMaterials.has(tile)) return faceMaterials.get(tile)
  const surface = document.createElement('canvas')
  surface.width = 384
  surface.height = 512
  drawTileFace(surface.getContext('2d'), tile, 0, 0, 384, 512)
  const texture = own(new THREE.CanvasTexture(surface))
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), 8)
  const material = trackTileMaterial(own(new THREE.MeshPhysicalMaterial({
    map: texture,
    envMap: scene.userData.tileEnvironment,
    color: 0xd8d7ce,
    roughness: .4,
    metalness: 0,
    clearcoat: .56,
    clearcoatRoughness: .24,
    ior: 1.46,
    specularIntensity: .36,
    specularColor: new THREE.Color(0xfffdf4),
    envMapIntensity: .3,
  })))
  if (!glossyMaterials) {
    material.clearcoat = 0
    material.clearcoatRoughness = 0
    material.specularIntensity = 0
    material.ior = 1.5
  }
  faceMaterials.set(tile, material)
  return material
}

// ---- 牌面纹理图集：全部牌面压进一张图，cap 合批从"每类型一个"压成 1 个 ----
const ATLAS_COLS = 6
const ATLAS_ROWS = 6
const ATLAS_CELL_W = 96
const ATLAS_CELL_H = 128
const ATLAS_CELL_U = 1 / ATLAS_COLS
const ATLAS_CELL_V = 1 / ATLAS_ROWS
let atlasMaterial: THREE.MeshPhysicalMaterial | null = null
let atlasUvData: Float32Array | null = null
// 图集 cap 用克隆几何体，aUvOffset 只挂在克隆上，绝不动共享的 tileCapGeometry（避免污染 back cap）。
let atlasCapGeometry: THREE.BufferGeometry | null = null
function getAtlasCapGeometry() {
  if (!atlasCapGeometry) atlasCapGeometry = own(scene.userData.tileCapGeometry.clone())
  return atlasCapGeometry
}

// 返回某牌在 6×6 图集中的左下角 UV（canvas 顶行为 row 0，对应 UV 高值）。
function atlasCellUvFor(tile) {
  const i = Math.max(0, TILE_TYPES.indexOf(tile))
  const col = i % ATLAS_COLS
  const row = Math.floor(i / ATLAS_COLS)
  return { u: col * ATLAS_CELL_U, v: 1 - (row + 1) * ATLAS_CELL_V }
}

function getAtlasMaterial() {
  if (atlasMaterial) return atlasMaterial
  const canvas = document.createElement('canvas')
  canvas.width = ATLAS_COLS * ATLAS_CELL_W
  canvas.height = ATLAS_ROWS * ATLAS_CELL_H
  const ctx = canvas.getContext('2d')
  TILE_TYPES.forEach((tile, i) => {
    const col = i % ATLAS_COLS
    const row = Math.floor(i / ATLAS_COLS)
    drawTileFace(ctx, tile, col * ATLAS_CELL_W, row * ATLAS_CELL_H, ATLAS_CELL_W, ATLAS_CELL_H)
  })
  const texture = own(new THREE.CanvasTexture(canvas))
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), 4)
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping
  const mat = trackTileMaterial(own(new THREE.MeshPhysicalMaterial({
    map: texture,
    envMap: scene.userData.tileEnvironment,
    color: 0xd8d7ce,
    roughness: .4,
    metalness: 0,
    clearcoat: .56,
    clearcoatRoughness: .24,
    ior: 1.46,
    specularIntensity: .36,
    specularColor: new THREE.Color(0xfffdf4),
    envMapIntensity: .3,
  })))
  // 每实例 UV 偏移：aUvOffset 由 InstancedMesh 逐实例提供，把顶面 UV 折进对应图集格。
  // 只改 vMapUv（r185 里 map 用 vMapUv 采样，且它在 #ifdef USE_MAP 下声明）。
  // ⚠️ 不能碰 vUv：three r185 的 USE_UV 已不存在（改成 USE_UV1/2/3），vUv 未声明，引用即编译失败→黑面。
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = 'attribute vec2 aUvOffset;\n' + shader.vertexShader
    shader.vertexShader = shader.vertexShader.replace(
      '#include <uv_vertex>',
      `#include <uv_vertex>
      #ifdef USE_MAP
        vMapUv = aUvOffset + vMapUv * vec2(${ATLAS_CELL_U.toFixed(6)}, ${ATLAS_CELL_V.toFixed(6)});
      #endif`,
    )
  }
  if (!glossyMaterials) {
    mat.clearcoat = 0
    mat.clearcoatRoughness = 0
    mat.specularIntensity = 0
    mat.ior = 1.5
  }
  atlasMaterial = mat
  return mat
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
  ctx.fillText(windForSeat(2, props.dealerIndex), 256, 86)
  ctx.fillText(windForSeat(1, props.dealerIndex), 424, 256)
  ctx.fillText(windForSeat(0, props.dealerIndex), 256, 426)
  ctx.fillText(windForSeat(3, props.dealerIndex), 86, 256)
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
  const jade = own(new THREE.MeshPhysicalMaterial({
    color: 0x254223,
    emissive: 0x101d0f,
    emissiveIntensity: .12,
    roughness: .4,
    metalness: .04,
    clearcoat: .72,
    clearcoatRoughness: .2,
    sheen: .22,
    sheenColor: new THREE.Color(0x6f8d69),
    sheenRoughness: .72,
  }))
  const darkJade = own(new THREE.MeshPhysicalMaterial({
    color: 0x08271c,
    emissive: 0x03140e,
    emissiveIntensity: .12,
    roughness: .48,
    metalness: .16,
    clearcoat: .36,
    clearcoatRoughness: .3,
  }))
  const gold = own(new THREE.MeshPhysicalMaterial({
    color: 0xb88a38,
    emissive: 0x3a2406,
    emissiveIntensity: .3,
    roughness: .28,
    metalness: .88,
    clearcoat: .3,
    clearcoatRoughness: .2,
  }))
  const goldHighlight = own(new THREE.MeshPhysicalMaterial({
    color: 0xe1b85d,
    emissive: 0x392006,
    emissiveIntensity: .35,
    roughness: .22,
    metalness: .94,
    clearcoat: .38,
    clearcoatRoughness: .16,
  }))
  const machine = own(new THREE.MeshPhysicalMaterial({
    color: 0x071f17,
    roughness: .3,
    metalness: .24,
    clearcoat: .76,
    clearcoatRoughness: .16,
  }))
  scene.userData.tileSide = trackTileMaterial(own(new THREE.MeshPhysicalMaterial({
    envMap: scene.userData.tileEnvironment,
    color: 0xc9c9c1,
    metalness: 0,
    roughness: .31,
    clearcoat: .58,
    clearcoatRoughness: .23,
    ior: 1.46,
    specularIntensity: .34,
    specularColor: new THREE.Color(0xfffdf3),
    envMapIntensity: .3,
  })))
  scene.userData.faceSide = trackTileMaterial(own(new THREE.MeshPhysicalMaterial({
    envMap: scene.userData.tileEnvironment,
    color: 0x32a73a,
    metalness: 0,
    roughness: .3,
    clearcoat: .68,
    clearcoatRoughness: .18,
    ior: 1.46,
    specularIntensity: .62,
    envMapIntensity: .46,
  })))
  scene.userData.tileBottom = trackTileMaterial(own(new THREE.MeshPhysicalMaterial({
    envMap: scene.userData.tileEnvironment,
    color: 0xbfc1b9,
    metalness: 0,
    roughness: .42,
    clearcoat: .38,
    clearcoatRoughness: .24,
    ior: 1.45,
    envMapIntensity: .25,
  })))
  scene.userData.backMaterial = trackTileMaterial(own(new THREE.MeshPhysicalMaterial({
    map: makeBackTexture(),
    envMap: scene.userData.tileEnvironment,
    color: 0xd1d2cb,
    metalness: 0,
    roughness: .32,
    clearcoat: .48,
    clearcoatRoughness: .26,
    ior: 1.46,
    envMapIntensity: .28,
  })))
  scene.userData.highlightMaterial = own(new THREE.MeshStandardMaterial({ color: 0xe3b948, emissive: 0x7d4d08, emissiveIntensity: .8, roughness: .4 }))
  // 牌体几何由整桌共享，避免每次手牌、牌河更新时重复构建和销毁圆角网格。
  // 绿色牌背层略微内收，白色正面层形成完整外轮廓。
  scene.userData.tileBaseGeometry = own(new RoundedBoxGeometry(.68, .22, .94, 6, .07))
  scene.userData.tileCapGeometry = own(new RoundedBoxGeometry(.69, .34, .95, 6, .072))

  // 墨玉台芯、鎏金托边与双层金线保持原有牌桌尺寸，不影响牌河和副露坐标。
  addStaticMesh(new RoundedBoxGeometry(21.8, .54, 17.3, 3, .18), darkJade, 0, -.37, -1.65)
  addStaticMesh(new RoundedBoxGeometry(21.46, .22, 16.96, 3, .13), gold, 0, -.14, -1.65)
  addStaticMesh(new RoundedBoxGeometry(21.04, .18, 16.54, 3, .12), jade, 0, -.02, -1.62)

  const railY = .1
  addStaticMesh(new THREE.BoxGeometry(20.55, .075, .105), goldHighlight, 0, railY, -9.68)
  addStaticMesh(new THREE.BoxGeometry(20.55, .075, .105), goldHighlight, 0, railY, 6.45)
  addStaticMesh(new THREE.BoxGeometry(.105, .075, 16.02), goldHighlight, -10.22, railY, -1.62)
  addStaticMesh(new THREE.BoxGeometry(.105, .075, 16.02), goldHighlight, 10.22, railY, -1.62)
  addStaticMesh(new THREE.BoxGeometry(19.96, .05, .045), gold, 0, .105, -9.38)
  addStaticMesh(new THREE.BoxGeometry(19.96, .05, .045), gold, 0, .105, 6.16)
  addStaticMesh(new THREE.BoxGeometry(.045, .05, 15.5), gold, -9.92, .105, -1.61)
  addStaticMesh(new THREE.BoxGeometry(.045, .05, 15.5), gold, 9.92, .105, -1.61)

  const cornerGeometry = own(new THREE.CylinderGeometry(.24, .3, .1, 12))
  ;[[-9.93, -9.4], [9.93, -9.4], [-9.93, 6.18], [9.93, 6.18]].forEach(([x, z]) => {
    const stud = addStaticMesh(cornerGeometry.clone(), goldHighlight, x, .16, z)
    stud.rotation.y = Math.PI / 4
  })

  const machineTop = own(new THREE.MeshPhysicalMaterial({
    map: makeMachineTexture(),
    roughness: .3,
    metalness: .16,
    clearcoat: .66,
    clearcoatRoughness: .18,
  }))
  const machineBottom = own(new THREE.MeshPhysicalMaterial({ color: 0x020906, roughness: .46, metalness: .3, clearcoat: .24 }))
  addStaticMesh(new RoundedBoxGeometry(3.85, .2, 3.85, 3, .22), gold, 0, .14, PLAY_AREA_OFFSET_Z)
  addStaticMesh(new RoundedBoxGeometry(3.58, .16, 3.58, 3, .18), darkJade, 0, .25, PLAY_AREA_OFFSET_Z)
  const machineGeometry = own(new RoundedBoxGeometry(3.35, .28, 3.35, 3, .16))
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
  winEffectAnimation = null
  dynamicResources.splice(0).forEach((resource) => resource.dispose?.())
}

function makeTableTile(topMaterial) {
  const tile = new THREE.Group()
  const green = scene.userData.faceSide
  const white = scene.userData.tileSide
  const bottom = scene.userData.tileBottom
  const back = scene.userData.backMaterial
  const base = new THREE.Mesh(scene.userData.tileBaseGeometry, [green, green, green, back, green, green])
  base.position.y = -.06
  base.castShadow = true
  base.receiveShadow = true
  tile.add(base)

  const cap = new THREE.Mesh(scene.userData.tileCapGeometry, [white, white, topMaterial, bottom, white, white])
  cap.position.y = .13
  cap.castShadow = true
  cap.receiveShadow = true
  tile.add(cap)
  return tile
}

function makeFaceTile(tileName) {
  return makeTableTile(makeFaceMaterial(tileName))
}

// ---- InstancedMesh 合批：暗手/弃牌/副露全部写进实例矩阵 ----
const INSTANCE_CAPACITY = 260
const TILE_BASE_OFFSET = new THREE.Matrix4().makeTranslation(0, -.06, 0)
const TILE_CAP_OFFSET = new THREE.Matrix4().makeTranslation(0, .13, 0)
let tableBaseInstances: THREE.InstancedMesh | null = null
let backCapInstances: THREE.InstancedMesh | null = null   // 背朝上（暗手/暗杠首尾）的 cap
let atlasCapInstances: THREE.InstancedMesh | null = null  // 所有牌面朝上的 cap（图集）
let atlasUvAttribute: THREE.InstancedBufferAttribute | null = null
let backCapCount = 0
let atlasCapCount = 0
let tableInstanceCount = 0
const scratchMatrix = new THREE.Matrix4()
const scratchScale = new THREE.Vector3()
const scratchVector = new THREE.Vector3()

function createCapInstances(topMaterial: THREE.Material, geometry: THREE.BufferGeometry) {
  const cap = ownDynamic(new THREE.InstancedMesh(
    geometry,
    [scene.userData.tileSide, scene.userData.tileSide, topMaterial,
      scene.userData.tileBottom, scene.userData.tileSide, scene.userData.tileSide],
    INSTANCE_CAPACITY,
  ))
  cap.castShadow = true
  cap.receiveShadow = true
  cap.frustumCulled = false
  scene.add(cap)
  dynamicGroups.push(cap)
  return cap
}

function beginTableInstances() {
  tableBaseInstances = ownDynamic(new THREE.InstancedMesh(
    scene.userData.tileBaseGeometry,
    [scene.userData.faceSide, scene.userData.faceSide, scene.userData.faceSide,
      scene.userData.backMaterial, scene.userData.faceSide, scene.userData.faceSide],
    INSTANCE_CAPACITY,
  ))
  tableBaseInstances.castShadow = true
  tableBaseInstances.receiveShadow = true
  tableBaseInstances.frustumCulled = false
  scene.add(tableBaseInstances)
  dynamicGroups.push(tableBaseInstances)
  backCapInstances = createCapInstances(scene.userData.tileBottom, scene.userData.tileCapGeometry)
  atlasCapInstances = createCapInstances(getAtlasMaterial(), getAtlasCapGeometry())
  atlasUvData = new Float32Array(INSTANCE_CAPACITY * 2)
  atlasUvAttribute = new THREE.InstancedBufferAttribute(atlasUvData, 2)
  // aUvOffset 只挂在图集 cap 的克隆几何体上，共享 tileCapGeometry 不受影响（上次破坏的根因）。
  atlasCapInstances.geometry.setAttribute('aUvOffset', atlasUvAttribute)
  backCapCount = 0
  atlasCapCount = 0
  tableInstanceCount = 0
}

// 写一张牌的实例矩阵。face 为牌面类型字符串（朝上→图集格）或 null（背朝上→back 合批）。
// initialPos/initialScale 供发牌、副露动画在最终位置前先置于起点。
function addTableTile(pos, quat, face, scale = 1, initialPos = null, initialScale = null) {
  const baseIndex = tableInstanceCount
  tableInstanceCount += 1
  scratchMatrix.compose(initialPos ?? pos, quat, scratchScale.setScalar(initialScale ?? scale))
  tableBaseInstances.setMatrixAt(baseIndex, scratchMatrix.clone().multiply(TILE_BASE_OFFSET))
  const faceUp = face !== null && face !== undefined
  const capMesh = faceUp ? atlasCapInstances : backCapInstances
  // 每个 cap 合批对象维护自己的实例序号，不能与全局 baseIndex 混用，否则牌面会错乱串位。
  const capIndex = faceUp ? atlasCapCount : backCapCount
  if (faceUp) {
    const uv = atlasCellUvFor(face)
    atlasUvData[capIndex * 2] = uv.u
    atlasUvData[capIndex * 2 + 1] = uv.v
  }
  capMesh.setMatrixAt(capIndex, scratchMatrix.multiply(TILE_CAP_OFFSET))
  if (faceUp) atlasCapCount += 1
  else backCapCount += 1
  return { baseIndex, capIndex, capMesh }
}

function setTileInstance(baseIndex, capMesh, capIndex, pos, quat, scale) {
  scratchMatrix.compose(pos, quat, scratchScale.setScalar(scale))
  tableBaseInstances.setMatrixAt(baseIndex, scratchMatrix.clone().multiply(TILE_BASE_OFFSET))
  capMesh.setMatrixAt(capIndex, scratchMatrix.multiply(TILE_CAP_OFFSET))
  tableBaseInstances.instanceMatrix.needsUpdate = true
  capMesh.instanceMatrix.needsUpdate = true
}

function finishTableInstances() {
  if (!tableBaseInstances) return
  tableBaseInstances.count = tableInstanceCount
  tableBaseInstances.instanceMatrix.needsUpdate = true
  if (backCapInstances) {
    backCapInstances.count = backCapCount
    backCapInstances.instanceMatrix.needsUpdate = true
  }
  if (atlasCapInstances) {
    atlasCapInstances.count = atlasCapCount
    atlasCapInstances.instanceMatrix.needsUpdate = true
    if (atlasUvAttribute) atlasUvAttribute.needsUpdate = true
  }
}

function addConcealedHand(playerIndex) {
  if (playerIndex === 0) return
  const position = ['bottom', 'right', 'top', 'left'][playerIndex]
  const rawHand = props.players[playerIndex]?.hand ?? []
  const presentation = props.winPresentation?.winnerIndex === playerIndex
    ? props.winPresentation
    : null
  const displayedHand = splitWinningTile(rawHand, presentation).hand
  const total = Math.min(displayedHand.length, 14)
  const gap = TILE_GAP_OFFSET // 三家手牌间隙
  const drawnTileIndex = props.players[playerIndex]?.drawnTileIndex ?? -1
  const layoutDrawnTileIndex = props.revealHands ? -1 : drawnTileIndex
  const drawnGap = .28
  const arrangedTotal = layoutDrawnTileIndex >= 0 ? total - 1 : total
  const melds = props.players[playerIndex]?.melds || []
  const revealedHand = props.revealHands ? sortTiles(displayedHand) : []
  // 牌面按每位玩家自身视角从左到右排列；副露固定在右手边，因此邻近副露的是字牌。
  const reverseRevealedFaces = position === 'top' || position === 'right' || melds.length > 0
  const exposedSpan = melds.reduce((span, meld, meldIndex) => {
    const laidTiles = meld.added ? meld.tiles.slice(0, 3) : meld.tiles
    const sourceTileIndex = meldSourceTileIndex({ ...meld, tiles: laidTiles }, playerIndex)
    const meldSpan = laidTiles.reduce(
      (width, _, tileIndex) => width + (tileIndex === sourceTileIndex ? 1.025 : gap),
      0,
    )
    return span + meldSpan + (meldIndex > 0 ? .18 : 0)
  }, 0)
  const animatedFromIndex = Math.max(0, total - (props.dealAnimation.count || 0))
  const dealThisHand = props.dealAnimation.playerIndex === playerIndex
  for (let index = 0; index < total; index += 1) {
    const faceIndex = reverseRevealedFaces ? total - 1 - index : index
    const face = props.revealHands ? revealedHand[faceIndex] : null
    const tileY = props.revealHands ? .28 : .56
    let x
    let z
    let rotationY
    if (position === 'top') {
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
      z = -7.75
      rotationY = props.revealHands ? Math.PI : 0
    } else {
      rotationY = props.revealHands
        ? (position === 'left' ? -Math.PI / 2 : Math.PI / 2)
        : (position === 'left' ? Math.PI / 2 : -Math.PI / 2)
      const centeredZ = (index - (arrangedTotal - 1) / 2) * gap
      if (index === layoutDrawnTileIndex) {
        z = position === 'right'
          ? -(arrangedTotal - 1) / 2 * gap - gap - drawnGap
          : (arrangedTotal - 1) / 2 * gap + gap + drawnGap
      } else {
        // 左右两家的副露使用独立轨道；暗手始终保持居中，避免副露时整排突然跳位。
        z = centeredZ
      }
      // 下家的暗手沿桌边向上家方向收拢；明牌结算与独立副露轨道保持原位。
      const concealedHandShift = position === 'right' && !props.revealHands ? -1.15 : 0
      x = position === 'left' ? -9.15 : 9.15
      z += concealedHandShift
    }
    const pos = new THREE.Vector3(x, tileY, z + PLAY_AREA_OFFSET_Z)
    // 暗手为背面朝玩家的立牌：makeHiddenTile 内部 body 绕 X 转 -90°，合批时折进实例矩阵。
    const quat = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rotationY, 0))
    if (!props.revealHands) quat.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0)))
    if (dealThisHand && index >= animatedFromIndex) {
      const origin = new THREE.Vector3(0, 3.4, PLAY_AREA_OFFSET_Z + .5)
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

function winEffectAnchor(playerIndex) {
  const layout = winDisplayLayout(playerIndex)
  return new THREE.Vector3(layout.x, layout.y, layout.z)
}

function cameraAlignedPoint(point, planeY) {
  const direction = point.clone().sub(camera.position).normalize()
  const distance = (planeY - camera.position.y) / direction.y
  return camera.position.clone().addScaledVector(direction, distance)
}

function addWinningDisplayTile() {
  if (!props.revealHands || !props.winPresentation?.tile) return
  const layout = winDisplayLayout(props.winPresentation.winnerIndex)
  const group = new THREE.Group()
  const tile = makeFaceTile(props.winPresentation.tile)
  tile.position.set(layout.x, layout.y, layout.z + PLAY_AREA_OFFSET_Z)
  tile.rotation.y = layout.rotation
  group.add(tile)
  scene.add(group)
  dynamicGroups.push(group)
}

function robbedKongSourceTransform(effect) {
  if (!effect.robbedKong || effect.robbedKongPlayerIndex < 0 || effect.robbedKongMeldIndex < 0) return null
  const playerIndex = effect.robbedKongPlayerIndex
  const melds = props.players[playerIndex]?.melds || []
  let trackOffset = 0
  for (let meldIndex = 0; meldIndex < melds.length; meldIndex += 1) {
    const meld = melds[meldIndex]
    const laidTiles = meld.added ? meld.tiles.slice(0, 3) : meld.tiles
    const sourceTileIndex = meldSourceTileIndex({ ...meld, tiles: laidTiles }, playerIndex)
    let sourcePlacement = null
    laidTiles.forEach((_, tileIndex) => {
      const pointsToSource = tileIndex === sourceTileIndex
      const tileSpan = pointsToSource ? 1.025 : .725
      const centerOffset = trackOffset + (tileSpan - .725) / 2
      const transform = alignMeldBottom(
        meldTransform(playerIndex, centerOffset),
        playerIndex,
        pointsToSource,
      )
      if (pointsToSource) {
        sourcePlacement = {
          x: transform.x,
          z: transform.z,
          rotation: transform.rotation + Math.PI / 2,
        }
      }
      trackOffset += tileSpan
    })
    if (meldIndex === effect.robbedKongMeldIndex && sourcePlacement) {
      const offset = addedKongTileOffset(playerIndex)
      return {
        position: new THREE.Vector3(
          sourcePlacement.x + offset.x,
          .28,
          sourcePlacement.z + offset.z + PLAY_AREA_OFFSET_Z,
        ),
        rotation: sourcePlacement.rotation,
      }
    }
    trackOffset += .18
  }
  return null
}

// 胡牌特效的几何体与光晕纹理在组件生命周期内固定不变，缓存复用避免每次胡牌重新分配/上传。
let cachedFlareTexture: THREE.CanvasTexture | null = null
let beamGeometry: THREE.CylinderGeometry | null = null
const ringGeometries: (THREE.TorusGeometry | null)[] = []
const particleGeometries: (THREE.SphereGeometry | null)[] = []

function getFlareTexture() {
  if (cachedFlareTexture) return cachedFlareTexture
  const flareCanvas = document.createElement('canvas')
  flareCanvas.width = 64
  flareCanvas.height = 64
  const flareContext = flareCanvas.getContext('2d')
  const flareGradient = flareContext.createRadialGradient(32, 32, 0, 32, 32, 31)
  flareGradient.addColorStop(0, 'rgba(255,255,235,1)')
  flareGradient.addColorStop(.18, 'rgba(255,224,125,.95)')
  flareGradient.addColorStop(.52, 'rgba(255,188,55,.38)')
  flareGradient.addColorStop(1, 'rgba(255,170,30,0)')
  flareContext.fillStyle = flareGradient
  flareContext.fillRect(0, 0, 64, 64)
  cachedFlareTexture = own(new THREE.CanvasTexture(flareCanvas))
  cachedFlareTexture.colorSpace = THREE.SRGBColorSpace
  return cachedFlareTexture
}

function getBeamGeometry() {
  if (!beamGeometry) beamGeometry = own(new THREE.CylinderGeometry(.055, .18, 8.5, 16, 1, true))
  return beamGeometry
}

function getRingGeometry(index: number) {
  if (!ringGeometries[index]) ringGeometries[index] = own(new THREE.TorusGeometry(.64 + index * .18, .025, 8, 48))
  return ringGeometries[index]!
}

function getParticleGeometry(index: number) {
  if (!particleGeometries[index]) particleGeometries[index] = own(new THREE.SphereGeometry(.035 + index % 3 * .012, 8, 8))
  return particleGeometries[index]!
}

function addWinEffect() {
  if (!props.winEffect?.tile) return
  const anchor = winEffectAnchor(props.winEffect.winnerIndex)
  anchor.z += PLAY_AREA_OFFSET_Z
  const faceCenter = anchor.clone().setY(anchor.y + .25)
  const burstAnchor = cameraAlignedPoint(faceCenter, .38)
  const outward = new THREE.Vector3(anchor.x, 0, anchor.z - PLAY_AREA_OFFSET_Z).normalize()
  const group = new THREE.Group()

  const beamMaterial = ownDynamic(new THREE.MeshBasicMaterial({
    color: 0xffe59a,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  }))
  const beam = new THREE.Mesh(getBeamGeometry(), beamMaterial)
  beam.position.set(anchor.x, 4.45, anchor.z)
  beam.rotation.z = outward.x * .07
  beam.rotation.x = -outward.z * .07
  beam.scale.y = .04
  group.add(beam)

  const tangent = new THREE.Vector3(-outward.z, 0, outward.x)
  const streakStarts = [
    burstAnchor.clone().addScaledVector(tangent, 3.4).addScaledVector(outward, -.8).setY(4.8),
    burstAnchor.clone().addScaledVector(tangent, -3.4).addScaledVector(outward, -.8).setY(4.8),
    burstAnchor.clone().addScaledVector(outward, -3.2).setY(5.4),
  ]
  const streaks = streakStarts.map((start, index) => {
    const direction = faceCenter.clone().sub(start)
    const length = direction.length()
    const material = ownDynamic(beamMaterial.clone())
    material.opacity = 0
    const streak = new THREE.Mesh(
      ownDynamic(new THREE.CylinderGeometry(.018 + index * .008, .055, length, 8, 1, true)),
      material,
    )
    streak.position.copy(start).add(faceCenter).multiplyScalar(.5)
    streak.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize())
    group.add(streak)
    return streak
  })

  const ringMaterial = ownDynamic(new THREE.MeshBasicMaterial({
    color: 0xffd76a,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  }))
  const rings = [0, 1, 2].map((index) => {
    const ring = new THREE.Mesh(getRingGeometry(index), ringMaterial.clone())
    ownDynamic(ring.material)
    ring.position.copy(burstAnchor).setY(.38 + index * .025)
    ring.rotation.x = Math.PI / 2
    ring.scale.setScalar(.18)
    group.add(ring)
    return ring
  })

  const particleMaterial = ownDynamic(new THREE.MeshBasicMaterial({
    color: 0xffdf72,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  }))
  const particles = Array.from({ length: 14 }, (_, index) => {
    const angle = index / 14 * Math.PI * 2 + (index % 3) * .12
    const particle = new THREE.Mesh(getParticleGeometry(index), particleMaterial.clone())
    ownDynamic(particle.material)
    particle.scale.set(.7, .18, 1.8)
    particle.rotation.y = angle
    particle.position.copy(burstAnchor).setY(.48)
    group.add(particle)
    return {
      mesh: particle,
      velocity: new THREE.Vector3(Math.cos(angle) * (1.2 + index % 4 * .22), .55 + index % 5 * .17, Math.sin(angle) * (1.2 + index % 3 * .28)),
    }
  })

  const winningTile = makeFaceTile(props.winEffect.tile)
  const robbedKongSource = robbedKongSourceTransform(props.winEffect)
  const startPosition = robbedKongSource?.position
    ?? anchor.clone().addScaledVector(outward, 1.08).setY(anchor.y)
  const seatRotation = winDisplayLayout(props.winEffect.winnerIndex).rotation
  const startRotation = robbedKongSource?.rotation ?? seatRotation
  winningTile.position.copy(startPosition)
  winningTile.rotation.y = startRotation
  group.add(winningTile)

  const flareTexture = getFlareTexture()
  const flareMaterial = ownDynamic(new THREE.SpriteMaterial({
    map: flareTexture,
    color: 0xffdf82,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  }))
  const flare = new THREE.Sprite(flareMaterial)
  flare.position.copy(faceCenter).setY(anchor.y + .58)
  flare.scale.setScalar(.45)
  group.add(flare)

  scene.add(group)
  dynamicGroups.push(group)
  winEffectAnimation = {
    startedAt: performance.now(), anchor, burstAnchor, outward, beam, streaks, rings, particles, winningTile, flare,
    startPosition, startRotation, seatRotation,
    duration: props.winEffect.duration ?? WIN_EFFECT_DURATION,
    reducedMotion: Boolean(props.winEffect.reducedMotion),
  }
}

function discardTransform(playerIndex, index) {
  // 本家前两行保持每行 6 张；从第 3 行开始每行 11 张，减少后续行被手牌遮挡。
  const isUserWideRow = playerIndex === 0 && index >= 12
  const columnCount = isUserWideRow ? 11 : 6
  const rowIndex = isUserWideRow ? index - 12 : index
  const column = rowIndex % columnCount
  const discardGap = 0.95   // 牌河行间隙
  const row = isUserWideRow ? 2 + Math.floor(rowIndex / columnCount) : Math.floor(rowIndex / columnCount)
  // 宽行沿用前两行的左侧起点，再向右扩展，避免每行中心线变化造成跳动。
  const lateral = (column - 2.5) * TILE_GAP_OFFSET
  if (playerIndex === 0) return { x: lateral, z: 2.48 + row * discardGap, rotation: 0 }
  if (playerIndex === 1) return { x: 2.64 + row * discardGap, z: -lateral, rotation: Math.PI / 2 }
  if (playerIndex === 2) return { x: -lateral, z: -2.48 - row * discardGap, rotation: Math.PI }
  return { x: -2.64 - row * discardGap, z: lateral, rotation: -Math.PI / 2 }
}

function addDiscards(playerIndex) {
  const discards = props.players[playerIndex]?.discards || []
  discards.forEach((tileName, index) => {
    const highlighted = props.lastDiscard?.from === playerIndex && index === discards.length - 1
    const transform = discardTransform(playerIndex, index)
    const y = highlighted ? .48 : .28
    const pos = new THREE.Vector3(transform.x, y, transform.z + PLAY_AREA_OFFSET_Z)
    const quat = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, transform.rotation, 0))
    addTableTile(pos, quat, tileName)
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

function meldTransform(playerIndex, trackOffset) {
  // 和参考界面一致：每家只有一条副露带，从玩家右手端连续排向手牌。
  if (playerIndex === 0) return { x: 9 - trackOffset, z: 5.85, rotation: 0 }
  if (playerIndex === 1) return { x: 7.78, z: -6.1 + trackOffset, rotation: Math.PI / 2 }
  if (playerIndex === 2) return { x: -9 + trackOffset, z: -7.35, rotation: Math.PI }
  return { x: -7.78, z: 6.1 - trackOffset, rotation: -Math.PI / 2 }
}

function alignMeldBottom(transform, playerIndex, pointsToSource) {
  if (!pointsToSource) return transform
  // 牌面尺寸为 .72 x 1.02；横置后朝玩家方向缩短 .135，中心外移一半即可底边对齐。
  const edgeCompensation = .135
  if (playerIndex === 0) transform.z += edgeCompensation
  else if (playerIndex === 1) transform.x += edgeCompensation
  else if (playerIndex === 2) transform.z -= edgeCompensation
  else transform.x -= edgeCompensation
  return transform
}

function addMelds(playerIndex) {
  const melds = props.players[playerIndex]?.melds || []
  let trackOffset = 0
  melds.forEach((meld, meldIndex) => {
    const animatesThisMeld = pendingTableActionAnimation?.actorIndex === playerIndex
      && pendingTableActionAnimation?.meldIndex === meldIndex
    const laidTiles = meld.added ? meld.tiles.slice(0, 3) : meld.tiles
    const sourceTileIndex = meldSourceTileIndex({ ...meld, tiles: laidTiles }, playerIndex)
    let sourcePlacement = null
    laidTiles.forEach((tileName, tileIndex) => {
      const concealed = meld.type === 'angang' && (tileIndex === 0 || tileIndex === laidTiles.length - 1)
      const pointsToSource = tileIndex === sourceTileIndex
      const face = concealed ? null : tileName
      const tileSpan = pointsToSource ? POINT_GAP_OFFSET : TILE_GAP_OFFSET
      const centerOffset = trackOffset + (tileSpan - .725) / 2
      const transform = alignMeldBottom(
        meldTransform(playerIndex, centerOffset),
        playerIndex,
        pointsToSource,
      )
      const rotationY = transform.rotation + (pointsToSource ? Math.PI / 2 : 0)
      // 暗杠首尾两张背朝上：makeFaceDownTile 内部 body 绕 X 转 180° 并上抬 .13，合批时折进矩阵。
      const bodyOffsetY = concealed ? .13 : 0
      const quat = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rotationY, 0))
      if (concealed) quat.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI, 0, 0)))
      const pos = new THREE.Vector3(transform.x, .28 + bodyOffsetY, transform.z + PLAY_AREA_OFFSET_Z)
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
        sourcePlacement.z + addedOffset.z + PLAY_AREA_OFFSET_Z,
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

function rebuildTableTiles() {
  if (!scene || !props.players.length || !scene.userData.tileImages) return
  clearDynamicScene()
  meldTweens = []
  pendingTableActionAnimation = props.tableActionEvent?.id !== animatedTableActionId
    ? props.tableActionEvent
    : null
  beginTableInstances()
  for (let playerIndex = 0; playerIndex < 4; playerIndex += 1) {
    addConcealedHand(playerIndex)
    addDiscards(playerIndex)
    addMelds(playerIndex)
  }
  finishTableInstances()
  if (pendingTableActionAnimation) animatedTableActionId = pendingTableActionAnimation.id
  pendingTableActionAnimation = null
  addWinEffect()
  addWinningDisplayTile()
}

// 手机端自适应降质：帧耗时超过预算时逐步降低牌面材质开销与阴影分辨率，保住帧率。
// 始终保持满分辨率渲染（画面不糊、布局不变），高负载时牌面由亮面转哑光、阴影略柔化。
const QUALITY_LEVELS = [
  { glossy: true, shadowSize: 1024 },    // 0: 最高（默认）
  { glossy: true, shadowSize: 512 },     // 1: 阴影略柔化
  { glossy: false, shadowSize: 512 },    // 2: 牌面转哑光
]
const DOWNGRADE_FRAME_MS = 26   // EMA 帧耗时超过约 38fps 一档，持续触发降级
const UPGRADE_FRAME_MS = 20     // EMA 帧耗时低于约 50fps 一档，持续触发恢复（避免降到哑光后因阈值过高永远回不来）
const DOWNGRADE_FRAMES = 45
const UPGRADE_FRAMES = 180
// URL 带 ?q=<0|1|2> 强制固定质量档（关闭自适应）；不填则自动。
const qOverride = (() => {
  const raw = new URLSearchParams(window.location.search).get('q')
  if (raw === null || raw === '') return null
  const n = parseInt(raw, 10)
  return Number.isFinite(n) && n >= 0 && n < QUALITY_LEVELS.length ? n : null
})()
let qualityLevel = qOverride ?? 0
let emaFrameMs = 0
let badFrames = 0
let goodFrames = 0
let lastFrameAt = 0
let qualityWarmup = 10
let shadowLight: THREE.DirectionalLight | null = null
let glossyMaterials = true

// 共享牌体材质：创建时把满配参数存入 userData，高负载时清零 clearcoat/specular/ior 以砍掉片元开销。
const tileMaterials: THREE.MeshPhysicalMaterial[] = []
function trackTileMaterial(material: THREE.MeshPhysicalMaterial) {
  material.userData.fullClearcoat = material.clearcoat
  material.userData.fullClearcoatRoughness = material.clearcoatRoughness
  material.userData.fullSpecularIntensity = material.specularIntensity
  material.userData.fullIor = material.ior
  tileMaterials.push(material)
  return material
}

function applyGlossy(glossy: boolean) {
  if (glossyMaterials === glossy) return
  glossyMaterials = glossy
  const change = (m: THREE.MeshPhysicalMaterial) => {
    m.clearcoat = glossy ? m.userData.fullClearcoat : 0
    m.clearcoatRoughness = glossy ? m.userData.fullClearcoatRoughness : 0
    m.specularIntensity = glossy ? m.userData.fullSpecularIntensity : 0
    m.ior = glossy ? m.userData.fullIor : 1.5
    m.needsUpdate = true
  }
  tileMaterials.forEach(change)
  faceMaterials.forEach((m) => change(m))
}

function resize() {
  if (!renderer || !canvas.value) return
  const width = canvas.value.clientWidth
  const height = canvas.value.clientHeight
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, pixelRatioCap))
  renderer.setSize(width, height, false)
  camera.aspect = width / Math.max(height, 1)
  camera.updateProjectionMatrix()
}

function applyQuality() {
  const level = QUALITY_LEVELS[qualityLevel]
  applyGlossy(level.glossy)
  if (shadowLight && shadowLight.shadow.mapSize.x !== level.shadowSize) {
    shadowLight.shadow.mapSize.set(level.shadowSize, level.shadowSize)
    shadowLight.shadow.map?.dispose()
    shadowLight.shadow.map = null
    shadowLight.shadow.needsUpdate = true
  }
}

function updateAdaptiveQuality(frameMs: number) {
  if (qOverride !== null) return
  if (qualityWarmup > 0) {
    qualityWarmup -= 1
    emaFrameMs = 0
    return
  }
  if (frameMs <= 0) return
  emaFrameMs = emaFrameMs ? emaFrameMs * .92 + frameMs * .08 : frameMs
  if (emaFrameMs > DOWNGRADE_FRAME_MS) {
    badFrames += 1
    goodFrames = 0
    if (badFrames >= DOWNGRADE_FRAMES && qualityLevel < QUALITY_LEVELS.length - 1) {
      qualityLevel += 1
      badFrames = 0
      applyQuality()
    }
  } else if (emaFrameMs < UPGRADE_FRAME_MS) {
    goodFrames += 1
    badFrames = 0
    if (goodFrames >= UPGRADE_FRAMES && qualityLevel > 0) {
      qualityLevel -= 1
      goodFrames = 0
      applyQuality()
    }
  } else {
    badFrames = 0
    goodFrames = 0
  }
}

// DEV-only：URL 带 ?perf 时显示帧耗时 HUD，便于真机量化卡顿；生产构建不包含。
let perfHud: { frame: (now: number) => void } | null = null
let perfHudEl: HTMLDivElement | null = null

function setupPerfHud() {
  if (!import.meta.env.DEV) return
  if (!new URLSearchParams(window.location.search).has('perf')) return
  perfHudEl = document.createElement('div')
  perfHudEl.style.cssText = 'position:fixed;top:8px;left:8px;z-index:9999;font:11px/1.5 ui-monospace,Consolas,monospace;color:#9ff;background:rgba(0,0,0,.6);padding:6px 9px;border-radius:6px;pointer-events:none;white-space:pre;'
  document.body.appendChild(perfHudEl)
  const samples: number[] = []
  let last = -1
  let maxMs = 0
  perfHud = {
    frame(now: number) {
      const ms = last >= 0 ? now - last : 0
      if (last >= 0) {
        samples.push(ms)
        if (samples.length > 120) samples.shift()
        if (ms > maxMs) maxMs = ms
      }
      last = now
      if (samples.length >= 30 && samples.length % 30 === 0 && perfHudEl) {
        const sorted = [...samples].sort((a, b) => a - b)
        const avg = samples.reduce((sum, v) => sum + v, 0) / samples.length
        const p95 = sorted[Math.floor(sorted.length * .95)]!
        const dc = renderer?.info.render.calls ?? 0
        const tris = Math.round((renderer?.info.render.triangles ?? 0) / 1000)
        const pr = renderer?.getPixelRatio() ?? 2
        perfHudEl.textContent = `frame ${ms.toFixed(1)}ms\navg ${avg.toFixed(1)}  p95 ${p95.toFixed(1)}  max ${maxMs.toFixed(1)}\n~${Math.min(60, 1000 / avg).toFixed(0)}fps  q${qualityLevel}${glossyMaterials ? 'G' : 'M'}\ndc${dc}  tri${tris}k  pr${pr.toFixed(1)}`
      }
    },
  }
}

function render(time = 0) {
  if (!renderer) return
  perfHud?.frame(time)
  const frameMs = lastFrameAt ? time - lastFrameAt : 0
  lastFrameAt = time
  updateAdaptiveQuality(frameMs)
  let cameraShakeX = 0
  let cameraShakeZ = 0
  let exposure = BASE_EXPOSURE
  animateDice(time)
  dealTweens = dealTweens.filter((tween) => {
    const progress = Math.min(1, (time - tween.startedAt) / tween.duration)
    const eased = 1 - (1 - progress) ** 3
    scratchVector.lerpVectors(tween.origin, tween.target, eased)
    setTileInstance(tween.baseIndex, tween.capMesh, tween.capIndex, scratchVector, tween.quat, 1)
    return progress < 1
  })
  meldTweens = meldTweens.filter((tween) => {
    const progress = Math.min(1, Math.max(0, (time - tween.startedAt) / tween.duration))
    const settled = 1 - (1 - progress) ** 3
    const bounce = Math.sin(progress * Math.PI) * (1 - progress) * .16
    const y = THREE.MathUtils.lerp(tween.targetY + .72, tween.targetY, settled) + bounce + (tween.extraY ?? 0)
    const scale = THREE.MathUtils.lerp(.78, 1, settled)
    scratchVector.set(tween.baseX, y, tween.baseZ)
    setTileInstance(tween.baseIndex, tween.capMesh, tween.capIndex, scratchVector, tween.quat, scale)
    return progress < 1
  })
  if (winEffectAnimation) {
    const effect = winEffectAnimation
    const progress = Math.max(0, Math.min(1, (time - effect.startedAt) / effect.duration))
    const beamIn = THREE.MathUtils.smoothstep(progress, .1, .2)
    const beamOut = 1 - THREE.MathUtils.smoothstep(progress, .72, .9)
    effect.beam.material.opacity = beamIn * beamOut * .52
    effect.beam.scale.y = THREE.MathUtils.lerp(.04, 1, beamIn)

    const burst = THREE.MathUtils.smoothstep(progress, .22, .34)
    const burstFade = 1 - THREE.MathUtils.smoothstep(progress, .66, .82)
    effect.flare.material.opacity = burst * burstFade * .92
    effect.flare.scale.setScalar(THREE.MathUtils.lerp(.35, .82, burst) * (1 - burst * .12))
    effect.streaks.forEach((streak, index) => {
      streak.material.opacity = burst * burstFade * (.42 - index * .06)
      streak.scale.x = streak.scale.z = THREE.MathUtils.lerp(.35, 1.25, burst)
    })
    effect.rings.forEach((ring, index) => {
      ring.material.opacity = burst * burstFade * (.9 - index * .2)
      ring.scale.setScalar(THREE.MathUtils.lerp(.18, 1.65 + index * .24, burst))
      ring.rotation.z = progress * (index ? -4.2 : 5.1)
    })
    effect.particles.forEach(({ mesh, velocity }, index) => {
      const particleProgress = Math.max(0, Math.min(1, (progress - .28 - index * .003) / .38))
      mesh.material.opacity = Math.sin(particleProgress * Math.PI) * .95
      // 直接计算目标坐标，避免每帧新建临时 Vector3 造成移动端 GC 压力。
      mesh.position.set(
        effect.burstAnchor.x + velocity.x * particleProgress,
        effect.burstAnchor.y + velocity.y * particleProgress + Math.sin(particleProgress * Math.PI) * .3,
        effect.burstAnchor.z + velocity.z * particleProgress,
      )
    })

    const approach = effect.reducedMotion ? 1 : THREE.MathUtils.smoothstep(progress, .02, .34)
    effect.winningTile.position.lerpVectors(effect.startPosition, effect.anchor, approach)
    effect.winningTile.rotation.set(
      0,
      THREE.MathUtils.lerp(effect.startRotation, effect.seatRotation, approach),
      0,
    )
    effect.winningTile.scale.setScalar(1)

    const impactProgress = Math.max(0, Math.min(1, (progress - .22) / .22))
    const impact = Math.sin(impactProgress * Math.PI) * (1 - THREE.MathUtils.smoothstep(progress, .44, .58))
    const dim = .66 + THREE.MathUtils.smoothstep(progress, .66, .94) * .26
    exposure = dim + impact * .72
    if (!effect.reducedMotion) {
      cameraShakeX = Math.sin(time * .075) * impact * .075
      cameraShakeZ = Math.cos(time * .061) * impact * .055
    }
  }
  renderer.toneMappingExposure = exposure
  camera.position.x = Math.sin(time * .00035) * .035 + cameraShakeX
  camera.position.z = 11.8 + cameraShakeZ
  camera.lookAt(0, 0, -.25)
  renderer.render(scene, camera)
  animationFrame = requestAnimationFrame(render)
}

onMounted(async () => {
  renderer = new THREE.WebGLRenderer({ canvas: canvas.value, antialias: true, alpha: true, powerPreference: 'high-performance' })
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = BASE_EXPOSURE
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFShadowMap
  renderer.setClearColor(0x050706, 0)

  scene = new THREE.Scene()
  scene.fog = new THREE.Fog(0x03100b, 20, 34)
  const pmremGenerator = new THREE.PMREMGenerator(renderer)
  const roomEnvironment = new RoomEnvironment()
  const environmentTarget = own(pmremGenerator.fromScene(roomEnvironment, .04))
  // 环境反射只服务于麻将牌，避免墨玉桌面和金色桌边被整体提亮。
  scene.userData.tileEnvironment = environmentTarget.texture
  roomEnvironment.dispose()
  pmremGenerator.dispose()
  camera = new THREE.PerspectiveCamera(39, 1, .1, 60)
  camera.position.set(0, 15, 11.8)
  scene.add(new THREE.HemisphereLight(0xf3e4ba, 0x020b08, 1.65))
  const keyLight = new THREE.DirectionalLight(0xffdfa0, 3.8)
  keyLight.position.set(-7, 13, 9)
  keyLight.castShadow = true
  keyLight.shadow.mapSize.set(1024, 1024)
  keyLight.shadow.camera.left = -12
  keyLight.shadow.camera.right = 12
  keyLight.shadow.camera.top = 10
  keyLight.shadow.camera.bottom = -10
  scene.add(keyLight)
  shadowLight = keyLight
  const rimLight = new THREE.DirectionalLight(0x3acb8b, 1.6)
  rimLight.position.set(8, 5, -8)
  scene.add(rimLight)
  // 移除了 goldFill（点光源，每片元开销最大）与 tileHighlight（与 keyLight 同向的微弱重复）。
  // 金色桌沿改由 gold/goldHighlight 的自发光补偿，保持亮度不依赖点光源。
  addDice()

  // 静态牌桌与暗牌不依赖牌面图片，必须先绘制首帧，避免线上加载图片时长时间黑屏。
  scene.userData.tileImages = new Map<TileType, HTMLImageElement>()
  addTable()
  rebuildTableTiles()
  if (qOverride !== null) {
    qualityLevel = qOverride
    applyQuality()
  }
  resizeObserver = new ResizeObserver(resize)
  resizeObserver.observe(canvas.value)
  resize()
  setupPerfHud()
  render()

  await Promise.all(TILE_TYPES.map(async (tile) => {
    try {
      const image = await loadImage(`${import.meta.env.BASE_URL}tiles/${tileFaceFile(tile)}`)
      scene.userData.tileImages.set(tile, image)
    } catch {
      // 单张牌面加载失败不应阻断整个 3D 牌桌，其牌面会回退为无图案底色。
    }
  }))
  if (destroyed) return
  faceMaterials.clear()
  // 图集在图片就绪前可能已用空底构建，需失效让下一次重建带上真实牌面。
  atlasMaterial = null
  rebuildTableTiles()
})

watch(
  () => (props.players.map((player) => [
    player.hand.length,
    player.drawnTileIndex,
    player.discards.join(','),
    player.melds.map((meld) => `${meld.type}:${meld.from ?? '-'}:${meld.tiles.join(',')}`).join('|'),
  ]).flat() as unknown[]).concat(
    props.lastDiscard?.id,
    props.revealHands,
    props.winnerIndex,
    props.winEffect?.id,
    props.winPresentation?.winnerIndex,
    props.winPresentation?.tile,
    props.winPresentation?.robbedKong,
    props.dealAnimation.serial,
  ),
  rebuildTableTiles,
)

watch(() => props.openingStage, (stage) => {
  if (!diceGroup) return
  diceGroup.visible = stage === 'dice'
  if (diceGroup.visible) diceStartedAt = performance.now()
})

watch(() => props.dealerIndex, updateMachineTexture)

// 剩余牌数与当前玩家只影响中央机器 LCD（数字 / 高亮边），单独监听即可，避免整桌重建
watch(() => props.wallCount, updateMachineTexture)
watch(() => props.currentPlayer, updateMachineTexture)

onBeforeUnmount(() => {
  destroyed = true
  cancelAnimationFrame(animationFrame)
  perfHudEl?.remove()
  perfHudEl = null
  perfHud = null
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
