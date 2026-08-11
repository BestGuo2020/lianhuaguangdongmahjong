// 本地默认头像资产：4 张按座位取（顺序与后端 PLAYER_SEED / 前端 useGame PLAYER_SEED 一致）。
// 联机真人使用外部头像 URL，加载失败时由各渲染点回退到这里的座位默认头像。
const AVATAR_BASE = `${import.meta.env.BASE_URL}avatars/`
const AVATAR_NAMES = ['lotus', 'ah-lok', 'shisan', 'young-master']

export const DEFAULT_AVATARS = AVATAR_NAMES.map((name) => `${AVATAR_BASE}${name}.svg`)

/** 座位 → 本地默认头像（取模 4；0 lotus / 1 ah-lok / 2 shisan / 3 young-master）。 */
export function defaultAvatarForSeat(seat: number): string {
  return DEFAULT_AVATARS[((seat % 4) + 4) % 4]
}
