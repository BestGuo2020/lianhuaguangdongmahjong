import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  test: {
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
  },
})
