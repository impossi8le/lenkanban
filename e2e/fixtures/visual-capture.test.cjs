const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const os = require("node:os");
const { createRequire } = require("node:module");
const { createHash } = require("node:crypto");
const sharp = require("sharp");
const localRequire = createRequire(path.join(__dirname, "design.cjs"));

async function scenario({ changedPixels = 0, malformed = false, updating = false } = {}) {
  const data = Buffer.alloc(100 * 100 * 4, 128);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  const expected = await sharp(data, { raw: { width: 100, height: 100, channels: 4 } }).png().toBuffer();
  for (let i = 0; i < changedPixels; i++) data[i * 4]++;
  const actual = malformed ? Buffer.from("invalid actual PNG") : await sharp(data, { raw: { width: 100, height: 100, channels: 4 } }).png().toBuffer();
  const baselinePath = "/synthetic-reference/board.png", attachments = [], calls = [], writes = new Map();
  let storedBaseline = expected;
  const metadata = { schemaVersion: 2, pngSha256: createHash("sha256").update(expected).digest("hex"), source: { digest: "a".repeat(64) },
    environment: { browser: "synthetic-browser", os: { platform: os.platform(), arch: os.arch() }, playwright: require("@playwright/test/package.json").version },
    project: "synthetic-project", viewport: { width: 100, height: 100 }, locale: "ru-RU", timezone: "Europe/Moscow", fixedTime: localRequire("./design-data.cjs").FIXED_TIME };
  const page = { evaluate: async () => {}, context: () => ({ browser: () => ({ version: () => "synthetic-browser" }) }),
    viewportSize: () => metadata.viewport, screenshot: async options => { calls.push({ kind: "capture", options }); return actual; } };
  const expect = value => ({
    toBe: expectedValue => assert.equal(value, expectedValue), toEqual: expectedValue => assert.deepEqual(JSON.parse(JSON.stringify(value)), JSON.parse(JSON.stringify(expectedValue))),
    toHaveScreenshot: async (name, options) => { assert.equal(value, page); calls.push({ kind: "page", name, options }); if (updating) storedBaseline = actual; },
    // Public matcher chain stub only; actual perceptual matching is checked separately.
    toMatchSnapshot: (name, options) => { calls.push({ kind: "buffer", value, name, options }); },
  });
  const context = { Buffer, __dirname, require: name => {
    if (name === "@playwright/test") return { test: { extend: () => ({}) }, expect };
    if (name === "node:fs") return { ...fs, existsSync: () => true, mkdirSync: () => {},
      readFileSync: file => { assert.ok([baselinePath, baselinePath + ".json"].includes(file)); return file.endsWith(".json") ? JSON.stringify(metadata) : storedBaseline; },
      writeFileSync: (file, contents) => writes.set(file, contents) };
    return localRequire(name);
  } };
  // Retrieve the exported function from its VM without loading isolated fixtures or a browser.
  const sandbox = { ...context, module: { exports: {} } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "design.cjs"), "utf8")
    + "\nsourceVersion = () => ({digest:'a'.repeat(64)}); this.runCapture = capture;", sandbox);
  const info = { project: { name: metadata.project }, config: { updateSnapshots: updating ? "all" : "none" }, snapshotPath: name => {
    assert.equal(name, "board.png"); return baselinePath;
  }, attach: async (name, attachment) => attachments.push({ name, ...attachment }) };
  let error;
  try { await sandbox.runCapture(page, info, "board"); } catch (caught) { error = caught; }
  return { error, calls, attachments, expected, actual, writes, baselinePath };
}

test("capture passes exactly the additionally captured bytes to buffer and raw gates", async () => {
  const result = await scenario({ changedPixels: 64 });
  assert.equal(result.error, undefined);
  assert.deepEqual(result.calls.map(call => call.kind), ["page", "capture", "buffer"]);
  assert.equal(result.calls[2].value, result.actual);
  assert.equal(result.calls[0].name, result.calls[2].name);
  const raw = JSON.parse(result.attachments[0].body);
  assert.equal(raw.changedRgbPixels, 64); assert.equal(raw.actualSha256, createHash("sha256").update(result.actual).digest("hex"));
});
for (const setup of [{ changedPixels: 65 }, { malformed: true }]) test(`capture fails raw rejection/setup and attaches all evidence: ${JSON.stringify(setup)}`, async () => {
  const result = await scenario(setup);
  assert.ok(result.error);
  assert.deepEqual(result.attachments.map(attachment => attachment.name), ["board-pixel-budget", "board-expected", "board-actual", "board-raw-diff"]);
  assert.equal(result.attachments[1].body, result.expected); assert.equal(result.attachments[2].body, result.actual);
  const diff = await sharp(result.attachments[3].body).metadata(); assert.ok(diff.width > 0);
});
test("manual update writes final baseline hash and does not run comparison captures", async () => {
  const result = await scenario({ updating: true, changedPixels: 1 });
  assert.equal(result.error, undefined); assert.deepEqual(result.calls.map(call => call.kind), ["page"]);
  const metadata = JSON.parse(result.writes.get(result.baselinePath + ".json"));
  assert.equal(metadata.pngSha256, createHash("sha256").update(result.actual).digest("hex"));
  assert.notEqual(metadata.pngSha256, createHash("sha256").update(result.expected).digest("hex"));
  assert.equal(metadata.pixelPolicy.maxChangedRgbPixels, 64);
});
