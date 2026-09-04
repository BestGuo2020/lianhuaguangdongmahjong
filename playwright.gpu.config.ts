import { defineConfig, devices } from '@playwright/test'

const port = Number(process.env.E2E_PORT || 4173)
const baseURL = `http://127.0.0.1:${port}`
const backendPort = Number(process.env.E2E_BACKEND_PORT || 8000)
const backendURL = `http://127.0.0.1:${backendPort}`
const backendPython = process.platform === 'win32' ? '.venv\\Scripts\\python.exe' : '.venv/bin/python'
const reuseExistingOnly = process.env.E2E_REUSE_ONLY === '1'

export default defineConfig({
  testDir: './tests/e2e',
  outputDir: 'test-results/playwright-gpu',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  reporter: process.env.CI ? 'dot' : 'list',
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    viewport: { width: 1280, height: 720 },
  },
  projects: [
    {
      name: 'chromium-gpu',
      use: {
        ...devices['Desktop Chrome'],
        channel: 'chromium',
        headless: true,
        launchOptions: {
          args: [
            '--enable-gpu',
            '--ignore-gpu-blocklist',
            '--use-angle=d3d11',
            '--disable-software-rasterizer',
          ],
        },
      },
    },
  ],
  webServer: reuseExistingOnly ? undefined : [
    {
      command: `${backendPython} -m uvicorn app.main:app --host 127.0.0.1 --port ${backendPort}`,
      cwd: 'backend',
      url: `${backendURL}/api/health`,
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
    },
    {
      command: `npm run dev -- --port ${port}`,
      url: baseURL,
      env: { ...process.env, VITE_API_BASE: backendURL },
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
    },
  ],
})
