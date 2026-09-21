import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

// vite.config 在 node 环境执行；typecheck 不引入 node 类型，此处窄声明即可。
declare const process: { env: Record<string, string | undefined> }

// 本地 e2e 冒烟可用 VITE_API_TARGET 指向其他后端端口（默认 8000 开发实例）。
const apiTarget = process.env.VITE_API_TARGET ?? 'http://127.0.0.1:8000'

export default defineConfig({
  plugins: [vue()],
  test: {
    // Bound this checkout's tests; dependency-store snapshots and other worktrees are not this suite.
    dir: './src',
    // 单测只跑 src 下的 *.test.ts / *.spec.ts。Playwright 的 e2e（tests/e2e）走
    // `npm run test:e2e`，不能被 vitest 收集，否则 @playwright/test 的
    // test.describe.configure() 会在这里报错。
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/e2e/**'],
  },
  // 相对 base：部署到未知子目录（如 vibehub 的 /项目名/）也能加载资源。
  // 注意：静态站点须以「目录 + 尾斜杠」形式访问（/项目名/），否则 ./ 相对解析会错位。
  base: './',
  server: {
    port: 4173,
    /**
     * 开发服务器不该因为**编辑器/工具的原子写临时文件**而崩掉。
     * 实测：Agent 的写入是"临时目录 + 改名"，Windows 上 chokidar 去 watch 那个临时文件会拿到
     * EBUSY，而 Vite 对 watcher 的 error 事件是致命的 ⇒ 整个 dev server 退出，
     * 正在跑的 e2e 随即 net::ERR_CONNECTION_REFUSED。这里把这类临时产物排除掉。
     */
    watch: {
      ignored: ['**/*.tmpdir/**', '**/*.tmp', '**/.*.tmpdir/**'],
    },
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
        ws: true,
      },
      '/ws': {
        target: apiTarget,
        changeOrigin: true,
        ws: true,
      },
    }
  },
})
