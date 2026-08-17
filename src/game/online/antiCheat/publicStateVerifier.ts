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
  return snapshot.rulesetId === 'lotus-legacy' ? WALL_TOTAL_WITHOUT_FLIP : WALL_TOTAL
}

export function verifySnapshot(snapshot: ServerSnapshot): SnapshotViolation[] {
  const violations: SnapshotViolation[] = []

  function range(name: string, code: string, value: number, min: number, max: number) {
    if (value < min || value > max) {
      violations.push({ code, message: `${name} 越界：${value}` })
    }
  }

  // 座位合法性
  range('快照座位', 'BAD_SEAT', snapshot.seat, SEAT_MIN, SEAT_MAX)
  range('庄家', 'BAD_DEALER', snapshot.dealer, SEAT_MIN, SEAT_MAX)
  range('当前玩家', 'BAD_CURRENT', snapshot.currentPlayer, -1, SEAT_MAX)
  range('赢家', 'BAD_WINNER', snapshot.winningPlayerIndex, -1, SEAT_MAX)

  // 墙一致性
  if (snapshot.wall && snapshot.wallCount !== snapshot.wall.length) {
    violations.push({ code: 'WALL_COUNT', message: `wallCount=${snapshot.wallCount} 与 wall.length=${snapshot.wall.length} 不符` })
  }
  // wallCount 表示「当前剩余牌数」，headDrawn 表示「从牌头累计摸过的牌数」；
  // 两者不是同一个坐标系，不能用 headDrawn <= wallCount 判断。摸到牌墙过半后，
  // 合法快照必然会出现 headDrawn > wallCount。这里按本规则的初始牌墙校验累计进度，
  // 同时允许杠后从牌尾补摸导致 headDrawn + wallCount 小于初始牌数。
  const initialCount = initialWallCount(snapshot)
  range('剩余牌数', 'WALL_COUNT_RANGE', snapshot.wallCount, 0, initialCount)
  range('牌头已摸', 'HEAD_DRAWN', snapshot.headDrawn, 0, initialCount)
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
    range('玩家座位', 'BAD_PLAYER_SEAT', seat, SEAT_MIN, SEAT_MAX)
  }

  // 暗牌脱敏一致性：同一玩家手牌要么全可见、要么全隐藏（null），不能混合。
  for (const player of snapshot.players) {
    const hasHidden = player.hand.some((tile) => tile === null)
    const hasVisible = player.hand.some((tile) => tile !== null)
    if (hasHidden && hasVisible) {
      violations.push({ code: 'HAND_MIX', message: `seat ${player.seat} 手牌半透明（混有 null 与真实牌）` })
    }
    // 副露与弃牌必须是公开的（不应含 null 语义，此处仅做数量健全性检查）
    range('副露数', 'MELD_COUNT', player.melds.length, 0, 4)
    range('弃牌数', 'DISCARD_COUNT', player.discards.length, 0, 40)
  }

  return violations
}
