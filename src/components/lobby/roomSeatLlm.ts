// 房间面板的「空位」语义（纯逻辑，便于单测）：
//
// - 自动选择（未列入 reservedSeats）：真人可占；真人没来则由服务端默认提供商补位。
// - 已预留（房主显式选了模型）：该座只留给这个大模型，真人加入时被跳过。
// - 已占：真人座位（预留只作用于空位，真人坐进来后不会被大模型顶掉）。
//
// 预留是服务端房间状态（RoomInfo.reservedSeats），面板只做展示与转发，不在本地留存意图，
// 因此房主刷新页面也不会丢选择。
import type {
  LlmProviderInfo,
  LlmSeatRequest,
  RoomSeatState,
  ServerLlmStyle,
} from '../../game/online/api/roomApi'

export const LLM_STYLES: ServerLlmStyle[] = ['激进', '稳健', '话痨', '高冷']
const PICK_SEPARATOR = '::'

export type RoomSeatLlmState =
  | { kind: 'occupied' }
  | { kind: 'reserved'; providerId: string; style: ServerLlmStyle | null }
  | { kind: 'auto' }

/** 某座位的档位：真人已占 / 已预留给大模型 / 自动（真人可占）。 */
export function seatLlmState(
  seat: number,
  roomSeats: Array<RoomSeatState | null>,
  reservedSeats: Array<LlmSeatRequest>,
): RoomSeatLlmState {
  if (roomSeats[seat]) return { kind: 'occupied' }
  const reserved = reservedSeats.find((item) => item.seat === seat)
  if (reserved) {
    return { kind: 'reserved', providerId: reserved.providerId, style: reserved.style ?? null }
  }
  return { kind: 'auto' }
}

/** 该模型可供座位选择的策略；旧服务端缺失 styles 时回退默认策略。 */
export function stylesForProvider(provider: LlmProviderInfo): ServerLlmStyle[] {
  return provider.styles?.length
    ? provider.styles
    : (LLM_STYLES.includes(provider.style) ? [provider.style] : ['稳健'])
}

/** 下拉框选项值 ↔ 预留（providerId + 策略）编解码。 */
export function pickValue(providerId: string, style: ServerLlmStyle): string {
  return `${providerId}${PICK_SEPARATOR}${style}`
}

export function parsePick(seat: number, value: string): LlmSeatRequest | null {
  const separator = value.lastIndexOf(PICK_SEPARATOR)
  if (separator <= 0) return null
  const providerId = value.slice(0, separator)
  const style = value.slice(separator + PICK_SEPARATOR.length) as ServerLlmStyle
  if (!providerId || !LLM_STYLES.includes(style)) return null
  return { seat, providerId, style }
}

export interface SeatLlmReservation {
  seat: number
  providerId: string | null
  style: ServerLlmStyle | null
}

/**
 * 房主改选下拉框 → 预留请求：空值（自动选择）表示**取消预留**，该座立刻可被真人占用。
 */
export function reservationFromPick(seat: number, value: string): SeatLlmReservation {
  const picked = parsePick(seat, value)
  if (!picked) return { seat, providerId: null, style: null }
  return { seat, providerId: picked.providerId, style: picked.style ?? null }
}

/**
 * 下拉框当前值：有预留则显示预留的模型；预留的提供商用「默认策略」时按注册表补齐策略，
 * 保证它与选项列表里的某一项完全一致（否则 select 会显示空白）。
 */
export function pickValueForSeat(
  seat: number,
  reservedSeats: Array<LlmSeatRequest>,
  providers: Array<LlmProviderInfo>,
): string {
  const reserved = reservedSeats.find((item) => item.seat === seat)
  if (!reserved) return ''
  const provider = providers.find((item) => item.id === reserved.providerId)
  const style = reserved.style ?? provider?.style ?? '稳健'
  return pickValue(reserved.providerId, style)
}

/** 预留座的可读标签：已知提供商用「昵称（策略）」；服务端已下架则退回 id 并标注不可用。 */
export function reservedSeatLabel(
  reserved: { providerId: string; style?: ServerLlmStyle | null },
  providers: Array<LlmProviderInfo>,
): string {
  const provider = providers.find((item) => item.id === reserved.providerId)
  if (!provider) return `${reserved.providerId}（服务端未配置）`
  return `${provider.nickname}（${reserved.style ?? provider.style}）`
}

/** 预留的提供商是否已不在服务端注册表（面板需给房主一个可见的失效项以便清掉）。 */
export function isReservationUnavailable(
  reserved: { providerId: string },
  providers: Array<LlmProviderInfo>,
): boolean {
  return !providers.some((item) => item.id === reserved.providerId)
}

/**
 * 开局 llmSeats：只送当前仍空着的预留座位。
 *
 * 服务端另有房间级预留兜底（客户端丢了状态也不会漏装），这里的过滤只防
 * 「请求发出前该座刚被真人占掉」的竞态——那种情况绝不能把真人座位交给大模型。
 */
export function startLlmSeats(
  roomSeats: Array<RoomSeatState | null>,
  reservedSeats: Array<LlmSeatRequest>,
): Array<LlmSeatRequest> {
  return reservedSeats
    .filter((item) => roomSeats[item.seat] == null)
    .map((item) => ({
      seat: item.seat,
      providerId: item.providerId,
      ...(item.style ? { style: item.style } : {}),
    }))
}
