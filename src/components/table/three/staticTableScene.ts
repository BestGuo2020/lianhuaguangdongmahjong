import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { TILE_TYPES } from '../../../game/core/rules/tiles'
import { windForSeat } from '../../../game/core/presentation/tableLayout'
import type { TileType } from '../../../game/core/contracts/types'
import { defaultTableTheme } from './tableTheme'
import type { TableTheme } from './tableTheme'

interface TableSceneOptions {
  renderer: THREE.WebGLRenderer
  scene: THREE.Scene
  props: {
    wallCount: number
    currentPlayer: number
    dealerIndex: number
  }
  playAreaOffsetZ: number
  /** 主题配置；不传则用 defaultTableTheme。换肤 = 传另一份 TableTheme。 */
  theme?: TableTheme
  own<T>(resource: T): T
  ownDynamic<T>(resource: T): T
  trackTileMaterial(material: THREE.MeshPhysicalMaterial): THREE.MeshPhysicalMaterial
  isGlossy(): boolean
}

export function createStaticTableScene(options: TableSceneOptions) {
  const { renderer, scene, props, own, ownDynamic, trackTileMaterial } = options
  const theme = options.theme ?? defaultTableTheme
  const PLAY_AREA_OFFSET_Z = options.playAreaOffsetZ
  const faceMaterials = new Map<string, THREE.MeshPhysicalMaterial>()

// 台面表面纹理（单张合成，避免 map 通道冲突）：
// - tableFelt：白底 + 逐像素微噪点（近白亮灰、极低 alpha），只产生细微颗粒明暗，避免可见短线脏点；
// - tableVignette：径向渐变边缘压暗（中心亮、四周暗）。
// 无平铺（ClampToEdge），整张覆盖台面 UV。
function makeTableSurfaceTexture() {
  const size = 256
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (theme.tableFelt) {
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, size, size)
    const imageData = ctx.createImageData(size, size)
    for (let i = 0; i < imageData.data.length; i += 4) {
      const v = 235 + Math.floor(Math.random() * 20)
      imageData.data[i] = v
      imageData.data[i + 1] = v
      imageData.data[i + 2] = v
      imageData.data[i + 3] = 14 + Math.floor(Math.random() * 26)
    }
    ctx.putImageData(imageData, 0, 0)
  } else {
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, size, size)
  }
  if (theme.tableVignette) {
    const i = theme.tableVignette
    const grad = ctx.createRadialGradient(size / 2, size / 2, size * .18, size / 2, size / 2, size * .62)
    grad.addColorStop(0, 'rgba(0,0,0,0)')
    grad.addColorStop(1, `rgba(0,0,0,${i})`)
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, size, size)
  }
  const texture = own(new THREE.CanvasTexture(canvas))
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), 4)
  return texture
}

