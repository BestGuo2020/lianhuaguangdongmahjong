import type * as THREE from 'three'

// 牌桌主题配置：把原来硬编码在 staticTableScene.ts 里的所有共享材质参数抽成数据。
// 换肤 = 换一份 TableTheme；贴图类（map/envMap）由创建方注入，不在这里配置。

/** MeshPhysicalMaterial 参数（排除需要创建方注入的贴图字段）。 */
export type PhysicalParams = Omit<THREE.MeshPhysicalMaterialParameters, 'map' | 'envMap'>

/** MeshStandardMaterial 参数（排除需要创建方注入的贴图字段）。 */
export type StandardParams = Omit<THREE.MeshStandardMaterialParameters, 'map' | 'envMap'>

export interface TableTheme {
  /** 牌桌台身、鎏金边、麻将机等静态部件的材质。 */
  table: {
    /** 墨玉台面（最上层桌面）。 */
    jade: PhysicalParams
    /** 深墨玉（最底层桌身 + 麻将机内圈）。 */
    darkJade: PhysicalParams
    /** 鎏金（中层托边、内圈细线）。 */
    gold: PhysicalParams
    /** 亮金（四边金线、四角饰钉）。 */
    goldHighlight: PhysicalParams
    /** 麻将机机身侧面。 */
    machine: PhysicalParams
    /** 麻将机顶面（壁牌数 + 风位贴图）。 */
    machineTop: PhysicalParams
    /** 麻将机底面。 */
    machineBottom: PhysicalParams
  }
  /** 素面模式：不建鎏金托边/四边金线/四角饰钉（雀魂等素面风格用）。桌身仍为两层（底 + 台面）。 */
  plainSurface?: boolean
  /** 桌面呢绒纹理：给台面材质叠加程序化噪点贴图，模拟织物绒感（配合高 roughness）。 */
  tableFelt?: boolean
  /** 牌背渐变纹理的三段颜色（canvas 程序纹理），不传用默认绿色渐变。 */
  tileBackGradient?: [string, string, string]
  /** 麻将牌共享材质（所有牌共用的白身/绿背/牌底等）。 */
  tile: {
    /** 牌体白色侧面。 */
    side: PhysicalParams
    /** 绿色牌背层（翻面时可见的侧边）。 */
    faceSide: PhysicalParams
    /** 牌底。 */
    bottom: PhysicalParams
    /** 牌背（带绿色渐变贴图）。 */
    back: PhysicalParams
    /** 牌面（makeFaceMaterial / 图集材质共用）。 */
    face: PhysicalParams
  }
  /** 选中/高亮牌的金色材质（MeshStandardMaterial）。 */
  highlight: StandardParams
}

/** 默认主题（原 staticTableScene.ts addTable/makeFaceMaterial 的硬编码值，逐一搬入）。 */
export const defaultTableTheme: TableTheme = {
  table: {
    jade: {
      color: 0x254223,
      emissive: 0x101d0f,
      emissiveIntensity: .12,
      roughness: .4,
      metalness: .04,
      clearcoat: .72,
      clearcoatRoughness: .2,
      sheen: .22,
      sheenColor: 0x6f8d69,
      sheenRoughness: .72,
    },
    darkJade: {
      color: 0x08271c,
      emissive: 0x03140e,
      emissiveIntensity: .12,
      roughness: .48,
      metalness: .16,
      clearcoat: .36,
      clearcoatRoughness: .3,
    },
    gold: {
      color: 0xb88a38,
      emissive: 0x3a2406,
      emissiveIntensity: .3,
      roughness: .28,
      metalness: .88,
      clearcoat: .3,
      clearcoatRoughness: .2,
    },
    goldHighlight: {
      color: 0xe1b85d,
      emissive: 0x392006,
      emissiveIntensity: .35,
      roughness: .22,
      metalness: .94,
      clearcoat: .38,
      clearcoatRoughness: .16,
    },
    machine: {
      color: 0x071f17,
      roughness: .3,
      metalness: .24,
      clearcoat: .76,
      clearcoatRoughness: .16,
    },
    machineTop: {
      roughness: .3,
      metalness: .16,
      clearcoat: .66,
      clearcoatRoughness: .18,
    },
    machineBottom: {
      color: 0x020906,
      roughness: .46,
      metalness: .3,
      clearcoat: .24,
    },
  },
  tile: {
    side: {
      color: 0xc9c9c1,
      metalness: 0,
      roughness: .31,
      clearcoat: .58,
      clearcoatRoughness: .23,
      ior: 1.46,
      specularIntensity: .34,
      specularColor: 0xfffdf3,
      envMapIntensity: .3,
    },
    faceSide: {
      color: 0x32a73a,
      metalness: 0,
      roughness: .3,
      clearcoat: .68,
      clearcoatRoughness: .18,
      ior: 1.46,
      specularIntensity: .62,
      envMapIntensity: .46,
    },
    bottom: {
      color: 0xbfc1b9,
      metalness: 0,
      roughness: .42,
      clearcoat: .38,
      clearcoatRoughness: .24,
      ior: 1.45,
      envMapIntensity: .25,
    },
    back: {
      color: 0xd1d2cb,
      metalness: 0,
      roughness: .32,
      clearcoat: .48,
      clearcoatRoughness: .26,
      ior: 1.46,
      envMapIntensity: .28,
    },
    face: {
      color: 0xd8d7ce,
      metalness: 0,
      roughness: .4,
      clearcoat: .56,
      clearcoatRoughness: .24,
      ior: 1.46,
      specularIntensity: .36,
      specularColor: 0xfffdf4,
      envMapIntensity: .3,
    },
  },
  highlight: {
    color: 0xe3b948,
    emissive: 0x7d4d08,
    emissiveIntensity: .8,
    roughness: .4,
  },
}

