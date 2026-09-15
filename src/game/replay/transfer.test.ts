import { describe, expect, it } from 'vitest'
import {
  REPLAY_SLICE_CHARS,
  acceptReplaySlice,
  createReceiveSession,
  decodeReplayPayload,
  encodeReplayPayload,
  isReceiveSessionExpired,
  sliceForManifest,
  sliceReplayPayload,
  type ReplayManifest,
  type ReplaySliceMessage,
  type AcceptSliceResult,
} from './transfer'

// 联机牌谱传输：打包 → 切片 → （丢片）回执补发 → 校验解码。
// 这里用确定性的"丢片通道"复现 AGENTS.md 记录的线上缺陷（分片在订阅者处被静默丢弃），
// 断言回执补发能把它救回来 —— 这种流程用 mock 传输层就能覆盖，不需要真 SDK。

/** 造一个够大的牌谱载荷（多片/丢片场景用）。 */
function makeRoundPayload(stepCount: number) {
  return {
    id: 'match-1:1',
    matchId: 'match-1',
    roundIndex: 1,
    roundLabel: '东1局',
    steps: Array.from({ length: stepCount }, (_, index) => ({
      t: index % 3 === 0 ? 'draw' : index % 3 === 1 ? 'discard' : 'meld',
      seat: index % 4,
      tile: ['m5', 'p2', 's9', 'east', 'red', 'white'][index % 6],
      wallLeft: 80 - index,
      headDrawn: index,
      currentPlayer: (index + 1) % 4,
      state: { hand: ['m1', 'm2', '东'], melds: [], drawnTileIndex: -1, redCount: 0, discards: ['p1', '中'] },
    })),
    final: null,
  }
}

/** 打包（可指定片长，便于构造多片场景；生产用默认片长）。 */
async function encode(value: unknown, sliceChars?: number) {
  return encodeReplayPayload('round', value, { id: 'match-1:1', matchId: 'match-1', roundIndex: 1 },
    sliceChars === undefined ? {} : { sliceChars })
}

/** 收全部切片（可指定丢掉哪些索引），返回收方结果。 */
function receiveAll(
  manifest: ReplayManifest,
  slices: ReplaySliceMessage[],
  options: { drop?: number[]; order?: 'asc' | 'desc'; duplicates?: number } = {},
) {
  const session = createReceiveSession(manifest, 0)
  const ordered = options.order === 'desc' ? [...slices].reverse() : slices
  let result: AcceptSliceResult = { complete: false, missing: [], base64: undefined }
  for (const slice of ordered) {
    if (options.drop?.includes(slice.index)) continue
    for (let repeat = 0; repeat < (options.duplicates ?? 1); repeat += 1) {
      result = acceptReplaySlice(session, slice)
    }
  }
  return { session, result }
}

