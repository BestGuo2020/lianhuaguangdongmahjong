import type { PatternDefinition, PatternId } from '../patterns/types'

function pattern(id: PatternId, label: string, weight: number, excludes: PatternId[] = []): PatternDefinition {
  return Object.freeze({ id, label, weight, excludes: Object.freeze(excludes) })
}

/**
 * 血流番值表（2026-09-12 **第二版完整番种表**，由用户定稿）。
 *
 * 梯度：1 → 2 → 4 → 6 → 8 → 12 → 16 → 24 → 32。新增了"路线牌型"：
 * 普通数牌路线（断幺九 → 三步高 → 清龙/四步高）、刻子路线（碰碰胡 → 三暗刻/三节高 → 四暗刻/四节高）、
 * 花色路线（混一色 → 清一色 → 九莲）、幺九路线（全带幺 → 混幺九 → 清幺九/字一色）、七对路线（七对 → 豪华七对）。
 * 覆盖规则用 `excludes` 表达（存在高位番种时剔除低位），详见各处注释与 catalog.ts 的判定。
 */
export const BLOOD_FLOW_PATTERNS = Object.freeze({
  // 顶级
  'big-four-winds': pattern('big-four-winds', '大四喜', 32, ['all-triplets', 'little-four-winds']),
  // 四杠只覆盖三杠（新表 §7：杠牌系列"四杠 → 三杠"）；四杠手必然也是四刻子+将，可与碰碰胡叠加。
  'four-kongs': pattern('four-kongs', '四杠', 32, ['three-kongs']),
  'nine-gates': pattern('nine-gates', '九莲宝灯', 32, ['pure-suit']),
  // 极高番
  'big-three-dragons': pattern('big-three-dragons', '大三元', 24, ['little-three-dragons']),
  'all-honors': pattern('all-honors', '字一色', 24, ['mixed-terminals', 'all-with-terminals', 'all-triplets']),
  'pure-terminals': pattern('pure-terminals', '清幺九', 24, ['mixed-terminals', 'all-with-terminals', 'all-triplets']),
  'all-green': pattern('all-green', '绿一色', 24),
  // 大牌
  'little-three-dragons': pattern('little-three-dragons', '小三元', 16),
  'little-four-winds': pattern('little-four-winds', '小四喜', 16),
  'four-concealed-triplets': pattern('four-concealed-triplets', '四暗刻', 16, ['three-concealed-triplets', 'all-triplets']),
  // 十三幺：2026-09-15 由 16 → **32 番**（用户定案，数据支持）。实测 1200 局 45,637 次胡牌里只出现 4 次
  // （每百胡 0.01）——全表最稀有的会出现的番种，而单次最高赔付只有 320/家，低于当时的豪华七对(12 番) 480
  // 与四暗刻(16 番)的 780。调到 32 与九莲宝灯（同 1200 局出现 0 次）、大四喜、四杠同档。
  thirteenOrphans: pattern('thirteenOrphans', '十三幺', 32,
    ['all-with-terminals', 'mixed-terminals', 'sevenPairs', 'all-triplets']),
  'one-suit-four-joints': pattern('one-suit-four-joints', '一色四节高', 16, ['one-suit-three-joints', 'all-triplets']),
  // 高番
  'mixed-terminals': pattern('mixed-terminals', '混幺九', 12, ['all-with-terminals', 'all-triplets']),
  'three-kongs': pattern('three-kongs', '三杠', 12),
  'luxury-seven-pairs': pattern('luxury-seven-pairs', '豪华七对', 6,
    ['sevenPairs', 'all-triplets', 'three-concealed-triplets', 'four-concealed-triplets', 'one-suit-three-joints', 'one-suit-four-joints']),
  // 中高番
  'pure-suit': pattern('pure-suit', '清一色', 8, ['mixed-suit']),
  'one-suit-three-joints': pattern('one-suit-three-joints', '一色三节高', 8),
  'one-suit-four-steps': pattern('one-suit-four-steps', '一色四步高', 8, ['one-suit-three-steps']),
  // 中番
  'three-concealed-triplets': pattern('three-concealed-triplets', '三暗刻', 6),
  qiXing: pattern('qiXing', '七星十三烂', 6, ['shiSanLan']),
  'pure-straight': pattern('pure-straight', '清龙', 6),
  // 中低番
  'mixed-suit': pattern('mixed-suit', '混一色', 4),
  'all-triplets': pattern('all-triplets', '碰碰胡', 4),
  sevenPairs: pattern('sevenPairs', '七对', 4,
    ['all-triplets', 'three-concealed-triplets', 'four-concealed-triplets', 'one-suit-three-joints', 'one-suit-four-joints']),
  'one-suit-three-steps': pattern('one-suit-three-steps', '一色三步高', 4),
  'all-with-terminals': pattern('all-with-terminals', '全带幺', 4),
  // 低番 / 基础
  shiSanLan: pattern('shiSanLan', '十三烂', 2),
  'all-simples': pattern('all-simples', '断幺九', 2, ['all-with-terminals', 'mixed-terminals', 'pure-terminals', 'all-honors']),
  // —— 2026-09-15 用户定案：拆掉「门清平胡」这个 2 番合并番种，换成两个独立番种 ——
  // 门清（1 番）：只看无副露（不排除用精牌），**与任何番种叠加**（清一色/碰碰胡/七对/四暗刻…都吃得到）；
  //   因此四暗刻的 excludes 里已移除它。
  // 平胡（1 番）：存在一种拆解 = 4 顺子 + 1 将、无刻子；可副露、字牌也可成顺；精牌只能补顺不能补刻。
  // 鸡胡（0.5 番）：完全没有任何计分番种时的兜底体；**不与任何番种叠加**（有番种时兜底一并消失，
  //   所以不会把清一色从 8 番拉低成 7.5 番）。
  // 合成口径同时改为 Σ(番值) + 杠加成（原 1 + Σ(番值−1)）：因为在这张表里"1 番"原本等于"不加成"，
  // 若不改口径，「门清 1 番 + 平胡 1 番」只会得到 1 番 = 10 点，比原来的门清平胡（20 点）还低。
  // 改后：鸡胡 0.5 番（5 点）、门清+平胡 2 番（20 点，与原来一致）、清一色仍 8 番、门清+清一色 9 番。
  'concealed-hand': pattern('concealed-hand', '门清', 1),
  pinghu: pattern('pinghu', '平胡', 1),
  chicken: pattern('chicken', '鸡胡', 0.5),
})
