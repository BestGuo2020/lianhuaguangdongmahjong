import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { TILE_TYPES } from '../../../game/core/rules/tiles'
import { windForSeat } from '../../../game/core/presentation/tableLayout'
import type { TileType } from '../../../game/core/contracts/types'
import { defaultTableTheme } from './tableTheme'
import type { TableTheme } from './tableTheme'
import { tableLiftSlots } from './tableLiftSlots'

/** 牌体材质：写实档用 PBR，二次元档用 Toon（cel）。 */
type TileMaterial = THREE.MeshPhysicalMaterial | THREE.MeshToonMaterial

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
  /** 已解码的外部桌布纹理；存在时优先于程序化桌面纹理。 */
  surfaceTexture?: THREE.Texture
  /** 主题牌背位图；缺失时回退到程序化渐变。 */
  tileBackTexture?: THREE.Texture
  own<T>(resource: T): T
  ownDynamic<T>(resource: T): T
  trackTileMaterial(material: TileMaterial): TileMaterial
  isGlossy(): boolean
  /** 二次元 cel 渲染：牌体用 MeshToonMaterial + 渐变 ramp，关闭 envMap/clearcoat。 */
  animeTable: boolean
}

// 二次元 cel 的 3 档明暗 ramp（暗 → 中 → 亮），由 MeshToonMaterial.gradientMap 消费。
let sharedToonGradientMap: THREE.DataTexture | null = null
export function toonGradientMap() {
  if (sharedToonGradientMap) return sharedToonGradientMap
  const data = new Uint8Array([
    150, 150, 150, 255,
    200, 200, 200, 255,
    255, 255, 255, 255,
  ])
  const texture = new THREE.DataTexture(data, 3, 1, THREE.RGBAFormat)
  texture.minFilter = THREE.NearestFilter
  texture.magFilter = THREE.NearestFilter
  texture.generateMipmaps = false
  texture.needsUpdate = true
  sharedToonGradientMap = texture
  return texture
}

export function createStaticTableScene(options: TableSceneOptions) {
  const { renderer, scene, props, own, ownDynamic, trackTileMaterial } = options
  const theme = options.theme ?? defaultTableTheme
  const PLAY_AREA_OFFSET_Z = options.playAreaOffsetZ
  const faceMaterials = new Map<string, TileMaterial>()
  // 环境反射只注入麻将牌材质，让圆角捕捉柔和室内高光；二次元档不需要（改用 cel ramp）。
  const tileEnvironment = scene.userData.tileEnvironment
  const tileEnvironmentParams = tileEnvironment && !options.animeTable ? { envMap: tileEnvironment } : {}

  // 二次元档：MeshToonMaterial + 3 档 ramp；写实档：MeshPhysicalMaterial。
  // PBR 独有字段 ToonMaterial 不认识，二次元档剔除，避免 setValues 警告与无效赋值。
  const PBR_ONLY_PROPS = new Set([
    'roughness', 'metalness', 'roughnessMap', 'metalnessMap',
    'clearcoat', 'clearcoatRoughness',
    'specularIntensity', 'specularColor', 'ior', 'envMap', 'envMapIntensity',
    'iridescence', 'iridescenceIOR', 'sheen', 'sheenRoughness', 'sheenColor',
    'transmission', 'thickness', 'attenuationDistance', 'attenuationColor',
  ])
  function tileMaterial(props: Record<string, unknown>): TileMaterial {
    if (options.animeTable) {
      const toonProps: Record<string, unknown> = {}
      for (const key of Object.keys(props)) {
        if (!PBR_ONLY_PROPS.has(key)) toonProps[key] = props[key]
      }
      return new THREE.MeshToonMaterial({ gradientMap: toonGradientMap(), ...toonProps })
    }
    return new THREE.MeshPhysicalMaterial(props)
  }
  let tileAoTexture: THREE.CanvasTexture | null = null

  function makeTileAoTexture() {
    if (tileAoTexture) return tileAoTexture
    const size = 128
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')
    const imageData = ctx.createImageData(size, size)
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const edge = Math.min(x, y, size - 1 - x, size - 1 - y) / (size * .18)
        const edgeShade = THREE.MathUtils.clamp(edge, 0, 1)
        const lowerShade = y / (size - 1)
        const value = Math.round(214 + edgeShade * 35 - lowerShade * 7)
        const offset = (y * size + x) * 4
        imageData.data[offset] = value
        imageData.data[offset + 1] = value
        imageData.data[offset + 2] = value
        imageData.data[offset + 3] = 255
      }
    }
    ctx.putImageData(imageData, 0, 0)
    tileAoTexture = own(new THREE.CanvasTexture(canvas))
    tileAoTexture.colorSpace = THREE.NoColorSpace
    tileAoTexture.channel = 1
    return tileAoTexture
  }

  const tileAoParams = theme.tileAoIntensity
    ? { aoMap: makeTileAoTexture(), aoMapIntensity: theme.tileAoIntensity }
    : {}

