import { describe, expect, it } from 'vitest'
import { isWakuDemoHost } from './host'

describe('WakuDemo 独立站入口', () => {
  it.each(['guoguo-labs.online', 'lianhuaguangdongmahjong.guoguo-labs.online', 'www.guoguo-labs.online'])(
    '在 %s 保留账号入口', (host) => expect(isWakuDemoHost(host)).toBe(true),
  )
  it.each(['gamesvibe.app', 'apps.gamesvibe.app', 'localhost', '127.0.0.1', 'not-guoguo-labs.online', 'guoguo-labs.online.example.com'])(
    '不在 %s 混入独立站账号', (host) => expect(isWakuDemoHost(host)).toBe(false),
  )
})
