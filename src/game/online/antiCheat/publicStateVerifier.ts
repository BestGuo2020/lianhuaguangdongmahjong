// 公开状态确定性复算（Phase 4 反作弊威慑）：对每个 state_snapshot 做结构一致性校验，
// 拦截「自相矛盾 / 不可能」的快照（如墙数不符、座位越界、暗牌半透明等）。
// 诚实说明：这只防「草率伪造」，防不了「自洽但不公平」的精心作弊。
import type { ServerSnapshot } from '../protocol/dto'
import { WALL_TOTAL } from '../../core/rules/wallLayout'
import { WALL_TOTAL_WITHOUT_FLIP } from '../../variants/lotus/lotusWall'

export interface SnapshotViolation {
  code: string
  message: string
}

const SEAT_MIN = 0
const SEAT_MAX = 3
const PLAYER_COUNT = 4

function initialWallCount(snapshot: ServerSnapshot) {
  // 莲花麻将在第一次掷骰/翻精前仍保留 136 张环墙；翻精墩移除后才变成
  // 134 张可摸牌墙。重进时可能先收到 phase=dealing 的这帧合法中间态，
  // 不能从整局一开始就用 134 张校验。
  if (
    snapshot.rulesetId === 'lotus-legacy'
    && snapshot.phase === 'dealing'
    && snapshot.flipTile == null
  ) return WALL_TOTAL
  return snapshot.rulesetId === 'lotus-legacy' ? WALL_TOTAL_WITHOUT_FLIP : WALL_TOTAL
}