// 台面表面纹理（单张合成，避免 map 通道冲突）：
// - tableFelt：近白底 + 低对比度蓝灰颗粒（保持材质基础色、只做轻微明暗起伏），模拟绒面颗粒且不显脏；
// - tableVignette：径向渐变边缘压暗（中心亮、四周暗）。
// 无平铺（ClampToEdge），整张覆盖台面 UV。

/** 把主题的机械接缝（中央大盘 + 升牌槽）画到给定的 2D 画布上；无 tableGuide 则跳过。 */
function drawTableGuide(ctx: CanvasRenderingContext2D, size: number) {
  if (!theme.tableGuide) return
  const guideScale = size / 256
  const { dark, light, opacity, slotDark = dark, slotOpacity = opacity * .58 } = theme.tableGuide
  const roundedRectPath = (x: number, y: number, width: number, height: number, radius: number) => {
    x *= guideScale
    y *= guideScale
    width *= guideScale
    height *= guideScale
    radius *= guideScale
    const right = x + width
    const bottom = y + height
    ctx.moveTo(x + radius, y)
    ctx.lineTo(right - radius, y)
    ctx.quadraticCurveTo(right, y, right, y + radius)
    ctx.lineTo(right, bottom - radius)
    ctx.quadraticCurveTo(right, bottom, right - radius, bottom)
    ctx.lineTo(x + radius, bottom)
    ctx.quadraticCurveTo(x, bottom, x, bottom - radius)
    ctx.lineTo(x, y + radius)
    ctx.quadraticCurveTo(x, y, x + radius, y)
    ctx.closePath()
  }
  const traceCenterSeam = () => roundedRectPath(99, 99, 58, 58, 3.5)
  const traceLiftSlots = () => {
    // 从牌墙真实世界坐标反推桌布 UV；不再用截图像素猜位置。
    const guideSize = 256
    const surfaceHalf = 11.65
    const surfaceCenterZ = -1.62
    const worldToGuideX = (worldX: number) => (worldX + surfaceHalf) / (surfaceHalf * 2) * guideSize
    const worldToGuideZ = (worldZ: number) => (worldZ - surfaceCenterZ + surfaceHalf) / (surfaceHalf * 2) * guideSize
    const worldLengthToGuide = (length: number) => length / (surfaceHalf * 2) * guideSize
    tableLiftSlots().forEach((slot) => {
      const width = worldLengthToGuide(slot.orientation === 'horizontal' ? slot.length : slot.width)
      const height = worldLengthToGuide(slot.orientation === 'horizontal' ? slot.width : slot.length)
      roundedRectPath(
        worldToGuideX(slot.centerX) - width / 2,
        worldToGuideZ(slot.centerZ) - height / 2,
        width,
        height,
        Math.min(width, height) * .08,
      )
    })
  }
  const drawGuide = (
    offsetX: number,
    offsetY: number,
    strokeStyle: string,
    alpha: number,
    lineWidth: number,
    trace: () => void,
  ) => {
    ctx.save()
    ctx.translate(offsetX * guideScale, offsetY * guideScale)
    ctx.globalAlpha = alpha
    ctx.strokeStyle = strokeStyle
    ctx.lineWidth = lineWidth * guideScale
    ctx.lineJoin = 'round'
    ctx.beginPath()
    trace()
    ctx.stroke()
    ctx.restore()
  }
  // 中央大盘接缝保留原有层次。
  drawGuide(0, 0, dark, opacity, .3, traceCenterSeam)
  drawGuide(0, -.35, light, opacity * .3, .16, traceCenterSeam)
  // 升牌槽保持细尺寸，但用独立深色提高可读性；高光仍只作克制的单侧提边。
  drawGuide(0, 0, slotDark, slotOpacity, .25, traceLiftSlots)
  drawGuide(0, -.12, light, slotOpacity * .22, .12, traceLiftSlots)
}

