<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as THREE from 'three'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { preloadTileImages, preloadedTileImages } from '../game/core/presentation/tileAssets'
import type { GamePlayer, TableActionEvent, TileType, WinPresentation } from '../game/core/contracts/types'
import type { DealAnimation, OpeningStage, WinEffect } from '../game/core/contracts/gamePort'
import { createAdaptiveQualityController, parseQualityOverride, QUALITY_LEVELS } from './table/three/adaptiveQuality'
import { createDicePresenter } from './table/three/dicePresenter'
import { createPerfHud } from './table/three/perfHud'
import { createStaticTableScene } from './table/three/staticTableScene'
import { createTileInstanceRenderer } from './table/three/tileInstanceRenderer'
import { createWinEffectPresenter } from './table/three/winEffectPresenter'
import { createTableTilePresenter } from './table/three/tableTilePresenter'

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
  winEffect?: WinEffect | null
  winPresentation?: WinPresentation | null
  dealAnimation?: DealAnimation
  openingStage?: OpeningStage | null
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
let winEffectPresenter: ReturnType<typeof createWinEffectPresenter> | null = null
let dicePresenter: ReturnType<typeof createDicePresenter> | null = null
let perfHud: ReturnType<typeof createPerfHud> | null = null
const staticResources = []
const dynamicResources = []
let tableScene: ReturnType<typeof createStaticTableScene>
let tableTiles: ReturnType<typeof createTableTilePresenter>
// 中控台与墨玉台面的 Z 中心（桌身中心，保持不变）
const PLAY_AREA_OFFSET_Z = -1.65
// 牌层（牌墙/牌河/手牌/副露/骰子）的 Z 中心：单独向本家（+z）偏移，靠近玩家侧
const TILE_LAYER_Z = -1.0
const BASE_EXPOSURE = .92
const TILE_GAP_OFFSET = .685    // 手牌间隙和加杠偏移量
const POINT_GAP_OFFSET = 0.965  // 副露指向的偏移量
// 副露带逼近手牌时，手牌让位后的「副露-暗手」间距：原 .62 ≈ 半个麻将，改为 1.24 ≈ 一个麻将牌。
const MELD_HAND_GAP = 1.24
// 下家（右家）副露整体向上（-z）移动 3 个麻将牌（3 × 牌宽 0.68），给摸牌位（右侧 -z 顶端）留出间隙。
const MELD_UP_MOVE = 3 * .68
const WALL_DEAL_ORIGIN_Y = 1.1  // 发牌从牌山 head 槽位上方起飞的初始高度（略高于两墩牌顶）

// 渲染分辨率上限（清晰度 vs 帧率）：默认 3 取设备原生 DPR，真机实测本设备 2.2 vs 2.0 帧率无差，原生清晰免费。
// URL 带 ?pr=<数字> 可覆盖。
const DEFAULT_PIXEL_RATIO_CAP = 3
let pixelRatioCap = parseFloat(new URLSearchParams(window.location.search).get('pr') ?? '') || DEFAULT_PIXEL_RATIO_CAP

// 抗锯齿开关：默认开；URL 带 ?aa=off 关闭 MSAA（省一大截 fill，但牌边缘会出现锯齿）。
const aaEnabled = new URLSearchParams(window.location.search).get('aa') !== 'off'
const adaptiveQuality = createAdaptiveQualityController({
  override: parseQualityOverride(window.location.search),
  onChange: applyQuality,
})
let lastFrameAt = 0

function own(resource) {
  staticResources.push(resource)
  return resource
}

function ownDynamic(resource) {
  dynamicResources.push(resource)
  return resource
}



function clearDynamicScene() {
  dynamicGroups.forEach((group) => scene.remove(group))
  // Presenters/renderers retain this array by reference. Keep the identity stable
  // so every subsequently-created dynamic object remains visible to cleanup.
  dynamicGroups.length = 0
  winEffectPresenter?.reset()
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
  return makeTableTile(tableScene.makeFaceMaterial(tileName))
}

const scratchVector = new THREE.Vector3()
let tileInstances: ReturnType<typeof createTileInstanceRenderer>

function beginTableInstances() {
  tileInstances.begin()
}
function addTableTile(pos, quat, face, scale = 1, initialPos = null, initialScale = null) {
  return tileInstances.add(pos, quat, face, scale, initialPos, initialScale)
}
function setTileInstance(baseIndex, capMesh, capIndex, pos, quat, scale) {
  tileInstances.set(baseIndex, capMesh, capIndex, pos, quat, scale)
}
function finishTableInstances() {
  tileInstances.finish()
}


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
  tableScene?.forEachFaceMaterial(change)
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

function applyQuality(levelIndex = adaptiveQuality.level) {
  const level = QUALITY_LEVELS[levelIndex]
  applyGlossy(level.glossy)
  if (shadowLight && shadowLight.shadow.mapSize.x !== level.shadowSize) {
    shadowLight.shadow.mapSize.set(level.shadowSize, level.shadowSize)
    shadowLight.shadow.map?.dispose()
    shadowLight.shadow.map = null
    shadowLight.shadow.needsUpdate = true
  }
}

