import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { pointFromSeat } from '../../../game/core/presentation/tableLayout'
import { toonGradientMap } from './staticTableScene'
import { makeContactShadowTexture, CONTACT_SHADOW_OFFSET_X, CONTACT_SHADOW_OFFSET_Z } from './tileInstanceRenderer'

interface DisposableResource { dispose?: () => void }

interface DicePresenterOptions {
  scene: THREE.Scene
  own<T extends DisposableResource>(resource: T): T
  getOpeningStage(): string | null
  getValues(): number[]
  getThrowerIndex(): number
  tileLayerZ: number
  /** 二次元：骰子也用 ToonMaterial，去掉写实高光/塑料膜感。 */
  anime?: boolean
}

const DICE_SIZE = .5
const DICE_LANDING_Y = .62
const DICE_SHADOW_Y = .075

export function createDicePresenter(options: DicePresenterOptions) {
  let startedAt = 0
  const group = new THREE.Group()

  function makeTexture(value: number) {
    const surface = document.createElement('canvas')
    surface.width = 192
    surface.height = 192
    const context = surface.getContext('2d')!
    const gradient = context.createLinearGradient(0, 0, 192, 192)
    gradient.addColorStop(0, '#fffef5')
    gradient.addColorStop(1, '#d9d9cd')
    context.fillStyle = gradient
    context.fillRect(0, 0, 192, 192)
    const positions: Record<number, number[][]> = {
      1: [[96, 96]], 2: [[55, 55], [137, 137]], 3: [[52, 52], [96, 96], [140, 140]],
      4: [[54, 54], [138, 54], [54, 138], [138, 138]],
      5: [[52, 52], [140, 52], [96, 96], [52, 140], [140, 140]],
      6: [[55, 45], [137, 45], [55, 96], [137, 96], [55, 147], [137, 147]],
    }
    context.fillStyle = value === 1 ? '#b42629' : '#17251f'
    positions[value]!.forEach(([x, y]) => {
      context.beginPath()
      context.arc(x!, y!, 17, 0, Math.PI * 2)
      context.fill()
    })
    const texture = options.own(new THREE.CanvasTexture(surface))
    texture.colorSpace = THREE.SRGBColorSpace
    return texture
  }

  function settledQuaternion(value: number) {
    const rotations: Record<number, [number, number, number]> = {
      1: [0, 0, 0], 2: [0, 0, Math.PI / 2], 3: [-Math.PI / 2, 0, 0],
      4: [Math.PI / 2, 0, 0], 5: [0, 0, -Math.PI / 2], 6: [Math.PI, 0, 0],
    }
    return new THREE.Quaternion().setFromEuler(new THREE.Euler(...(rotations[value] ?? rotations[1]!)))
  }

  function rollingQuaternion(index: number, progress: number) {
    return new THREE.Quaternion().setFromEuler(new THREE.Euler(
      progress * Math.PI * (index === 0 ? 9 : 8),
      progress * Math.PI * (index === 0 ? 7 : -9),
      progress * Math.PI * (index === 0 ? -5 : 6),
    ))
  }

  const materials = Array.from({ length: 6 }, (_, index) => options.own(options.anime
    ? new THREE.MeshToonMaterial({ map: makeTexture(index + 1), gradientMap: toonGradientMap() })
    : new THREE.MeshStandardMaterial({ map: makeTexture(index + 1), roughness: .5, metalness: 0 })))
  const faceMaterials = [materials[1]!, materials[4]!, materials[0]!, materials[5]!, materials[2]!, materials[3]!]
  const geometry = options.own(new RoundedBoxGeometry(DICE_SIZE, DICE_SIZE, DICE_SIZE, 6, .08))
  const dice: THREE.Mesh[] = []
  const shadowPlanes: THREE.Mesh[] = []
  const shadowTexture = options.anime ? options.own(makeContactShadowTexture()) : null
  for (let index = 0; index < 2; index += 1) {
    const die = new THREE.Mesh(geometry, faceMaterials)
    die.castShadow = true
    die.receiveShadow = true
    group.add(die)
    dice.push(die)
    if (options.anime && shadowTexture) {
      const shadowPlane = new THREE.Mesh(
        new THREE.PlaneGeometry(.8, .8),
        new THREE.MeshBasicMaterial({ map: shadowTexture, transparent: true, depthWrite: false }),
      )
      shadowPlane.rotation.x = -Math.PI / 2
      group.add(shadowPlane)
      shadowPlanes.push(shadowPlane)
    }
  }
  options.scene.add(group)

  let lastValuesKey = ''
  let lastStage: string | null = null

  function setVisible(visible: boolean) {
    group.visible = visible
    if (!visible) {
      // 即使中间阶段没有机会渲染出一帧，下一次 visible 也必须被视为新的投骰。
      lastStage = null
      return
    }
    // Vue watcher 可能在下一帧才触发；只有从其它阶段进入骰子阶段时才重置，
    // 避免同一段动画因重复通知而从中途重新开始。
    if (lastStage !== 'dice') {
      startedAt = performance.now()
      lastValuesKey = ''
    }
  }

  function animate(time: number) {
    const stage = options.getOpeningStage()
    const valuesKey = options.getValues().join(',')
    if (stage !== 'dice') {
      if (group.visible) group.visible = false
      lastStage = stage
      return false
    }
    const enteredDice = lastStage !== 'dice'
    // 重新进入骰子阶段，或骰子值变化（莲花麻将两次掷骰）时重新起势
    if (!group.visible || enteredDice || valuesKey !== lastValuesKey) {
      group.visible = true
      startedAt = performance.now()
      lastValuesKey = valuesKey
    }
    lastStage = 'dice'
    const progress = Math.min(1, Math.max(0, (time - startedAt) / 1050))
    const travel = 1 - (1 - progress) ** 2
    dice.forEach((die, index) => {
      const side = index === 0 ? -1 : 1
      const throwPoint = pointFromSeat(options.getThrowerIndex(), side * (.58 + .22 * travel), THREE.MathUtils.lerp(5.2, .2, travel) + side * .1)
      die.position.set(throwPoint.x, DICE_LANDING_Y, throwPoint.z + options.tileLayerZ)
      const arc = Math.sin(Math.PI * Math.min(progress / .82, 1)) * 2.6
      const bounceProgress = Math.max(0, (progress - .82) / .18)
      const bounce = bounceProgress > 0 ? Math.abs(Math.sin(bounceProgress * Math.PI * 2)) * .14 * (1 - bounceProgress) : 0
      die.position.y += arc + bounce
      const settleStart = .72
      if (progress < settleStart) die.quaternion.copy(rollingQuaternion(index, progress))
      else die.quaternion.copy(rollingQuaternion(index, settleStart)).slerp(settledQuaternion(options.getValues()[index] || 1), (progress - settleStart) / (1 - settleStart))
      if (shadowPlanes[index]) {
        shadowPlanes[index]!.position.set(
          die.position.x + CONTACT_SHADOW_OFFSET_X,
          DICE_SHADOW_Y,
          die.position.z + CONTACT_SHADOW_OFFSET_Z,
        )
      }
    })
    return progress < 1
  }

  setVisible(options.getOpeningStage() === 'dice')
  return { animate, setVisible }
}
