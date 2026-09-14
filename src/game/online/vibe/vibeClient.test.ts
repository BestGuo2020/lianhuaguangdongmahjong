import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

async function setupClient() {
  vi.stubGlobal('window', {
    location: { hostname: 'localhost' },
  })
  const module = await import('./vibeClient')
  const client = await module.initVibeHub()
  if (!client) throw new Error('测试 SDK 初始化失败')
  return { module, client }
}

describe('平台域判定（2026-09-14：平台域名换到 gamesvibe.app）', () => {
  async function withHostname(hostname: string) {
    vi.stubGlobal('window', { location: { hostname } })
    vi.resetModules()
    return import('./vibeClient')
  }

  it('新域族 gamesvibe.app（含子域）也算平台生产域 —— 否则 SDK 不初始化、线上联机整体不可用', async () => {
    const module = await withHostname('apps.gamesvibe.app')
    expect(module.isPlatformHost('apps.gamesvibe.app')).toBe(true)
    expect(module.isVibeHost).toBe(true)
    const root = await withHostname('gamesvibe.app')
    expect(root.isVibeHost).toBe(true)
  })

  it('旧域族 lumigrav.space 继续放行', async () => {
    const module = await withHostname('vibeapps.lumigrav.space')
    expect(module.isVibeHost).toBe(true)
  })

  it('相似但不同的域必须排除（不能用 contains 判定）', async () => {
    for (const hostname of ['notgamesvibe.app', 'gamesvibe.app.evil.com', 'evil-lumigrav.space', 'example.com']) {
      const module = await withHostname(hostname)
      expect(module.isVibeHost).toBe(false)
      expect(module.isPlatformHost(hostname)).toBe(false)
    }
  })
})

describe('vibeClient login', () => {
  it('登录进行中复用同一个 SDK Promise，并在结束前保持忙碌状态', async () => {
    const { module, client } = await setupClient()
    let resolveLogin!: (user: VibeHubSDK.User) => void
    const pending = new Promise<VibeHubSDK.User>((resolve) => { resolveLogin = resolve })
    client.login = vi.fn(() => pending)
    module.vibeError.value = '上一次已取消'

    const first = module.login()
    const second = module.login()

    expect(client.login).toHaveBeenCalledTimes(1)
    expect(module.vibeStatus.value).toBe('authenticating')
    expect(module.vibeError.value).toBe('')

    const user = { id: 'u1', name: '测试账号', image: null }
    resolveLogin(user)
    await expect(first).resolves.toEqual(user)
    await expect(second).resolves.toEqual(user)
    expect(module.vibeUser.value).toEqual(user)
    expect(module.vibeStatus.value).toBe('ready')
  })

  it('取消登录后恢复按钮状态，并允许开启全新的 SDK 登录', async () => {
    const { module, client } = await setupClient()
    client.login = vi.fn()
      .mockRejectedValueOnce(new Error('已取消登录'))
      .mockResolvedValueOnce({ id: 'u2', name: null, image: null })

    await expect(module.login()).resolves.toBeNull()
    expect(module.vibeError.value).toBe('已取消登录')
    expect(module.vibeStatus.value).toBe('ready')

    await expect(module.login()).resolves.toEqual({ id: 'u2', name: null, image: null })
    expect(client.login).toHaveBeenCalledTimes(2)
    expect(module.vibeError.value).toBe('')
    expect(module.vibeStatus.value).toBe('ready')
  })
})
