import { describe, expect, it, vi } from 'vitest'
import type { RoundResult } from '../../core/contracts/gamePort'
import {
  createMatchStatsRecorder,
  type MatchHandRecord,
  type MatchStatsRecorderOptions,
  type StorageLike,
} from './matchStatsRecorder'

function createMemoryStorage() {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value) },
    removeItem: (key: string) => { data.delete(key) },
  } satisfies StorageLike & { data: Map<string, string> }
}

interface RecordedDelta {
  matches: number
  hands: number
  wins: number
  totalDelta: number
}

function createRecorder(storage: ReturnType<typeof createMemoryStorage>) {
  const writes: RecordedDelta[] = []
  const writeStats = vi.fn(async (delta: Partial<RecordedDelta>) => {
    writes.push({
      matches: delta.matches ?? 0,
      hands: delta.hands ?? 0,
      wins: delta.wins ?? 0,
      totalDelta: delta.totalDelta ?? 0,
    })
  })
  const options: MatchStatsRecorderOptions = {
    writeStats,
    getStorage: () => storage,
  }
  return { recorder: createMatchStatsRecorder(options), writes, writeStats }
}

/** 构造一手结算记录；result 覆盖项可用部分字段（内部统一断言为 RoundResult）。 */
function hand(overrides: Partial<MatchHandRecord> = {}, result: Record<string, unknown> = {}): MatchHandRecord {
  const fullResult = {
    winnerIndex: -1,
    draw: false,
    scoreChanges: [
      { playerIndex: 0, delta: 0 },
      { playerIndex: 1, delta: 0 },
      { playerIndex: 2, delta: 0 },
      { playerIndex: 3, delta: 0 },
    ],
    ...result,
  } as unknown as RoundResult
  return { result: fullResult, epoch: 'epoch-1', round: 1, honba: 0, ...overrides }
}

describe('createMatchStatsRecorder（个人战绩累计）', () => {
  it('终局一次性写入手数/胡数/净胜分', async () => {
    const { recorder, writes } = createRecorder(createMemoryStorage())
    recorder.noteHandResult(hand(
      { round: 1 },
      { winnerIndex: 2, scoreChanges: [{ playerIndex: 0, delta: -40 }, { playerIndex: 2, delta: 120 }] },
    ))
    recorder.noteHandResult(hand(
      { round: 2 },
      { winnerIndex: 0, scoreChanges: [{ playerIndex: 0, delta: 300 }, { playerIndex: 3, delta: -300 }] },
    ))
    await recorder.flushMatch('epoch-1')
    expect(writes).toEqual([{ matches: 1, hands: 2, wins: 1, totalDelta: 260 }])
  })

  it('同一手牌重复投递（重进补发快照）不重复计数', async () => {
    const { recorder, writes } = createRecorder(createMemoryStorage())
    const first = hand({ round: 1, honba: 0 }, { winnerIndex: 0, scoreChanges: [{ playerIndex: 0, delta: 60 }] })
    recorder.noteHandResult(first)
    recorder.noteHandResult(first)
    recorder.noteHandResult(first)
    await recorder.flushMatch('epoch-1')
    expect(writes).toEqual([{ matches: 1, hands: 1, wins: 1, totalDelta: 60 }])
  })

  it('流局不计胡数，但计入手数与净胜分', async () => {
    const { recorder, writes } = createRecorder(createMemoryStorage())
    recorder.noteHandResult(hand({ round: 1 }, {
      draw: true,
      winnerIndex: undefined,
      scoreChanges: [{ playerIndex: 0, delta: 100 }],
    }))
    await recorder.flushMatch('epoch-1')
    expect(writes).toEqual([{ matches: 1, hands: 1, wins: 0, totalDelta: 100 }])
  })

  it('连庄（同 round、honba 递增）视为不同手牌', async () => {
    const { recorder, writes } = createRecorder(createMemoryStorage())
    recorder.noteHandResult(hand({ round: 1, honba: 0 }))
    recorder.noteHandResult(hand({ round: 1, honba: 1 }))
    recorder.noteHandResult(hand({ round: 1, honba: 1 }))
    await recorder.flushMatch('epoch-1')
    expect(writes[0].hands).toBe(2)
  })

  it('刷新重进（新 recorder 共用存储）恢复累计且同 key 不重复计数', async () => {
    const storage = createMemoryStorage()
    const first = createRecorder(storage)
    first.recorder.noteHandResult(hand({ round: 1 }, { winnerIndex: 0, scoreChanges: [{ playerIndex: 0, delta: 50 }] }))
    first.recorder.noteHandResult(hand({ round: 2 }))
    // 模拟刷新：重新创建 recorder（内存清空），同一手 settled 快照被房主补发。
    const second = createRecorder(storage)
    second.recorder.noteHandResult(hand({ round: 2 }))
    second.recorder.noteHandResult(hand({ round: 3 }))
    await second.recorder.flushMatch('epoch-1')
    expect(second.writes).toEqual([{ matches: 1, hands: 3, wins: 1, totalDelta: 50 }])
  })

  it('同代次终局补发（重进到终局页）不重复写入', async () => {
    const storage = createMemoryStorage()
    const first = createRecorder(storage)
    first.recorder.noteHandResult(hand({ round: 1 }))
    await first.recorder.flushMatch('epoch-1')
    // 刷新重进：直接收到同代次 finished 快照 → 再次 flush。
    const second = createRecorder(storage)
    await second.recorder.flushMatch('epoch-1')
    expect(first.writes).toHaveLength(1)
    expect(second.writes).toHaveLength(0)
  })

  it('没有观察到任何一局结算（重进到终局页）时跳过写入，不用 0 局污染战绩', async () => {
    const { recorder, writes } = createRecorder(createMemoryStorage())
    await recorder.flushMatch('epoch-1')
    expect(writes).toHaveLength(0)
  })

  it('代次变化（新一场对局）重置累计，未终局的旧场计数不并入新场', async () => {
    const { recorder, writes } = createRecorder(createMemoryStorage())
    recorder.noteHandResult(hand({ round: 1 }, { winnerIndex: 0, scoreChanges: [{ playerIndex: 0, delta: 500 }] }))
    recorder.noteHandResult(hand({ round: 1, epoch: 'epoch-2' }))
    await recorder.flushMatch('epoch-2')
    expect(writes).toEqual([{ matches: 1, hands: 1, wins: 0, totalDelta: 0 }])
  })

  it('scoreChanges 缺失时净胜分按 0 计，不崩溃', async () => {
    const { recorder, writes } = createRecorder(createMemoryStorage())
    recorder.noteHandResult({ result: { winnerIndex: 0 } as RoundResult, epoch: 'epoch-1', round: 1, honba: 0 })
    await recorder.flushMatch('epoch-1')
    expect(writes).toEqual([{ matches: 1, hands: 1, wins: 1, totalDelta: 0 }])
  })

  it('reset 丢弃本场未终局累计', async () => {
    const { recorder, writes } = createRecorder(createMemoryStorage())
    recorder.noteHandResult(hand({ round: 1 }))
    recorder.reset()
    await recorder.flushMatch('epoch-1')
    expect(writes).toHaveLength(0)
  })
})
