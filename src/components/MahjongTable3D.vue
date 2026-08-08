<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as THREE from 'three'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { isHorse, sortTiles, TILE_TYPES } from '../game/core/tiles'
import { preloadTileImages, preloadedTileImages } from '../game/core/tileAssets'
import { meldSourceTileIndex } from '../game/core/rules'
import { addedKongTileOffset, pointFromSeat, windForSeat } from '../game/core/tableLayout'
import { wallBreakIndex, wallStackSlot, wallTilePlacement, WALL_TOTAL } from '../game/core/wallLayout'
import { splitWinningTile, WIN_EFFECT_DURATION, winDisplayLayout } from '../game/core/winEffect'
import type { GamePlayer, TableActionEvent, TileType, WinPresentation } from '../game/core/types'

interface TableProps {
  players?: GamePlayer[]
  currentPlayer?: number
  lastDiscard?: { tile: TileType; from: number; id: number } | null
  wall?: TileType[]
  wallHeadDrawn?: number
  wallCount?: number
  horses?: TileType[]
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
  players: () => [], currentPlayer: -1, lastDiscard: null, wall: () => [], wallHeadDrawn: 0, wallCount: 0, horses: () => [],
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
let discardTweens = []
let animatedDiscardId = -1   // 最近一次已播过出牌动画的弃牌 id，避免重复动画
let animatedTableActionId = -1
let pendingTableActionAnimation = null
let winEffectAnimation = null
let diceGroup
let diceStartedAt = 0
const staticResources = []
const dynamicResources = []
const faceMaterials = new Map()
// 中控台与墨玉台面的 Z 中心（桌身中心，保持不变）
const PLAY_AREA_OFFSET_Z = -1.65
// 牌层（牌墙/牌河/手牌/副露/骰子）的 Z 中心：单独向本家（+z）偏移，靠近玩家侧
const TILE_LAYER_Z = -1.0
const DICE_SIZE = .5
const DICE_LANDING_Y = .62
const BASE_EXPOSURE = .92
const TILE_GAP_OFFSET = .685    // 手牌间隙和加杠偏移量
const POINT_GAP_OFFSET = 0.965  // 副露指向的偏移量
// 副露带逼近手牌时，手牌让位后的「副露-暗手」间距：原 .62 ≈ 半个麻将，改为 1.24 ≈ 一个麻将牌。
const MELD_HAND_GAP = 1.24
// 下家（右家）副露整体向上（-z）移动 3 个麻将牌（3 × 牌宽 0.68），给摸牌位留出间隙。
const MELD_UP_MOVE = 3 * .68
const WALL_DEAL_ORIGIN_Y = 1.1  // 发牌从牌山 head 槽位上方起飞的初始高度（略高于两墩牌顶）

// 渲染分辨率上限（清晰度 vs 帧率）：默认 3 取设备原生 DPR，真机实测本设备 2.2 vs 2.0 帧率无差，原生清晰免费。
// URL 带 ?pr=<数字> 可覆盖。
const DEFAULT_PIXEL_RATIO_CAP = 3
let pixelRatioCap = parseFloat(new URLSearchParams(window.location.search).get('pr') ?? '') || DEFAULT_PIXEL_RATIO_CAP

// 抗锯齿开关：默认开；URL 带 ?aa=off 关闭 MSAA（省一大截 fill，但牌边缘会出现锯齿）。
const aaEnabled = new URLSearchParams(window.location.search).get('aa') !== 'off'

function own(resource) {
  staticResources.push(resource)
  return resource
}

function ownDynamic(resource) {
  dynamicResources.push(resource)
  return resource
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
    die.position.z = throwPoint.z + TILE_LAYER_Z
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

// 买马未中：牌面正常渲染（能识别是哪张牌），整牌 75% 透明（半透明、区别于中马）。
// 共享材质按 75% 透明度克隆缓存，避免影响正常牌。
const transparentMaterialCache = new Map<THREE.Material, THREE.Material>()
function transparentClone(material: THREE.Material) {
  if (!transparentMaterialCache.has(material)) {
    const clone = material.clone()
    clone.transparent = true
    clone.opacity = .75
    clone.depthWrite = false
    transparentMaterialCache.set(material, clone)
  }
  return transparentMaterialCache.get(material)!
}

function makeTransparentFaceMaterial(tile) {
  const key = `dim:${tile}`
  if (faceMaterials.has(key)) return faceMaterials.get(key)
  const material = makeFaceMaterial(tile).clone()
  material.transparent = true
  material.opacity = .75
  material.depthWrite = false
  faceMaterials.set(key, material)
  return material
}

// 未中马牌：牌面（+y）+ 整体 75% 透明，仍能看清是哪张牌。
function makeDimmedHorseTile(tile) {
  const tileObj = new THREE.Group()
  const base = new THREE.Mesh(scene.userData.tileBaseGeometry, [
    transparentClone(scene.userData.faceSide), transparentClone(scene.userData.faceSide),
    transparentClone(scene.userData.faceSide), transparentClone(scene.userData.backMaterial),
    transparentClone(scene.userData.faceSide), transparentClone(scene.userData.faceSide),
  ])
  base.position.y = -.06
  tileObj.add(base)
  const cap = new THREE.Mesh(scene.userData.tileCapGeometry, [
    transparentClone(scene.userData.tileSide), transparentClone(scene.userData.tileSide),
    makeTransparentFaceMaterial(tile), transparentClone(scene.userData.tileBottom),
    transparentClone(scene.userData.tileSide), transparentClone(scene.userData.tileSide),
  ])
  cap.position.y = .13
  tileObj.add(cap)
  return tileObj
}

// 买马中马：四周金光 = 金色柔光晕（径向渐变，加色混合），铺在牌下方，光从牌底溢出。
let glowTexture: THREE.Texture | null = null
function getGlowTexture() {
  if (!glowTexture) {
    const size = 256
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')
    const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
    grad.addColorStop(0, 'rgba(255, 205, 90, .95)')
    grad.addColorStop(.4, 'rgba(255, 180, 60, .45)')
    grad.addColorStop(1, 'rgba(255, 160, 40, 0)')
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, size, size)
    glowTexture = own(new THREE.CanvasTexture(canvas))
    glowTexture.colorSpace = THREE.SRGBColorSpace
  }
  return glowTexture
}

function makeGoldGlow() {
  // 平铺在桌面的金色光晕（比牌大一圈，径向渐变边缘渐隐），加色混合 → 从牌底溢出的金光。
  const glow = new THREE.Mesh(
    ownDynamic(new THREE.PlaneGeometry(1.5, 1.5)),
    ownDynamic(new THREE.MeshBasicMaterial({
      map: getGlowTexture(),
      transparent: true,
      opacity: .95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    })),
  )
  glow.rotation.x = -Math.PI / 2
  return glow
}

// 中马竖光：从牌向上溢出的金色光柱（垂直渐变：下亮上渐隐 + 水平中心保留），Sprite 始终面向相机。
let verticalGlowTexture: THREE.Texture | null = null
function getVerticalGlowTexture() {
  if (!verticalGlowTexture) {
    const w = 96
    const h = 256
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    const vgrad = ctx.createLinearGradient(0, h, 0, 0)
    vgrad.addColorStop(0, 'rgba(255, 200, 85, .8)')
    vgrad.addColorStop(.55, 'rgba(255, 180, 60, .28)')
    vgrad.addColorStop(1, 'rgba(255, 150, 40, 0)')
    ctx.fillStyle = vgrad
    ctx.fillRect(0, 0, w, h)
    // 水平：中心保留、两侧裁掉（destination-in 只取 alpha）
    const hgrad = ctx.createLinearGradient(0, 0, w, 0)
    hgrad.addColorStop(0, 'rgba(0,0,0,0)')
    hgrad.addColorStop(.5, 'rgba(0,0,0,1)')
    hgrad.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.globalCompositeOperation = 'destination-in'
    ctx.fillStyle = hgrad
    ctx.fillRect(0, 0, w, h)
    ctx.globalCompositeOperation = 'source-over'
    verticalGlowTexture = own(new THREE.CanvasTexture(canvas))
    verticalGlowTexture.colorSpace = THREE.SRGBColorSpace
  }
  return verticalGlowTexture
}

function makeGoldVerticalGlow() {
  const sprite = new THREE.Sprite(
    ownDynamic(new THREE.SpriteMaterial({
      map: getVerticalGlowTexture(),
      transparent: true,
      opacity: .7,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })),
  )
  sprite.scale.set(.85, 1.5, 1)
  return sprite
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
  // 几何正方形：宽 = 深 = 21.8，桌身中心保持在 z=-1.65。
  addStaticMesh(new RoundedBoxGeometry(21.8, .54, 21.8, 3, .18), darkJade, 0, -.37, -1.65)
  addStaticMesh(new RoundedBoxGeometry(21.46, .22, 21.46, 3, .13), gold, 0, -.14, -1.65)
  addStaticMesh(new RoundedBoxGeometry(21.04, .18, 21.04, 3, .12), jade, 0, -.02, -1.62)

  const railY = .1
  addStaticMesh(new THREE.BoxGeometry(20.55, .075, .105), goldHighlight, 0, railY, -11.87)
  addStaticMesh(new THREE.BoxGeometry(20.55, .075, .105), goldHighlight, 0, railY, 8.57)
  addStaticMesh(new THREE.BoxGeometry(.105, .075, 20.44), goldHighlight, -10.22, railY, -1.65)
  addStaticMesh(new THREE.BoxGeometry(.105, .075, 20.44), goldHighlight, 10.22, railY, -1.65)
  addStaticMesh(new THREE.BoxGeometry(19.96, .05, .045), gold, 0, .105, -11.57)
  addStaticMesh(new THREE.BoxGeometry(19.96, .05, .045), gold, 0, .105, 8.27)
  addStaticMesh(new THREE.BoxGeometry(.045, .05, 19.84), gold, -9.92, .105, -1.65)
  addStaticMesh(new THREE.BoxGeometry(.045, .05, 19.84), gold, 9.92, .105, -1.65)

  const cornerGeometry = own(new THREE.CylinderGeometry(.24, .3, .1, 12))
  ;[[-9.93, -11.59], [9.93, -11.59], [-9.93, 8.29], [9.93, 8.29]].forEach(([x, z]) => {
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
  discardTweens = []
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
      // 下家镜像上家：副露逼近时手牌让位（摸牌位在手牌末尾），副露基准已上移 MELD_UP_MOVE。
      const handNear = -(arrangedTotal - 1) / 2 * gap + (props.revealHands ? 0 : -1.15)
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
        // 四家统一：摸牌位在手牌末尾（带 drawnGap），与上家一致。
        const isDrawn = index === layoutDrawnTileIndex
        z = meldClear + index * gap + (isDrawn ? drawnGap : 0)
      } else {
        const centeredZ = (index - (arrangedTotal - 1) / 2) * gap
        if (index === layoutDrawnTileIndex) {
          z = position === 'right'
            ? -(arrangedTotal - 1) / 2 * gap - gap - drawnGap
            : (arrangedTotal - 1) / 2 * gap + gap + drawnGap
        } else {
          z = centeredZ
        }
        // 下家的暗手沿桌边向上家方向收拢；明牌结算与独立副露轨道保持原位。
        const concealedHandShift = position === 'right' && !props.revealHands ? -1.15 : 0
        z += concealedHandShift
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

function winEffectAnchor(playerIndex) {
  const layout = winDisplayLayout(playerIndex)
  return new THREE.Vector3(layout.x, layout.y, layout.z)
}

function cameraAlignedPoint(point, planeY) {
  const direction = point.clone().sub(camera.position).normalize()
  const distance = (planeY - camera.position.y) / direction.y
  return camera.position.clone().addScaledVector(direction, distance)
}

// 四红中赢牌：4 张红中都已作为花杠亮在副露区，胡牌牌（第 4 张红中）已包含其中，
// 若再单独显示胡牌红中会多出一张 → 四红中时跳过独立胡牌牌展示。
function isFourRedWin() {
  const tile = props.winPresentation?.tile ?? props.winEffect?.tile
  const winnerIndex = props.winPresentation?.winnerIndex ?? props.winEffect?.winnerIndex
  return tile === 'red' && winnerIndex >= 0 && (props.players[winnerIndex]?.redCount ?? 0) >= 4
}

function addWinningDisplayTile() {
  if (!props.revealHands || !props.winPresentation?.tile) return
  if (isFourRedWin()) return
  const layout = winDisplayLayout(props.winPresentation.winnerIndex)
  const group = new THREE.Group()
  const tile = makeFaceTile(props.winPresentation.tile)
  tile.position.set(layout.x, layout.y, layout.z + TILE_LAYER_Z)
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
    const relativeSource = ['peng', 'gang'].includes(meld.type) && Number.isInteger(meld.from)
      ? (meld.from - playerIndex + 4) % 4
      : -1
    let sourcePlacement = null
    laidTiles.forEach((_, tileIndex) => {
      const pointsToSource = tileIndex === sourceTileIndex
      const tileSpan = pointsToSource ? 1.025 : .725
      const centerOffset = trackOffset + (tileSpan - .725) / 2
      const sourceRot = pointsToSource ? sourceTileRotationOffset(relativeSource) : 0
      const transform = alignMeldBottom(
        meldTransform(playerIndex, centerOffset),
        playerIndex,
        sourceRot !== 0,  // 仅横摆的来源牌需要底边对齐补偿
      )
      if (pointsToSource) {
        sourcePlacement = {
          x: transform.x,
          z: transform.z,
          rotation: transform.rotation + sourceRot,
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
          sourcePlacement.z + offset.z + TILE_LAYER_Z,
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

// 金色星芒贴图：胡牌牌处向外爆发的光束（12 道光芒 + 中心柔光）。
// 信标式竖直光束纹理：底部亮金、向上渐隐（贴在圆柱侧面，v 沿高度）。
let cachedBeamTexture: THREE.CanvasTexture | null = null
function getBeamTexture() {
  if (cachedBeamTexture) return cachedBeamTexture
  const w = 32
  const h = 256
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  const grad = ctx.createLinearGradient(0, h, 0, 0)
  grad.addColorStop(0, 'rgba(255,222,135,.95)')
  grad.addColorStop(.3, 'rgba(255,210,115,.55)')
  grad.addColorStop(.65, 'rgba(255,195,95,.2)')
  grad.addColorStop(1, 'rgba(255,185,85,0)')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, w, h)
  cachedBeamTexture = own(new THREE.CanvasTexture(canvas))
  cachedBeamTexture.colorSpace = THREE.SRGBColorSpace
  return cachedBeamTexture
}

// 信标内芯光束（细、亮）
let beamGeometry: THREE.CylinderGeometry | null = null
function getBeamGeometry() {
  if (!beamGeometry) beamGeometry = own(new THREE.CylinderGeometry(.05, .1, 8.5, 12, 1, true))
  return beamGeometry
}

// 信标外层光晕（宽、柔）
let beamGlowGeometry: THREE.CylinderGeometry | null = null
function getBeamGlowGeometry() {
  if (!beamGlowGeometry) beamGlowGeometry = own(new THREE.CylinderGeometry(.16, .26, 7, 12, 1, true))
  return beamGlowGeometry
}

// 金色星芒纹理：光束底部向外爆发的光芒（12 道），与信标光束叠加。
let cachedStarburstTexture: THREE.CanvasTexture | null = null
function getStarburstTexture() {
  if (cachedStarburstTexture) return cachedStarburstTexture
  const size = 256
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  const cx = size / 2
  const cy = size / 2
  const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, size / 2)
  core.addColorStop(0, 'rgba(255,255,235,1)')
  core.addColorStop(.22, 'rgba(255,228,140,.9)')
  core.addColorStop(1, 'rgba(255,195,70,0)')
  ctx.fillStyle = core
  ctx.fillRect(0, 0, size, size)
  const rays = 12
  const rayLen = size * .46
  for (let i = 0; i < rays; i++) {
    const angle = (i / rays) * Math.PI * 2
    const grad = ctx.createLinearGradient(0, 0, rayLen, 0)
    grad.addColorStop(0, 'rgba(255,238,180,.95)')
    grad.addColorStop(.6, 'rgba(255,212,110,.45)')
    grad.addColorStop(1, 'rgba(255,195,70,0)')
    ctx.save()
    ctx.translate(cx, cy)
    ctx.rotate(angle)
    ctx.fillStyle = grad
    ctx.beginPath()
    ctx.moveTo(0, 0)
    ctx.lineTo(rayLen, -size * .05)
    ctx.lineTo(rayLen, size * .05)
    ctx.closePath()
    ctx.fill()
    ctx.restore()
  }
  cachedStarburstTexture = own(new THREE.CanvasTexture(canvas))
  cachedStarburstTexture.colorSpace = THREE.SRGBColorSpace
  return cachedStarburstTexture
}

// 金色菱形粒子几何体（八面体 = 立体菱形）。
let diamondGeometry: THREE.OctahedronGeometry | null = null
function getDiamondGeometry() {
  if (!diamondGeometry) diamondGeometry = own(new THREE.OctahedronGeometry(.06, 0))
  return diamondGeometry
}

function addWinEffect() {
  if (!props.winEffect?.tile) return
  const anchor = winEffectAnchor(props.winEffect.winnerIndex)
  anchor.z += TILE_LAYER_Z
  const faceCenter = anchor.clone().setY(anchor.y + .25)
  const burstAnchor = cameraAlignedPoint(faceCenter, .38)
  const outward = new THREE.Vector3(anchor.x, 0, anchor.z - TILE_LAYER_Z).normalize()
  const group = new THREE.Group()

  // 信标式竖直光束：从胡牌牌垂直射向天空（垂直于牌面），带光晕
  const beamMaterial = ownDynamic(new THREE.MeshBasicMaterial({
    map: getBeamTexture(),
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  }))
  const beam = new THREE.Mesh(getBeamGeometry(), beamMaterial)
  beam.position.set(anchor.x, anchor.y + .25 + 8.5 / 2, anchor.z)
  group.add(beam)
  const beamGlowMaterial = ownDynamic(new THREE.MeshBasicMaterial({
    map: getBeamTexture(),
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  }))
  const beamGlow = new THREE.Mesh(getBeamGlowGeometry(), beamGlowMaterial)
  beamGlow.position.set(anchor.x, anchor.y + .3 + 7 / 2, anchor.z)
  group.add(beamGlow)

  // 星芒：光束底部向外爆发的光芒（与信标光束叠加）
  const starburstMaterial = ownDynamic(new THREE.SpriteMaterial({
    map: getStarburstTexture(),
    color: 0xffd86e,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  }))
  const starburst = new THREE.Sprite(starburstMaterial)
  starburst.position.copy(anchor).setY(anchor.y + .4)
  starburst.scale.setScalar(.4)
  group.add(starburst)

  // 金色光晕：落在牌上的强光晕
  const glowMaterial = ownDynamic(new THREE.SpriteMaterial({
    map: getFlareTexture(),
    color: 0xffc23d,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  }))
  const glow = new THREE.Sprite(glowMaterial)
  glow.position.copy(anchor).setY(anchor.y + .35)
  glow.scale.setScalar(.5)
  group.add(glow)

  // 大量金色菱形粒子：向四周 3D 散射（黄金比例均匀撒布）
  const diamondMaterial = ownDynamic(new THREE.MeshBasicMaterial({
    color: 0xffe9a8,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  }))
  const diamonds = Array.from({ length: 40 }, (_, index) => {
    const y = (index / 40) * 2 - 1
    const radius = Math.sqrt(Math.max(0, 1 - y * y))
    const theta = index * 2.39996
    const speed = 1.5 + index % 8 * .26
    const diamond = new THREE.Mesh(getDiamondGeometry(), diamondMaterial.clone())
    ownDynamic(diamond.material)
    diamond.scale.setScalar(.6 + index % 4 * .22)
    diamond.position.copy(burstAnchor)
    group.add(diamond)
    return {
      mesh: diamond,
      direction: new THREE.Vector3(radius * Math.cos(theta), y, radius * Math.sin(theta)),
      speed,
      spin: (index % 2 ? 1 : -1) * (2.5 + index % 3),
    }
  })

  // 胡牌牌：飞入 + 落地弹跳。四红中时 4 张红中已在花杠区，不单独飞牌（避免多一张红中）。
  const isFourRed = isFourRedWin()
  const winningTile = isFourRed ? null : makeFaceTile(props.winEffect.tile)
  const robbedKongSource = robbedKongSourceTransform(props.winEffect)
  const startPosition = robbedKongSource?.position
    ?? anchor.clone().addScaledVector(outward, 1.08).setY(anchor.y)
  const seatRotation = winDisplayLayout(props.winEffect.winnerIndex).rotation
  const startRotation = robbedKongSource?.rotation ?? seatRotation
  if (winningTile) {
    winningTile.position.copy(startPosition)
    winningTile.rotation.y = startRotation
    winningTile.scale.setScalar(.7)
    group.add(winningTile)
  }

  scene.add(group)
  dynamicGroups.push(group)
  winEffectAnimation = {
    startedAt: performance.now(), anchor, burstAnchor, outward,
    beam, beamGlow, starburst, glow, diamonds, winningTile,
    startPosition, startRotation, seatRotation,
    duration: props.winEffect.duration ?? WIN_EFFECT_DURATION,
    reducedMotion: Boolean(props.winEffect.reducedMotion),
  }
}

function discardTransform(playerIndex, index) {
  // 四家牌河统一：1-3 行每行 6 张，第 4 行起每行 10 张。
  const wideStart = 18   // 前三行 6×3=18 张后进入 10 张/行
  const isWide = index >= wideStart
  const columnCount = isWide ? 10 : 6
  const rowIndex = isWide ? index - wideStart : index
  const column = rowIndex % columnCount
  const discardGap = 0.95   // 牌河行间隙
  const row = isWide ? 3 + Math.floor(rowIndex / columnCount) : Math.floor(rowIndex / columnCount)
  // 每行居中对齐：6 列中心 2.5、10 列中心 4.5
  const lateral = (column - (columnCount - 1) / 2) * TILE_GAP_OFFSET
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

function meldTransform(playerIndex, trackOffset) {
  // 和参考界面一致：每家只有一条副露带，从玩家右手端连续排向手牌。
  // 本家副露整体下移一个牌深（0.94），与牌河拉开距离。
  // 下家（右）副露往右移、上家（左）副露往左移各一个牌宽（0.68），远离中间牌河/副露区。
  if (playerIndex === 0) return { x: 9 - trackOffset, z: 6.79, rotation: 0 }
  if (playerIndex === 1) return { x: 8.9, z: -6.1 - MELD_UP_MOVE + trackOffset, rotation: Math.PI / 2 }
  // 对家副露随手牌一起向后（远离本家）移一个牌深（0.94）。
  if (playerIndex === 2) return { x: -9 + trackOffset, z: -8.29, rotation: Math.PI }
  return { x: -8.9, z: 6.1 - trackOffset, rotation: -Math.PI / 2 }
}

function alignMeldBottom(transform, playerIndex, rotated: boolean) {
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
  // 来源牌一律横摆 ±90°（视觉统一、一眼可辨）：
  // - 相邻玩家 → 牌头指向出牌方：下家（1）→ -90°，上家（3）→ +90°
  // - 对家（2）→ +90°：对家方向恰好 = 副露带方向，横摆后长轴只能指相邻一侧、
  //   牌头指不到对家；头方向为任意值，保留 +90°（可调）
  if (relativeSource === 1) return -Math.PI / 2
  return Math.PI / 2
}

function addMelds(playerIndex) {
  const melds = props.players[playerIndex]?.melds || []
  let trackOffset = 0
  melds.forEach((meld, meldIndex) => {
    const animatesThisMeld = pendingTableActionAnimation?.actorIndex === playerIndex
      && pendingTableActionAnimation?.meldIndex === meldIndex
    const laidTiles = meld.added ? meld.tiles.slice(0, 3) : meld.tiles
    const sourceTileIndex = meldSourceTileIndex({ ...meld, tiles: laidTiles }, playerIndex)
    const relativeSource = ['peng', 'gang'].includes(meld.type) && Number.isInteger(meld.from)
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

// 牌山 head 位置 = 下一张要摸的牌所在处：wall[0] 经 wallHeadDrawn 沿环顺时针推进。
function wallDrawHeadPos() {
  const headOffset = props.wallHeadDrawn ?? 0
  const breakIndex = wallBreakIndex(props.diceValues)
  const { stackIndex } = wallTilePlacement(0, (breakIndex + headOffset) % WALL_TOTAL, props.wall?.length ?? 0)
  const slot = wallStackSlot(stackIndex)
  return { x: slot.x, z: slot.z }
}

// 四边环状牌山（参考欢乐麻将）：wall[i] → 物理槽 (breakIndex + headOffset + i) % 136。
// 每墩 2 张上下叠，牌径向放置（长边指向桌中心），X-180° 翻转让绿色牌背朝上。
// headOffset = wallHeadDrawn（从牌头累计摸走的张数），使 head 顺时针推进（抓牌顺时针）；
// 开杠/红中从牌尾补张（pop）不计入，因此牌尾端会正确地随之缩短。
function addWall() {
  const tiles = props.wall || []
  if (!tiles.length) return
  const breakIndex = wallBreakIndex(props.diceValues)
  const headOffset = props.wallHeadDrawn ?? 0
  tiles.forEach((_, index) => {
    const { stackIndex, layer } = wallTilePlacement(index, (breakIndex + headOffset) % WALL_TOTAL, tiles.length)
    const slot = wallStackSlot(stackIndex)
    const y = .41 + layer * .47
    const quat = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, slot.rotationY, 0))
    // 背朝上：绕 X 转 180°，使 base 底面的牌背（backMaterial）朝上（与暗杠首尾一致）。
    quat.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI, 0, 0)))
    addTableTile(new THREE.Vector3(slot.x, y, slot.z), quat, null)
  })
}

// 买马：胡牌后把 8 张马牌显示到赢家牌河里（续接在赢家弃牌河之后）。
// 中马（红中/1/5/9）正常牌面 + 四周金光（金色发光边框）；未中则牌面正常渲染但整牌 75% 透明。
function addHorses() {
  const horses = props.horses || []
  if (!horses.length) return
  const winnerIndex = props.winnerIndex
  if (winnerIndex < 0) return
  const discardCount = props.players[winnerIndex]?.discards.length ?? 0
  horses.forEach((tile, index) => {
    const hit = isHorse(tile)
    const transform = discardTransform(winnerIndex, discardCount + index)
    const pos = new THREE.Vector3(transform.x, .28, transform.z + PLAY_AREA_OFFSET_Z)
    const tileObj = hit ? makeFaceTile(tile) : makeDimmedHorseTile(tile)
    tileObj.position.copy(pos)
    tileObj.rotation.y = transform.rotation
    scene.add(tileObj)
    dynamicGroups.push(tileObj)
    if (hit) {
      // 中马：四周金光（金色柔光晕铺在牌下方，光从牌底溢出）+ 一点向上的竖光。
      const glow = makeGoldGlow()
      glow.position.set(transform.x, .09, transform.z + PLAY_AREA_OFFSET_Z)
      scene.add(glow)
      dynamicGroups.push(glow)
      const vGlow = makeGoldVerticalGlow()
      // Sprite 中心：让光柱底部（亮端）落在牌顶附近
      vGlow.position.set(transform.x, .55 + .75, transform.z + PLAY_AREA_OFFSET_Z)
      scene.add(vGlow)
      dynamicGroups.push(vGlow)
    }
  })
}

function rebuildTableTiles() {
  if (!scene || !props.players.length || !scene.userData.tileImages) return
  clearDynamicScene()
  meldTweens = []
  discardTweens = []
  pendingTableActionAnimation = props.tableActionEvent?.id !== animatedTableActionId
    ? props.tableActionEvent
    : null
  beginTableInstances()
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
  const pixelRatio = Math.min(window.devicePixelRatio, pixelRatioCap)
  renderer.setPixelRatio(pixelRatio)
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
  // 出牌动画：牌从手牌方向飞向牌河，带弧度抬升 + 落地微弹（模拟人类打牌）
  discardTweens = discardTweens.filter((tween) => {
    const progress = Math.min(1, Math.max(0, (time - tween.startedAt) / tween.duration))
    const eased = 1 - (1 - progress) ** 3
    const arc = Math.sin(progress * Math.PI) * .32
    const bounce = Math.sin(progress * Math.PI) * (1 - progress) * .1
    scratchVector.lerpVectors(tween.origin, tween.target, eased)
    scratchVector.y = THREE.MathUtils.lerp(tween.origin.y, tween.target.y, eased) + arc + bounce
    setTileInstance(tween.baseIndex, tween.capMesh, tween.capIndex, scratchVector, tween.quat, 1)
    return progress < 1
  })
  if (winEffectAnimation) {
    const effect = winEffectAnimation
    const progress = Math.max(0, Math.min(1, (time - effect.startedAt) / effect.duration))

    // 胡牌牌飞入 + 落地弹跳（四红中无独立胡牌牌）
    const approach = effect.reducedMotion ? 1 : THREE.MathUtils.smoothstep(progress, .02, .15)
    if (effect.winningTile) {
      effect.winningTile.position.lerpVectors(effect.startPosition, effect.anchor, approach)
      effect.winningTile.rotation.set(0, THREE.MathUtils.lerp(effect.startRotation, effect.seatRotation, approach), 0)
      const pop = Math.sin(Math.min(1, approach) * Math.PI) * .28
      effect.winningTile.scale.setScalar(THREE.MathUtils.lerp(.7, 1, approach) + pop)
    }

    // 信标光束：牌落地后快速竖起，末尾缓缓收
    const beamIn = THREE.MathUtils.smoothstep(progress, .08, .15)
    const beamOut = 1 - THREE.MathUtils.smoothstep(progress, .55, 1)
    const beamVis = beamIn * beamOut
    effect.beam.material.opacity = beamVis * .8
    effect.beamGlow.material.opacity = beamVis * .32

    // 星芒：光束底部向外爆发的光芒（快速展开后淡出）
    const burstIn = THREE.MathUtils.smoothstep(progress, .08, .16)
    const burstOut = 1 - THREE.MathUtils.smoothstep(progress, .3, .42)
    effect.starburst.material.opacity = burstIn * burstOut * .85
    effect.starburst.scale.setScalar(THREE.MathUtils.lerp(.4, 3, burstIn) * (1 + (1 - burstOut) * .2))

    // 光晕：星芒爆出后逐渐亮起，常驻在牌上，末尾淡出
    const glowIn = THREE.MathUtils.smoothstep(progress, .3, .5)
    const glowOut = 1 - THREE.MathUtils.smoothstep(progress, .85, 1)
    effect.glow.material.opacity = glowIn * glowOut * .85
    effect.glow.scale.setScalar(THREE.MathUtils.lerp(.5, 1.1, glowIn))

    // 金色菱形粒子：向四周 3D 散射 + 旋转闪光
    effect.diamonds.forEach((d, index) => {
      const t = Math.max(0, Math.min(1, (progress - .08 - index * .004) / .55))
      const fade = Math.sin(Math.min(1, t) * Math.PI)
      d.mesh.material.opacity = fade * .95
      // 直接计算目标坐标，避免每帧新建临时 Vector3 造成移动端 GC 压力。
      d.mesh.position.set(
        effect.burstAnchor.x + d.direction.x * d.speed * t,
        effect.burstAnchor.y + d.direction.y * d.speed * t,
        effect.burstAnchor.z + d.direction.z * d.speed * t,
      )
      d.mesh.rotation.x = time * .001 * d.spin
      d.mesh.rotation.y = time * .001 * d.spin * 1.3
    })

    // 曝光：星芒爆发时闪亮，之后略压暗衬托光晕，末尾回稳
    const impactProgress = Math.max(0, Math.min(1, (progress - .08) / .2))
    const impact = Math.sin(impactProgress * Math.PI) * (1 - THREE.MathUtils.smoothstep(progress, .3, .42))
    const dim = .82 + THREE.MathUtils.smoothstep(progress, .5, .9) * .1
    exposure = dim + impact * .42
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
  renderer = new THREE.WebGLRenderer({ canvas: canvas.value, antialias: aaEnabled, alpha: true, powerPreference: 'high-performance' })
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = BASE_EXPOSURE
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFShadowMap
  renderer.setClearColor(0x050706, 0)

  scene = new THREE.Scene()
  // 雾推到桌身之外（桌角最远约 30）：让整张桌（含对家远侧）都在雾区外，只让背景淡出。
  scene.fog = new THREE.Fog(0x03100b, 32, 60)
  const pmremGenerator = new THREE.PMREMGenerator(renderer)
  const roomEnvironment = new RoomEnvironment()
  const environmentTarget = own(pmremGenerator.fromScene(roomEnvironment, .04))
  // 环境反射只服务于麻将牌，避免墨玉桌面和金色桌边被整体提亮。
  scene.userData.tileEnvironment = environmentTarget.texture
  roomEnvironment.dispose()
  pmremGenerator.dispose()
  camera = new THREE.PerspectiveCamera(39, 1, .1, 60)
  // 斜俯视 55°（更接近俯拍，参考雀魂牌桌视角）：y = 水平距离 12.05 × tan(55°) ≈ 17.2
  camera.position.set(0, 17.2, 11.8)
  // 均匀亮（参考雀魂）：环境光（半球光）为主要基底，主光只做轻微方向感。
  // 半球光地面色提亮 + 强度拉高，让所有朝向的面都有基础亮度，避免右侧/远端掉进暗区。
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
  // 牌面用应用启动时预加载的共享表（可能已在内存中，直接带真实牌面）。
  scene.userData.tileImages = preloadedTileImages()
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

  // 等启动预加载完成（已完成则立即返回），确保图集带上全部真实牌面。
  await preloadTileImages()
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
    props.wall?.length,
    props.horses?.length,
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
