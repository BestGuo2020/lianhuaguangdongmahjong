import { afterEach, describe, expect, it, vi } from 'vitest'
import { getSelfHostConfig } from './selfHostConfig'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('getSelfHostConfig', () => {
  it('未配置信令地址时返回 null', () => {
    vi.stubEnv('VITE_SELF_HOST_SIGNALING', '')
    expect(getSelfHostConfig()).toBeNull()
  })

  it('从 env 读取信令地址与 TURN（含凭据）', () => {
    vi.stubEnv('VITE_SELF_HOST_SIGNALING', 'wss://sig.example.com')
    vi.stubEnv('VITE_TURN_SERVER', 'turn:alice:s3cret@turn.example.com:3478')
    const config = getSelfHostConfig()
    expect(config?.signalingUrl).toBe('wss://sig.example.com')
    expect(config?.iceServers).toContainEqual({
      urls: 'turn:turn.example.com:3478',
      username: 'alice',
      credential: 's3cret',
    })
  })

  it('非法信令地址返回 null', () => {
    vi.stubEnv('VITE_SELF_HOST_SIGNALING', 'http-not-websocket')
    expect(getSelfHostConfig()).toBeNull()
  })
})
