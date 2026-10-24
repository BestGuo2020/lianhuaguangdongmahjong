import { isWakuDemoHost } from '../../account/wakudemo/host'

export type OnlineBackend = 'ws' | 'vibehub'

/** 一个主分支按部署环境选联机后端，账号 Cookie 与 VibeHub 身份不得互相替代。 */
export function resolveOnlineBackend(hostname: string, configured?: string): OnlineBackend {
  if (configured === 'ws' || configured === 'vibehub') return configured
  return isWakuDemoHost(hostname) ? 'ws' : 'vibehub'
}
