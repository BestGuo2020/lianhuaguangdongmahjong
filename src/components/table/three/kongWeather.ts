import * as THREE from 'three'
import { pointFromSeat } from '../../../game/core/presentation/tableLayout'
import type { KongWeatherCue } from '../../../game/core/presentation/kongWeather'
import { setWeatherFrame, type WeatherAssets } from './kongWeatherAssets'

/** Actor-relative right-to-left sweep; the local player's screen X decreases throughout. */
export function kongWindPosition(seat: number, localSeat = 0, progress = .5) {
  const t = THREE.MathUtils.clamp(progress, 0, 1)
  const eased = t * t * (3 - 2 * t)
  const point = pointFromSeat((seat - localSeat + 4) % 4, 2.8 - 6 * eased, 4.35)
  return { x: point.x, y: .09, z: point.z - 1.65 }
}

interface WeatherEffect {
  cue: KongWeatherCue
  root: THREE.Group
  frame(elapsed: number, progress: number): void
  dispose(): void
}

function buildWeather(scene: THREE.Scene, cue: KongWeatherCue, localSeat: number, assets: WeatherAssets, viewAspect: () => number): WeatherEffect {
  const root = new THREE.Group()
  root.name = `kong-weather-${cue.kind}`
  root.userData.seat = cue.seat
  root.userData.layer = cue.kind === 'rain' ? 'screen' : 'table'
  const resources = new Set<{ dispose(): void }>()
  const fades: Array<{ material: THREE.Material; opacity: number }> = []
  const updates: Array<(seconds: number) => void> = []
  const own = <T extends { dispose(): void }>(value: T) => { resources.add(value); return value }
  const material = <T extends THREE.Material>(value: T) => {
    own(value)
    value.transparent = true
    value.depthWrite = false
    if (cue.kind === 'rain') value.depthTest = false
    value.toneMapped = false
    value.userData.outlineParameters = { visible: false }
    fades.push({ material: value, opacity: value.opacity })
    return value
  }
  const texture = (name: keyof WeatherAssets['textures']) => {
    const value = own(assets.textures[name].clone())
    value.needsUpdate = true
    return value
  }
  const sprite = (map: THREE.Texture, color: number, opacity: number, additive = false) => {
    const item = new THREE.Sprite(material(new THREE.SpriteMaterial({ map, color, opacity,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending })))
    root.add(item)
    return item
  }
  const plane = (map: THREE.Texture, color: number, opacity: number, size: number, y: number) => {
    const item = new THREE.Mesh(own(new THREE.PlaneGeometry(size, size)), material(new THREE.MeshBasicMaterial({
      map, color, opacity, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    })))
    item.rotation.x = -Math.PI / 2
    item.position.y = y
    root.add(item)
    return item
  }
  const dummy = new THREE.Object3D()

  if (cue.kind === 'tornado') {
    // Original exported storm and wind-ring UV meshes replace the procedural wire coils.
    const stormGeometry = own(assets.meshes.storm.clone())
    stormGeometry.rotateX(-Math.PI / 2)
    const veil = texture('wind')
    veil.wrapS = THREE.RepeatWrapping
    const storm = new THREE.Mesh(stormGeometry, material(new THREE.MeshBasicMaterial({
      map: veil, color: 0xffe8c2, opacity: .48, side: THREE.DoubleSide,
    })))
    storm.scale.setScalar(7.4)
    root.add(storm)
    const pattern = texture('pattern'), mask = texture('mask')
    pattern.wrapS = pattern.wrapT = THREE.RepeatWrapping
    const undercurrent = new THREE.Mesh(own(assets.meshes.ground.clone()), material(new THREE.MeshBasicMaterial({
      map: pattern, alphaMap: mask, color: 0xf5c46f, opacity: .26, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
    })))
    undercurrent.rotation.x = -Math.PI / 2
    undercurrent.scale.setScalar(1.65)
    undercurrent.position.y = .025
    root.add(undercurrent)
    const moon = plane(texture('crescent'), 0xffb35b, .85, 3.5, .045)
    const glow = plane(texture('glow'), 0xffb451, .48, 2.6, .035)
    const ringGeometry = own(assets.meshes.ring.clone())
    for (let i = 0; i < 3; i++) {
      const map = texture('ribbon')
      map.wrapS = THREE.RepeatWrapping
      const ring = new THREE.Mesh(ringGeometry, material(new THREE.MeshBasicMaterial({
        map, color: i === 1 ? 0xffd490 : 0xfff3df, opacity: .52 - i * .08, side: THREE.DoubleSide,
      })))
      ring.scale.set(2.3 + i * .85, 3.4, 2.3 + i * .85)
      ring.position.y = .25 + i * .82
      root.add(ring)
      updates.push(seconds => {
        ring.rotation.y = seconds * (i % 2 ? 5 : -6) + i * 2
        ring.rotation.z = Math.sin(seconds * 2 + i) * .09
        map.offset.x = -seconds * .65 + i * .3
      })
    }
    for (let i = 0; i < 2; i++) {
      const mist = sprite(texture('wind'), 0xffecc9, .13)
      mist.scale.set(3.4, 2.3, 1)
      mist.position.y = 1.35 + i * .45
      updates.push(seconds => { mist.material.rotation = Math.sin(seconds * 1.7 + i) * .3 })
    }
    for (let i = 0; i < 12; i++) {
      const star = sprite(texture('star'), 0xffdf9b, .8, true)
      updates.push(seconds => {
        const phase = (seconds * .7 + i * .137) % 1, angle = i * 2.4 - seconds * 3.8
        star.position.set(Math.cos(angle) * (1.1 + phase * .65), .2 + phase * 2.6, Math.sin(angle) * (1.1 + phase * .65))
        star.scale.setScalar(.11 + Math.sin(phase * Math.PI) * .08)
        star.material.opacity *= Math.sin(phase * Math.PI)
      })
    }
    updates.push(seconds => {
      storm.rotation.y = -seconds * 4.2
      veil.offset.x = seconds * .3
      pattern.offset.set(seconds * .12, -seconds * .2)
      moon.rotation.z = seconds * 2.1
      glow.material.opacity *= .8 + .2 * Math.sin(seconds * 5)
    })
  } else {
    // Camera-facing foreground rain: no perspective ground planes or local puddle patch.
    for (let i = 0; i < 5; i++) {
      const map = texture('smoke')
      setWeatherFrame(map, i % 4, 2, 2)
      const cloud = sprite(map, 0x4d95b5, .23)
      cloud.renderOrder = 1
      updates.push(seconds => {
        cloud.position.set(((i % 3) - 1) * viewAspect() * .52, .25 - Math.floor(i / 3) * .6, 0)
        cloud.scale.set(viewAspect() * 1.5, 1.25, 1)
        cloud.material.rotation = Math.sin(seconds * .5 + i) * .08
      })
    }
    const drops = new THREE.InstancedMesh(own(new THREE.PlaneGeometry(1, 1)),
      material(new THREE.MeshBasicMaterial({ map: texture('rain'), color: 0xb6dcf4, opacity: .5, side: THREE.DoubleSide })), 160)
    own(drops)
    drops.frustumCulled = false
    drops.renderOrder = 2
    root.add(drops)
    updates.push(seconds => {
      for (let i = 0; i < drops.count; i++) {
        const fall = (i * .173 + seconds / .65) % 1
        const across = (i * .61803398875) % 1
        dummy.position.set((across * 2 - 1) * (viewAspect() + .13) - fall * .12, 1.15 - fall * 2.3, 0)
        dummy.rotation.set(0, 0, Math.PI / 2 - .06)
        dummy.scale.set(.13 + (i % 5) * .025, .0035 + (i % 3) * .001, 1)
        dummy.updateMatrix()
        drops.setMatrixAt(i, dummy.matrix)
      }
      drops.instanceMatrix.needsUpdate = true
    })
    for (let i = 0; i < 12; i++) {
      const map = texture('splash')
      const splash = sprite(map, 0xb3d9ed, .36)
      splash.renderOrder = 3
      splash.center.set(.5, .12)
      updates.push(seconds => {
        const cycle = (seconds + i * .137) % .75, age = cycle / .32
        splash.visible = age < 1
        splash.position.set(((i * .61803) % 1 * 2 - 1) * viewAspect() * .85, -.66 + (i % 3) * .18 - cycle * .06, 0)
        splash.scale.setScalar(.1 + (i % 3) * .025)
        setWeatherFrame(map, Math.min(15, age * 16), 4, 4)
      })
    }
  }
  // Both supplied 2×1 atlases are decorative tokens; they never generate score transfers.
  const wind = cue.kind === 'tornado'
  for (let i = 0; i < (cue.reducedMotion ? 4 : 16); i++) {
    const coin = wind ? i % 3 === 0 : i % 3 !== 0
    const map = texture(coin ? 'coin' : 'goldenTile')
    setWeatherFrame(map, i % 2, 2, 1)
    const token = sprite(map, 0xffd18a, .9, true)
    token.name = 'kong-gold-particle'
    token.renderOrder = 4
    const delay = .16 + (i >= 8 ? .32 : 0) + (i % 8) * .018
    const lifetime = 1.05 + (i % 4) * .12
    const angle = i * 2.39996
    updates.push(seconds => {
      const age = seconds - delay
      token.visible = age >= 0 && age < lifetime
      if (!token.visible) return
      const progress = age / lifetime
      const spread = 1 - Math.exp(-age * 2.2)
      if (wind) {
        // Released pieces trail the moving wind instead of remaining glued to its core.
        const origin = kongWindPosition(cue.seat, localSeat, cue.reducedMotion ? .5 : delay * 1000 / cue.duration)
        token.position.set(origin.x - root.position.x + Math.cos(angle) * spread * 2,
          .4 + (2.1 + i % 3 * .3) * age - 1.6 * age * age,
          origin.z - root.position.z + Math.sin(angle) * spread * 1.2)
      } else {
        token.position.set(Math.cos(angle) * spread * viewAspect() * .7,
          -.25 + Math.sin(angle) * spread * .4 + 1.15 * age - .65 * age * age, 0)
      }
      // The source frames have wide transparent margins; size for the visible glyph, not the atlas cell.
      const size = wind ? .72 + i % 3 * .14 : .12 + i % 3 * .02
      const turn = .45 + .55 * Math.abs(Math.cos(age * (7 + i % 3) + i))
      token.scale.set(size * turn, size, 1)
      token.material.rotation = angle + age * (i % 2 ? 2.8 : -2.8)
      token.material.opacity *= Math.min(1, progress / .12, (1 - progress) / .3)
    })
  }
  scene.add(root)
  return {
    cue, root,
    frame(elapsed, progress) {
      const fade = cue.reducedMotion ? 1 : Math.min(1, progress / .12, (1 - progress) / .24)
      if (cue.kind === 'tornado') {
        const position = kongWindPosition(cue.seat, localSeat, cue.reducedMotion ? .5 : progress)
        root.position.set(position.x, position.y, position.z)
        root.scale.setScalar(cue.reducedMotion ? .8 : .8 + .2 * Math.min(1, progress / .16))
      }
      fades.forEach(({ material, opacity }) => { material.opacity = opacity * Math.max(0, fade) })
      updates.forEach(update => update(cue.reducedMotion ? .45 : elapsed / 1000))
    },
    dispose() { root.removeFromParent(); resources.forEach(resource => resource.dispose()); resources.clear() },
  }
}

