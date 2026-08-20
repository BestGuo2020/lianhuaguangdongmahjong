import { defineConfig, devices } from '@playwright/test'

const port = Number(process.env.E2E_PORT || 4173)
const baseURL = `http://127.0.0.1:${port}`
// 线上专项用例自行打开生产 URL 并创建独立 Chromium 进程，不依赖本地 Vite。
// Windows 上无关的 webServer 可能在测试主体完成后阻塞收尾，允许显式跳过。
const skipWebServer = process.env.E2E_SKIP_WEBSERVER === '1'

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? 'dot' : 'list',
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    viewport: { width: 1280, height: 720 },
    // 多 context 场景下，后台标签页的计时器/rAF 会被 Chromium 节流甚至冻结，
    // 导致重进页面的开局动画（setTimeout 驱动）停滞。显式禁用后台节流。
    launchOptions: {
      args: [
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-features=IntensiveWakeUpThrottling',
      ],
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: skipWebServer ? undefined : [
    {
      command: `npm run dev -- --port ${port}`,
      url: baseURL,
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
    },
  ],
})
