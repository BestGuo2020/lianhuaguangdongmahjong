import type * as THREE from 'three'

// 牌桌主题配置：把原来硬编码在 staticTableScene.ts 里的所有共享材质参数抽成数据。
// 换肤 = 换一份 TableTheme；运行时 Texture 仍由创建方注入，主题这里只保存可序列化的图片地址与变换参数。

/** MeshPhysicalMaterial 参数（排除需要创建方注入的贴图字段）。 */
export type PhysicalParams = Omit<THREE.MeshPhysicalMaterialParameters, 'map' | 'envMap'>

/** MeshStandardMaterial 参数（排除需要创建方注入的贴图字段）。 */
export type StandardParams = Omit<THREE.MeshStandardMaterialParameters, 'map' | 'envMap'>

/** 单张方形桌布纹理；由 MahjongTable3D 异步加载后注入静态场景。 */
export interface TableSurfaceTextureConfig {
  url: string
  /** 以纹理中心为轴旋转，单位为弧度。 */
  rotation?: number
  offset?: [number, number]
  repeat?: [number, number]
  /** map 会与材质底色相乘；图片主题通常使用纯白避免染色。 */
  tint?: THREE.ColorRepresentation
}

export interface TableTheme {
  /** 主题专属牌体圆角；未配置时保留原有 6 段几何，避免旧主题视觉变化。 */
  tileGeometry?: {
    segments: number
    baseRadius: number
    capRadius: number
  }
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
  /** 桌面暗角强度 0-1：台面中心亮、向四周渐暗（径向渐变压暗边缘），不传不启用。 */
  tableVignette?: number
  /** 呢绒亮度噪点范围；值越小纹理越细腻均匀。 */
  tableFeltVariation?: number
  /** 仅作为桌布纹理绘制的四向分区压线，不改变牌桌几何和玩法布局。 */
  tableGuide?: {
    dark: string
    light: string
    opacity: number
    slotDark?: string
    slotOpacity?: number
  }
  /** 中控台视觉缩放与厚度倍率；不改变牌河/牌墙坐标。 */
  machineScale?: number
  machineRelief?: number
  /** 桌身、外框等静态几何是否投影；关闭后仍接收麻将与中控台阴影。 */
  staticTableCastShadow?: boolean
  /** 外部桌布图片；优先级高于 tableFelt / tableVignette 的程序纹理。 */
  tableSurfaceTexture?: TableSurfaceTextureConfig
  /** 木质包边：台面四周一圈程序木纹框（雀魂等木框桌用），与 plainSurface 配合。 */
  woodTrim?: boolean
  /** 木纹三段颜色（canvas 程序纹理），不传用默认深棕。 */
  woodTrimColors?: [string, string, string]
  /** 木框表面光泽参数；不传使用默认木框质感。 */
  woodTrimMaterial?: {
    roughness?: number
    metalness?: number
    clearcoat?: number
    clearcoatRoughness?: number
  }
  /** 非木质包边材质；仅在未启用 woodTrim 的主题上绘制一圈低矮硬质边框。 */
  edgeTrim?: PhysicalParams
  /** 非木质包边宽度；不传使用中等宽度，避免边框压过桌面。 */
  edgeTrimWidth?: number
  /** 非木质包边上的细金线与装饰纹样。 */
  edgeAccent?: boolean
  /** 包边金线的主题专属材质；未配置时沿用现有金属高光。 */
  edgeAccentMaterial?: PhysicalParams
  /** 包边顶面复用桌面材质，只保留深色立面，避免形成宽色带。 */
  edgeTrimTopMatchesSurface?: boolean
  /** 牌桌侧向补光；不同主题可换成相配的色温。 */
  rimLight?: {
    color: number
    intensity: number
  }
  /** 牌背渐变纹理的三段颜色（canvas 程序纹理），不传用默认绿色渐变。 */
  tileBackGradient?: [string, string, string]
  /** 牌面底色的顶部/中部/底部烘焙明暗；不传保留默认牌面。 */
  tileFaceGradient?: [string, string, string]
  /** 牌体边缘低成本 AO 强度；0/不传时禁用。 */
  tileAoIntensity?: number
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
  tableVignette: .35,
  plainSurface: true,
  edgeTrim: {
    color: 0x163a2c,
    emissive: 0x071a13,
    emissiveIntensity: .08,
    roughness: .52,
    metalness: .06,
    clearcoat: .2,
    clearcoatRoughness: .36,
  },
  edgeAccent: true,
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
  tableVignette: .45,
  plainSurface: true,
  rimLight: {
    color: 0xb45b3f,
    intensity: 1.05,
  },
  edgeTrim: {
    color: 0x3f1d13,
    emissive: 0x140703,
    emissiveIntensity: .08,
    roughness: .52,
    metalness: .06,
    clearcoat: .2,
    clearcoatRoughness: .36,
  },
  edgeTrimWidth: .65,
  edgeAccent: true,
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

/** 示例主题「雀魂风」：深蓝绒布渐变桌（中心亮 #4262AC → 边缘暗 #1F3358）+ 哑光瓷白牌 + 橙色牌背（#E69D47 系）。 */
export const majsoulTheme: TableTheme = {
  table: {
    jade: {
      color: 0x4262ac,
      emissive: 0x14234a,
      emissiveIntensity: .08,
      roughness: .85,
      metalness: 0,
      clearcoat: .08,
      clearcoatRoughness: .6,
      sheen: .35,
      sheenColor: 0x4a5f9e,
      sheenRoughness: .8,
    },
    darkJade: {
      color: 0x16263f,
      emissive: 0x0a1424,
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
  tableVignette: .32,
  woodTrim: true,
  woodTrimColors: ['#78502b', '#62401f', '#452b17'],
  woodTrimMaterial: {
    roughness: .62,
    metalness: .04,
    clearcoat: .1,
    clearcoatRoughness: .4,
  },
  tileBackGradient: ['#e5a04a', '#d58b35', '#b97127'],
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
      color: 0xe69d47,
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
      color: 0xffffff,
      metalness: 0,
      roughness: .75,
      clearcoat: .06,
      clearcoatRoughness: .5,
      ior: 1.45,
      specularIntensity: .03,
      specularColor: 0x8a5a20,
      envMapIntensity: .06,
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

/** 欢乐麻将风：青绿色绒面台 + 翡翠色牌背 + 暖白牌体 + 深青外沿金线。 */
export const happyMahjongTheme: TableTheme = {
  ...defaultTableTheme,
  table: {
    ...defaultTableTheme.table,
    jade: {
      ...defaultTableTheme.table.jade,
      color: 0x2a7287,
      emissive: 0x08242e,
      emissiveIntensity: .1,
      roughness: .5,
      metalness: .02,
      clearcoat: .34,
      clearcoatRoughness: .3,
      sheen: .28,
      sheenColor: 0x4b8298,
      sheenRoughness: .76,
    },
    darkJade: {
      ...defaultTableTheme.table.darkJade,
      color: 0x082b38,
      emissive: 0x04171f,
      emissiveIntensity: .1,
      roughness: .6,
      metalness: .08,
      clearcoat: .22,
      clearcoatRoughness: .34,
    },
    gold: {
      ...defaultTableTheme.table.gold,
      color: 0xb39a42,
      emissive: 0x302808,
      emissiveIntensity: .24,
      roughness: .38,
      metalness: .72,
      clearcoat: .18,
      clearcoatRoughness: .3,
    },
    goldHighlight: {
      ...defaultTableTheme.table.goldHighlight,
      color: 0xd2bf62,
      emissive: 0x392f0b,
      emissiveIntensity: .28,
      roughness: .32,
      metalness: .78,
      clearcoat: .2,
      clearcoatRoughness: .26,
    },
    machine: {
      ...defaultTableTheme.table.machine,
      color: 0x092d32,
      roughness: .42,
      metalness: .14,
      clearcoat: .36,
      clearcoatRoughness: .3,
    },
    machineBottom: {
      ...defaultTableTheme.table.machineBottom,
      color: 0x020d10,
      roughness: .52,
      metalness: .18,
      clearcoat: .18,
    },
  },
  plainSurface: true,
  tableFelt: true,
  tableVignette: .3,
  woodTrim: false,
  rimLight: {
    color: 0x477a73,
    intensity: .95,
  },
  tileBackGradient: ['#2a9361', '#1e754c', '#105238'],
  edgeTrim: {
    color: 0x15545e,
    emissive: 0x08262b,
    emissiveIntensity: .14,
    roughness: .56,
    metalness: .04,
    clearcoat: .2,
    clearcoatRoughness: .36,
  },
  edgeTrimWidth: .65,
  edgeAccent: true,
  tile: {
    ...defaultTableTheme.tile,
    side: {
      ...defaultTableTheme.tile.side,
      color: 0xe5e9df,
      roughness: .42,
      clearcoat: .38,
      clearcoatRoughness: .28,
      specularIntensity: .24,
    },
    faceSide: {
      ...defaultTableTheme.tile.faceSide,
      color: 0x237e56,
      roughness: .38,
      clearcoat: .5,
      clearcoatRoughness: .24,
      specularIntensity: .42,
      envMapIntensity: .3,
    },
    bottom: {
      ...defaultTableTheme.tile.bottom,
      color: 0xd9ded5,
      roughness: .48,
      clearcoat: .28,
      clearcoatRoughness: .28,
    },
    back: {
      ...defaultTableTheme.tile.back,
      color: 0xe4e8df,
      roughness: .45,
      clearcoat: .25,
      clearcoatRoughness: .35,
      envMapIntensity: .18,
    },
    face: {
      ...defaultTableTheme.tile.face,
      color: 0xf0efe5,
      roughness: .45,
      clearcoat: .35,
      clearcoatRoughness: .28,
      specularIntensity: .28,
    },
  },
}

/** 大模型专属主题：Q 版双模型对决桌布 + 深蓝星轨桌体；麻将牌材质保持默认绿色。 */
export const llmTheme: TableTheme = {
  ...defaultTableTheme,
  table: {
    ...defaultTableTheme.table,
    jade: {
      color: 0x10265c,
      emissive: 0x030a20,
      emissiveIntensity: .08,
      roughness: .72,
      metalness: 0,
      clearcoat: .08,
      clearcoatRoughness: .5,
    },
    darkJade: {
      ...defaultTableTheme.table.darkJade,
      color: 0x071329,
      emissive: 0x020817,
      emissiveIntensity: .12,
      roughness: .54,
      metalness: .12,
      clearcoat: .28,
    },
    gold: {
      ...defaultTableTheme.table.gold,
      color: 0xc6a27f,
      emissive: 0x2a190d,
      emissiveIntensity: .24,
      roughness: .34,
      metalness: .78,
    },
    goldHighlight: {
      ...defaultTableTheme.table.goldHighlight,
      color: 0xe4c4a0,
      emissive: 0x342011,
      emissiveIntensity: .3,
      roughness: .28,
      metalness: .82,
    },
    machine: {
      ...defaultTableTheme.table.machine,
      color: 0x0b1737,
      roughness: .42,
      metalness: .18,
      clearcoat: .42,
    },
    machineTop: {
      ...defaultTableTheme.table.machineTop,
      roughness: .4,
      metalness: .12,
      clearcoat: .42,
    },
    machineBottom: {
      ...defaultTableTheme.table.machineBottom,
      color: 0x020615,
      roughness: .55,
      metalness: .2,
    },
  },
  tableFelt: false,
  tableVignette: undefined,
  tableSurfaceTexture: {
    url: `${import.meta.env.BASE_URL}img/llm-table.webp`,
    tint: 0xffffff,
  },
  plainSurface: true,
  edgeTrim: {
    color: 0x101d43,
    emissive: 0x03091c,
    emissiveIntensity: .12,
    roughness: .5,
    metalness: .14,
    clearcoat: .22,
    clearcoatRoughness: .38,
  },
  edgeTrimWidth: .65,
  edgeAccent: true,
  rimLight: {
    color: 0x67a8ff,
    intensity: 1.1,
  },
  // tile / highlight 直接继承 defaultTableTheme，不改变牌面、绿色牌背与选中高亮。
  tile: defaultTableTheme.tile,
  highlight: defaultTableTheme.highlight,
}

/**
 * 大模型二次元主题：鼠尾草绒面 + 墨色结构 + 香槟金点缀。
 *
 * 角色/UI 保持二次元表达，Three.js 牌桌则使用雀魂式软阴影、长焦机位和
 * 树脂清漆麻将，避免平涂牌体悬浮、塑料发灰和广角边缘发散。
 */
export const llmAnimeTheme: TableTheme = {
  ...defaultTableTheme,
  tileGeometry: { segments: 4, baseRadius: .07, capRadius: .075 },
  table: {
    ...defaultTableTheme.table,
    jade: {
      ...defaultTableTheme.table.jade,
      color: 0x667b6d,
      emissive: 0x172619,
      emissiveIntensity: .025,
      roughness: .82,
      metalness: 0,
      clearcoat: .04,
      clearcoatRoughness: .72,
      sheen: .22,
      sheenColor: 0x9bad98,
      sheenRoughness: .82,
    },
    darkJade: {
      ...defaultTableTheme.table.darkJade,
      color: 0x35463a,
      emissive: 0x101811,
      emissiveIntensity: .025,
      roughness: .58,
      metalness: .05,
      clearcoat: .2,
      clearcoatRoughness: .44,
    },
    gold: {
      ...defaultTableTheme.table.gold,
      color: 0xd3ad68,
      emissive: 0x211507,
      emissiveIntensity: .1,
      roughness: .62,
      metalness: .22,
      clearcoat: .1,
      clearcoatRoughness: .58,
    },
    goldHighlight: {
      ...defaultTableTheme.table.goldHighlight,
      color: 0xf0cc82,
      emissive: 0x2a1d0b,
      emissiveIntensity: .12,
      roughness: .56,
      metalness: .26,
      clearcoat: .12,
      clearcoatRoughness: .52,
    },
    machine: {
      ...defaultTableTheme.table.machine,
      color: 0x252c28,
      roughness: .68,
      metalness: .02,
      clearcoat: .06,
      clearcoatRoughness: .62,
    },
    machineTop: {
      ...defaultTableTheme.table.machineTop,
      emissive: 0x101d16,
      emissiveIntensity: .14,
      roughness: .7,
      metalness: 0,
      clearcoat: .04,
      clearcoatRoughness: .68,
    },
    machineBottom: {
      ...defaultTableTheme.table.machineBottom,
      color: 0x171c19,
      roughness: .75,
      metalness: 0,
      clearcoat: .03,
      clearcoatRoughness: .7,
    },
  },
  tableFelt: true,
  tableVignette: .38,
  tableFeltVariation: 8,
  // 外部动漫桌布：12 个 Q 版角色围边 + 中央留白（整张铺，不平铺）。优先于程序化绒面。
  tableSurfaceTexture: {
    url: `${import.meta.env.BASE_URL}themes/llm-anime/v1/table-felt.png`,
    tint: 0xffffff,
  },
  tableGuide: {
    dark: '#30443a',
    light: '#b5c2aa',
    opacity: .14,
    slotDark: '#102018',
    slotOpacity: .42,
  },
  // 原 3.85×1.13 的中控台总宽高缩小 0.2 个牌长（0.94×0.2）。
  machineScale: 1.081,
  machineRelief: 1.22,
  staticTableCastShadow: false,
  plainSurface: true,
  woodTrim: false,
  edgeTrim: {
    color: 0x27332c,
    emissive: 0x0c130e,
    emissiveIntensity: .025,
    roughness: .76,
    metalness: 0,
    clearcoat: .04,
    clearcoatRoughness: .72,
  },
  edgeTrimWidth: .65,
  edgeAccent: true,
  edgeAccentMaterial: {
    color: 0xc7a45b,
    emissive: 0x2c210d,
    emissiveIntensity: .08,
    roughness: .62,
    metalness: .18,
    clearcoat: .08,
    clearcoatRoughness: .6,
  },
  edgeTrimTopMatchesSurface: true,
  rimLight: {
    color: 0xffe2ae,
    intensity: .12,
  },
  tileBackGradient: ['#bd5b48', '#bd5b48', '#bd5b48'],
  tileFaceGradient: ['#f8f5ed', '#e8e5dc', '#cfd2ca'],
  tileAoIntensity: .32,
  tile: {
    ...defaultTableTheme.tile,
    side: {
      ...defaultTableTheme.tile.side,
      color: 0xfff9ec,
      metalness: 0,
      roughness: .18,
      clearcoat: 1,
      clearcoatRoughness: .1,
      ior: 1.48,
      specularIntensity: .72,
      specularColor: 0xffffff,
      envMapIntensity: .62,
    },
    faceSide: {
      ...defaultTableTheme.tile.faceSide,
      color: 0xa94d3b,
      metalness: 0,
      roughness: .16,
      clearcoat: 1,
      clearcoatRoughness: .1,
      ior: 1.48,
      specularIntensity: .82,
      specularColor: 0xfff3e8,
      envMapIntensity: 1,
    },
    bottom: {
      ...defaultTableTheme.tile.bottom,
      color: 0xe9e1d0,
      metalness: 0,
      roughness: .22,
      clearcoat: 1,
      clearcoatRoughness: .1,
      ior: 1.48,
      specularIntensity: .62,
      envMapIntensity: .48,
    },
    back: {
      ...defaultTableTheme.tile.back,
      color: 0xf0a58f,
      metalness: 0,
      roughness: .17,
      clearcoat: 1,
      clearcoatRoughness: .1,
      ior: 1.48,
      specularIntensity: 1,
      specularColor: 0xfff3e8,
      envMapIntensity: 1,
    },
    face: {
      ...defaultTableTheme.tile.face,
      color: 0xffffff,
      metalness: 0,
      roughness: .2,
      clearcoat: 1,
      clearcoatRoughness: .1,
      ior: 1.48,
      specularIntensity: .72,
      specularColor: 0xffffff,
      envMapIntensity: .82,
    },
  },
  highlight: {
    color: 0xe4b861,
    emissive: 0x3a240b,
    emissiveIntensity: .42,
    roughness: .3,
  },
}

/** 主题注册表：按名字取主题（URL ?theme=<name> 等调试/换肤入口用）。 */
export const TABLE_THEMES: Record<string, TableTheme> = {
  jade: defaultTableTheme,
  rosewood: rosewoodTheme,
  majsoul: majsoulTheme,
  happyMahjong: happyMahjongTheme,
  llm: llmTheme,
  llmAnime: llmAnimeTheme,
}

export const TABLE_THEME_OPTIONS = [
  { value: 'jade', label: '默认墨玉', description: '深绿玉石与金色桌沿' },
  { value: 'majsoul', label: '雀魂风', description: '蓝灰台面与木质边框' },
  { value: 'happyMahjong', label: '欢乐麻将', description: '青绿色绒面与翡翠牌背' },
  { value: 'rosewood', label: '红木金丝', description: '红棕台面与暖金包边' },
  { value: 'llm', label: '大模型专属', description: '双模型娘化对决与深蓝星轨' },
  { value: 'llmAnime', label: '大模型二次元', description: '鼠尾草绒面、树脂麻将与角色演出' },
] as const

export type TableThemeName = typeof TABLE_THEME_OPTIONS[number]['value']

/** 按名字解析主题；名字未知或未提供返回 undefined（调用方回退默认主题）。 */
export function tableThemeByName(name: string | null | undefined): TableTheme | undefined {
  return name ? TABLE_THEMES[name] : undefined
}

