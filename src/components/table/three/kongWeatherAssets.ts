import * as THREE from 'three'
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js'

export const WEATHER_TEXTURE_FILES = {
  wind: 'wind_trail.png', ribbon: 'effect_trail_02.png', crescent: 'effect_flash_00.png',
  pattern: 'effect_wenli_00.png', mask: 'effect_mask_03.png', glow: 'effect_glow_03.png',
  star: 'shanguang_bai.png', rain: 'rain.png', smoke: 'effect_smike_01.png',
  ripple: 'water_ripple.png', splash: 'water_splash_4x4_blue.png',
  coin: 'effect_jinbi.png', goldenTile: 'golden_majiangzi.png',
} as const
export const WEATHER_MESH_FILES = { ring: 'mesh_wind.obj', storm: 'fx_mesh_storm.obj', ground: 'Fx_mesh_wenli.obj' } as const
export interface WeatherAssets {
  textures: Record<keyof typeof WEATHER_TEXTURE_FILES, THREE.Texture>
  meshes: Record<keyof typeof WEATHER_MESH_FILES, THREE.BufferGeometry>
}

export function setWeatherFrame(texture: THREE.Texture, frame: number, columns: number, rows: number) {
  const index = THREE.MathUtils.clamp(Math.floor(frame), 0, columns * rows - 1)
  texture.repeat.set(1 / columns, 1 / rows)
  texture.offset.set((index % columns) / columns, 1 - (Math.floor(index / columns) + 1) / rows)
}

/** Retain original OBJ positions and UVs; effect instances transform clones only. */
export function parseWeatherMesh(text: string): THREE.BufferGeometry {
  const group = new OBJLoader().parse(text)
  let geometry: THREE.BufferGeometry | undefined
  group.traverse(object => {
    // Vite can load the addon and application through separate Three.js module
    // instances. Use Three's structural flag rather than constructor identity.
    const mesh = object as THREE.Mesh
    if (!mesh.isMesh) return
    if (!geometry) geometry = mesh.geometry
    else mesh.geometry.dispose()
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) material.dispose()
  })
  if (!geometry?.getAttribute('uv')) { geometry?.dispose(); throw new Error('Weather OBJ has no textured geometry') }
  return geometry
}

let loaded: Promise<WeatherAssets> | null = null
/** Small, shared immutable sources are preloaded with the table, before any kong can occur. */
export function preloadWeatherAssets(): Promise<WeatherAssets> {
  if (loaded) return loaded
  const base = `${import.meta.env.BASE_URL}effects/yaotong-weather/`
  loaded = (async () => {
    const textures = {} as WeatherAssets['textures'], meshes = {} as WeatherAssets['meshes']
    const tasks = [
      ...Object.entries(WEATHER_TEXTURE_FILES).map(async ([name, file]) => {
        const texture = await new THREE.TextureLoader().loadAsync(base + file)
        texture.name = file
        texture.colorSpace = name === 'mask' ? THREE.NoColorSpace : THREE.SRGBColorSpace
        texture.minFilter = THREE.LinearFilter
        texture.magFilter = THREE.LinearFilter
        texture.generateMipmaps = false
        textures[name as keyof typeof textures] = texture
      }),
      ...Object.entries(WEATHER_MESH_FILES).map(async ([name, file]) => {
        const response = await fetch(base + file)
        if (!response.ok) throw new Error(`Weather mesh ${file}: ${response.status}`)
        const geometry = parseWeatherMesh(await response.text())
        geometry.name = file
        meshes[name as keyof typeof meshes] = geometry
      }),
    ]
    const results = await Promise.allSettled(tasks)
    const failed = results.find(result => result.status === 'rejected')
    if (failed?.status === 'rejected') {
      Object.values(textures).forEach(texture => texture.dispose())
      Object.values(meshes).forEach(geometry => geometry.dispose())
      throw failed.reason
    }
    return { textures, meshes }
  })().catch(error => { loaded = null; throw error })
  return loaded
}
