import * as THREE from 'three'
import type { TileType } from '../../../game/core/contracts/types'

interface TileInstanceRendererOptions {
  scene: THREE.Scene
  ownDynamic<T>(resource: T): T
  dynamicGroups: THREE.Object3D[]
  getAtlasMaterial(): THREE.Material
  getJokerAtlasMaterial?: () => THREE.Material
  getWildcardAtlasMaterial?: () => THREE.Material
  getLaiziAtlasMaterial?: () => THREE.Material
  getAtlasCapGeometry(): THREE.BufferGeometry
  atlasCellUvFor(tile: TileType): { u: number; v: number }
  isJoker?: (tile: TileType) => boolean
  isWildcard?: (tile: TileType) => boolean
  isLaizi?: (tile: TileType) => boolean
}

const INSTANCE_CAPACITY = 260
const TILE_BASE_OFFSET = new THREE.Matrix4().makeTranslation(0, -.06, 0)
const TILE_CAP_OFFSET = new THREE.Matrix4().makeTranslation(0, .13, 0)

export function createTileInstanceRenderer(options: TileInstanceRendererOptions) {
  let baseMesh: THREE.InstancedMesh | null = null
  let backCapMesh: THREE.InstancedMesh | null = null
  let atlasCapMesh: THREE.InstancedMesh | null = null
  let jokerAtlasCapMesh: THREE.InstancedMesh | null = null
  let wildcardAtlasCapMesh: THREE.InstancedMesh | null = null
  let laiziAtlasCapMesh: THREE.InstancedMesh | null = null
  let atlasUvAttribute: THREE.InstancedBufferAttribute | null = null
  let atlasUvData: Float32Array | null = null
  let jokerAtlasUvAttribute: THREE.InstancedBufferAttribute | null = null
  let jokerAtlasUvData: Float32Array | null = null
  let wildcardAtlasUvAttribute: THREE.InstancedBufferAttribute | null = null
  let wildcardAtlasUvData: Float32Array | null = null
  let laiziAtlasUvAttribute: THREE.InstancedBufferAttribute | null = null
  let laiziAtlasUvData: Float32Array | null = null
  let backCapCount = 0
  let atlasCapCount = 0
  let jokerAtlasCapCount = 0
  let wildcardAtlasCapCount = 0
  let laiziAtlasCapCount = 0
  let instanceCount = 0
  const matrix = new THREE.Matrix4()
  const scaleVector = new THREE.Vector3()

  function createCap(topMaterial: THREE.Material, geometry: THREE.BufferGeometry) {
    const cap = options.ownDynamic(new THREE.InstancedMesh(
      geometry,
      [options.scene.userData.tileSide, options.scene.userData.tileSide, topMaterial,
        options.scene.userData.tileBottom, options.scene.userData.tileSide, options.scene.userData.tileSide],
      INSTANCE_CAPACITY,
    ))
    cap.castShadow = true
    cap.receiveShadow = true
    cap.frustumCulled = false
    options.scene.add(cap)
    options.dynamicGroups.push(cap)
    return cap
  }

  function canReuse() {
    return Boolean(
      baseMesh?.parent === options.scene
      && backCapMesh?.parent === options.scene
      && atlasCapMesh?.parent === options.scene
      && jokerAtlasCapMesh?.parent === options.scene
      && wildcardAtlasCapMesh?.parent === options.scene
      && laiziAtlasCapMesh?.parent === options.scene,
    )
  }

  function begin(reuse = false) {
    if (!reuse || !canReuse()) {
      baseMesh = options.ownDynamic(new THREE.InstancedMesh(
        options.scene.userData.tileBaseGeometry,
        [options.scene.userData.faceSide, options.scene.userData.faceSide, options.scene.userData.faceSide,
          options.scene.userData.backMaterial, options.scene.userData.faceSide, options.scene.userData.faceSide],
        INSTANCE_CAPACITY,
      ))
      baseMesh.castShadow = true
      baseMesh.receiveShadow = true
      baseMesh.frustumCulled = false
      options.scene.add(baseMesh)
      options.dynamicGroups.push(baseMesh)
      backCapMesh = createCap(options.scene.userData.tileBottom, options.scene.userData.tileCapGeometry)
      atlasCapMesh = createCap(options.getAtlasMaterial(), options.getAtlasCapGeometry())
      jokerAtlasCapMesh = createCap(
        options.getJokerAtlasMaterial?.() ?? options.getAtlasMaterial(),
        options.ownDynamic(options.getAtlasCapGeometry().clone()),
      )
      wildcardAtlasCapMesh = createCap(
        options.getWildcardAtlasMaterial?.() ?? options.getAtlasMaterial(),
        options.ownDynamic(options.getAtlasCapGeometry().clone()),
      )
      laiziAtlasCapMesh = createCap(
        options.getLaiziAtlasMaterial?.() ?? options.getAtlasMaterial(),
        options.ownDynamic(options.getAtlasCapGeometry().clone()),
      )
      atlasUvData = new Float32Array(INSTANCE_CAPACITY * 2)
      atlasUvAttribute = new THREE.InstancedBufferAttribute(atlasUvData, 2)
      atlasCapMesh.geometry.setAttribute('aUvOffset', atlasUvAttribute)
      jokerAtlasUvData = new Float32Array(INSTANCE_CAPACITY * 2)
      jokerAtlasUvAttribute = new THREE.InstancedBufferAttribute(jokerAtlasUvData, 2)
      jokerAtlasCapMesh.geometry.setAttribute('aUvOffset', jokerAtlasUvAttribute)
      wildcardAtlasUvData = new Float32Array(INSTANCE_CAPACITY * 2)
      wildcardAtlasUvAttribute = new THREE.InstancedBufferAttribute(wildcardAtlasUvData, 2)
      wildcardAtlasCapMesh.geometry.setAttribute('aUvOffset', wildcardAtlasUvAttribute)
      laiziAtlasUvData = new Float32Array(INSTANCE_CAPACITY * 2)
      laiziAtlasUvAttribute = new THREE.InstancedBufferAttribute(laiziAtlasUvData, 2)
      laiziAtlasCapMesh.geometry.setAttribute('aUvOffset', laiziAtlasUvAttribute)
    }
    backCapCount = 0
    atlasCapCount = 0
    jokerAtlasCapCount = 0
    wildcardAtlasCapCount = 0
    laiziAtlasCapCount = 0
    instanceCount = 0
  }

  function set(baseIndex: number, capMesh: THREE.InstancedMesh, capIndex: number, position: THREE.Vector3, quaternion: THREE.Quaternion, scale: number) {
    scaleVector.setScalar(scale)
    matrix.compose(position, quaternion, scaleVector)
    baseMesh!.setMatrixAt(baseIndex, matrix.multiply(TILE_BASE_OFFSET))
    matrix.compose(position, quaternion, scaleVector)
    capMesh.setMatrixAt(capIndex, matrix.multiply(TILE_CAP_OFFSET))
    // setMatrixAt only mutates the CPU-side buffer. Mark both attributes dirty so
    // deal/discard/meld tween matrices are uploaded on the next render frame.
    baseMesh!.instanceMatrix.needsUpdate = true
    capMesh.instanceMatrix.needsUpdate = true
  }

  function add(position: THREE.Vector3, quaternion: THREE.Quaternion, face: TileType | null, scale = 1, initialPosition: THREE.Vector3 | null = null, initialScale: number | null = null) {
    const baseIndex = instanceCount++
    const joker = Boolean(face && options.isJoker?.(face))
    const wildcard = Boolean(face && !joker && options.isWildcard?.(face))
    const laizi = Boolean(face && !joker && !wildcard && options.isLaizi?.(face))
    const capMesh = !face ? backCapMesh!
      : joker ? jokerAtlasCapMesh!
        : wildcard ? wildcardAtlasCapMesh!
          : laizi ? laiziAtlasCapMesh!
            : atlasCapMesh!
    const capIndex = !face ? backCapCount++
      : joker ? jokerAtlasCapCount++
        : wildcard ? wildcardAtlasCapCount++
          : laizi ? laiziAtlasCapCount++
            : atlasCapCount++
    if (face) {
      const uv = options.atlasCellUvFor(face)
      const uvData = joker ? jokerAtlasUvData!
        : wildcard ? wildcardAtlasUvData!
          : laizi ? laiziAtlasUvData!
            : atlasUvData!
      uvData[capIndex * 2] = uv.u
      uvData[capIndex * 2 + 1] = uv.v
    }
    set(baseIndex, capMesh, capIndex, initialPosition ?? position, quaternion, initialScale ?? scale)
    return { baseIndex, capMesh, capIndex }
  }

  function finish() {
    baseMesh!.count = instanceCount
    backCapMesh!.count = backCapCount
    atlasCapMesh!.count = atlasCapCount
    jokerAtlasCapMesh!.count = jokerAtlasCapCount
    wildcardAtlasCapMesh!.count = wildcardAtlasCapCount
    laiziAtlasCapMesh!.count = laiziAtlasCapCount
    baseMesh!.instanceMatrix.needsUpdate = true
    backCapMesh!.instanceMatrix.needsUpdate = true
    atlasCapMesh!.instanceMatrix.needsUpdate = true
    jokerAtlasCapMesh!.instanceMatrix.needsUpdate = true
    wildcardAtlasCapMesh!.instanceMatrix.needsUpdate = true
    laiziAtlasCapMesh!.instanceMatrix.needsUpdate = true
    if (atlasUvAttribute) atlasUvAttribute.needsUpdate = true
    if (jokerAtlasUvAttribute) jokerAtlasUvAttribute.needsUpdate = true
    if (wildcardAtlasUvAttribute) wildcardAtlasUvAttribute.needsUpdate = true
    if (laiziAtlasUvAttribute) laiziAtlasUvAttribute.needsUpdate = true
  }

  return { begin, canReuse, add, set, finish }
}

export type TileInstanceRenderer = ReturnType<typeof createTileInstanceRenderer>
