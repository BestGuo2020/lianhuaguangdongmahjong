import { BloodFlowEngine } from '../engine'
import { bloodFlowSeatView } from '../seatView'
import type { BloodFlowSeatView } from '../seatView'
import { decideBloodFlowAction, decideBloodFlowActionEv } from '../ai'
import { BLOOD_FLOW_AI } from '../config'
import { createBloodFlowWorkerClient } from '../workerClient'
import type { BloodFlowAuthorityBackend } from './authority'
import type { EngineReproductionDump } from '../../../../replay/analysis/onlineReproduction'

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
export function createDirectAuthorityBackend(now: () => number = Date.now,
  testTiming: { winBeatMs?: number; recordCommands?: boolean } = {}) {
  let engine: BloodFlowEngine | null = null
  const get = () => { if (!engine) throw new Error('No authority'); return engine }
  return {
    get engine() { return get() },
    start: async options => { engine = new BloodFlowEngine({ ...options, ...testTiming, now }) },
    view: async seat => bloodFlowSeatView(get(), seat),
    // 旁观视角（本地专用，供对局回放）：四家明牌 + 累计弃牌流水；永不下发到网络。
    spectator: async () => bloodFlowSeatView(get(), 0, { revealAll: true, includeDiscards: true }),
    command: async command => get().submit(command),
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
    // §6 赛后私有复现数据：开局快照 + 权威真正执行过的命令序列（引擎侧记录，见 recordCommands）。
    reproduction: async () => ({
      roundId: get().options.roundId,
      opening: get().initialOpening, openingScores: get().openingScores, dealer: get().dealer,
      commands: get().recordedCommands, dice: get().initialDice,
    }),
    pause: async () => { get().pause() }, resume: async () => { get().resume() },
    close: () => { engine = null },
  } satisfies BloodFlowAuthorityBackend & { readonly engine: BloodFlowEngine }
}

/**
 * 浏览器权威后端（引擎跑在 worker 里）。
 *
 * `recordCommands`：开启后引擎自己维护权威命令序列与开局快照，供**局后**产出 §6 复现数据。
 * 默认关闭 —— 单机、模拟与不需要分析的联机房间都不该为此付任何成本。
 */
export function createWorkerAuthorityBackend(options: { recordCommands?: boolean } = {}): BloodFlowAuthorityBackend {
  const client = createBloodFlowWorkerClient()
  return {
    start: async startOptions => {
      await client.request({ kind: 'start', options: options.recordCommands ? { ...startOptions, recordCommands: true } : startOptions })
    },
    view: seat => client.request<BloodFlowSeatView>({ kind: 'view', seat }),
    // 旁观视角：worker 侧带 `replay` 标记的回复附带四家明牌 + 累计弃牌流水（本地专用）。
    // 若旧 worker 不支持该标记（版本漂移），退回座位 0 的普通视图并把明牌缺失暴露出来。
    spectator: async () => {
      const view = await client.request<BloodFlowSeatView & { replay?: BloodFlowSeatView }>({ kind: 'view', seat: 0, replay: true })
      return view.replay ?? view
    },
    // §6 赛后私有复现数据：只在局后由权威端索取；旧 worker 不认识这条消息会报错，调用方如实标记"拿不到"。
    reproduction: () => client.request<EngineReproductionDump>({ kind: 'reproduction' }),
    // 提交结果（是否被引擎接受）回传给权威端，供分析记录落执行回执（§3.4）。
    // 旧 worker 没有该字段时返回 undefined，调用方按"未知"处理，不谎称执行过。
    command: async command => {
      const reply = await client.request<BloodFlowSeatView & { commandAccepted?: boolean }>({ kind: 'command', command })
      return reply?.commandAccepted
    },
    bot: async (seat, windowId) => {
      // 权威机器人实际提交的动作随回复回传（供分析记录落成真命令，§6/§10.6）；
      // 旧 worker 没有该字段时退回 undefined，由调用方如实落 auto 标记。
      const reply = await client.request<BloodFlowSeatView & { botAction?: unknown }>({ kind: 'bot', seat, windowId })
      return reply?.botAction
    },
    expire: async windowId => { await client.request({ kind: 'expire', windowId }) },
    pause: async () => { await client.request({ kind: 'pause' }) }, resume: async () => { await client.request({ kind: 'resume' }) },
    close: client.close,
  }
}
