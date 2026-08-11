import * as THREE from 'three'
import { addedKongTileOffset } from '../../../game/core/presentation/tableLayout'
import { meldSourceTileIndex } from '../../../game/core/rules/rules'
import { WIN_EFFECT_DURATION, winDisplayLayout } from '../../../game/core/presentation/winEffect'
import type { WinEffect } from '../../../game/core/contracts/gamePort'
import type { TileType } from '../../../game/core/contracts/types'
import type { ResolvedTableProps, TableTransform } from './tableRenderTypes'

interface DiamondParticle {
  mesh: THREE.Mesh<THREE.OctahedronGeometry, THREE.MeshBasicMaterial>
  direction: THREE.Vector3
  speed: number
  spin: number
}

interface WinEffectAnimation {
  startedAt: number
  anchor: THREE.Vector3
  burstAnchor: THREE.Vector3
  outward: THREE.Vector3
  beam: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshBasicMaterial>
  beamGlow: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshBasicMaterial>
  starburst: THREE.Sprite
  glow: THREE.Sprite
  diamonds: DiamondParticle[]
  winningTile: THREE.Group | null
  startPosition: THREE.Vector3
  startRotation: number
  seatRotation: number
  duration: number
  reducedMotion: boolean
}

interface WinEffectPresenterOptions {
  scene: THREE.Scene
  camera: THREE.Camera
  props: Readonly<ResolvedTableProps>
  tileLayerZ: number
  dynamicGroups: THREE.Object3D[]
  own<T>(resource: T): T
  ownDynamic<T>(resource: T): T
  makeFaceTile(tile: TileType): THREE.Group
  meldTransform(playerIndex: number, trackOffset: number): TableTransform
  alignMeldBottom(transform: TableTransform, playerIndex: number, rotated: boolean): TableTransform
  sourceTileRotationOffset(relativeSource: number): number
}

export function createWinEffectPresenter(options: WinEffectPresenterOptions) {
  const { scene, camera, props, dynamicGroups, own, ownDynamic, makeFaceTile } = options
  const { meldTransform, alignMeldBottom, sourceTileRotationOffset } = options
  const TILE_LAYER_Z = options.tileLayerZ
  let winEffectAnimation: WinEffectAnimation | null = null

function winEffectAnchor(playerIndex) {
  const layout = winDisplayLayout(playerIndex)
  return new THREE.Vector3(layout.x, layout.y, layout.z)
}

function cameraAlignedPoint(point: THREE.Vector3, planeY: number) {
  const direction = point.clone().sub(camera.position).normalize()
  const distance = (planeY - camera.position.y) / direction.y
  return camera.position.clone().addScaledVector(direction, distance)
}

// 四红中赢牌：摸到第 4 张红中直接胡牌时，该红中在手牌中，须在赢牌位置独立展示；
// 仅发牌即 4 红中（4 张都已亮花杠、手牌无红）时跳过，避免与花杠重复多出一张。
function isFourRedWin() {
  const tile = props.winPresentation?.tile ?? props.winEffect?.tile
  const winnerIndex = props.winPresentation?.winnerIndex ?? props.winEffect?.winnerIndex
  if (tile !== 'red' || winnerIndex < 0) return false
  const winner = props.players[winnerIndex]
  if (!winner || (winner.redCount ?? 0) < 4) return false
  return !winner.hand.includes('red')
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

function robbedKongSourceTransform(effect: WinEffect) {
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
    let sourcePlacement: TableTransform | null = null
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

  function animate(time: number) {
    if (!winEffectAnimation) return null
    const effect = winEffectAnimation
    const progress = Math.max(0, Math.min(1, (time - effect.startedAt) / effect.duration))
    const approach = effect.reducedMotion ? 1 : THREE.MathUtils.smoothstep(progress, .02, .15)
    if (effect.winningTile) {
      effect.winningTile.position.lerpVectors(effect.startPosition, effect.anchor, approach)
      effect.winningTile.rotation.set(0, THREE.MathUtils.lerp(effect.startRotation, effect.seatRotation, approach), 0)
      const pop = Math.sin(Math.min(1, approach) * Math.PI) * .28
      effect.winningTile.scale.setScalar(THREE.MathUtils.lerp(.7, 1, approach) + pop)
    }
    const beamIn = THREE.MathUtils.smoothstep(progress, .08, .15)
    const beamOut = 1 - THREE.MathUtils.smoothstep(progress, .55, 1)
    const beamVis = beamIn * beamOut
    effect.beam.material.opacity = beamVis * .8
    effect.beamGlow.material.opacity = beamVis * .32
    const burstIn = THREE.MathUtils.smoothstep(progress, .08, .16)
    const burstOut = 1 - THREE.MathUtils.smoothstep(progress, .3, .42)
    effect.starburst.material.opacity = burstIn * burstOut * .85
    effect.starburst.scale.setScalar(THREE.MathUtils.lerp(.4, 3, burstIn) * (1 + (1 - burstOut) * .2))
    const glowIn = THREE.MathUtils.smoothstep(progress, .3, .5)
    const glowOut = 1 - THREE.MathUtils.smoothstep(progress, .85, 1)
    effect.glow.material.opacity = glowIn * glowOut * .85
    effect.glow.scale.setScalar(THREE.MathUtils.lerp(.5, 1.1, glowIn))
    effect.diamonds.forEach((diamond, index) => {
      const t = Math.max(0, Math.min(1, (progress - .08 - index * .004) / .55))
      const fade = Math.sin(Math.min(1, t) * Math.PI)
      diamond.mesh.material.opacity = fade * .95
      diamond.mesh.position.set(
        effect.burstAnchor.x + diamond.direction.x * diamond.speed * t,
        effect.burstAnchor.y + diamond.direction.y * diamond.speed * t,
        effect.burstAnchor.z + diamond.direction.z * diamond.speed * t,
      )
      diamond.mesh.rotation.x = time * .001 * diamond.spin
      diamond.mesh.rotation.y = time * .001 * diamond.spin * 1.3
    })
    const impactProgress = Math.max(0, Math.min(1, (progress - .08) / .2))
    const impact = Math.sin(impactProgress * Math.PI) * (1 - THREE.MathUtils.smoothstep(progress, .3, .42))
    const exposure = .82 + THREE.MathUtils.smoothstep(progress, .5, .9) * .1 + impact * .42
    return {
      exposure,
      shakeX: effect.reducedMotion ? 0 : Math.sin(time * .075) * impact * .075,
      shakeZ: effect.reducedMotion ? 0 : Math.cos(time * .061) * impact * .055,
    }
  }

  return { addWinEffect, addWinningDisplayTile, animate, reset: () => { winEffectAnimation = null } }
}
