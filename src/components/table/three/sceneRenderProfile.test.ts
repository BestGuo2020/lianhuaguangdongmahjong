import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import {
  DEFAULT_TABLE_SCENE_PROFILE,
  LLM_ANIME_SCENE_PROFILE,
  applyDirectionalShadowProfile,
  applyRendererProfile,
  responsiveCameraFov,
  shadowMapSizeForQuality,
  tableCameraPosition,
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

  it.each([DEFAULT_TABLE_SCENE_PROFILE, LLM_ANIME_SCENE_PROFILE])('普通摸打保持固定机位，胡牌 shake 结束后精确复原', (profile) => {
    const idle = tableCameraPosition(profile)
    expect(idle).toEqual([0, profile.camera.positionY, profile.camera.positionZ])

    const shaken = tableCameraPosition(profile, .075, -.055)
    expect(shaken).toEqual([.075, profile.camera.positionY, profile.camera.positionZ - .055])

    const restored = tableCameraPosition(profile)
    expect(restored).toEqual(idle)
  })

  it.each([DEFAULT_TABLE_SCENE_PROFILE, LLM_ANIME_SCENE_PROFILE])('平板窄宽比保持 16:9 的水平视野', (profile) => {
    const referenceAspect = 16 / 9
    const tabletAspect = 4 / 3
    const fittedFov = responsiveCameraFov(profile.camera.fov, tabletAspect)
    expect(fittedFov).toBeGreaterThan(profile.camera.fov)
    expect(responsiveCameraFov(profile.camera.fov, referenceAspect)).toBe(profile.camera.fov)
    expect(responsiveCameraFov(profile.camera.fov, 21 / 9)).toBe(profile.camera.fov)

    const baseHorizontalTangent = Math.tan(THREE.MathUtils.degToRad(profile.camera.fov) / 2) * referenceAspect
    const tabletHorizontalTangent = Math.tan(THREE.MathUtils.degToRad(fittedFov) / 2) * tabletAspect
    expect(tabletHorizontalTangent).toBeCloseTo(baseHorizontalTangent, 10)
  })

  it.each([DEFAULT_TABLE_SCENE_PROFILE, LLM_ANIME_SCENE_PROFILE])('任意有效宽高比都连续保持水平视野且宽屏不放大', (profile) => {
    const aspects = [4 / 3, 1.4, 1.5, 1.599, 1.6, 1.777, 16 / 9, 1.999, 2, 2.17, 21 / 9]
    const fitted = aspects.map((aspect) => responsiveCameraFov(profile.camera.fov, aspect))
    for (let index = 1; index < fitted.length; index += 1) {
      expect(fitted[index]).toBeLessThanOrEqual(fitted[index - 1] + 1e-10)
    }
    for (const [index, aspect] of aspects.entries()) {
      const fov = fitted[index]
      if (aspect >= 16 / 9) expect(fov).toBe(profile.camera.fov)
      else {
        const horizontal = Math.tan(THREE.MathUtils.degToRad(fov) / 2) * aspect
        const reference = Math.tan(THREE.MathUtils.degToRad(profile.camera.fov) / 2) * (16 / 9)
        expect(horizontal).toBeCloseTo(reference, 10)
      }
    }
  })
})