// 程序木纹：全幅单张（repeat 1 覆盖整个木框面），不规则弯曲年轮条带 + 细木丝 + 节疤，
// 避免平铺重复造成的「一块块复制塑料片」感。方向：条带沿纹理 u（世界 x），v（世界 z）分布。
function makeWoodTexture() {
  const w = 512
  const h = 512
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  const [c1, c2, c3] = theme.woodTrimColors ?? ['#7a4e2a', '#5f3a1e', '#462a14']
  const base = ctx.createLinearGradient(0, 0, 0, h)
  base.addColorStop(0, c1)
  base.addColorStop(.5, c2)
  base.addColorStop(1, c3)
  ctx.fillStyle = base
  ctx.fillRect(0, 0, w, h)
  // 不规则年轮条带：随机波浪线（每条第带独立波形）、宽度随机、深浅交替，部分分叉
  for (let i = 0; i < 46; i++) {
    const y = (i / 46) * h + (Math.random() - .5) * 24
    const dark = Math.random() > .45
    ctx.strokeStyle = dark
      ? `rgba(20,10,5,${.1 + Math.random() * .12})`
      : `rgba(255,225,185,${.05 + Math.random() * .08})`
    ctx.lineWidth = 1 + Math.random() * 5
    ctx.beginPath()
    ctx.moveTo(0, y)
    const amp = 3 + Math.random() * 12
    const cycles = 1 + Math.random() * 1.5
    for (let x = 0; x <= w; x += 16) {
      const yy = y + Math.sin((x / w) * Math.PI * 2 * cycles) * amp
      ctx.lineTo(x, yy)
    }
    ctx.stroke()
    // 分叉：约 1/4 条带末端分出短支
    if (Math.random() < .25) {
      ctx.beginPath()
      ctx.moveTo(w * .6, y + Math.sin(.6 * Math.PI * 2 * cycles) * amp)
      ctx.quadraticCurveTo(w * .72, y + 10, w * .82, y + 6)
      ctx.stroke()
    }
  }
  // 大块色差斑块：低 alpha 椭圆，模拟天然木色不均
  for (let i = 0; i < 5; i++) {
    const x = Math.random() * w
    const y = Math.random() * h
    const r = 40 + Math.random() * 90
    ctx.fillStyle = `rgba(255,235,200,${.03 + Math.random() * .05})`
    ctx.beginPath()
    ctx.ellipse(x, y, r, r * .5, Math.random() * Math.PI, 0, Math.PI * 2)
    ctx.fill()
  }
  // 细木丝：短纵向微弯细线
  for (let i = 0; i < 700; i++) {
    const x = Math.random() * w
    const y0 = Math.random() * h
    const len = 14 + Math.random() * 48
    ctx.strokeStyle = `rgba(0,0,0,${.015 + Math.random() * .04})`
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(x, y0)
    ctx.quadraticCurveTo(x + 2, y0 + len / 2, x + Math.random() * 2 - 1, y0 + len)
    ctx.stroke()
  }
  // 节疤：少量、纯随机、可聚簇（打破均匀节奏，避免「每 N 块牌一个」的平铺感）
  const knotCount = 2 + Math.floor(Math.random() * 3)
  for (let i = 0; i < knotCount; i++) {
    const x = Math.random() * w
    const y = Math.random() * h
    const r = 3 + Math.random() * 9
    ctx.strokeStyle = `rgba(25,12,4,${.18 + Math.random() * .12})`
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.ellipse(x, y, r, r * .55, Math.random() * Math.PI, 0, Math.PI * 2)
    ctx.stroke()
    if (Math.random() < .5) {
      // 聚簇：旁再画一个更小的节疤
      ctx.beginPath()
      ctx.ellipse(x + r * .8, y + r * .5, r * .45, r * .28, Math.random() * Math.PI, 0, Math.PI * 2)
      ctx.stroke()
    }
  }
  const texture = own(new THREE.CanvasTexture(canvas))
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), 8)
  return texture
}

// 木纹细节纹理：灰度噪点，作 bumpMap（微凹凸）+ roughnessMap（光泽不均），消除塑料均匀感。
function makeWoodDetailTexture() {
  const size = 256
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  const imageData = ctx.createImageData(size, size)
  for (let i = 0; i < imageData.data.length; i += 4) {
    const v = 128 + Math.floor(Math.random() * 100)
    imageData.data[i] = v
    imageData.data[i + 1] = v
    imageData.data[i + 2] = v
    imageData.data[i + 3] = 255
  }
  ctx.putImageData(imageData, 0, 0)
  const texture = own(new THREE.CanvasTexture(canvas))
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping
  texture.repeat.set(12, 12)
  return texture
}

