import type { ServerSnapshot } from '../protocol/dto'

/**
 * 开局动画使用的第一份权威快照门闸。
 *
 * round_start 和 state_snapshot 不是同一条消息，慢网下两者的先后不能假定。
 * 只接受当前 round 的 opening 快照，并在取消/超时后释放等待者，避免旧时间线
 * 永久挂起。
 */
export interface OpeningSnapshotGate {
  begin(round: number): void
  capture(snapshot: ServerSnapshot): boolean
  wait(): Promise<ServerSnapshot | null>
  cancel(): void
}

export function createOpeningSnapshotGate(timeoutMs = 15000): OpeningSnapshotGate {
  let activeRound = -1
  let snapshot: ServerSnapshot | null = null
  let resolveWait: ((value: ServerSnapshot | null) => void) | null = null
  let timeout: ReturnType<typeof setTimeout> | null = null

  function clearWait() {
    if (timeout != null) {
      clearTimeout(timeout)
      timeout = null
    }
    resolveWait = null
  }

  function cancel() {
    const resolve = resolveWait
    clearWait()
    resolve?.(null)
    activeRound = -1
    snapshot = null
  }

  function begin(round: number) {
    cancel()
    activeRound = round
  }

  function capture(value: ServerSnapshot) {
    if (value.round !== activeRound || value.phase !== 'opening' || snapshot) return false
    snapshot = value
    const resolve = resolveWait
    clearWait()
    resolve?.(value)
    return true
  }

  function wait() {
    if (snapshot) return Promise.resolve(snapshot)
    return new Promise<ServerSnapshot | null>((resolve) => {
      resolveWait = resolve
      timeout = setTimeout(() => {
        const done = resolveWait
        clearWait()
        done?.(null)
      }, timeoutMs)
    })
  }

  return { begin, capture, wait, cancel }
}