export function createKongWeather(options: {
  scene: THREE.Scene
  cues(): readonly KongWeatherCue[]
  localSeat(): number
  assets: WeatherAssets | null
}) {
  const active = new Map<number, WeatherEffect>()
  const screenScene = new THREE.Scene()
  const screenCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, .1, 10)
  screenCamera.position.z = 5
  let aspect = 1
  let localSeat = options.localSeat()
  function dispose() { active.forEach(effect => effect.dispose()); active.clear() }
  function animate(now: number) {
    if (!options.assets) return false
    if (options.localSeat() !== localSeat) { dispose(); localSeat = options.localSeat() }
    const live = options.cues().filter(cue => now >= cue.startedAt && now < cue.startedAt + cue.duration).slice(-4)
    // Consecutive concealed kongs refresh one rain curtain instead of darkening the screen repeatedly.
    const latestRain = live.filter(cue => cue.kind === 'rain').at(-1)
    const current = live.filter(cue => cue.kind !== 'rain' || cue === latestRain)
    const ids = new Set(current.map(cue => cue.id))
    for (const [id, effect] of active) if (!ids.has(id)) { effect.dispose(); active.delete(id) }
    for (const cue of current) {
      let effect = active.get(cue.id)
      if (!effect) { effect = buildWeather(cue.kind === 'rain' ? screenScene : options.scene, cue, localSeat, options.assets, () => aspect); active.set(cue.id, effect) }
      effect.frame(now - cue.startedAt, (now - cue.startedAt) / cue.duration)
    }
    return active.size > 0
  }
  function setAspect(value: number) {
    if (!Number.isFinite(value) || value <= 0 || value === aspect) return
    aspect = value
    screenCamera.left = -aspect
    screenCamera.right = aspect
    screenCamera.updateProjectionMatrix()
  }
  function renderOverlay(renderer: Pick<THREE.WebGLRenderer, 'autoClear' | 'clearDepth' | 'render'> & { info?: { autoReset: boolean } }) {
    if (!screenScene.children.length) return
    const autoClear = renderer.autoClear
    const autoReset = renderer.info?.autoReset
    try {
      renderer.autoClear = false
      if (renderer.info) renderer.info.autoReset = false
      renderer.clearDepth()
      renderer.render(screenScene, screenCamera)
    } finally {
      renderer.autoClear = autoClear
      if (renderer.info && autoReset !== undefined) renderer.info.autoReset = autoReset
    }
  }
  return { animate, dispose, setAspect, renderOverlay, screenScene,
    get visibleCues() { return [...active.values()].map(effect => ({ seat: effect.cue.seat, kind: effect.cue.kind })) },
    get visibleLayouts() { return [...active.values()].map(effect => ({ seat: effect.cue.seat, kind: effect.cue.kind, layer: effect.root.userData.layer, x: effect.root.position.x, z: effect.root.position.z })) },
  }
}
