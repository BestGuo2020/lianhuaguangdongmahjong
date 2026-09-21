import { describe, expect, it } from 'vitest'
import { SEATS, type BloodFlowOpeningState } from './state'
import type { GamePlayer, Meld, TileType } from '../../../core/contracts/types'
import { createWall } from '../../../core/rules/tiles'

// 权威 worker 的回执契约（§3.4、§6、§10.2）：
// - `commandAccepted`：这次提交权威是否接受。分析录制据此决定要不要记进"权威命令序列"——
//   记下被拒命令会让重放执行一条权威从未执行的动作（静默分叉）。
// - `expireAdvanced`：这条 expire 是否真的推进了窗口。窗口没到截止时间时 engine.expire 是无操作，
//   记成"靠超时推进"会让重放替引擎多做一次决定。

interface WorkerReply { id: number; result?: Record<string, unknown>; error?: string }

const posted: WorkerReply[] = []
let onMessage: ((event: { data: Record<string, unknown> }) => void) | null = null
// worker 模块在导入时就注册 self.onmessage：必须先造一个最小的 self，再动态导入。
;(globalThis as { self?: unknown }).self = {
  postMessage: (message: WorkerReply) => { posted.push(message) },
  set onmessage(handler: (event: { data: Record<string, unknown> }) => void) { onMessage = handler },
  get onmessage() { return onMessage },
}
await import('./engineWorker')

function buildOpening(): BloodFlowOpeningState {
  const pool = createWall()
  const remove = (tile: TileType) => { const index = pool.indexOf(tile); if (index >= 0) pool.splice(index, 1) }
  const flipTiles: [TileType, TileType] = ['p9', 'white']
  flipTiles.forEach(remove)
  const players = SEATS.map((seat): GamePlayer => ({
    seat, name: `P${seat}`, avatar: '', score: 2000,
    hand: pool.splice(0, seat === 0 ? 14 : 13),
    melds: [] as Meld[], discards: [], redCount: 0, drawnTileIndex: -1,
  }))
  return {
    players, wall: pool, flipTiles, jokers: ['red', 'green'],
    headDrawn: 134 - pool.length, dealerDrawnIndex: players[0].hand.length - 1,
    flipStack: 0, flipSeat: 0, wallBreakIndex: 2,
  }
}

function send(data: Record<string, unknown>): WorkerReply {
  posted.length = 0
  onMessage!({ data: { id: 7, ...data } })
  expect(posted.length, 'worker 必须回一条消息').toBe(1)
  return posted[0]
}

function start(options: Record<string, unknown> = {}) {
  const opening = buildOpening()
  const reply = send({
    kind: 'start',
    options: { authorityEpoch: 'test', roundId: 'round-1', dealer: 0, opening, winBeatMs: 0, paced: false, ...options },
  })
  expect(reply.error).toBeUndefined()
  return reply.result as { window: { id: string; kind: string } | null }
}

describe('权威 worker 的回执（§3.4、§6）', () => {
  it('接受的命令 ⇒ commandAccepted=true；同一座位再提交 ⇒ false（重复决定会被拒）', () => {
    const view = start()
    const windowId = view.window!.id
    const own = send({ kind: 'view', seat: 0 }).result as { ownActions: Array<{ kind: string; index?: number }> }
    const discard = own.ownActions.find(action => action.kind === 'discard')!
    const first = send({
      kind: 'command',
      command: { authorityEpoch: 'test', roundId: 'round-1', windowId, stateVersion: 1, seat: 0, action: discard },
    })
    expect(first.result?.commandAccepted).toBe(true)
    const repeat = send({
      kind: 'command',
      command: { authorityEpoch: 'test', roundId: 'round-1', windowId, stateVersion: 1, seat: 0, action: discard },
    })
    expect(repeat.result?.commandAccepted, '同一窗口同一座位的第二次提交必须被拒').toBe(false)
  })

  it('对不上的窗口提交 ⇒ commandAccepted=false（迟到的命令不算执行）', () => {
    start()
    const reply = send({
      kind: 'command',
      command: { authorityEpoch: 'test', roundId: 'round-1', windowId: 'round-1/window/999', stateVersion: 1, seat: 0,
        action: { kind: 'discard', index: 0 } },
    })
    expect(reply.result?.commandAccepted).toBe(false)
  })

  it('窗口未到截止时间 ⇒ expireAdvanced=false（提前发出的 expire 是无操作）', () => {
    const view = start()
    const reply = send({ kind: 'expire', windowId: view.window!.id })
    expect(reply.result?.expireAdvanced, '默认决策时长下 expire 必须报未推进').toBe(false)
  })

  it('到点后的 expire ⇒ expireAdvanced=true（这条才是"靠超时推进"）', () => {
    const view = start({ decisionMs: 0 })
    const reply = send({ kind: 'expire', windowId: view.window!.id })
    expect(reply.result?.expireAdvanced).toBe(true)
  })

  it('窗口 id 不匹配的 expire ⇒ false，不会误判成推进', () => {
    const view = start({ decisionMs: 0 })
    const reply = send({ kind: 'expire', windowId: `${view.window!.id}-stale` })
    expect(reply.result?.expireAdvanced).toBe(false)
  })

  it('机器人代决：回传实际动作与实际接受结果', () => {
    const view = start()
    const reply = send({ kind: 'bot', seat: 0, windowId: view.window!.id })
    const result = reply.result as { botAction?: unknown; commandAccepted?: boolean }
    // 机器人可能选择"过"（此时它不提交任何动作 ⇒ 没有接受可言）
    if (result.botAction === undefined) expect(result.commandAccepted).toBe(false)
    else expect(result.commandAccepted).toBe(true)
  })
})
