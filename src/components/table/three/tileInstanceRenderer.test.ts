import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { createTileInstanceRenderer } from './tileInstanceRenderer'

describe('tileInstanceRenderer', () => {
  it('marks instance matrices dirty after a tween updates a tile', () => {
    const scene = new THREE.Scene()
    const dynamicGroups: THREE.Object3D[] = []
    const geometry = new THREE.BoxGeometry(1, 1, 1)
    const atlasGeometry = geometry.clone()
    const material = new THREE.MeshBasicMaterial()
    scene.userData.tileBaseGeometry = geometry
    scene.userData.tileCapGeometry = geometry
    scene.userData.faceSide = material
    scene.userData.backMaterial = material
    scene.userData.tileSide = material
    scene.userData.tileBottom = material

    const renderer = createTileInstanceRenderer({
      scene,
      dynamicGroups,
      ownDynamic: (resource) => resource,
      getAtlasMaterial: () => material,
      getAtlasCapGeometry: () => atlasGeometry,
      atlasCellUvFor: () => ({ u: 0, v: 0 }),
    })

    renderer.begin()
    const tile = renderer.add(
      new THREE.Vector3(),
      new THREE.Quaternion(),
      null,
    )
    renderer.finish()

    const baseMesh = dynamicGroups[0] as THREE.InstancedMesh
    const baseVersion = baseMesh.instanceMatrix.version
    const capVersion = tile.capMesh.instanceMatrix.version

    renderer.set(
      tile.baseIndex,
      tile.capMesh,
      tile.capIndex,
      new THREE.Vector3(2, 3, 4),
      new THREE.Quaternion(),
      0.8,
    )

    expect(baseMesh.instanceMatrix.version).toBeGreaterThan(baseVersion)
    expect(tile.capMesh.instanceMatrix.version).toBeGreaterThan(capVersion)

    geometry.dispose()
    atlasGeometry.dispose()
    material.dispose()
  })
})
