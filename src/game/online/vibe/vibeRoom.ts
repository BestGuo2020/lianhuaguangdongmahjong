// VibeHub SDK 房间访问层：把 SDK 的 room/rooms 原语封装成麻将联机所需的最小操作集。
// Phase 1 的 remoteRoomLifecycle 将改用本模块，替换 roomApi.ts 的 REST 调用。
//
// SDK 没有「服务端签发房间码 / 座位 / rejoinCode」概念：房间码就是 roomId，由建房方
// 自己生成并认领（room.join 后 isHost 为 true）。码冲突时重新生成重试。
import { getVibeClient } from './vibeClient'
import type { TableThemeName } from '../../../components/table/three/tableTheme'

// 6 位房间码字母表：去掉易混淆字符（0/O、1/I、U），与旧后端一致。
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const ROOM_CODE_LENGTH = 6

export interface RoomConfig {
  mode: 'east' | 'hanchan'
  rulesetId: 'lotus-classic' | 'lotus-legacy'
  capacity: number
  tableThemeName?: TableThemeName
}

function requireClient(): VibeHubSDK.Client {
  const client = getVibeClient()
  if (!client) throw new Error('VibeHub 未初始化或未登录')
  return client
}

export function generateRoomCode(random: () => number = Math.random): string {
  let code = ''
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    code += ROOM_ALPHABET[Math.floor(random() * ROOM_ALPHABET.length)]
  }
  return code
}

/** 建房：认领一个 6 位码房间（私密，仅凭码加入）；码冲突时重试。 */
export async function createRoom(config: RoomConfig, attempts = 5): Promise<VibeHubSDK.Room> {
  const client = requireClient()
  for (let i = 0; i < attempts; i++) {
    const room = await client.room.join(generateRoomCode(), { topology: 'host' })
    if (room.isHost) {
      await room.announce({
        listed: false,
        open: true,
        max: config.capacity,
        mode: config.mode,
        rulesetId: config.rulesetId,
        tableThemeName: config.tableThemeName ?? 'jade',
      })
      return room
    }
    room.leave()
  }
  throw new Error('创建房间失败：房间码冲突')
}

/** 加房：按 6 位房间码加入。 */
export async function joinRoom(roomId: string): Promise<VibeHubSDK.Room> {
  const client = requireClient()
  return client.room.join(roomId.toUpperCase(), { topology: 'host' })
}

/** 读房间元数据（announce 字段 mode/rulesetId 等），供加入方获知场次与规则。 */
export async function getRoomMeta(roomId: string): Promise<VibeHubSDK.RoomMetadata | null> {
  return requireClient().rooms.get(roomId.toUpperCase())
}
