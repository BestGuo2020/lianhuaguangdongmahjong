/** WakuDemo 是独立站账号；VibeHub 平台继续使用自己的 SDK 登录。 */
export function isWakuDemoHost(hostname: string): boolean {
  return hostname === 'guoguo-labs.online' || hostname.endsWith('.guoguo-labs.online')
}