function makeBackTexture() {
  const surface = document.createElement('canvas')
  surface.width = 256
  surface.height = 352
  const ctx = surface.getContext('2d')
  const gradient = ctx.createLinearGradient(22, 8, 232, 344)
  const [c1, c2, c3] = theme.tileBackGradient ?? ['#3eb34a', '#26983a', '#176d2b']
  gradient.addColorStop(0, c1)
  gradient.addColorStop(.46, c2)
  gradient.addColorStop(1, c3)
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
function drawTileFace(ctx: CanvasRenderingContext2D, tile: TileType, x: number, y: number, w: number, h: number, marker: 'joker' | 'wildcard' | 'laizi' | false = false) {
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
  if (marker) {
    // 按身份区分标记：精=真精牌/白板翻精（白板即精）；替=莲花麻将白板替身（可代本局精牌）；癞=广麻白板癞子。
    const markerLabel = marker === 'wildcard' ? '\u66ff' : marker === 'laizi' ? '\u764d' : '\u7cbe'
    const markerColor = marker === 'wildcard' ? '#b88220' : marker === 'laizi' ? '#c0342e' : '#08a9dc'
    const markerShadow = marker === 'wildcard' ? 'rgba(75,45,0,.85)' : marker === 'laizi' ? 'rgba(90,10,12,.85)' : 'rgba(0,40,70,.85)'
    ctx.save()
    ctx.fillStyle = markerColor
    ctx.beginPath()
    ctx.moveTo(x + w * .48, y)
    ctx.lineTo(x + w, y)
    ctx.lineTo(x + w, y + h * .42)
    ctx.closePath()
    ctx.fill()
    ctx.fillStyle = '#fff'
    ctx.shadowColor = markerShadow
    ctx.shadowBlur = Math.max(1, w * .008)
    ctx.font = `900 ${Math.max(16, Math.round(h * .15))}px sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(markerLabel, x + w * .79, y + h * .15)
    ctx.restore()
  }
}

function makeFaceMaterial(tile: TileType, marker: 'joker' | 'wildcard' | 'laizi' | false = false) {
  const key = marker ? `${marker}:${tile}` : tile
  if (faceMaterials.has(key)) return faceMaterials.get(key)
  const surface = document.createElement('canvas')
  surface.width = 384
  surface.height = 512
  drawTileFace(surface.getContext('2d'), tile, 0, 0, 384, 512, marker)
  const texture = own(new THREE.CanvasTexture(surface))
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), 8)
  const material = trackTileMaterial(own(new THREE.MeshPhysicalMaterial({
    map: texture,
    envMap: scene.userData.tileEnvironment,
    ...theme.tile.face,
  })))
  if (!options.isGlossy()) {
    material.clearcoat = 0
    material.clearcoatRoughness = 0
    material.specularIntensity = 0
    material.ior = 1.5
  }
  faceMaterials.set(key, material)
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

function makeTransparentFaceMaterial(tile: TileType) {
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
function makeDimmedHorseTile(tile: TileType) {
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
    ...theme.tile.face,
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
  if (!options.isGlossy()) {
    mat.clearcoat = 0
    mat.clearcoatRoughness = 0
    mat.specularIntensity = 0
    mat.ior = 1.5
  }
  atlasMaterial = mat
  return mat
}

function makeAtlasMaterial(marker: 'joker' | 'wildcard' | 'laizi') {
  const canvas = document.createElement('canvas')
  canvas.width = ATLAS_COLS * ATLAS_CELL_W
  canvas.height = ATLAS_ROWS * ATLAS_CELL_H
  const ctx = canvas.getContext('2d')
  TILE_TYPES.forEach((tile, i) => {
    const col = i % ATLAS_COLS
    const row = Math.floor(i / ATLAS_COLS)
    drawTileFace(ctx, tile, col * ATLAS_CELL_W, row * ATLAS_CELL_H, ATLAS_CELL_W, ATLAS_CELL_H, marker)
  })
  const texture = own(new THREE.CanvasTexture(canvas))
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), 4)
  const mat = trackTileMaterial(own(new THREE.MeshPhysicalMaterial({
    map: texture,
    envMap: scene.userData.tileEnvironment,
    ...theme.tile.face,
  })))
  if (!options.isGlossy()) {
    mat.clearcoat = 0
    mat.clearcoatRoughness = 0
    mat.specularIntensity = 0
    mat.ior = 1.5
  }
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
  mat.userData.atlasMaterial = true
  return mat
}

let jokerAtlasMaterial: THREE.MeshPhysicalMaterial | null = null
function getJokerAtlasMaterial() {
  if (!jokerAtlasMaterial) jokerAtlasMaterial = makeAtlasMaterial('joker')
  return jokerAtlasMaterial
}

let wildcardAtlasMaterial: THREE.MeshPhysicalMaterial | null = null
function getWildcardAtlasMaterial() {
  if (!wildcardAtlasMaterial) wildcardAtlasMaterial = makeAtlasMaterial('wildcard')
  return wildcardAtlasMaterial
}

let laiziAtlasMaterial: THREE.MeshPhysicalMaterial | null = null
function getLaiziAtlasMaterial() {
  if (!laiziAtlasMaterial) laiziAtlasMaterial = makeAtlasMaterial('laizi')
  return laiziAtlasMaterial
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
    ...theme.table.jade,
    ...(theme.tableFelt || theme.tableVignette ? { map: makeTableSurfaceTexture() } : {}),
  }))
  const darkJade = own(new THREE.MeshPhysicalMaterial({ ...theme.table.darkJade }))
  const gold = own(new THREE.MeshPhysicalMaterial({ ...theme.table.gold }))
  const goldHighlight = own(new THREE.MeshPhysicalMaterial({ ...theme.table.goldHighlight }))
  const machine = own(new THREE.MeshPhysicalMaterial({ ...theme.table.machine }))
  scene.userData.tileSide = trackTileMaterial(own(new THREE.MeshPhysicalMaterial({
    envMap: scene.userData.tileEnvironment,
    ...theme.tile.side,
  })))
  scene.userData.faceSide = trackTileMaterial(own(new THREE.MeshPhysicalMaterial({
    envMap: scene.userData.tileEnvironment,
    ...theme.tile.faceSide,
  })))
  scene.userData.tileBottom = trackTileMaterial(own(new THREE.MeshPhysicalMaterial({
    envMap: scene.userData.tileEnvironment,
    ...theme.tile.bottom,
  })))
  scene.userData.backMaterial = trackTileMaterial(own(new THREE.MeshPhysicalMaterial({
    map: makeBackTexture(),
    envMap: scene.userData.tileEnvironment,
    ...theme.tile.back,
  })))
  scene.userData.highlightMaterial = own(new THREE.MeshStandardMaterial({ ...theme.highlight }))
  // 牌体几何由整桌共享，避免每次手牌、牌河更新时重复构建和销毁圆角网格。
  // 绿色牌背层略微内收，白色正面层形成完整外轮廓。
  scene.userData.tileBaseGeometry = own(new RoundedBoxGeometry(.68, .22, .94, 6, .07))
  scene.userData.tileCapGeometry = own(new RoundedBoxGeometry(.69, .34, .95, 6, .072))

  // 墨玉台芯、鎏金托边与双层金线保持原有牌桌尺寸，不影响牌河和副露坐标。
  // 几何正方形：宽 = 深 = 21.8，桌身中心保持在 z=-1.65。
  // 素面主题（plainSurface）：只建桌身 + 台面两层，跳过鎏金托边/金线/饰钉。
  // woodTrim 主题：桌身/台面随木框外扩（木框外移 1.5 个麻将 ≈ 1.4 单位，避免悬空/露底）。
  const tableHalf = theme.woodTrim ? 12.5 : 10.9
  const surfaceHalf = theme.woodTrim ? 11.65 : 10.52
  addStaticMesh(new RoundedBoxGeometry(tableHalf * 2, .54, tableHalf * 2, 3, .18), darkJade, 0, -.37, -1.65)
  addStaticMesh(new RoundedBoxGeometry(surfaceHalf * 2, .18, surfaceHalf * 2, 3, .12), jade, 0, -.02, -1.62)
  if (!theme.plainSurface) {
    addStaticMesh(new RoundedBoxGeometry(21.46, .22, 21.46, 3, .13), gold, 0, -.14, -1.65)

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
  }

  // 木质包边（woodTrim）：台面四周一圈宽大木纹框，回字形挤出几何一体成型（四角零重叠，避免 z-fighting 闪烁）。
  // 台面 21.04 见方（半宽 10.52）、顶面 y≈.07；桌身半宽 10.9；牌河最远约 ±10.2（框内沿不得内缩越过）。
  // 木框：内沿 10.2（牌河边界）、外沿 11.0，条宽 .8、高 .16、中心 y=.14（顶 .22）。
  if (theme.woodTrim) {
    // 顶面：全幅木纹 + 噪点凹凸/光泽不均；立面（内/外/底面）：纯色木料，避免立面 UV 拉伸成塑料感。
    const woodTop = own(new THREE.MeshPhysicalMaterial({
      map: makeWoodTexture(),
      bumpMap: makeWoodDetailTexture(),
      bumpScale: .01,
      roughnessMap: makeWoodDetailTexture(),
      color: 0xffffff,
      roughness: .45,
      metalness: .05,
      clearcoat: .3,
      clearcoatRoughness: .3,
    }))
    const woodSide = own(new THREE.MeshPhysicalMaterial({
      color: 0x6b421f,
      roughness: .5,
      metalness: .05,
      clearcoat: .25,
      clearcoatRoughness: .35,
    }))
    // 木框相对台面外移 1.5 个麻将（1.5 × 牌长 .94 ≈ 1.4）：内沿 10.2→11.6、外沿 11.0→12.4（条宽 .8 不变）。
    // 台面/桌身已随之外扩（surfaceHalf 11.65 / tableHalf 12.5），框不悬空、绒布无露底。
    const outer = 24.8
    const inner = 23.2
    // ⚠️ shape 必须建在第一象限（0..24.8）：ExtrudeGeometry 顶面 UV 按 shape 坐标/包围盒生成，
    // 若中心在原点则 UV 为 -0.5..0.5，ClampToEdge 下纹理只剩 1/4 象限 + 边缘拉伸（伪重复）。
    const shape = new THREE.Shape()
    shape.moveTo(0, 0)
    shape.lineTo(outer, 0)
    shape.lineTo(outer, outer)
    shape.lineTo(0, outer)
    shape.closePath()
    const hole = new THREE.Path()
    hole.moveTo(inner, inner)
    hole.lineTo(inner, outer - inner)
    hole.lineTo(outer - inner, outer - inner)
    hole.lineTo(outer - inner, inner)
    hole.closePath()
    shape.holes.push(hole)
    const frameGeometry = own(new THREE.ExtrudeGeometry(shape, { depth: .16, bevelEnabled: false }))
    // ExtrudeGeometry 材质组顺序：[0]=侧面, [1]=顶面, [2]=底面
    // 位置补偿：shape 中心 (12.4,12.4) → 世界 (0, 桌心 z=-1.65)；深度 .16 旋转后 y 0..0.16 → 中心 .08 → pos.y=.06（顶 .22）
    const frame = addStaticMesh(frameGeometry, [woodSide, woodTop, woodSide], -12.4, .06, 10.75)
    frame.rotation.x = -Math.PI / 2 // XY 平面挤出 → 水平放置，挤出方向朝上（顶 .22、底 .06）
  }

  const machineTop = own(new THREE.MeshPhysicalMaterial({
    map: makeMachineTexture(),
    ...theme.table.machineTop,
  }))
  const machineBottom = own(new THREE.MeshPhysicalMaterial({ ...theme.table.machineBottom }))
  addStaticMesh(new RoundedBoxGeometry(3.85, .2, 3.85, 3, .22), gold, 0, .14, PLAY_AREA_OFFSET_Z)
  addStaticMesh(new RoundedBoxGeometry(3.58, .16, 3.58, 3, .18), darkJade, 0, .25, PLAY_AREA_OFFSET_Z)
  const machineGeometry = own(new RoundedBoxGeometry(3.35, .28, 3.35, 3, .16))
  const machineMesh = new THREE.Mesh(machineGeometry, [machine, machine, machineTop, machineBottom, machine, machine])
  machineMesh.position.set(0, .21, PLAY_AREA_OFFSET_Z)
  machineMesh.castShadow = true
  machineMesh.receiveShadow = true
  scene.add(machineMesh)
}

  return {
    addTable,
    updateMachineTexture,
    makeFaceMaterial,
    makeDimmedHorseTile,
    makeGoldGlow,
    makeGoldVerticalGlow,
    getAtlasCapGeometry,
    atlasCellUvFor,
    getAtlasMaterial,
    getJokerAtlasMaterial,
    getWildcardAtlasMaterial,
    getLaiziAtlasMaterial,
    forEachFaceMaterial(callback: (material: THREE.MeshPhysicalMaterial) => void) {
      faceMaterials.forEach(callback)
    },
    invalidateTileFaces() {
      faceMaterials.clear()
      atlasMaterial = null
      jokerAtlasMaterial = null
      wildcardAtlasMaterial = null
      laiziAtlasMaterial = null
    },
  }
}
