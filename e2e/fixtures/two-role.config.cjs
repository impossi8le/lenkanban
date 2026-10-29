// Optional runner for #89 while the root testMatch/project list is owned by
// another task. Keep all root safety checks; never start a managed server.
if (process.env.PLAYWRIGHT_EXTERNAL_SERVER !== '1') {
  throw new Error('#89 requires PLAYWRIGHT_EXTERNAL_SERVER=1 and a separately prepared test server');
}
const root = require('../../playwright.config.ts').default;
const desktop = root.projects.find(project => project.name === 'chromium-desktop');
if (!desktop) throw new Error('Root Chromium desktop project was not found');

module.exports = {
  ...root,
  testDir: require('node:path').resolve(__dirname, '..'),
  testMatch: '**/two-role-request.spec.cjs',
  projects: [{ ...desktop, name: 'chromium', testIgnore: [] }],
  webServer: undefined,
  outputDir: require('node:path').resolve(__dirname, '../artifacts/two-role-results'),
  reporter: [['line']],
};
