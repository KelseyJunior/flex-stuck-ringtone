import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  fullyParallel: true,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    ...devices['Desktop Chrome'],
    launchOptions: {
      // Lets the page start audio without a click, as an agent's Flex tab can after the first interaction.
      args: ['--autoplay-policy=no-user-gesture-required']
    }
  },
  webServer: {
    command: 'node demo/server.js',
    url: `http://localhost:${PORT}`,
    env: { PORT: String(PORT) },
    reuseExistingServer: !process.env.CI
  }
});
