// App 层装配：创建录制器 + 本地存储，并在场次结束时落库。
import { ref, type Ref } from 'vue'
import { createReplayRecorder, type ReplayMatchMeta, type ReplayRecorder, type ReplaySink } from './recorder'
import { createReplayStorage, type ReplayStorage } from './storage'
import { readReplayKeepCount } from './preferences'
import type { ReplayMatch, ReplayStanding } from './types'

export interface UseReplayRecorderOptions {
  meta: () => ReplayMatchMeta
  storage?: ReplayStorage | null
  /** 保留上限（场）；缺省读本机偏好。 */
  maxMatches?: number
  now?: () => number
}

export interface ReplayRecording {
  /** 传给 useGame / useLotusGame / useBloodFlowGame 的可选 recorder 参数。 */
  hooks: ReplayRecorder['hooks']
  storage: ReplayStorage
  /** 本地存储可用（无 IDB / 隐私模式 / 写入失败后为 false）。 */
  available: Ref<boolean>
  /** 收尾并落库；返回落库的场次记录（无有效数据时为 null）。 */
  finish(status: 'finished' | 'aborted', standings?: ReplayStanding[]): ReplayMatch | null
  /** 场末或退出时自动判定状态与名次。 */
  finishAuto(standings?: ReplayStanding[]): ReplayMatch | null
  active(): boolean
  /**
   * 取得本场次 id（场次尚未开始则先预留）。
   * 分析区（§9.2）必须用它开一场，才能与展示回放按同一 id 对账、被回收时同步删除。
   */
  ensureMatchId(): string
  /** 当前内存记录与计数（诊断/测试用）。 */
  snapshot(): ReturnType<ReplayRecorder['snapshot']>
}

export function useReplayRecorder(options: UseReplayRecorderOptions): ReplayRecording {
  const available = ref(true)
  const storage = options.storage ?? createReplayStorage({
    // 保留上限取本机偏好（超出按开始时间淘汰最旧）。
    maxMatches: options.maxMatches ?? readReplayKeepCount(),
    onError: () => { available.value = false },
  })
  if (!storage.available) available.value = false

  const sink: ReplaySink = {
    // 存储失败不能影响对局：storage 内部已吞掉异常并降级；这里把 Promise 交回录制器统一兜底。
    saveMatch: (match) => storage.saveMatch(match)
      .then(() => { available.value = storage.available }),
    saveRound: (round) => storage.saveRound(round)
      .then(() => { available.value = storage.available }),
  }
  const recorder = createReplayRecorder({
    sink,
    meta: options.meta,
    ...(options.now ? { now: options.now } : {}),
  })

  return {
    hooks: recorder.hooks,
    storage,
    available,
    finish(status, standings) {
      const match = recorder.finish(status, standings)
      available.value = storage.available
      return match
    },
    finishAuto(standings) {
      const match = recorder.finishAuto(standings)
      available.value = storage.available
      return match
    },
    active() {
      return recorder.active()
    },
    ensureMatchId() {
      return recorder.ensureMatchId()
    },
    snapshot() {
      return recorder.snapshot()
    },
  }
}
