import { BloodFlowEngine } from './engine'
import type { BloodFlowEngineOptions } from './engine'
import type { EngineCommand } from './state'
import type { Seat } from './types'
import { bloodFlowSeatView } from './seatView'
import { decideBloodFlowAction, decideBloodFlowActionEv } from './ai'
import { BLOOD_FLOW_AI } from './config'
import { evaluateWaits } from '../patterns/evaluate'
import type { EngineReproductionDump } from '../../../replay/analysis/onlineReproduction'

export type EngineWorkerRequest = {
  id: number
  /**
   * 本地回放录制：回复里额外附带一份「旁观视角」（四家明牌 + 累计弃牌流水）。
   * 与座位视角同一次回复送达，因此不受 worker 重开/终止影响；该字段永不下发到网络。
   */
  replay?: boolean
} & (
  | { kind: 'start'; options: Omit<BloodFlowEngineOptions, 'random' | 'now'> }
  | { kind: 'command'; command: EngineCommand }
  | { kind: 'bot'; seat: Seat; windowId: string }
  | { kind: 'expire'; windowId: string }
  | { kind: 'advance'; transitionId: string }
  | { kind: 'view'; seat: Seat }
  | { kind: 'pause' | 'resume' }
  | { kind: 'waits'; seat: Seat; discardIndex: number | null; windowId: string }
  /**
   * §6 赛后私有复现数据：开局快照 + 权威实际执行的命令序列。
   * **只在局后**由权威端索取（进行中索取会把牌墙/暗手交给调用方，那是泄露）。
   */
  | { kind: 'reproduction' }
)
let engine: BloodFlowEngine | null = null
self.onmessage = ({ data }: MessageEvent<EngineWorkerRequest>) => {
  try {
    if (data.kind === 'start') engine = new BloodFlowEngine(data.options)
    if (!engine) throw new Error('No active blood-flow engine')
    let result: unknown
    /** 权威机器人实际提交的动作：随回复回传，供分析记录落成真命令（§6/§10.6）。 */
    let botAction: unknown = null
    /**
     * 这次提交权威**是否接受**（§3.4：请求发出 ≠ 动作执行）。
     * 只有 `{kind:'command'|'bot'}` 才有值；分析录制据此决定要不要记进"权威命令序列" ——
     * 记下被拒的命令会让重放执行一条权威从未执行的动作（静默分叉，比报错更难查）。
     */
    let commandAccepted: boolean | null = null
    /**
     * `{kind:'expire'}` 是否**真的推进了窗口**。窗口还没到截止时间、或已被别的动作解决时，
     * `engine.expire` 是无操作；把无操作的 expire 记成"靠超时推进"，重放就会替引擎多做一次决定。
     */
    let expireAdvanced: boolean | null = null
    if (data.kind === 'command') commandAccepted = engine.submit(data.command)
    if (data.kind === 'bot' && engine.window?.id === data.windowId) {
      const view = bloodFlowSeatView(engine, data.seat)
      const action = BLOOD_FLOW_AI.strategy === 'legacy'
        ? decideBloodFlowAction(view, BLOOD_FLOW_AI.minimumFirstPayment)
        : decideBloodFlowActionEv(view, BLOOD_FLOW_AI)
      if (action) {
        botAction = action
        commandAccepted = engine.submit(engine.command(data.seat, action))
      } else commandAccepted = false
    }
    if (data.kind === 'expire') {
      const beforeWindow = engine.window?.id ?? null
      const beforeVersion = engine.version
      engine.expire(Date.now(), data.windowId)
      // 推进的判据用引擎自己的版本号/窗口 id：expire 会要么解决当前窗口、要么什么都不做。
      expireAdvanced = engine.version !== beforeVersion || (engine.window?.id ?? null) !== beforeWindow
    }
    if (data.kind === 'advance') engine.advance(data.transitionId)
    if (data.kind === 'pause') engine.pause()
    if (data.kind === 'resume') engine.resume()
    let viewSeat: Seat | null = data.kind === 'view' ? data.seat : 0
    if (data.kind === 'reproduction') {
      // §6：开局快照 + 权威实际执行的命令序列（含真正推进窗口的 expire）。
      // `play` 的顺序与座位的 14 张规整无关：这里给的是**构造时**的快照，重跑从同一局面开始。
      viewSeat = null
      result = {
        roundId: engine.options.roundId,
        opening: engine.initialOpening,
        openingScores: engine.openingScores,
        dealer: engine.dealer,
        commands: engine.recordedCommands,
        dice: engine.initialDice,
      } satisfies EngineReproductionDump
    }
    if (data.kind === 'waits') {
      viewSeat = null
      if (engine.window?.id !== data.windowId) result = []
      else {
        const player = engine.players[data.seat]
        const concealed = [...player.hand]
        if (data.discardIndex !== null) concealed.splice(data.discardIndex, 1)
        result = evaluateWaits({ concealed, melds: player.melds, jokers: engine.jokers })
      }
    }
    if (viewSeat !== null) {
      const view = bloodFlowSeatView(engine, viewSeat)
      const base = data.replay
        ? { ...view, replay: bloodFlowSeatView(engine, 0, { revealAll: true, includeDiscards: true }) }
        : view
      result = {
        ...base,
        ...(botAction ? { botAction } : {}),
        ...(commandAccepted === null ? {} : { commandAccepted }),
        ...(expireAdvanced === null ? {} : { expireAdvanced }),
      }
    }
    self.postMessage({ id: data.id, result })
  } catch (error) {
    self.postMessage({ id: data.id, error: error instanceof Error ? error.message : String(error) })
  }
}
