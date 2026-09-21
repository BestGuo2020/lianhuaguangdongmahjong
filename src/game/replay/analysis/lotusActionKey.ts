// 动作的**区分键**：把"窗口里两个选项是不是同一件事"这件事收成一个纯函数。
//
// 为什么单独抽出来：这个判据现在有两个玩法在用（翻精癞子 `lotusLegacyAdapter.actionMatchKey`、
// 广麻 `lotusClassicReproduction.commandEntryMatchKey`）。写法一旦各自漂移，症状是
// **静默错**：重跑时"补杠下标 2"会被当成"补杠下标 0"，或吃组合排序不同被判成对不上，
// 而读方只会看到一句"命令与当时的合法动作对不上"，查不出是哪个字段的锅。
//
// 口径（只取**能区分这个窗口内选项**的字段）：
// - 弃牌看手牌下标（同牌不同位置不是同一个选项，摸切/手切语义不能丢）；
// - 补杠看副露下标（同一张牌可能有两个可补杠的碰面子）；
// - 暗杠看牌（一手里可能有多种四张）；
// - 吃看组合（排序后比，与 `chiOptions` 的枚举顺序无关）；
// - 其余（胡/过/碰/直杠/风杠）在一个窗口里至多一个 ⇒ 按 `kind` 就是唯一的。
//
// 牌面一律过 `canonicalTileKey` 折回**牌码**，因此"控制器动作（牌码）、适配层动作（牌码）、
// LLM 钩子上报动作（`llm/schema` 的阿拉伯数字中文名）"三方落在同一个键上。
import { TILE_META } from '../../core/rules/tiles'
import type { TileType } from '../../core/contracts/types'
import { tileFromName as llmTileFromName } from '../../llm/schema'

/** 可以参与匹配键的动作：`tile`/`meld` 既可能是牌码（`m5`）也可能是中文显示名（`五万`）。 */
export interface LotusActionKeyLike {
  kind: string
  tile?: string
  handIndex?: number
  meldIndex?: number
  meld?: readonly string[]
}

/**
 * 牌面 → **规范键（牌码）**。
 *
 * 仓库里有**两套中文牌名**，而且两张表都在用：
 * - `core/rules/tiles` 的 `TILE_META[].name` 是**中文数字**（`六筒`）—— 适配层与展示层用这套；
 * - `llm/schema` 的 `tileName` 是**阿拉伯数字**（`6筒`）—— `llmController` 上报动作时用的正是它。
 *
 * 所以匹配键必须统一回**牌码**，不能拿任一侧的显示名当键：早先拿中文数字那套去比，
 * 实测每一个吃候选都对不上（`chi|七筒,八筒,六筒` vs `chi|7筒,8筒,6筒`），落库时静默少候选。
 * 认不出来的字符串原样返回（不猜）。
 */
export function canonicalTileKey(tile: string): string {
  if (TILE_META[tile as TileType]) return tile
  const byLlmTable = llmTileFromName(tile)
  if (byLlmTable) return byLlmTable
  const byCoreTable = (Object.keys(TILE_META) as TileType[]).find((code) => TILE_META[code]?.name === tile)
  return byCoreTable ?? tile
}

/** 见文件头。`meld` 与 `tiles` 是同一个语义的两套字段名，调用方自己统一。 */
export function actionMatchKey(action: LotusActionKeyLike): string {
  switch (action.kind) {
    case 'discard': return `discard|${action.handIndex ?? -1}`
    case 'added-kong': return `added-kong|${action.meldIndex ?? -1}`
    case 'concealed-kong': return `concealed-kong|${action.tile ? canonicalTileKey(action.tile) : ''}`
    case 'chi': return `chi|${[...(action.meld ?? [])].map(canonicalTileKey).sort().join(',')}`
    default: return action.kind
  }
}