// @ts-check
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const fixtureSource = fs.readFileSync(
  path.join(__dirname, "isolated-project.cjs"),
  "utf8",
);
const dndSpecSource = fs.readFileSync(
  path.join(__dirname, "..", "kanban-dnd-v2.spec.cjs"),
  "utf8",
);
const configSource = fs.readFileSync(
  path.join(__dirname, "..", "..", "playwright.config.ts"),
  "utf8",
);

assert.match(configSource, /from "\.\/e2e\/fixtures\/safety\.cjs"/);
assert.match(configSource, /parseSafeBaseUrl\(/);
assert.match(configSource, /parseTestDatabaseUrl\(/);
assert.match(fixtureSource, /require\("\.\/safety\.cjs"\)/);
assert.match(
  fixtureSource,
  /new AggregateError\(\s*\[setupError, cleanupError\]/,
);

const cardByTitleSource = fixtureSource.match(
  /function cardByTitle[\s\S]*?\n}\n/,
)?.[0];
assert.ok(cardByTitleSource, "cardByTitle must remain defined");
assert.match(cardByTitleSource, /\.locator\("\[data-priority\]"\)/);
assert.doesNotMatch(cardByTitleSource, /kanban-sortable-card/);

assert.match(
  fixtureSource,
  /\(await modernHandle\.count\(\)\) > 0 \? modernHandle : card/,
);
assert.match(fixtureSource, /scrollIntoViewIfNeeded\(\)/);
assert.match(fixtureSource, /page\.viewportSize\(\)/);
assert.match(fixtureSource, /assertViewportPoint\(/);

assert.match(dndSpecSource, /if \(!project\.dndV2Enabled\)/);
assert.match(
  dndSpecSource,
  /pointer drag is desktop-only; mobile coverage uses tap\/menu/,
);
assert.match(
  dndSpecSource,
  /await expect\(legacyCard\)\.toHaveAttribute\("role", "button"\)/,
);
assert.match(dndSpecSource, /await legacyCard\.press\("Space"\)/);
assert.match(dndSpecSource, /await expect\(page\)\.toHaveURL\(\/\\\/tasks/);
assert.match(
  dndSpecSource,
  /await trigger\.tap\(\)[\s\S]*await menuItem\.tap\(\)/,
  "Touch coverage must tap both the trigger and the selected menu item",
);

console.log("legacy/pointer fixture contract probes: OK");
