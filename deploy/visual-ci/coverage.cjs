const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { validateBaseline } = require("../../e2e/fixtures/check-baselines.cjs");
const { VISUAL_PIXEL_POLICY } = require("../../e2e/fixtures/visual-pixel-budget.cjs");
const screens = ["board-long", "table-long", "calendar", "my-tasks-long", "task-details", "task-chat-offline-long", "menu-theme", "menu-user", "board-archive", "new-task-dialog-long"];
const states = ["board-loading", "board-error", "table-loading", "table-error", "calendar-loading", "calendar-error", "chat-loading", "chat-empty", "chat-error", "my-tasks-loading", "my-tasks-empty", "my-tasks-error", "board-empty", "table-empty", "calendar-empty"];
function requiredPngs() {
  return [360, 768, 1440].flatMap(width => ["light", "dark", "system-light", "system-dark"].flatMap(theme => [
    ...screens.map(name => `visual-${width}-${theme}/design-screens.spec.cjs/${name}.png`),
    ...states.map(name => `visual-${width}-${theme}/design-states.spec.cjs/${name}.png`),
  ]));
}
function checkCoverage(root = path.resolve(__dirname, "../../e2e/baselines")) {
  const required = requiredPngs(), expected = new Set(required.flatMap(file => [file, file + ".json"]));
  assert.equal(required.length, 300);
  const found = [];
  function visit(relative = "") {
    const absolute = path.join(root, relative), stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) throw Error("Baseline links are forbidden");
    if (stat.isDirectory()) for (const name of fs.readdirSync(absolute)) visit(relative ? `${relative}/${name}` : name);
    else { if (!stat.isFile() || !expected.has(relative)) throw Error("Unexpected baseline coverage input"); found.push(relative); }
  }
  visit();
  assert.equal(found.length, 600, "Expected exactly 300 PNG + JSON pairs");
  for (const relative of required) {
    const png = fs.readFileSync(path.join(root, relative));
    const metadata = JSON.parse(fs.readFileSync(path.join(root, relative + ".json"), "utf8"));
    validateBaseline(png, metadata);
    assert.equal(metadata.project, relative.split("/")[0], "Baseline project/path mismatch");
    const width = Number(metadata.project.split("-")[1]);
    assert.deepEqual(metadata.viewport, { width, height: width === 360 ? 844 : width === 768 ? 1024 : 900 });
    assert.equal(metadata.environment.os.platform, "linux"); assert.equal(metadata.environment.os.arch, "x64");
    assert.equal(metadata.environment.playwright, "1.58.2"); assert.equal(metadata.environment.browser, "145.0.7632.6");
    assert.deepEqual(metadata.pixelPolicy, VISUAL_PIXEL_POLICY, "Baseline pixel policy must be reviewed");
  }
  return { projects: 12, pngs: 300, sidecars: 300 };
}
if (require.main === module) console.log(JSON.stringify(checkCoverage(process.argv[2])));
module.exports = { requiredPngs, checkCoverage };
