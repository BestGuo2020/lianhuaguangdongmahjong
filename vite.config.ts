import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  test: {
    // 限定测试发现根目录，避免命令行的 `src` 子串过滤误扫 tmp/.pnpm-store
    // 中带有 src 路径的历史工作区副本。
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
    // 本地联调 WebRTC：通过 hosts 把 127.0.0.1 伪装成 *.lumigrav.space 域名
    // （VibeHub SDK 只给该域提供服务），因此放开 Vite 的 Host 头校验。
    allowedHosts: true,
    watch: {
      // 编辑器「另存为重命名」会在源码目录留下 `.xxx.ts.<pid>.tmpdir` 临时目录，
      // 且编辑器/其他进程持有 tmp 目录下文件锁时 watcher 在 Windows 上报 EBUSY
      // 直接崩溃 dev server。忽略这类路径与整个 tmp 目录。
      ignored: ['**/.selfHostConfig.ts.*.tmpdir/**', '**/*.tmp', '**/*.tmpdir/**', 'tmp/**'],
    },
  },
})
