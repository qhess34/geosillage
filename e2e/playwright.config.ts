import { defineConfig } from '@playwright/test'

// The whole application: backend (FastAPI) serving the built interface, fresh data at every run (serve.sh).
// Each test creates its own project from the simulated ride: tests do not depend on one another.
const PORT = Number(process.env.E2E_PORT || 8799)

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  workers: process.env.CI ? 2 : 3,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1280, height: 800 },
    trace: 'off',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'bash serve.sh',
    url: `http://127.0.0.1:${PORT}/api/projects`,
    timeout: 120_000,
    reuseExistingServer: false,
    stdout: 'ignore',
    stderr: 'pipe',
  },
})
