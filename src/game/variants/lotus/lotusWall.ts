// 「莲花麻将」开局牌墙构造（旧版两次掷骰规则）。
// 纯函数：把「立牌山 → 第一次掷骰翻精 → 第二次掷骰定开门 → 重排为发牌顺序」拆成独立步骤，
// 供开局时间线在合适时机分别调用（掷骰前先立起牌山）。
import type { TileType } from '../../core/contracts/types'
import { WALL_STACKS } from '../../core/rules/wallLayout'
import { createWall, shuffle } from '../../core/rules/tiles'
import { computeJokers } from './lotusRules'

/** 翻精墩（指示牌 + 底张）整体移出牌墙：牌山 136 → 可摸 134 张。 */
export const FLIP_STACK_REMOVED = 2

/**
 * 座位 → 实际牌桌物理墙段起始墩。
 * wallStackSlot 的环序是：庄家前方（0）→上家左侧（17）→对家前方（34）
 * →下家右侧（51），所以不能直接用 seat * 17；下家和上家的墙段需要互换。
 */
export function seatSegmentStart(seat: number): number {
  return [0, 51, 34, 17][((seat % 4) + 4) % 4]
}

/** 洗好的 136 张环序牌墙（墙数组下标即物理张位：2s 为墩 s 顶层、2s+1 为底层）。 */
export function buildRingWall(random: () => number = Math.random): TileType[] {
  return shuffle(createWall(), random)
}

export interface FlipResolution {
  /** 第一次骰子确定的翻精目标方，也是第二次掷骰的投掷者。 */
  flipSeat: number
  /** 翻精所在物理墩（0..67） */
  flipStack: number
  flipTile: TileType
  jokers: [TileType, TileType]
}

/**
 * 第一次掷骰 S：从庄家开始按逆时针座位顺序数 S，目标玩家（也是第二次
 * 掷骰者）为 (dealer + S - 1) % 4；从该玩家牌墙右侧数第 S 墩翻上层。
 */
export function resolveFlip(ring: TileType[], dealer: number, dice: readonly [number, number]): FlipResolution {
  const S = dice[0] + dice[1]
  const flipSeat = (dealer + S - 1) % 4
  const flipStack = seatSegmentStart(flipSeat) + (S - 1)
  const flipTile = ring[flipStack * 2]
  return { flipSeat, flipStack, flipTile, jokers: computeJokers(flipTile) }
}

/** 第二次掷骰 T：从翻精墩顺时针（墩号递增）数 T 墩为开门位置。 */
export function resolveOpeningStack(flipStack: number, secondDice: readonly [number, number]): number {
  const T = secondDice[0] + secondDice[1]
  return (flipStack + T) % WALL_STACKS
}

/** 移出翻精墩（2 张）后的可摸牌墙（保持环序）。 */
export function removeFlipStack(ring: TileType[], flipStack: number): TileType[] {
  return ring.filter((_, index) => index !== flipStack * 2 && index !== flipStack * 2 + 1)
}

/** 重排为发牌顺序：从开门墩起顺时针取墩（跳过翻精墩），每墩上层先摸。 */
export function buildDrawOrderWall(ring: TileType[], openingStack: number, flipStack: number): TileType[] {
  const wall: TileType[] = []
  for (let step = 0; step < WALL_STACKS; step += 1) {
    const stack = (openingStack + step) % WALL_STACKS
    if (stack === flipStack) continue
    wall.push(ring[stack * 2], ring[stack * 2 + 1])
  }
  return wall
}

/**
 * 莲花麻将不留王牌。杠后从当前牌尾补摸，同一墩先摸上层、再摸下层；
 * 普通摸牌仍可从牌头一直摸到牌墙耗尽。
 */
export function takeLotusTailTile(wall: TileType[], headDrawn: number): TileType | null {
  if (!wall.length) return null
  const tailDrawn = WALL_TOTAL_WITHOUT_FLIP - headDrawn - wall.length
  const index = tailDrawn % 2 === 0 && wall.length >= 2 ? wall.length - 2 : wall.length - 1
  return wall.splice(index, 1)[0] ?? null
}

export const WALL_TOTAL_WITHOUT_FLIP = WALL_STACKS * 2 - FLIP_STACK_REMOVED

// ── 兼容入口：给定两次骰子直接得出最终发牌顺序牌墙（单元测试 / 旧逻辑用）──

export interface LotusWallOptions {
  dealer: number
  /** 第一次掷骰（决定翻精方位与第 S 墩） */
  dice: readonly [number, number]
  /** 第二次掷骰（决定开门位置，从翻精墩顺时针数 T 墩） */
  secondDice: readonly [number, number]
  random?: () => number
}

export interface LotusWallResult {
  /** 发牌/摸牌顺序的牌墙（翻精墩整体跳过，指示牌已移出） */
  wall: TileType[]
  /** 翻出的指示牌（精），桌面亮出 */
  flipTile: TileType
  jokers: [TileType, TileType]
  /** 翻精所在物理墩（0..67） */
  flipStack: number
  /** 开门（发牌起点）所在物理墩 */
  openingStack: number
  /** 3D 牌山断点：wall[0] 在环中的物理张位（0..135） */
  wallBreakIndex: number
}

export function buildLotusWall(options: LotusWallOptions): LotusWallResult {
  const ring = buildRingWall(options.random)
  const { flipStack, flipTile, jokers } = resolveFlip(ring, options.dealer, options.dice)
  const openingStack = resolveOpeningStack(flipStack, options.secondDice)
  return {
    wall: buildDrawOrderWall(ring, openingStack, flipStack),
    flipTile,
    jokers,
    flipStack,
    openingStack,
    wallBreakIndex: openingStack * 2,
  }
}
