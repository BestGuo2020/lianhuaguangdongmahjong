/**
 * vibehub 房主侧开局屏障。
 *
 * 房主是 P2P 对局的权威，不存在 WebSocket 后端替它等待 opening_done，
 * 因此由房主按当前在线 peer 集合判断是否可以进入首回合。
 */
export interface HostOpeningBarrier {
  wait(round: number, honba: number): Promise<void>
  markLocalReady(round: number, honba: number): void
  markPeerReady(peerId: string, round: number, honba: number): void
  removePeer(peerId: string): void
  cancel(): void
}

export function createHostOpeningBarrier(
  getLivePeerIds: () => string[],
  // 保留参数以兼容现有调用方；它不再是放行逻辑的兜底。
  // 房主 viewer 未 ready 时绝不能让权威引擎先进入首回合。
  _timeoutMs = 60000,
): HostOpeningBarrier {
  let activeRound = -1
  let activeHonba = -1
  let localReady = false
  let peerReady = new Set<string>()
  let resolveWait: (() => void) | null = null

  function clearWait() {
    resolveWait = null
  }

  function finish() {
    const resolve = resolveWait
    clearWait()
    resolve?.()
  }

  function maybeFinish() {
    if (!localReady) return
    const livePeers = getLivePeerIds()
    if (livePeers.every((peerId) => peerReady.has(peerId))) finish()
  }

  function wait(round: number, honba: number) {
    cancel()
    activeRound = round
    activeHonba = honba
    return new Promise<void>((resolve) => {
      resolveWait = resolve
      maybeFinish()
    })
  }

  function markLocalReady(round: number, honba: number) {
    if (round !== activeRound || honba !== activeHonba) return
    localReady = true
    maybeFinish()
  }

  function markPeerReady(peerId: string, round: number, honba: number) {
    if (round !== activeRound || honba !== activeHonba || !getLivePeerIds().includes(peerId)) return
    peerReady.add(peerId)
    maybeFinish()
  }

  function removePeer(peerId: string) {
    peerReady.delete(peerId)
    maybeFinish()
  }

  function cancel() {
    const resolve = resolveWait
    clearWait()
    resolve?.()
    activeRound = -1
    activeHonba = -1
    localReady = false
    peerReady = new Set<string>()
  }

  return { wait, markLocalReady, markPeerReady, removePeer, cancel }
}
