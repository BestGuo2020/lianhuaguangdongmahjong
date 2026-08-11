const AVATAR_BASE = `${import.meta.env.BASE_URL}avatars/`

export const PLAYER_SEED = [
  { name: '北冥重生', avatar: `${AVATAR_BASE}lotus.svg`, score: 1000 },
  { name: '南粤阿乐', avatar: `${AVATAR_BASE}ah-lok.svg`, score: 1000 },
  { name: '西关十三姨', avatar: `${AVATAR_BASE}shisan.svg`, score: 1000 },
  { name: '东山少爷', avatar: `${AVATAR_BASE}young-master.svg`, score: 1000 },
]

export const MATCH_HANDS = { east: 4, hanchan: 8 } as const
export const MATCH_NAMES = { east: '东风场', hanchan: '半庄场' } as const

// 视觉节奏延迟（非 AI 思考，用于动作动画展示与牌桌节奏）。
export const PACE_MS = {
  afterDiscardToNextTurn: 450,
  afterClaimGang: 550,
  afterClaimPeng: 650,
  afterKongSettle: 600,
  beforeRobKong: 650,
  betweenRobKongs: 450,
  skipDrawPengDelay: 350,
  redKongDraw: 600,
} as const
