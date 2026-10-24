import { describe, expect, it } from 'vitest'
import { resolveOnlineBackend } from './backend'

describe('部署环境选择联机后端', () => {
  it.each(['guoguo-labs.online', 'lianhuaguangdongmahjong.guoguo-labs.online'])(
    '%s 使用原 WebSocket 后端', host => expect(resolveOnlineBackend(host)).toBe('ws'),
  )
  it.each(['gamesvibe.app', 'apps.gamesvibe.app', 'localhost', 'guoguo-labs.online.example.com'])(
    '%s 不误接独立站后端', host => expect(resolveOnlineBackend(host)).toBe('vibehub'),
  )
  it('本地真实后端验收可显式选择 WS', () => {
    expect(resolveOnlineBackend('localhost', 'ws')).toBe('ws')
    expect(resolveOnlineBackend('localhost', 'invalid')).toBe('vibehub')
  })
})
