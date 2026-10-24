import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

beforeEach(() => {
  vi.resetModules()
  vi.stubEnv('VITE_API_BASE', '')
  vi.stubGlobal('location', { origin: 'https://lianhuaguangdongmahjong.guoguo-labs.online' })
})
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

describe('WakuDemo 账号接口', () => {
  it('用会话 Cookie 读取同源账号，不向前端索取 token', async () => {
    const session = { authenticated: true, account: { id: 'account-1', displayName: '玩家', avatarUrl: null } }
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => session })
    vi.stubGlobal('fetch', fetch)
    const { getWakuDemoLoginSession } = await import('./api')
    expect(await getWakuDemoLoginSession()).toEqual(session)
    expect(fetch).toHaveBeenCalledWith('https://lianhuaguangdongmahjong.guoguo-labs.online/api/login/session',
      expect.objectContaining({ credentials: 'include', cache: 'no-store' }))
  })

  it('保留独立后端地址，登录跳转与退出使用同一个服务', async () => {
    vi.stubEnv('VITE_API_BASE', 'https://accounts.example.test/')
    const assign = vi.fn()
    vi.stubGlobal('window', { location: { assign } })
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ authenticated: false }) })
    vi.stubGlobal('fetch', fetch)
    const { beginWakuDemoLogin, logoutWakuDemo } = await import('./api')
    beginWakuDemoLogin()
    expect(assign).toHaveBeenCalledWith('https://accounts.example.test/api/login/wakudemo')
    await logoutWakuDemo()
    expect(fetch).toHaveBeenCalledWith('https://accounts.example.test/api/login/logout',
      expect.objectContaining({ method: 'POST', credentials: 'include' }))
  })

  it('会话查询失败时不伪装为成功登录', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401,
      json: async () => ({ detail: { code: 'AUTH_REQUIRED' } }) }))
    const { getWakuDemoLoginSession } = await import('./api')
    await expect(getWakuDemoLoginSession()).rejects.toThrow('AUTH_REQUIRED')
  })
})
