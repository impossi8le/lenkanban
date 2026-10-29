const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");
const sharp = require("sharp");
const { requiredPngs, checkCoverage } = require("./coverage.cjs");
const { VISUAL_PIXEL_POLICY } = require("../../e2e/fixtures/visual-pixel-budget.cjs");
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "visual-coverage-"));
  t.after(async () => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.match(path.basename(root), /^visual-coverage-/); await fs.rm(root, { recursive: true, force: true }); });
  const cached = new Map();
  for (const relative of requiredPngs()) {
    const project = relative.split("/")[0], width = Number(project.split("-")[1]), height = width === 360 ? 844 : width === 768 ? 1024 : 900;
    if (!cached.has(width)) cached.set(width, await sharp({ create: { width, height, channels: 3, background: "white" } }).png().toBuffer());
    const png = cached.get(width), file = path.join(root, relative);
    await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, png);
    await fs.writeFile(file + ".json", JSON.stringify({ schemaVersion: 2, pngSha256: createHash("sha256").update(png).digest("hex"), source: { digest: "a".repeat(64) },
      environment: { browser: "145.0.7632.6", playwright: "1.58.2", os: { platform: "linux", arch: "x64" } },
      project, viewport: { width, height }, locale: "ru-RU", timezone: "Europe/Moscow", fixedTime: require("../../e2e/fixtures/design-data.cjs").FIXED_TIME, pixelPolicy: VISUAL_PIXEL_POLICY }));
  }
  return root;
}
test("exact 12-project/300-pair inventory passes; one missing state fails", async t => {
  const root = await fixture(t); assert.deepEqual(checkCoverage(root), { projects: 12, pngs: 300, sidecars: 300 });
  await fs.unlink(path.join(root, requiredPngs()[299])); assert.throws(() => checkCoverage(root));
});
test("300 pairs cannot substitute an unexpected name for a missing screen", async t => {
  const root = await fixture(t), file = path.join(root, requiredPngs()[0]);
  await fs.rename(file, file.replace("board-long", "unreviewed")); assert.throws(() => checkCoverage(root), /Unexpected/);
});
test("wrong project provenance and wrong OS fail even with complete PNG count", async t => {
  const root = await fixture(t), file = path.join(root, requiredPngs()[0] + ".json"), metadata = JSON.parse(await fs.readFile(file, "utf8"));
  await fs.writeFile(file, JSON.stringify({ ...metadata, project: "visual-360-dark" })); assert.throws(() => checkCoverage(root), /project\/path/);
  metadata.environment.os.platform = "win32"; await fs.writeFile(file, JSON.stringify(metadata)); assert.throws(() => checkCoverage(root));
});
