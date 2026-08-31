import * as THREE from 'three'

export interface TableSceneRenderProfile {
  readonly camera: {
    readonly fov: number
    readonly positionY: number
    readonly positionZ: number
    readonly lookAtZ: number
  }
  readonly toneMapping: THREE.ToneMapping
  readonly exposure: number
  readonly fog: boolean
  readonly hemisphere: {
    readonly skyColor: number
    readonly groundColor: number
    readonly intensity: number
  }
  readonly keyLight: {
    readonly color: number
    readonly intensity: number
    readonly position: readonly [number, number, number]
    readonly targetZ: number
  }
  readonly areaLights?: readonly {
    readonly color: number
    readonly intensity: number
    readonly width: number
    readonly height: number
    readonly position: readonly [number, number, number]
    readonly target: readonly [number, number, number]
  }[]
  readonly shadows: {
    readonly mapType: THREE.ShadowMapType
    readonly mapSize: number
    readonly cameraSize: number
    readonly near: number
    readonly far: number
    readonly bias: number
    readonly normalBias: number
    readonly radius: number
    readonly blurSamples: number
  }
  readonly outline?: {
    readonly thickness: number
    readonly color: readonly [number, number, number]
    readonly alpha: number
  }
}

/** 原牌桌渲染参数；非 llmAnime 主题继续使用，避免主题改造影响旧画面。 */
export const DEFAULT_TABLE_SCENE_PROFILE: TableSceneRenderProfile = {
  camera: { fov: 39, positionY: 17.2, positionZ: 11.8, lookAtZ: -.25 },
  toneMapping: THREE.ACESFilmicToneMapping,
  exposure: .92,
  fog: true,
  hemisphere: { skyColor: 0xf3e4ba, groundColor: 0x020b08, intensity: 1.65 },
  keyLight: { color: 0xffdfa0, intensity: 3.8, position: [-7, 13, 9], targetZ: 0 },
  shadows: {
    mapType: THREE.PCFSoftShadowMap,
    mapSize: 1024,
    cameraSize: 18,
    near: .5,
    far: 500,
    bias: -.0004,
    normalBias: .02,
    radius: 1,
    blurSamples: 8,
  },
}

/**
 * 大模型二次元主题的雀魂式 3D 配置。
 *
 * 34° 偏长焦配合后移机位压缩左右牌山透视；暖色主光与较弱半球光拉开
 * 明暗层次，2048 软阴影负责把牌压回桌面。描边只保留很薄的一层，避免
 * 覆盖树脂牌边缘的清漆高光。
 */
export const LLM_ANIME_SCENE_PROFILE: TableSceneRenderProfile = {
  camera: { fov: 34, positionY: 20.8, positionZ: 14, lookAtZ: -.65 },
  toneMapping: THREE.NeutralToneMapping,
  exposure: 1,
  fog: false,
  hemisphere: { skyColor: 0xfff4e8, groundColor: 0x2b3b32, intensity: .65 },
  keyLight: { color: 0xfff0dc, intensity: .75, position: [-4, 22, 6], targetZ: -1.65 },
  areaLights: [
    {
      color: 0xfff0dc,
      intensity: 4,
      width: 16,
      height: 10,
      position: [-2, 14, 6],
      target: [0, 0, -1.65],
    },
    {
      color: 0xdde8ff,
      intensity: 1.2,
      width: 10,
      height: 8,
      position: [8, 9, -7],
      target: [0, 0, -1.65],
    },
  ],
  shadows: {
    mapType: THREE.VSMShadowMap,
    mapSize: 2048,
    cameraSize: 17.5,
    near: .5,
    far: 45,
    bias: -.00035,
    normalBias: .018,
    radius: 4,
    blurSamples: 16,
  },
  outline: {
    thickness: .00135,
    color: [.10, .13, .10],
    alpha: .34,
  },
}

export function tableSceneRenderProfile(themeName: string | null | undefined): TableSceneRenderProfile {
  return themeName === 'llmAnime' ? LLM_ANIME_SCENE_PROFILE : DEFAULT_TABLE_SCENE_PROFILE
}

/**
 * 每帧从主题基准机位重新计算相机坐标，禁止把摸打或胡牌偏移累加到上一帧。
 * 普通对局传入零偏移；胡牌 shake 结束后的下一帧会精确回到 [0, positionY, positionZ]。
 */
export function tableCameraPosition(
  profile: TableSceneRenderProfile,
  shakeX = 0,
  shakeZ = 0,
): readonly [number, number, number] {
  return [shakeX, profile.camera.positionY, profile.camera.positionZ + shakeZ]
}

/**
 * 16:9 及更宽视口保持主题原始纵向 FOV；更窄的平板按实际 aspect 扩大纵向 FOV，
 * 从而保持相同的水平视野。只改变投影矩阵，不改牌山、牌河、中控台或麻将坐标。
 */
export function responsiveCameraFov(baseVerticalFov: number, aspect: number, referenceAspect = 16 / 9): number {
  if (!Number.isFinite(aspect) || aspect <= 0 || aspect >= referenceAspect) return baseVerticalFov
  const baseRadians = THREE.MathUtils.degToRad(baseVerticalFov)
  const fittedRadians = 2 * Math.atan(Math.tan(baseRadians / 2) * referenceAspect / aspect)
  return THREE.MathUtils.radToDeg(fittedRadians)
}

export function applyRendererProfile(
  renderer: Pick<THREE.WebGLRenderer, 'outputColorSpace' | 'toneMapping' | 'toneMappingExposure' | 'shadowMap'>,
  profile: TableSceneRenderProfile,
): void {
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = profile.toneMapping
  renderer.toneMappingExposure = profile.exposure
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = profile.shadows.mapType
}

export function applyDirectionalShadowProfile(
  light: THREE.DirectionalLight,
  profile: TableSceneRenderProfile,
): void {
  const { shadows } = profile
  light.castShadow = true
  light.shadow.mapSize.set(shadows.mapSize, shadows.mapSize)
  light.shadow.bias = shadows.bias
  light.shadow.normalBias = shadows.normalBias
  light.shadow.radius = shadows.radius
  light.shadow.blurSamples = shadows.blurSamples
  light.shadow.camera.near = shadows.near
  light.shadow.camera.far = shadows.far
  light.shadow.camera.left = -shadows.cameraSize
  light.shadow.camera.right = shadows.cameraSize
  light.shadow.camera.top = shadows.cameraSize
  light.shadow.camera.bottom = -shadows.cameraSize
  light.shadow.camera.updateProjectionMatrix()
}

/** 自适应质量以旧主题的 1024 基准缩放；llmAnime 高档保持 2048。 */
export function shadowMapSizeForQuality(profile: TableSceneRenderProfile, baselineSize: number): number {
  return Math.max(512, Math.round(profile.shadows.mapSize * baselineSize / 1024))
}
