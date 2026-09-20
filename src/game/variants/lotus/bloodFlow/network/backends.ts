import { BloodFlowEngine } from '../engine'
import { bloodFlowSeatView } from '../seatView'
import type { BloodFlowSeatView } from '../seatView'
import { decideBloodFlowAction, decideBloodFlowActionEv } from '../ai'
import { BLOOD_FLOW_AI } from '../config'
import { createBloodFlowWorkerClient } from '../workerClient'
import type { BloodFlowAuthorityBackend } from './authority'

/**
 * 权威机器人命令的观察钩子（分析与测试用）。
 * 机器人由权威侧就地决定并提交，**选择本身不回传主线程** ⇒ 分析记录里只能落 auto 标记、
 * 该局也就无法复现（§10.6）。这个钩子把"权威实际提交了什么"暴露出来，
 * 让录制与离线校验拿到真实命令（含牌种/索引等载荷）。
 */
export type BotCommandObserver = (seat: number, action: unknown, windowId: string | undefined) => void
let botCommandObserver: BotCommandObserver | null = null
export function setBotCommandObserver(observer: BotCommandObserver | null) { botCommandObserver = observer }

/** In-process backend for deterministic simulations. Browser hosts use worker backend. */
export function createDirectAuthorityBackend(now: () => number = Date.now, testTiming: { winBeatMs?: number } = {}) {
  let engine: BloodFlowEngine | null = null
  const get = () => { if (!engine) throw new Error('No authority'); return engine }
  return {
    get engine() { return get() },
    start: async options => { engine = new BloodFlowEngine({ ...options, ...testTiming, now }) },
    view: async seat => bloodFlowSeatView(get(), seat),
    // 旁观视角（本地专用，供对局回放）：四家明牌 + 累计弃牌流水；永不下发到网络。
    spectator: async () => bloodFlowSeatView(get(), 0, { revealAll: true, includeDiscards: true }),
    command: async command => { get().submit(command) },
    bot: async (seat, windowId) => {
      if (get().window?.id !== windowId) return
      const view = bloodFlowSeatView(get(), seat)
      const action = BLOOD_FLOW_AI.strategy === 'legacy'
        ? decideBloodFlowAction(view, BLOOD_FLOW_AI.minimumFirstPayment)
        : decideBloodFlowActionEv(view, BLOOD_FLOW_AI)
      if (action) {
        // 通知观察者（分析记录/测试）：权威实际提交的动作与所属窗口
        botCommandObserver?.(seat, action, windowId)
        get().submit(get().command(seat, action))
      }
    },
    expire: async id => { get().expire(now(), id) },
    pause: async () => { get().pause() }, resume: async () => { get().resume() },
    close: () => { engine = null },
  } satisfies BloodFlowAuthorityBackend & { readonly engine: BloodFlowEngine }
}

export function createWorkerAuthorityBackend(): BloodFlowAuthorityBackend {
  const client = createBloodFlowWorkerClient()
  return {
    start: async options => { await client.request({ kind: 'start', options }) },
    view: seat => client.request<BloodFlowSeatView>({ kind: 'view', seat }),
    // 旁观视角：worker 侧带 `replay` 标记的回复附带四家明牌 + 累计弃牌流水（本地专用）。
    // 若旧 worker 不支持该标记（版本漂移），退回座位 0 的普通视图并把明牌缺失暴露出来。
    spectator: async () => {
      const view = await client.request<BloodFlowSeatView & { replay?: BloodFlowSeatView }>({ kind: 'view', seat: 0, replay: true })
      return view.replay ?? view
    },
    command: async command => { await client.request({ kind: 'command', command }) },
    bot: async (seat, windowId) => { await client.request({ kind: 'bot', seat, windowId }) },
    expire: async windowId => { await client.request({ kind: 'expire', windowId }) },
    pause: async () => { await client.request({ kind: 'pause' }) }, resume: async () => { await client.request({ kind: 'resume' }) },
    close: client.close,
  }
}
