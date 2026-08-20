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