/** 示例主题「红木金丝」：红木台面 + 亮金丝边 + 暖白牌身，验证换肤链路用。 */
export const rosewoodTheme: TableTheme = {
  table: {
    jade: {
      color: 0x6e2f1e,
      emissive: 0x1d0a04,
      emissiveIntensity: .15,
      roughness: .38,
      metalness: .06,
      clearcoat: .58,
      clearcoatRoughness: .22,
      sheen: .28,
      sheenColor: 0x9c5f42,
      sheenRoughness: .68,
    },
    darkJade: {
      color: 0x3c160d,
      emissive: 0x160604,
      emissiveIntensity: .15,
      roughness: .5,
      metalness: .12,
      clearcoat: .34,
      clearcoatRoughness: .32,
    },
    gold: {
      color: 0xc4943f,
      emissive: 0x402706,
      emissiveIntensity: .35,
      roughness: .26,
      metalness: .9,
      clearcoat: .32,
      clearcoatRoughness: .2,
    },
    goldHighlight: {
      color: 0xe8c05e,
      emissive: 0x3f2106,
      emissiveIntensity: .4,
      roughness: .2,
      metalness: .95,
      clearcoat: .34,
      clearcoatRoughness: .16,
    },
    machine: {
      color: 0x140f0a,
      roughness: .32,
      metalness: .22,
      clearcoat: .72,
      clearcoatRoughness: .18,
    },
    machineTop: {
      roughness: .3,
      metalness: .16,
      clearcoat: .66,
      clearcoatRoughness: .18,
    },
    machineBottom: {
      color: 0x050302,
      roughness: .46,
      metalness: .3,
      clearcoat: .24,
    },
  },
  tile: {
    side: {
      color: 0xcfc9bd,
      metalness: 0,
      roughness: .31,
      clearcoat: .58,
      clearcoatRoughness: .23,
      ior: 1.46,
      specularIntensity: .34,
      specularColor: 0xfff7e8,
      envMapIntensity: .3,
    },
    faceSide: {
      color: 0x32a73a,
      metalness: 0,
      roughness: .3,
      clearcoat: .68,
      clearcoatRoughness: .18,
      ior: 1.46,
      specularIntensity: .62,
      envMapIntensity: .46,
    },
    bottom: {
      color: 0xc2beb2,
      metalness: 0,
      roughness: .42,
      clearcoat: .38,
      clearcoatRoughness: .24,
      ior: 1.45,
      envMapIntensity: .25,
    },
    back: {
      color: 0xd8d2c4,
      metalness: 0,
      roughness: .32,
      clearcoat: .48,
      clearcoatRoughness: .26,
      ior: 1.46,
      envMapIntensity: .28,
    },
    face: {
      color: 0xe3dfd2,
      metalness: 0,
      roughness: .4,
      clearcoat: .56,
      clearcoatRoughness: .24,
      ior: 1.46,
      specularIntensity: .36,
      specularColor: 0xfff8ea,
      envMapIntensity: .3,
    },
  },
  highlight: {
    color: 0xe3b948,
    emissive: 0x7d4d08,
    emissiveIntensity: .8,
    roughness: .4,
  },
}

