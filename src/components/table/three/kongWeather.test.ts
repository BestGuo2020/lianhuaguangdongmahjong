import * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'
import { createKongWeather, kongWindPosition } from './kongWeather'
import type { KongWeatherCue } from '../../../game/core/presentation/kongWeather'
import { parseWeatherMesh, WEATHER_MESH_FILES, WEATHER_TEXTURE_FILES, type WeatherAssets } from './kongWeatherAssets'
// @ts-expect-error Node APIs are used only by Vitest, not the browser application.
import { readFileSync } from 'node:fs'

const assets: WeatherAssets = {
  textures: Object.fromEntries(Object.entries(WEATHER_TEXTURE_FILES).map(([key, file]) => {
    const texture = new THREE.Texture(); texture.name = file
    return [key, texture]
  })) as WeatherAssets['textures'],
  meshes: Object.fromEntries(Object.entries(WEATHER_MESH_FILES).map(([key, file]) =>
    [key, parseWeatherMesh(readFileSync(`public/effects/yaotong-weather/${file}`, 'utf8'))],
  )) as WeatherAssets['meshes'],
}

const cue = (kind: KongWeatherCue['kind'], seat = 0): KongWeatherCue => ({ id: seat + 1, seat, kind, startedAt: 100, duration: 2200, reducedMotion: false })
describe('3D开杠天气', () => {
  it.each(['tornado', 'rain'] as const)('%s使用两款金色粒子，分批飞散后淡出，不改变原始事件', kind => {
    const input = [cue(kind)], before = structuredClone(input), scene = new THREE.Scene()
    const weather = createKongWeather({ scene, assets, cues: () => input, localSeat: () => 0 })
    weather.animate(100)
    const layer = kind === 'rain' ? weather.screenScene : scene
    const tokens = layer.children[0].children.filter(object => object.name === 'kong-gold-particle') as THREE.Sprite[]
    expect(tokens).toHaveLength(16)
    expect(tokens.every(token => !token.visible)).toBe(true)
    expect(new Set(tokens.map(token => token.material.map!.name))).toEqual(new Set(['effect_jinbi.png', 'golden_majiangzi.png']))
    for (const token of tokens) expect(token.material.map!.repeat.toArray()).toEqual([.5, 1])
    weather.animate(600)
    expect(tokens.filter(token => token.visible).length).toBeGreaterThan(0)
    const positions = tokens.map(token => token.position.clone())
    weather.animate(1100)
    expect(tokens.some((token, i) => token.visible && token.position.distanceTo(positions[i]) > .1)).toBe(true)
    weather.animate(2250)
    expect(tokens.every(token => !token.visible)).toBe(true)
    expect(input).toEqual(before)
    weather.dispose()
    expect(layer.children).toHaveLength(0)
  })

  it.each(['tornado', 'rain'] as const)('%s只建一次，牌桌刷新不重播，到期释放GPU资源', kind => {
    const scene = new THREE.Scene(), input = [cue(kind)]
    const weather = createKongWeather({ scene, assets, cues: () => input, localSeat: () => 0 })
    expect(weather.animate(0)).toBe(false)
    expect(weather.animate(600)).toBe(true)
    const layer = kind === 'rain' ? weather.screenScene : scene
    const root = layer.children[0]
    expect(root.userData.layer).toBe(kind === 'rain' ? 'screen' : 'table')
    if (kind === 'rain') expect(scene.children).toHaveLength(0)
    expect(weather.visibleCues).toEqual([{ seat: 0, kind }])
    const resources = new Set<THREE.BufferGeometry | THREE.Material | THREE.Texture>()
    root.traverse(object => {
      if (object instanceof THREE.Mesh || object instanceof THREE.Sprite) {
        if (object instanceof THREE.Mesh) resources.add(object.geometry)
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
          resources.add(material)
          const mapped = material as THREE.MeshBasicMaterial
          if (mapped.map) resources.add(mapped.map)
          if (mapped.alphaMap) resources.add(mapped.alphaMap)
        }
      }
    })
    const spies = [...resources].map(resource => vi.spyOn(resource, 'dispose'))
    expect([...resources].some(resource => resource instanceof THREE.Texture && resource.name === (kind === 'rain' ? 'water_splash_4x4_blue.png' : 'wind_trail.png'))).toBe(true)
    expect([...resources].every(resource => !Object.values(assets.textures).includes(resource as THREE.Texture))).toBe(true)
    expect(weather.animate(700)).toBe(true)
    expect(layer.children).toEqual([root])
    expect(weather.animate(2300)).toBe(false)
    expect(layer.children).toHaveLength(0)
    spies.forEach(spy => expect(spy).toHaveBeenCalledOnce())
    expect(weather.animate(2400)).toBe(false)
    expect(layer.children).toHaveLength(0)
  })

  it('不同玩家可同时开杠；取消提示立即清理对应效果', () => {
    const scene = new THREE.Scene()
    let input = [cue('rain', 1), cue('tornado', 2)]
    const weather = createKongWeather({ scene, assets, cues: () => input, localSeat: () => 1 })
    weather.animate(600)
    expect(scene.children).toHaveLength(1)
    expect(scene.children[0].userData.seat).toBe(2)
    expect(weather.screenScene.children[0].userData.seat).toBe(1)
    input = [input[1]]
    weather.animate(700)
    expect(weather.visibleCues).toEqual([{ seat: 2, kind: 'tornado' }])
    expect(weather.screenScene.children).toHaveLength(0)
    weather.dispose()
    expect(scene.children).toHaveLength(0)
  })

  it('减少动态效果保留静态云雨标识，不旋转或高速落雨', () => {
    const scene = new THREE.Scene(), input = [{ ...cue('rain'), reducedMotion: true, duration: 600 }]
    const weather = createKongWeather({ scene, assets, cues: () => input, localSeat: () => 0 })
    weather.animate(200)
    const tokens = weather.screenScene.children[0].children.filter(object => object.name === 'kong-gold-particle') as THREE.Sprite[]
    expect(tokens).toHaveLength(4)
    const tokenPositions = tokens.map(token => token.position.toArray())
    const matrices: number[][] = []
    weather.screenScene.traverse(object => { if (object instanceof THREE.InstancedMesh) matrices.push([...object.instanceMatrix.array]) })
    weather.animate(500)
    expect(tokens.map(token => token.position.toArray())).toEqual(tokenPositions)
    const after: number[][] = []
    weather.screenScene.traverse(object => { if (object instanceof THREE.InstancedMesh) after.push([...object.instanceMatrix.array]) })
    expect(matrices).toHaveLength(1)
    expect(after).toEqual(matrices)
    weather.animate(700)
    expect(weather.screenScene.children).toHaveLength(0)
  })

  it('本家风从右向左连续平移，并按开杠者座位旋转方向', () => {
    const scene = new THREE.Scene(), weather = createKongWeather({ scene, assets, cues: () => [cue('tornado')], localSeat: () => 0 })
    const positions = [320, 980, 1860].map(now => { weather.animate(now); return scene.children[0].position.clone() })
    expect(positions[0].x).toBeGreaterThan(0)
    expect(positions[2].x).toBeLessThan(0)
    expect(positions[0].x).toBeGreaterThan(positions[1].x)
    expect(positions[1].x).toBeGreaterThan(positions[2].x)
    expect(positions[0].z).toBe(positions[2].z)
    expect(kongWindPosition(2, 2, .1).x).toBeGreaterThan(kongWindPosition(2, 2, .9).x)
    expect(kongWindPosition(1, 0, .1).z).toBeLessThan(kongWindPosition(1, 0, .9).z)
    weather.dispose()
  })

  it('雨幕独立叠加在画面上，适应宽高比，保留主画面清屏设置', () => {
    const scene = new THREE.Scene(), weather = createKongWeather({ scene, assets, cues: () => [cue('rain')], localSeat: () => 0 })
    weather.setAspect(2)
    weather.animate(600)
    const renderer = { autoClear: true, info: { autoReset: true }, clearDepth: vi.fn(), render: vi.fn() }
    weather.renderOverlay(renderer)
    const [layer, camera] = renderer.render.mock.calls[0]
    expect(layer).toBe(weather.screenScene)
    expect(camera.isOrthographicCamera).toBe(true)
    expect([camera.left, camera.right, camera.top, camera.bottom]).toEqual([-2, 2, 1, -1])
    expect(renderer.clearDepth).toHaveBeenCalledOnce()
    expect(renderer.autoClear).toBe(true)
    expect(renderer.info.autoReset).toBe(true)
    weather.setAspect(.75)
    expect([camera.left, camera.right]).toEqual([-.75, .75])
    renderer.render.mockImplementationOnce(() => { throw new Error('renderer lost') })
    expect(() => weather.renderOverlay(renderer)).toThrow('renderer lost')
    expect(renderer.autoClear).toBe(true)
    expect(renderer.info.autoReset).toBe(true)
    weather.animate(2300)
    renderer.render.mockClear()
    weather.renderOverlay(renderer)
    expect(renderer.render).not.toHaveBeenCalled()
  })

  it('连续暗杠只保留最新雨幕，避免多层雨叠加遮挡画面', () => {
    const scene = new THREE.Scene(), weather = createKongWeather({ scene, assets, cues: () => [cue('rain', 1), cue('rain', 2)], localSeat: () => 0 })
    weather.animate(600)
    expect(weather.screenScene.children).toHaveLength(1)
    expect(weather.visibleCues).toEqual([{ seat: 2, kind: 'rain' }])
    weather.dispose()
  })

  it('素材不可用时跳过装饰，不显示白色方块或阻塞对局', () => {
    const scene = new THREE.Scene()
    const weather = createKongWeather({ scene, assets: null, cues: () => [cue('rain')], localSeat: () => 0 })
    expect(weather.animate(400)).toBe(false)
    expect(scene.children).toHaveLength(0)
  })
})
