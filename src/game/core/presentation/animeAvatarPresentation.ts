import type { GamePlayer } from '../contracts/types'
import { animeCharacterAvatarUrl } from '../../llm/animeCharacterPreference'

type AvatarPlayer = Pick<GamePlayer, 'avatar' | 'characterId' | 'playerKind' | 'isLlm'>

/**
 * llmAnime 只为真人/bot解析基础稳健头像；LLM 的 avatar 已由预置 style 生成，
 * 必须原样保留激进/稳健/话痨/高冷差异。
 */
export function animeAvatarForPlayer(player: AvatarPlayer): string {
  if (player.playerKind === 'llm' || player.isLlm === true) return player.avatar
  return animeCharacterAvatarUrl(player.characterId)
}