/** 把外部桌布图与主题接缝合成到同一张纹理上，保留机械接缝的层次。 */
function composeSurfaceWithGuide(imageTexture: THREE.Texture): THREE.Texture {
  const size = 1024
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx || !imageTexture.image) return imageTexture
  try {
    ctx.drawImage(imageTexture.image as CanvasImageSource, 0, 0, size, size)
  } catch {
    return imageTexture
  }
  drawTableGuide(ctx, size)
  const texture = own(new THREE.CanvasTexture(canvas))
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), 8)
  return texture
}

function makeTableSurfaceTexture() {
  // 带机械接缝的主题用 1024：1 个真实纹理像素映射到画面约 1–2px，
  // 既能稳定显示，又不会像低分辨率放大线那样发粗。
  const size = theme.tableGuide ? 1024 : 256
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (theme.tableFelt) {
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, size, size)
    // 纹理会作为材质 map 直接参与基础色计算，不能用低 alpha 的深蓝像素
    // 假装“叠加”在白底上：putImageData 不会替我们完成透明混色，且材质默认不透明。
    // 这里使用接近白色的低对比度蓝灰像素，让 map 只改变明暗，不把基础蓝色压成黑蓝。
    const imageData = ctx.createImageData(size, size)
    for (let i = 0; i < imageData.data.length; i += 4) {
      const variation = Math.floor(Math.random() * (theme.tableFeltVariation ?? 16))
      imageData.data[i] = 232 + variation
      imageData.data[i + 1] = 238 + variation
      imageData.data[i + 2] = 248 + Math.floor(variation / 2)
      imageData.data[i + 3] = 255
    }
    ctx.putImageData(imageData, 0, 0)
  } else {
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, size, size)
  }
  if (theme.tableVignette) {
    const i = theme.tableVignette
    const grad = ctx.createRadialGradient(size / 2, size / 2, size * .16, size / 2, size / 2, size * .68)
    grad.addColorStop(0, 'rgba(0,0,0,0)')
    grad.addColorStop(1, `rgba(0,0,0,${i})`)
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, size, size)
  }
  drawTableGuide(ctx, size)
  const texture = own(new THREE.CanvasTexture(canvas))
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), 8)
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
  if (options.tileBackTexture) return options.tileBackTexture
  const surface = document.createElement('canvas')
  surface.width = 256
  surface.height = 352
  const ctx = surface.getContext('2d')
  const [c1, c2, c3] = theme.tileBackGradient ?? ['#3eb34a', '#26983a', '#176d2b']
  const gradient = ctx.createLinearGradient(22, 8, 232, 344)
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
  const [faceTop, faceMiddle, faceBottom] = theme.tileFaceGradient ?? ['#e9e8df', '#dad9d0', '#c9ccc2']
  if (options.animeTable) {
    // 二次元：扁平象牙底，明暗交给 ToonMaterial 的 ramp。
    ctx.fillStyle = faceTop
    ctx.fillRect(x, y, w, h)
  } else {
    const faceGradient = ctx.createLinearGradient(x, y, x + w, y + h)
    faceGradient.addColorStop(0, faceTop)
    faceGradient.addColorStop(.58, faceMiddle)
    faceGradient.addColorStop(1, faceBottom)
    ctx.fillStyle = faceGradient
    ctx.fillRect(x, y, w, h)
  }
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
  if (options.animeTable) {
    // 卡通高光：画在牌面图案之上，压成顶边一条硬边白色亮线。
    ctx.fillStyle = 'rgba(255,255,255,.8)'
    ctx.fillRect(x, y, w, h * .05)
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
  const material = trackTileMaterial(own(tileMaterial({
    map: texture,
    ...tileEnvironmentParams,
    ...tileAoParams,
    ...theme.tile.face,
  })))
  if (!options.animeTable && !options.isGlossy()) {
    const physical = material as THREE.MeshPhysicalMaterial
    physical.clearcoat = 0
    physical.clearcoatRoughness = 0
    physical.specularIntensity = 0
    physical.ior = 1.5
  }
  faceMaterials.set(key, material)
  return material
}