describe('联机牌谱传输：切片与校验', () => {
  it('打包 → 切片 → 解码往返一致（含中文与嵌套结构）', async () => {
    const payload = makeRoundPayload(120)
    const { manifest, base64 } = await encode(payload)
    expect(manifest.payloadKind).toBe('round')
    expect(manifest.matchId).toBe('match-1')
    expect(manifest.roundIndex).toBe(1)
    expect(manifest.bytes).toBeGreaterThan(1000)
    expect(manifest.sliceChars).toBe(REPLAY_SLICE_CHARS)
    expect(['gzip', 'raw']).toContain(manifest.codec)
    // 压缩有效：base64 长度小于原始 JSON 字节数（无 CompressionStream 时退化为 raw）
    if (manifest.codec === 'gzip') expect(base64.length).toBeLessThan(manifest.bytes)

    const decoded = await decodeReplayPayload(manifest, base64)
    expect(decoded.error).toBeNull()
    expect(decoded.value).toEqual(payload)
  })

  it('每片消息都远小于传输层 4000 字节上限（不触发自动分片）', async () => {
    const { manifest, base64 } = await encode(makeRoundPayload(400))
    const slices = sliceForManifest(manifest, base64)
    expect(slices).toHaveLength(manifest.total)
    for (const slice of slices) {
      expect(slice.data.length).toBeLessThanOrEqual(manifest.sliceChars)
      expect(JSON.stringify(slice).length).toBeLessThan(4_000)
    }
  })

  it('片数与清单一致：换片长必须通过清单，否则收方永远收不全', async () => {
    const { manifest, base64 } = await encode(makeRoundPayload(200), 200)
    expect(manifest.sliceChars).toBe(200)
    expect(manifest.total).toBeGreaterThan(2)
    const slices = sliceForManifest(manifest, base64)
    expect(slices).toHaveLength(manifest.total)
    // 用默认片长切（片数与清单不符）时，收方拒绝这些片 —— 这正是必须走 sliceForManifest 的原因
    const wrong = sliceReplayPayload(base64)
    const mismatched = receiveAll(manifest, wrong)
    expect(mismatched.result.complete).toBe(false)
    expect(mismatched.result.missing).toHaveLength(manifest.total)
  })

  it('丢片：收方报缺失索引，房主只补缺失片即可恢复', async () => {
    const payload = makeRoundPayload(160)
    const { manifest, base64 } = await encode(payload, 200)
    const slices = sliceForManifest(manifest, base64)
    expect(slices.length).toBeGreaterThanOrEqual(2)

    // 通道丢掉第 1 片（模拟订阅者处被静默丢弃）
    const { session, result } = receiveAll(manifest, slices, { drop: [1] })
    expect(result.complete).toBe(false)
    expect(result.missing).toEqual([1])
    expect(session.parts[1]).toBeNull()

    // 收方回执缺失 → 房主只补发缺失片
    const resent = slices.filter((slice) => result.missing.includes(slice.index))
    expect(resent).toHaveLength(1)
    let reassembled: string | undefined
    for (const slice of resent) reassembled = acceptReplaySlice(session, slice).base64
    expect(reassembled).toBe(base64)

    const decoded = await decodeReplayPayload(manifest, reassembled!)
    expect(decoded.error).toBeNull()
    expect(decoded.value).toEqual(payload)
  })

  it('重复投递幂等：同一片来三次不会污染内容', async () => {
    const { manifest, base64 } = await encode(makeRoundPayload(60), 200)
    const slices = sliceForManifest(manifest, base64)
    const { result } = receiveAll(manifest, slices, { duplicates: 3 })
    expect(result.complete).toBe(true)
    expect(result.base64).toBe(base64)
    const decoded = await decodeReplayPayload(manifest, result.base64!)
    expect(decoded.error).toBeNull()
  })

  it('乱序到达也能收全（分片按索引归位）', async () => {
    const payload = makeRoundPayload(140)
    const { manifest, base64 } = await encode(payload, 200)
    const slices = sliceForManifest(manifest, base64)
    const { result } = receiveAll(manifest, slices, { order: 'desc' })
    expect(result.complete).toBe(true)
    const decoded = await decodeReplayPayload(manifest, result.base64!)
    expect(decoded.error).toBeNull()
    expect(decoded.value).toEqual(payload)
  })

  it('内容被篡改或截断时校验失败，不会被当成本局牌谱', async () => {
    const { manifest, base64 } = await encode(makeRoundPayload(80), 200)
    const tampered = base64.slice(0, Math.max(1, base64.length - 8)) + 'AAAAAAA='
    const broken = await decodeReplayPayload(manifest, tampered)
    expect(broken.error).not.toBeNull()
    expect(['sha-mismatch', 'length-mismatch', 'parse-failed']).toContain(broken.error)

    // 中间缺一片（空洞）也必须失败
    const slices = sliceForManifest(manifest, base64)
    expect(slices.length).toBeGreaterThanOrEqual(3)
    const holed = slices.filter((slice) => slice.index !== 1).map((slice) => slice.data).join('')
    const holedResult = await decodeReplayPayload(manifest, holed)
    expect(holedResult.error).not.toBeNull()
  })

  it('空载荷也能安全传输；未知 codec 被拒；半截会话会过期', async () => {
    const empty = await encode('')
    expect(empty.manifest.total).toBeGreaterThanOrEqual(1)
    const decodedEmpty = await decodeReplayPayload(empty.manifest, empty.base64)
    expect(decodedEmpty.error).toBeNull()
    expect(decodedEmpty.value).toBe('')

    const { manifest, base64 } = await encode({ a: 1 })
    const badCodec: ReplayManifest = { ...manifest, codec: 'brotli' as never }
    expect((await decodeReplayPayload(badCodec, base64)).error).not.toBeNull()

    const session = createReceiveSession(manifest, 1_000)
    expect(isReceiveSessionExpired(session, 1_000 + 119_000)).toBe(false)
    expect(isReceiveSessionExpired(session, 1_000 + 121_000)).toBe(true)
  })

  it('分片越界或 total 不符时被忽略（脏包不会污染会话）', async () => {
    const { manifest, base64 } = await encode(makeRoundPayload(40), 200)
    const session = createReceiveSession(manifest, 0)
    acceptReplaySlice(session, { id: manifest.id, index: 0, total: manifest.total, data: 'AAAA' })
    const before = session.parts[0]
    acceptReplaySlice(session, { id: manifest.id, index: 999, total: manifest.total, data: 'ZZZZ' })
    acceptReplaySlice(session, { id: manifest.id, index: 0, total: manifest.total + 5, data: 'ZZZZ' })
    expect(session.parts[0]).toBe(before)
    expect(session.parts.every((part) => part == null || part.length > 0)).toBe(true)
    expect(base64.length).toBeGreaterThan(0)
  })
})
