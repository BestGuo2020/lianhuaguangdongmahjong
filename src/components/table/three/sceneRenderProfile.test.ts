import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import {
  DEFAULT_TABLE_SCENE_PROFILE,
  LLM_ANIME_SCENE_PROFILE,
  applyDirectionalShadowProfile,
  applyRendererProfile,
  shadowMapSizeForQuality,
  tableSceneRenderProfile,
} from './sceneRenderProfile'

describe('llmAnime Three.js 渲染配置', () => {
  it('只为 llmAnime 使用长焦机位、Neutral 色调、双面积光和 2048 VSM 软阴影', () => {
    expect(tableSceneRenderProfile('llmAnime')).toBe(LLM_ANIME_SCENE_PROFILE)
    expect(tableSceneRenderProfile('llm')).toBe(DEFAULT_TABLE_SCENE_PROFILE)
    expect(LLM_ANIME_SCENE_PROFILE.camera.fov).toBeGreaterThanOrEqual(28)
    expect(LLM_ANIME_SCENE_PROFILE.camera.fov).toBeLessThanOrEqual(34)
    expect(LLM_ANIME_SCENE_PROFILE.camera.positionY).toBeGreaterThan(DEFAULT_TABLE_SCENE_PROFILE.camera.positionY)
    expect(LLM_ANIME_SCENE_PROFILE.camera.positionZ).toBeGreaterThan(DEFAULT_TABLE_SCENE_PROFILE.camera.positionZ)
    expect(LLM_ANIME_SCENE_PROFILE.toneMapping).toBe(THREE.NeutralToneMapping)
    expect(LLM_ANIME_SCENE_PROFILE.exposure).toBe(1)
    expect(LLM_ANIME_SCENE_PROFILE.areaLights).toHaveLength(2)
    expect(LLM_ANIME_SCENE_PROFILE.shadows.mapSize).toBe(2048)
    expect(LLM_ANIME_SCENE_PROFILE.shadows.mapType).toBe(THREE.VSMShadowMap)
  })

  it('把色彩管理和软阴影应用到 WebGLRenderer', () => {
    const renderer = {
      outputColorSpace: '',
      toneMapping: THREE.NoToneMapping,
      toneMappingExposure: 0,
      shadowMap: { enabled: false, type: THREE.BasicShadowMap },
    }
    applyRendererProfile(renderer as never, LLM_ANIME_SCENE_PROFILE)
    expect(renderer.outputColorSpace).toBe(THREE.SRGBColorSpace)
    expect(renderer.toneMapping).toBe(THREE.NeutralToneMapping)
    expect(renderer.toneMappingExposure).toBe(1)
    expect(renderer.shadowMap).toEqual({ enabled: true, type: THREE.VSMShadowMap })
  })

  it('配置主方向光阴影视锥并随质量档位缩放贴图', () => {
    const light = new THREE.DirectionalLight()
    applyDirectionalShadowProfile(light, LLM_ANIME_SCENE_PROFILE)
    expect(light.castShadow).toBe(true)
    expect(light.shadow.mapSize.x).toBe(2048)
    expect(light.shadow.camera.left).toBe(-17.5)
    expect(light.shadow.camera.right).toBe(17.5)
    expect(light.shadow.camera.near).toBe(.5)
    expect(light.shadow.camera.far).toBe(45)
    expect(light.shadow.radius).toBe(4)
    expect(light.shadow.blurSamples).toBe(16)
    expect(shadowMapSizeForQuality(LLM_ANIME_SCENE_PROFILE, 1024)).toBe(2048)
    expect(shadowMapSizeForQuality(LLM_ANIME_SCENE_PROFILE, 512)).toBe(1024)
  })
})