/** 示例主题「雀魂风」：素面深绿呢绒桌（无金线/饰钉）+ 哑光瓷白牌 + 蓝色牌背。 */
export const majsoulTheme: TableTheme = {
  table: {
    jade: {
      color: 0x1f4d2e,
      emissive: 0x08150c,
      emissiveIntensity: .06,
      roughness: .85,
      metalness: 0,
      clearcoat: .08,
      clearcoatRoughness: .6,
      sheen: .35,
      sheenColor: 0x2e6b45,
      sheenRoughness: .8,
    },
    darkJade: {
      color: 0x0e2417,
      emissive: 0x050d08,
      emissiveIntensity: .05,
      roughness: .9,
      metalness: 0,
      clearcoat: 0,
    },
    gold: {
      color: 0x2a2a28,
      emissive: 0x0a0a08,
      emissiveIntensity: .1,
      roughness: .5,
      metalness: .4,
      clearcoat: .1,
      clearcoatRoughness: .5,
    },
    goldHighlight: {
      color: 0x3a3a36,
      emissive: 0x0d0d0a,
      emissiveIntensity: .08,
      roughness: .55,
      metalness: .35,
      clearcoat: .1,
      clearcoatRoughness: .5,
    },
    machine: {
      color: 0x0a1210,
      roughness: .5,
      metalness: .1,
      clearcoat: .3,
      clearcoatRoughness: .4,
    },
    machineTop: {
      roughness: .55,
      metalness: .05,
      clearcoat: .2,
      clearcoatRoughness: .5,
    },
    machineBottom: {
      color: 0x040605,
      roughness: .6,
      metalness: .1,
      clearcoat: .1,
    },
  },
  plainSurface: true,
  tableFelt: true,
  tileBackGradient: ['#3e7bb8', '#2a5d9e', '#1b4278'],
  tile: {
    side: {
      color: 0xe8e8e4,
      metalness: 0,
      roughness: .5,
      clearcoat: .18,
      clearcoatRoughness: .4,
      ior: 1.45,
      specularIntensity: .15,
      specularColor: 0xffffff,
      envMapIntensity: .22,
    },
    faceSide: {
      color: 0x2e6db4,
      metalness: 0,
      roughness: .55,
      clearcoat: .2,
      clearcoatRoughness: .4,
      ior: 1.45,
      specularIntensity: .18,
      envMapIntensity: .25,
    },
    bottom: {
      color: 0xd8d8d2,
      metalness: 0,
      roughness: .5,
      clearcoat: .2,
      clearcoatRoughness: .4,
      ior: 1.45,
      envMapIntensity: .2,
    },
    back: {
      color: 0xd8d8d2,
      metalness: 0,
      roughness: .45,
      clearcoat: .25,
      clearcoatRoughness: .35,
      ior: 1.45,
      envMapIntensity: .22,
    },
    face: {
      color: 0xf2f1ea,
      metalness: 0,
      roughness: .55,
      clearcoat: .22,
      clearcoatRoughness: .4,
      ior: 1.45,
      specularIntensity: .18,
      specularColor: 0xffffff,
      envMapIntensity: .22,
    },
  },
  highlight: {
    color: 0xe3b948,
    emissive: 0x7d4d08,
    emissiveIntensity: .8,
    roughness: .4,
  },
}

/** 主题注册表：按名字取主题（URL ?theme=<name> 等调试/换肤入口用）。 */
export const TABLE_THEMES: Record<string, TableTheme> = {
  jade: defaultTableTheme,
  rosewood: rosewoodTheme,
  majsoul: majsoulTheme,
}

/** 按名字解析主题；名字未知或未提供返回 undefined（调用方回退默认主题）。 */
export function tableThemeByName(name: string | null | undefined): TableTheme | undefined {
  return name ? TABLE_THEMES[name] : undefined
}

