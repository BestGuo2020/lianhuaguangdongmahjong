/**
 * 3D 牌山（wall）布局：把"摸牌顺序的扁平牌数组"映射成桌上的四边环（参考欢乐麻将）。
 *
 * 环 = 4 段 × 17 墩（每墩 2 张上下叠、径向摆放：长边指向桌中心），共 68 墩 / 136 张。
 * 牌径向放置后短边（0.68）沿墙，每侧 17 墩仅 11.56 长，环可紧凑内移到手牌/副露内侧。
 *
 * 抓牌方向为**顺时针**：head（wall[0]）沿环顺时针推进。
 * 渲染时 wall[i] → 物理槽 (breakIndex + headOffset + i) % 136，其中
 * breakIndex 由骰子决定、headOffset = 136 - wall.length（近似假设所有消耗都来自 head）。
 * 相邻两张（i 与 i+1）同属一墩（bottom/top）。
 *
 * 坐标均为世界坐标：环以 PLAY_AREA_OFFSET_Z=-1.65 为 z 对称中心。
 */

export const WALL_TOTAL = 136
export const WALL_STACKS = 68
const STACKS_PER_SIDE = WALL_STACKS / 4  // 17 墩/边
const STACK_SPACING = 0.68               // 墩沿墙方向的间距（牌宽，径向放置时短边沿墙）

// 环几何（内移环：在牌河外侧、各家手牌/副露内侧）。
// 近侧墙 z、远侧墙 z、侧墙 x；半长 = 17 墩占位的一半。
// 四家牌山整体再向牌河方向（环中心）前移半个麻将牌 = 牌长 0.94 的一半 0.47。
const WALL_INWARD_SHIFT = 0.47
const NEAR_Z = 5.2 - WALL_INWARD_SHIFT   // 4.73
const FAR_Z = -8.5 + WALL_INWARD_SHIFT   // -8.03
const SIDE_X = 7.9 - WALL_INWARD_SHIFT   // 7.43
const SEGMENT_HALF = (STACKS_PER_SIDE - 1) * STACK_SPACING / 2  // 5.44
const SIDE_CENTER_Z = (NEAR_Z + FAR_Z) / 2                      // -1.65（桌中心）

export interface WallSlot {
  x: number
  z: number
  rotationY: number
}

/**
 * 拆墙点（莲花广麻骰子规则，牌单位 0..135）：
 * - 点数和决定拆哪家墙：5/9→庄家，2/6/10→下家，3/7/11→对家，4/8/12→上家；
 *   即 wallPlayer = (sum - 1) % 4。
 * - 较小的点数 n 决定从该墙右起第 n+1 列开始抓（一墩=2 张）。
 * - 各玩家墙段起点对应 3D 环四边：庄=近(0)、下=右(102)、对=远(68)、上=左(34)。
 * 与前端 useGame 及后端 _break_wall_by_dice 保持一致（本地/远程同规则）。
 */
export function wallBreakIndex(dice: readonly [number, number] | number[], total = WALL_TOTAL): number {
  const d1 = dice[0] ?? 1
  const d2 = dice[1] ?? 1
  const sum = d1 + d2
  const n = Math.min(d1, d2)
  const wallPlayer = (sum - 1) % 4
  const segmentStart = [0, 102, 68, 34][wallPlayer]
  return (segmentStart + n * 2) % total
}

/** 第 i 张当前牌（wall[i]）在固定环中的墩位与层（0=底牌，1=顶牌）。
 * 牌头正常按上、下层摸取；牌尾不设固定王牌区，只把当前最后一墩按杠后
 * pop() 的顺序显示为上、下层。remainingCount 是当前尚未摸走的牌数。 */
export function wallTilePlacement(tileIndex: number, headOffset: number, remainingCount = WALL_TOTAL) {
  const physical = (headOffset + tileIndex) % WALL_TOTAL
  const stackIndex = Math.floor(physical / 2)
  const tailDrawn = Math.max(0, WALL_TOTAL - headOffset - remainingCount)
  const lastIndex = remainingCount - 1
  const inCurrentTailStack = tailDrawn % 2 === 0
    ? tileIndex >= lastIndex - 1
    : tileIndex === lastIndex
  let layer = 1 - (physical % 2)
  if (inCurrentTailStack) {
    if (tailDrawn % 2 === 1) layer = 0
    else layer = tileIndex === lastIndex ? 1 : 0
  }
  return { stackIndex, layer }
}

/** 环形第 stack 个墩（0..67）的位置。牌径向放置：长边指向桌中心（近/远墙沿 z，侧墙沿 x）。 */
export function wallStackSlot(stackIndex: number): WallSlot {
  const s = ((stackIndex % WALL_STACKS) + WALL_STACKS) % WALL_STACKS
  if (s < STACKS_PER_SIDE) {
    // 近侧墙：head 在右端，沿 x 向左推进
    const t = s
    return { x: SEGMENT_HALF - t * STACK_SPACING, z: NEAR_Z, rotationY: 0 }
  }
  if (s < 2 * STACKS_PER_SIDE) {
    // 左墙：z 从近到远（顺时针）
    const t = s - STACKS_PER_SIDE
    return { x: -SIDE_X, z: SIDE_CENTER_Z + SEGMENT_HALF - t * STACK_SPACING, rotationY: Math.PI / 2 }
  }
  if (s < 3 * STACKS_PER_SIDE) {
    // 远侧墙：x 从左到右
    const t = s - 2 * STACKS_PER_SIDE
    return { x: -SEGMENT_HALF + t * STACK_SPACING, z: FAR_Z, rotationY: 0 }
  }
  // 右墙：z 从远到近
  const t = s - 3 * STACKS_PER_SIDE
  return { x: SIDE_X, z: SIDE_CENTER_Z - SEGMENT_HALF + t * STACK_SPACING, rotationY: Math.PI / 2 }
}
