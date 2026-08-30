/**
 * 单机牌桌以本家为座位 0：座位 1 在右侧（下家），座位 2 在上方（对家），
 * 座位 3 在左侧（上家）。设置页保持常用的“上、对、下”展示顺序，但必须显式绑定座位号。
 */
export const LOCAL_LLM_SEAT_OPTIONS = [
  { seat: 3, label: '上家（左）' },
  { seat: 2, label: '对家（上）' },
  { seat: 1, label: '下家（右）' },
] as const
