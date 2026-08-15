// VibeHub SDK 浏览器端类型声明（Phase 0 仅认证相关；后续阶段按需扩展）。
// 权威声明：https://vibe.lumigrav.space/sdk/v3/vibehub.d.ts
declare namespace VibeHubSDK {
  interface User {
    id: string
    name: string | null
    image: string | null
  }

  interface Client {
    readonly work: string
    readonly apiBase: string
    readonly user: User | null
    /** 打开 VibeHub 授权弹窗；成功返回当前用户，token 仅驻留当前页面内存。 */
    login(): Promise<User>
    /** 同步退出当前作品游戏账号，清除内存 token（不退出主站）。 */
    logout(): void
    isLoggedIn(): boolean
    onAuthChange(callback: (user: User | null) => void): () => void
  }
}

interface Window {
  VibeHub: {
    readonly version: string
    readonly channel: 'stable' | 'beta' | 'unknown'
    init(options: { work: string; apiBase?: string }): Promise<VibeHubSDK.Client>
  }
}