// 买马未中：不能用透明度弱化。透明牌会与桌布混色且触发透明排序，俯视角下牌面会近乎消失。
// 改用不透明、低饱和的哑光克隆；中马继续由正常彩色牌面与金光负责强调。
const dimmedMaterialCache = new Map<THREE.Material, THREE.Material>()
function configureDimmedHorseMaterial<T extends THREE.Material>(clone: T): T {
  clone.transparent = false
  clone.opacity = 1
  clone.depthWrite = true
  if (clone instanceof THREE.MeshPhysicalMaterial) {
    clone.color.set(0xe1e2dc)
    clone.emissive.set(0x454b47)
    clone.emissiveIntensity = .12
    clone.roughness = Math.max(clone.roughness, .68)
    clone.clearcoat = 0
    clone.envMapIntensity = .18
    clone.aoMapIntensity *= .55
  }
  return clone
}
function dimmedClone(material: THREE.Material) {
  if (!dimmedMaterialCache.has(material)) {
    const clone = configureDimmedHorseMaterial(material.clone())
    dimmedMaterialCache.set(material, clone)
  }
  return dimmedMaterialCache.get(material)!
}

function makeDimmedFaceMaterial(tile: TileType) {
  const key = `dim:${tile}`
  if (faceMaterials.has(key)) return faceMaterials.get(key)
  const material = configureDimmedHorseMaterial(makeFaceMaterial(tile).clone())
  faceMaterials.set(key, material)
  return material
}