export function verifySnapshot(snapshot: ServerSnapshot): SnapshotViolation[] {
  const violations: SnapshotViolation[] = []

  function range(name: string, code: string, value: number, min: number, max: number) {
    if (value < min || value > max) {
      violations.push({ code, message: `${name} 越界：${value}` })
    }
  }

  function integerRange(name: string, code: string, value: number, min: number, max: number) {
    if (!Number.isInteger(value)) {
      violations.push({ code, message: `${name} 必须是整数：${value}` })
      return
    }
    range(name, code, value, min, max)
  }

  // 座位合法性
  integerRange('快照座位', 'BAD_SEAT', snapshot.seat, SEAT_MIN, SEAT_MAX)
  integerRange('庄家', 'BAD_DEALER', snapshot.dealer, SEAT_MIN, SEAT_MAX)
  integerRange('当前玩家', 'BAD_CURRENT', snapshot.currentPlayer, -1, SEAT_MAX)
  integerRange('赢家', 'BAD_WINNER', snapshot.winningPlayerIndex, -1, SEAT_MAX)
  integerRange('轮次', 'BAD_ROUND', snapshot.round, 1, Number.MAX_SAFE_INTEGER)
  integerRange('本局数', 'BAD_HONBA', snapshot.honba, 0, Number.MAX_SAFE_INTEGER)

  // 墙一致性
  if (snapshot.wall && snapshot.wallCount !== snapshot.wall.length) {
    violations.push({ code: 'WALL_COUNT', message: `wallCount=${snapshot.wallCount} 与 wall.length=${snapshot.wall.length} 不符` })
  }

  // 房主会话/快照代次只做格式校验；跨代和倒序由客户端 reconciler 继续校验。
  if (snapshot.authorityEpoch != null && !snapshot.authorityEpoch.trim()) {
    violations.push({ code: 'EMPTY_AUTHORITY_EPOCH', message: '房主代次不能为空' })
  }
  if (snapshot.sequence != null && (!Number.isInteger(snapshot.sequence) || snapshot.sequence < 1)) {
    violations.push({ code: 'BAD_SNAPSHOT_SEQUENCE', message: `快照序列非法：${snapshot.sequence}` })
  }
  if ((snapshot.requestId == null) !== (snapshot.requestSeq == null)) {
    violations.push({ code: 'REQUEST_META_MISMATCH', message: 'requestId/requestSeq 必须同时存在或同时为空' })
  }
  if (snapshot.requestSeq != null && (!Number.isInteger(snapshot.requestSeq) || snapshot.requestSeq < 1)) {
    violations.push({ code: 'BAD_REQUEST_SEQUENCE', message: `请求序列非法：${snapshot.requestSeq}` })
  }
  // 终局是跨页面生命周期最危险的状态：只要进入一次就会展示最终排名，且旧
  // Room 的迟到快照很容易在重进时复活它。生产序列化始终同时写这两个字段，
  // 因此不接受只有一半终局标志的自相矛盾快照。
  if ((snapshot.phase === 'finished') !== snapshot.matchFinished) {
    violations.push({
      code: 'TERMINAL_STATE_MISMATCH',
      message: `终局字段不一致：phase=${snapshot.phase}, matchFinished=${snapshot.matchFinished}`,
    })
  }
  // settled 是一局结算事实，不是单纯的动画阶段；没有 result 的 settled 快照
  // 无法让客户端确定本局分数，继续接收它会造成各端在“结算/下一局”之间分叉。
  if (snapshot.phase === 'settled' && snapshot.result == null) {
    violations.push({ code: 'SETTLEMENT_RESULT_MISSING', message: 'settled 快照缺少结算结果' })
  }
  // wallCount 表示「当前剩余牌数」，headDrawn 表示「从牌头累计摸过的牌数」；
  // 两者不是同一个坐标系，不能用 headDrawn <= wallCount 判断。摸到牌墙过半后，
  // 合法快照必然会出现 headDrawn > wallCount。这里按本规则的初始牌墙校验累计进度，
  // 同时允许杠后从牌尾补摸导致 headDrawn + wallCount 小于初始牌数。
  const initialCount = initialWallCount(snapshot)
  integerRange('剩余牌数', 'WALL_COUNT_RANGE', snapshot.wallCount, 0, initialCount)
  integerRange('牌头已摸', 'HEAD_DRAWN', snapshot.headDrawn, 0, initialCount)
  if (snapshot.headDrawn + snapshot.wallCount > initialCount) {
    violations.push({
      code: 'WALL_PROGRESS',
      message: `牌墙进度不可能：headDrawn=${snapshot.headDrawn} + wallCount=${snapshot.wallCount} > ${initialCount}`,
    })
  }

  // 玩家数量与座位唯一性
  if (snapshot.players.length !== PLAYER_COUNT) {
    violations.push({ code: 'PLAYER_COUNT', message: `玩家数=${snapshot.players.length}（应为 ${PLAYER_COUNT}）` })
  }
  const seats = snapshot.players.map((player) => player.seat)
  if (new Set(seats).size !== seats.length) {
    violations.push({ code: 'DUP_SEAT', message: '座位号重复' })
  }
  for (const seat of seats) {
    integerRange('玩家座位', 'BAD_PLAYER_SEAT', seat, SEAT_MIN, SEAT_MAX)
  }

  // 暗牌脱敏一致性：同一玩家手牌要么全可见、要么全隐藏（null），不能混合。
  const handsMayBeRevealed = snapshot.phase === 'revealing'
    || snapshot.phase === 'settled'
    || snapshot.phase === 'finished'
  for (const player of snapshot.players) {
    const hasHidden = player.hand.some((tile) => tile === null)
    const hasVisible = player.hand.some((tile) => tile !== null)
    if (hasHidden && hasVisible) {
      violations.push({ code: 'HAND_MIX', message: `seat ${player.seat} 手牌半透明（混有 null 与真实牌）` })
    }
    if (!handsMayBeRevealed && player.seat !== snapshot.seat && hasVisible) {
      violations.push({ code: 'HAND_LEAK', message: `seat ${player.seat} 在非结算阶段泄露暗牌` })
    }
    // 副露与弃牌必须是公开的（不应含 null 语义，此处仅做数量健全性检查）
    range('副露数', 'MELD_COUNT', player.melds.length, 0, 4)
    range('弃牌数', 'DISCARD_COUNT', player.discards.length, 0, 40)
  }

  return violations
}