function render(time = 0) {
  if (!renderer) return
  perfHud?.frame(time)
  const frameMs = lastFrameAt ? time - lastFrameAt : 0
  lastFrameAt = time
  adaptiveQuality.frame(frameMs)
  let cameraShakeX = 0
  let cameraShakeZ = 0
  let exposure = BASE_EXPOSURE
  dicePresenter?.animate(time)
  tableTiles.animate(time, scratchVector)
  const winFrame = winEffectPresenter?.animate(time)
  if (winFrame) {
    exposure = winFrame.exposure
    cameraShakeX = winFrame.shakeX
    cameraShakeZ = winFrame.shakeZ
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
  tableScene = createStaticTableScene({
    renderer,
    scene,
    props,
    playAreaOffsetZ: PLAY_AREA_OFFSET_Z,
    own,
    ownDynamic,
    trackTileMaterial,
    isGlossy: () => glossyMaterials,
  })
  tileInstances = createTileInstanceRenderer({
    scene,
    ownDynamic,
    dynamicGroups,
    getAtlasMaterial: tableScene.getAtlasMaterial,
    getAtlasCapGeometry: tableScene.getAtlasCapGeometry,
    atlasCellUvFor: tableScene.atlasCellUvFor,
  })
  tableTiles = createTableTilePresenter({
    props,
    scene,
    dynamicGroups,
    ownDynamic,
    clearDynamicScene,
    makeFaceTile,
    tableScene,
    tileInstances,
    tileLayerZ: TILE_LAYER_Z,
    playAreaOffsetZ: PLAY_AREA_OFFSET_Z,
    tileGapOffset: TILE_GAP_OFFSET,
    pointGapOffset: POINT_GAP_OFFSET,
    meldHandGap: MELD_HAND_GAP,
    meldUpMove: MELD_UP_MOVE,
    wallDealOriginY: WALL_DEAL_ORIGIN_Y,
    addWinEffect: () => winEffectPresenter?.addWinEffect(),
    addWinningDisplayTile: () => winEffectPresenter?.addWinningDisplayTile(),
  })
  winEffectPresenter = createWinEffectPresenter({
    scene,
    camera,
    props,
    tileLayerZ: TILE_LAYER_Z,
    dynamicGroups,
    own,
    ownDynamic,
    makeFaceTile,
    meldTransform: tableTiles.meldTransform,
    alignMeldBottom: tableTiles.alignMeldBottom,
    sourceTileRotationOffset: tableTiles.sourceTileRotationOffset,
  })
  dicePresenter = createDicePresenter({
    scene,
    own,
    getOpeningStage: () => props.openingStage,
    getValues: () => props.diceValues,
    getDealerIndex: () => props.dealerIndex,
    tileLayerZ: TILE_LAYER_Z,
  })

  // 静态牌桌与暗牌不依赖牌面图片，必须先绘制首帧，避免线上加载图片时长时间黑屏。
  // 牌面用应用启动时预加载的共享表（可能已在内存中，直接带真实牌面）。
  scene.userData.tileImages = preloadedTileImages()
  tableScene.addTable()
  tableTiles.rebuild()
  if (adaptiveQuality.overridden) adaptiveQuality.apply()
  resizeObserver = new ResizeObserver(resize)
  resizeObserver.observe(canvas.value)
  resize()
  perfHud = createPerfHud(
    import.meta.env.DEV && new URLSearchParams(window.location.search).has('perf'),
    () => ({
      drawCalls: renderer?.info.render.calls ?? 0,
      triangles: renderer?.info.render.triangles ?? 0,
      pixelRatio: renderer?.getPixelRatio() ?? 2,
      qualityLevel: adaptiveQuality.level,
      glossy: glossyMaterials,
    }),
  )
  render()

  // 等启动预加载完成（已完成则立即返回），确保图集带上全部真实牌面。
  await preloadTileImages()
  if (destroyed) return
  // 图集在图片就绪前可能已用空底构建，需失效让下一次重建带上真实牌面。
  tableScene.invalidateTileFaces()
  tableTiles.rebuild()
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
  // 发牌批次只刷新已有实例的 count / matrix / UV，避免每 150-260ms
  // 销毁并重建整套 InstancedMesh 与 GPU buffer。
  () => tableTiles?.rebuild({ reuseInstances: props.openingStage === 'deal' }),
)

watch(() => props.openingStage, (stage) => {
  dicePresenter?.setVisible(stage === 'dice')
})

watch(() => props.dealerIndex, () => tableScene?.updateMachineTexture())

// 剩余牌数与当前玩家只影响中央机器 LCD（数字 / 高亮边），单独监听即可，避免整桌重建
watch(() => props.wallCount, () => tableScene?.updateMachineTexture())
watch(() => props.currentPlayer, () => tableScene?.updateMachineTexture())

onBeforeUnmount(() => {
  destroyed = true
  cancelAnimationFrame(animationFrame)
  perfHud?.destroy()
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
