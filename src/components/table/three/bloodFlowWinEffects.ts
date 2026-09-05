import type * as THREE from 'three'
import { createWinEffectPresenter, type WinEffectPresenterOptions } from './winEffectPresenter'
import { bloodFlowWinPiles } from './bloodFlowWinPile'
import { BloodFlowPresentationQueue } from '../../../game/variants/lotus/bloodFlow/presentation'
import { prefersReducedMotion } from '../../../game/core/presentation/winEffect'
import type { WinEffect } from '../../../game/core/contracts/gamePort'

/** Reuse the existing light/particle effect; keep its resources outside table rebuilds. */
export function createBloodFlowWinEffects(options: WinEffectPresenterOptions) {
  const queue = new BloodFlowPresentationQueue()
  let restoreKey: string | undefined, initialized = false, serial = 0, nextCueAt = 0
  const active = new Map<number, { presenter: ReturnType<typeof createWinEffectPresenter>; until: number; dispose(): void }>()
  function clear() {
    active.forEach(effect => effect.dispose()); active.clear(); nextCueAt = 0
  }
  function sync() {
    const batches = options.props.bloodFlowBatches ?? []
    if (!initialized || restoreKey !== options.props.bloodFlowPresentationKey) {
      initialized = true; restoreKey = options.props.bloodFlowPresentationKey
      clear(); queue.reset(batches); return
    }
    for (const batch of batches) queue.enqueue(batch, performance.now())
  }
  function animate(now: number) {
    for (const [seat, effect] of active) if (now >= effect.until) { effect.dispose(); active.delete(seat) }
    if (now >= nextCueAt) {
      const cue = queue.next(now)
      if (cue) {
        const duration = prefersReducedMotion() ? 420 : Math.max(750, cue.duration)
        nextCueAt = now + duration
        const piles = bloodFlowWinPiles(options.props.bloodFlowBatches ?? [], options.props.localSeat, options.props.bloodFlowCompact)
        for (const feedback of cue.seats) {
          const seat = (feedback.seat - options.props.localSeat + 4) % 4
          const tile = piles[seat].tiles.find(t => t.record.id === feedback.record.id)
          if (!tile) continue
          active.get(seat)?.dispose()
          const groups: THREE.Object3D[] = [], resources = new Set<{ dispose?: () => void }>()
          const own = <T>(resource: T): T => { resources.add(resource as { dispose?: () => void }); return resource }
          const effect: WinEffect = { id: ++serial, winnerIndex: seat, tile: tile.tile, duration,
            reducedMotion: prefersReducedMotion(), robbedKong: false, robbedKongPlayerIndex: -1, robbedKongMeldIndex: -1 }
          let presenter: ReturnType<typeof createWinEffectPresenter> | undefined
          const dispose = () => {
            presenter?.reset(); groups.forEach(group => group.removeFromParent())
            resources.forEach(resource => resource.dispose?.()); resources.clear()
          }
          try {
            presenter = createWinEffectPresenter({ ...options, own, ownDynamic: own, dynamicGroups: groups,
              props: { ...options.props, winEffect: effect }, winLayout: () => tile, showWinningTile: false })
            presenter.addWinEffect()
            groups.forEach(group => { group.name = 'blood-flow-win-effect'; group.userData.recordId = tile.record.id })
            active.set(seat, { presenter, until: now + duration, dispose })
          } catch { dispose() } // Decorative allocation failure must not stop the table render loop.
        }
      }
    }
    active.forEach(effect => effect.presenter.animate(now))
    if (!active.size) nextCueAt = 0
    return active.size > 0
  }
  return { sync, animate, dispose: () => { clear(); queue.reset() }, get activeCount() { return active.size } }
}
