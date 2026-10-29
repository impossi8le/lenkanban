const path = require('node:path');
process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.resolve(__dirname, '../work/playwright-browsers');
module.exports = {
  testDir: __dirname,
  testMatch: 'prod-smoke.spec.cjs',
  timeout: 300000,
  retries: 0,
  workers: 1,
  outputDir: path.join(__dirname, 'artifacts/prod-audit/runner'),
  reporter: [['list']],
  use: {
    baseURL: process.env.PROD_BASE_URL || 'https://taskboard.lenremontn8n.ru',
    browserName: 'chromium', locale: 'ru-RU', timezoneId: 'Europe/Moscow',
    ignoreHTTPSErrors: false, serviceWorkers: 'block',
    trace: 'off', video: 'off', screenshot: 'off',
  },
};
