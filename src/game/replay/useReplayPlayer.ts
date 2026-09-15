// 回放播放状态机：局 / 帧索引、播放暂停、速度、视角。
// 逐帧局面由 projection 预生成（一局最多百余帧），切帧是纯数组索引，播放靠定时器推进。
import { computed, onScopeDispose, ref, watch, type ComputedRef, type Ref } from 'vue'
import { buildReplayFrames, type ReplayFrame } from './projection'
import type { ReplayMatch, ReplayRound } from './types'

/** 基础步进间隔（毫秒）；速度倍率在其上叠加。 */
export const REPLAY_BASE_STEP_MS = 800
export const REPLAY_SPEEDS = [0.5, 1, 2, 4] as const
export type ReplaySpeed = typeof REPLAY_SPEEDS[number]

export interface UseReplayPlayerOptions {
  match: () => ReplayMatch | null
  rounds: () => ReplayRound[]
  stepMs?: number
}

export interface ReplayPlayer {
  roundIndex: Ref<number>
  frameIndex: Ref<number>
  playing: Ref<boolean>
  speed: Ref<ReplaySpeed>
  /** 全知视角（四家明牌）/ 按当时所见（他家暗牌）。 */
  revealAll: Ref<boolean>
  frames: ComputedRef<ReplayFrame[]>
  frame: ComputedRef<ReplayFrame | null>
  round: ComputedRef<ReplayRound | null>
  atStart: ComputedRef<boolean>
  atEnd: ComputedRef<boolean>
  /** 本局全部鸣牌/和牌节点对应的帧序号。 */
  actionFrames: ComputedRef<number[]>
  next(): void
  prev(): void
  first(): void
  last(): void
  play(): void
  pause(): void
  toggle(): void
  /** 跳到某一帧（事件列表点击用）。 */
  seek(index: number): void
  /** 切换局；越界自动收敛。 */
  selectRound(index: number): void
  stepBy(offset: number): void
  /** 跳到下一个（1）/ 上一个（-1）鸣牌或和牌节点。 */
  jumpAction(direction: 1 | -1): void
}

export function useReplayPlayer(options: UseReplayPlayerOptions): ReplayPlayer {
  const baseStepMs = options.stepMs ?? REPLAY_BASE_STEP_MS
  const roundIndex = ref(0)
  const frameIndex = ref(0)
  const playing = ref(false)
  const speed = ref<ReplaySpeed>(1)
  const revealAll = ref(true)

  const round = computed<ReplayRound | null>(() => options.rounds()[roundIndex.value] ?? null)
  const frames = computed<ReplayFrame[]>(() => {
    const match = options.match()
    const current = round.value
    if (!match || !current) return []
    return buildReplayFrames(match, current, { revealAll: revealAll.value })
  })
  const frame = computed<ReplayFrame | null>(() => {
    const list = frames.value
    if (!list.length) return null
    return list[Math.min(frameIndex.value, list.length - 1)] ?? null
  })
  const atStart = computed(() => frameIndex.value <= 0)
  const atEnd = computed(() => frameIndex.value >= frames.value.length - 1)
  /** 鸣牌/和牌节点（牌谱里的"重事件"）：跳转以它们为锚点，避免逐帧翻找。 */
  const actionFrames = computed(() => frames.value
    .filter((item) => item.step && (item.step.t === 'meld' || item.step.t === 'win'))
    .map((item) => item.index))

  let timer: number | null = null

  function stopTimer() {
    if (timer != null) {
      globalThis.clearTimeout(timer)
      timer = null
    }
  }

  function schedule() {
    stopTimer()
    if (!playing.value) return
    timer = globalThis.setTimeout(() => {
      timer = null
      if (!playing.value) return
      if (atEnd.value) {
        playing.value = false
        return
      }
      frameIndex.value += 1
      schedule()
    }, baseStepMs / speed.value) as unknown as number
  }

  function play() {
    if (playing.value || atEnd.value) {
      // 已在末帧：从开局重新播一遍。
      if (atEnd.value) frameIndex.value = 0
      else return
    }
    playing.value = true
    schedule()
  }

  function pause() {
    playing.value = false
    stopTimer()
  }

  function toggle() {
    if (playing.value) pause()
    else play()
  }

  function moveTo(index: number) {
    const total = frames.value.length
    if (!total) return
    frameIndex.value = Math.max(0, Math.min(index, total - 1))
    if (playing.value && atEnd.value) pause()
    else if (playing.value) schedule()
  }

  function stepBy(offset: number) {
    pause()
    moveTo(frameIndex.value + offset)
  }

  /** 跳到下一个/上一个鸣牌或和牌节点；越界时停在原位。 */
  function jumpAction(direction: 1 | -1) {
    const anchors = actionFrames.value
    if (!anchors.length) return
    pause()
    const current = frameIndex.value
    const target = direction > 0
      ? anchors.find((index) => index > current)
      : [...anchors].reverse().find((index) => index < current)
    if (target === undefined) return
    moveTo(target)
  }

  function selectRound(index: number) {
    const total = options.rounds().length
    if (!total) return
    pause()
    roundIndex.value = Math.max(0, Math.min(index, total - 1))
    frameIndex.value = 0
  }

  // 视角切换会重建帧序列（同一帧索引仍指向同一步动作）。
  watch(roundIndex, () => { frameIndex.value = 0 })

  onScopeDispose(stopTimer)

  return {
    roundIndex,
    frameIndex,
    playing,
    speed,
    revealAll,
    frames,
    frame,
    round,
    atStart,
    atEnd,
    actionFrames,
    next() { pause(); moveTo(frameIndex.value + 1) },
    prev() { pause(); moveTo(frameIndex.value - 1) },
    first() { pause(); moveTo(0) },
    last() { pause(); moveTo(frames.value.length - 1) },
    play,
    pause,
    toggle,
    seek(index) { pause(); moveTo(index) },
    selectRound,
    stepBy,
    jumpAction,
  }
}