// 未中马牌：不透明哑光牌体，保留完整牌面辨识度。
function makeDimmedHorseTile(tile: TileType) {
  const tileObj = new THREE.Group()
  const base = new THREE.Mesh(scene.userData.tileBaseGeometry, [
    dimmedClone(scene.userData.faceSide), dimmedClone(scene.userData.faceSide),
    dimmedClone(scene.userData.faceSide), dimmedClone(scene.userData.backMaterial),
    dimmedClone(scene.userData.faceSide), dimmedClone(scene.userData.faceSide),
  ])
  base.position.y = -.06
  base.castShadow = Boolean(theme.tileGeometry)
  base.receiveShadow = Boolean(theme.tileGeometry)
  tileObj.add(base)
  const cap = new THREE.Mesh(scene.userData.tileCapGeometry, [
    dimmedClone(scene.userData.tileSide), dimmedClone(scene.userData.tileSide),
    makeDimmedFaceMaterial(tile), dimmedClone(scene.userData.tileBottom),
    dimmedClone(scene.userData.tileSide), dimmedClone(scene.userData.tileSide),
  ])
  cap.position.y = .13
  cap.castShadow = Boolean(theme.tileGeometry)
  cap.receiveShadow = Boolean(theme.tileGeometry)
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
let atlasMaterial: TileMaterial | null = null
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
  const mat = trackTileMaterial(own(tileMaterial({
    map: texture,
    ...tileEnvironmentParams,
    ...tileAoParams,
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
  if (!options.animeTable && !options.isGlossy()) {
    const physical = mat as THREE.MeshPhysicalMaterial
    physical.clearcoat = 0
    physical.clearcoatRoughness = 0
    physical.specularIntensity = 0
    physical.ior = 1.5
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
  const mat = trackTileMaterial(own(tileMaterial({
    map: texture,
    ...tileEnvironmentParams,
    ...tileAoParams,
    ...theme.tile.face,
  })))
  if (!options.animeTable && !options.isGlossy()) {
    const physical = mat as THREE.MeshPhysicalMaterial
    physical.clearcoat = 0
    physical.clearcoatRoughness = 0
    physical.specularIntensity = 0
    physical.ior = 1.5
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

let jokerAtlasMaterial: TileMaterial | null = null
function getJokerAtlasMaterial() {
  if (!jokerAtlasMaterial) jokerAtlasMaterial = makeAtlasMaterial('joker')
  return jokerAtlasMaterial
}

let wildcardAtlasMaterial: TileMaterial | null = null
function getWildcardAtlasMaterial() {
  if (!wildcardAtlasMaterial) wildcardAtlasMaterial = makeAtlasMaterial('wildcard')
  return wildcardAtlasMaterial
}

let laiziAtlasMaterial: TileMaterial | null = null
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
  item.castShadow = theme.staticTableCastShadow !== false
  item.receiveShadow = true
  scene.add(item)
  return item
}

function addTable() {
  const jade = own(tileMaterial({
    ...theme.table.jade,
    ...(options.surfaceTexture
      ? {
        map: theme.tableGuide
          ? composeSurfaceWithGuide(options.surfaceTexture)
          : options.surfaceTexture,
        color: theme.tableSurfaceTexture?.tint ?? 0xffffff,
      }
      : theme.tableFelt || theme.tableVignette
        ? { map: makeTableSurfaceTexture() }
        : {}),
  }))
  const darkJade = own(tileMaterial({ ...theme.table.darkJade }))
  const gold = own(tileMaterial({ ...theme.table.gold }))
  const goldHighlight = own(tileMaterial({ ...theme.table.goldHighlight }))
  const machine = own(tileMaterial({ ...theme.table.machine }))
  scene.userData.tileSide = trackTileMaterial(own(tileMaterial({
    ...tileEnvironmentParams,
    ...tileAoParams,
    ...theme.tile.side,
    ...(options.animeTable ? { color: 0xc8b7a5 } : {}),
  })))
  scene.userData.faceSide = trackTileMaterial(own(tileMaterial({
    ...tileEnvironmentParams,
    ...tileAoParams,
    ...theme.tile.faceSide,
  })))
  scene.userData.tileBottom = trackTileMaterial(own(tileMaterial({
    ...tileEnvironmentParams,
    ...tileAoParams,
    ...theme.tile.bottom,
    ...(options.animeTable ? { color: 0xc4bba8 } : {}),
  })))
  scene.userData.backMaterial = trackTileMaterial(own(tileMaterial({
    map: makeBackTexture(),
    ...tileEnvironmentParams,
    ...tileAoParams,
    ...theme.tile.back,
  })))
  scene.userData.highlightMaterial = own(new THREE.MeshStandardMaterial({ ...theme.highlight }))
  // 牌体几何由整桌共享，避免每次手牌、牌河更新时重复构建和销毁圆角网格。
  // 绿色牌背层略微内收，白色正面层形成完整外轮廓。
  const tileGeometry = theme.tileGeometry ?? { segments: 6, baseRadius: .07, capRadius: .072 }
  scene.userData.tileBaseGeometry = own(new RoundedBoxGeometry(.68, .22, .94, tileGeometry.segments, tileGeometry.baseRadius))
  scene.userData.tileCapGeometry = own(new RoundedBoxGeometry(.69, .34, .95, tileGeometry.segments, tileGeometry.capRadius))
  if (theme.tileAoIntensity) {
    ;[scene.userData.tileBaseGeometry, scene.userData.tileCapGeometry].forEach((geometry: THREE.BufferGeometry) => {
      const uv = geometry.getAttribute('uv')
      if (uv) geometry.setAttribute('uv1', uv.clone())
    })
  }

  // 墨玉台芯、鎏金托边与双层金线保持原有牌桌尺寸，不影响牌河和副露坐标。
  // 几何正方形：宽 = 深 = 21.8，桌身中心保持在 z=-1.65。
  // 素面主题（plainSurface）：只建桌身 + 台面两层，跳过鎏金托边/金线/饰钉。
  // 带包边的主题：桌身/台面随边框外扩（外移约 1.5 个麻将，避免边框悬空/露底）。
  const hasWideTrim = Boolean(theme.woodTrim || theme.edgeTrim)
  const tableHalf = hasWideTrim ? 12.5 : 10.9
  const surfaceHalf = hasWideTrim ? 11.65 : 10.52
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
  // 木框：内沿 10.2（牌河边界）、外沿 11.0，条宽 .8；垂直厚度取半个麻将厚度（.34 × .5 = .17）。
  if (theme.woodTrim) {
    // 顶面：全幅木纹 + 噪点凹凸/光泽不均；立面（内/外/底面）：纯色木料，避免立面 UV 拉伸成塑料感。
    const woodFinish = theme.woodTrimMaterial ?? {}
    const woodTop = own(tileMaterial({
      map: makeWoodTexture(),
      bumpMap: makeWoodDetailTexture(),
      bumpScale: .01,
      roughnessMap: makeWoodDetailTexture(),
      color: 0xffffff,
      roughness: .45,
      metalness: .05,
      clearcoat: .3,
      clearcoatRoughness: .3,
      ...woodFinish,
    }))
    const woodSide = own(tileMaterial({
      color: 0x6b421f,
      roughness: .5,
      metalness: .05,
      clearcoat: .25,
      clearcoatRoughness: .35,
      ...woodFinish,
    }))
    // 木框保持原有宽度，避免影响雀魂主题的牌墙空间。
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
    const woodTrimThickness = .34 * .5
    const frameGeometry = own(new THREE.ExtrudeGeometry(shape, { depth: woodTrimThickness, bevelEnabled: false }))
    // ExtrudeGeometry 材质组顺序：[0]=侧面, [1]=顶面, [2]=底面
    // 位置补偿：shape 中心 (12.4,12.4) → 世界 (0, 桌心 z=-1.65)；深度 .16 旋转后 y 0..0.16 → 中心 .08 → pos.y=.06（顶 .22）
    const frame = addStaticMesh(frameGeometry, [woodSide, woodTop, woodSide], -12.4, .05, 10.75)
    frame.rotation.x = -Math.PI / 2 // XY 平面挤出 → 水平放置，挤出方向朝上（顶 .22、底 .05）
  }

  // 非木质主题使用中等宽度的硬质包边：保留边缘层次，但不压过桌面主体。
  if (!theme.woodTrim && theme.edgeTrim) {
    const outerHalf = 12.4
    const innerHalf = outerHalf - (theme.edgeTrimWidth ?? .65)
    const outer = outerHalf * 2
    const inner = outerHalf - innerHalf
    const trimShape = new THREE.Shape()
    trimShape.moveTo(0, 0)
    trimShape.lineTo(outer, 0)
    trimShape.lineTo(outer, outer)
    trimShape.lineTo(0, outer)
    trimShape.closePath()
    const trimHole = new THREE.Path()
    trimHole.moveTo(inner, inner)
    trimHole.lineTo(inner, outer - inner)
    trimHole.lineTo(outer - inner, outer - inner)
    trimHole.lineTo(outer - inner, inner)
    trimHole.closePath()
    trimShape.holes.push(trimHole)
    const trimMaterial = own(tileMaterial({ ...theme.edgeTrim }))
    const trimGeometry = own(new THREE.ExtrudeGeometry(trimShape, { depth: .17, bevelEnabled: false }))
    const trim = addStaticMesh(
      trimGeometry,
      theme.edgeTrimTopMatchesSurface ? [trimMaterial, jade, trimMaterial] : trimMaterial,
      -outerHalf,
      .05,
      -1.65 + outerHalf,
    )
    trim.rotation.x = -Math.PI / 2

    if (theme.edgeAccent) {
      const accentMaterial = own(tileMaterial(theme.edgeAccentMaterial ?? {
        ...theme.table.goldHighlight,
        color: 0xe2c15f,
        emissive: 0x4b350a,
        emissiveIntensity: .32,
        roughness: .3,
        metalness: .82,
        clearcoat: .26,
        clearcoatRoughness: .24,
      }))
      const accentOffset = 11.98
      const accentLength = 23.1
      const accentY = .25
      addStaticMesh(new THREE.BoxGeometry(accentLength, .06, .09), accentMaterial, 0, accentY, -1.65 - accentOffset)
      addStaticMesh(new THREE.BoxGeometry(accentLength, .06, .09), accentMaterial, 0, accentY, -1.65 + accentOffset)
      addStaticMesh(new THREE.BoxGeometry(.09, .06, accentLength), accentMaterial, -accentOffset, accentY, -1.65)
      addStaticMesh(new THREE.BoxGeometry(.09, .06, accentLength), accentMaterial, accentOffset, accentY, -1.65)

      const ornamentGeometry = new THREE.TorusGeometry(.18, .035, 8, 18, Math.PI * 1.6)
      ;[[-accentOffset, -1.65, Math.PI / 2], [accentOffset, -1.65, -Math.PI / 2], [0, -1.65 - accentOffset, 0], [0, -1.65 + accentOffset, Math.PI]].forEach(([x, z, rotation]) => {
        const ornament = addStaticMesh(ornamentGeometry.clone(), accentMaterial, x, accentY + .025, z)
        ornament.rotation.x = Math.PI / 2
        ornament.rotation.z = rotation
      })
    }
  }

  const machineTop = own(tileMaterial({
    map: makeMachineTexture(),
    ...theme.table.machineTop,
  }))
  const machineBottom = own(tileMaterial({ ...theme.table.machineBottom }))
  const machineScale = theme.machineScale ?? 1
  const machineRelief = theme.machineRelief ?? 1
  addStaticMesh(new RoundedBoxGeometry(3.85 * machineScale, .2 * machineRelief, 3.85 * machineScale, 3, .22), gold, 0, .14, PLAY_AREA_OFFSET_Z)
  addStaticMesh(new RoundedBoxGeometry(3.58 * machineScale, .16 * machineRelief, 3.58 * machineScale, 3, .18), darkJade, 0, .25, PLAY_AREA_OFFSET_Z)
  const machineGeometry = own(new RoundedBoxGeometry(3.35 * machineScale, .28 * machineRelief, 3.35 * machineScale, 3, .16))
  const machineMesh = new THREE.Mesh(machineGeometry, [machine, machine, machineTop, machineBottom, machine, machine])
  machineMesh.position.set(0, .21 + (machineRelief - 1) * .1, PLAY_AREA_OFFSET_Z)
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
    forEachFaceMaterial(callback: (material: TileMaterial) => void) {
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
