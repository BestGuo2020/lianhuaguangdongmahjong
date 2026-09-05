import { BloodFlowEngine } from '../engine'
import { bloodFlowSeatView } from '../seatView'
import type { BloodFlowSeatView } from '../seatView'
import { decideBloodFlowAction } from '../ai'
import { createBloodFlowWorkerClient } from '../workerClient'
import type { BloodFlowAuthorityBackend } from './authority'

/** In-process backend for deterministic simulations. Browser hosts use worker backend. */
export function createDirectAuthorityBackend(now: () => number = Date.now, testTiming: { winBeatMs?: number } = {}) {
  let engine: BloodFlowEngine | null = null
  const get = () => { if (!engine) throw new Error('No authority'); return engine }
  return {
    get engine() { return get() },
    start: async options => { engine = new BloodFlowEngine({ ...options, ...testTiming, now }) },
    view: async seat => bloodFlowSeatView(get(), seat),
    command: async command => { get().submit(command) },
    bot: async (seat, windowId) => {
      if (get().window?.id !== windowId) return
      const action = decideBloodFlowAction(bloodFlowSeatView(get(), seat))
      if (action) get().submit(get().command(seat, action))
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
    command: async command => { await client.request({ kind: 'command', command }) },
    bot: async (seat, windowId) => { await client.request({ kind: 'bot', seat, windowId }) },
    expire: async windowId => { await client.request({ kind: 'expire', windowId }) },
    pause: async () => { await client.request({ kind: 'pause' }) }, resume: async () => { await client.request({ kind: 'resume' }) },
    close: client.close,
  }
}
