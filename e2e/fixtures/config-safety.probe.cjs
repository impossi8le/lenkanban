// @ts-check
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const workspace = path.join(__dirname, "..", "..");
const configUrl = pathToFileURL(
  path.join(workspace, "playwright.config.ts"),
).href;
const tsxCli = require.resolve("tsx/cli");
const importScript = `import(${JSON.stringify(configUrl)}).catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });`;

/**
 * @param {string} baseUrl
 */
function importManagedConfig(baseUrl) {
  return spawnSync(process.execPath, [tsxCli, "-e", importScript], {
    cwd: workspace,
    encoding: "utf8",
    env: {
      ...process.env,
      E2E_DATABASE_URL:
        "postgresql://e2e:e2e@127.0.0.1:5432/kanban_test",
      PLAYWRIGHT_BASE_URL: baseUrl,
      PLAYWRIGHT_EXTERNAL_SERVER: "0",
    },
  });
}

const exactOrigin = importManagedConfig("http://127.0.0.1:3555");
assert.equal(
  exactOrigin.status,
  0,
  exactOrigin.stderr || exactOrigin.stdout,
);

for (const mismatch of [
  "http://127.0.0.1:3556",
  "https://127.0.0.1:3555",
]) {
  const result = importManagedConfig(mismatch);
  assert.notEqual(
    result.status,
    0,
    `Managed config unexpectedly accepted ${mismatch}`,
  );
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /managed|127\.0\.0\.1:3555|origin/i,
  );
}

console.log("managed Playwright config origin probes: OK");
