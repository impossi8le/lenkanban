const { test } = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");
const { compareVisualPixels } = require("./visual-pixel-budget.cjs");
const width = 100, height = 100;
const base = Buffer.alloc(width * height * 4, 128);
for (let i = 3; i < base.length; i += 4) base[i] = 255;
const png = (bytes, w = width, h = height) => sharp(bytes, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
async function pair(mutator) {
  const actual = Buffer.from(base); mutator(actual);
  return [await png(base), await png(actual)];
}

test("identical PNG and 64 RGB pixels with delta4 pass", async () => {
  const [expected, actual] = await pair(bytes => { for (let i = 0; i < 64; i++) for (let c = 0; c < 3; c++) bytes[i * 4 + c] += 4; });
  assert.equal((await compareVisualPixels(expected, expected)).pass, true);
  const result = await compareVisualPixels(expected, actual);
  assert.equal(result.pass, true); assert.equal(result.changedRgbPixels, 64); assert.equal(result.maxRgbChannelDelta, 4);
});
test("65 low-delta pixels fail the raw gate", async () => {
  const [expected, actual] = await pair(bytes => { for (let i = 0; i < 65; i++) bytes[i * 4]++; });
  const result = await compareVisualPixels(expected, actual);
  assert.equal(result.pass, false); assert.equal(result.changedRgbPixels, 65); assert.ok(result.diff.length);
});
test("widespread one-shade change fails the raw gate", async () => {
  const [expected, actual] = await pair(bytes => { for (let i = 0; i < bytes.length; i += 4) for (let c = 0; c < 3; c++) bytes[i + c]++; });
  assert.equal((await compareVisualPixels(expected, actual)).changedRgbPixels, width * height);
  assert.equal((await compareVisualPixels(expected, actual)).pass, false);
});
for (const delta of [5, 127]) test(`one RGB pixel delta${delta} fails`, async () => {
  const [expected, actual] = await pair(bytes => { bytes[0] += delta; });
  const result = await compareVisualPixels(expected, actual);
  assert.equal(result.pass, false); assert.equal(result.changedRgbPixels, 1); assert.equal(result.maxRgbChannelDelta, delta);
});
test("one alpha delta1 fails, even without an RGB change", async () => {
  const [expected, actual] = await pair(bytes => { bytes[3]--; });
  const result = await compareVisualPixels(expected, actual);
  assert.equal(result.pass, false); assert.equal(result.changedRgbPixels, 0); assert.equal(result.maxAlphaChannelDelta, 1);
});
test("dimensions mismatch fails with a visible diff", async () => {
  const result = await compareVisualPixels(await png(base), await png(Buffer.alloc(99 * 100 * 4, 255), 99, 100));
  assert.equal(result.pass, false); assert.equal(result.reason, "PNG dimensions differ"); assert.ok(result.diff.length);
});
test("malformed and unsupported PNG input fail closed with a visible setup diff", async () => {
  const valid = await png(base);
  for (const invalid of [Buffer.from("not PNG"), valid.subarray(0, 40), null]) {
    const result = await compareVisualPixels(valid, invalid);
    assert.equal(result.pass, false); assert.match(result.reason, /decoding\/setup/); assert.ok(result.diff.length);
  }
  const unsupported = Buffer.from(valid); unsupported[24] = 16;
  assert.equal((await compareVisualPixels(valid, unsupported)).pass, false);
});
test("actual encoded PNG with high-contrast one-pixel displacement fails", async () => {
  const original = Buffer.from(base), shifted = Buffer.from(base);
  for (let y = 20; y < 80; y++) { original[(y * width + 30) * 4] = 0; shifted[(y * width + 31) * 4] = 0; }
  const expected = await png(original), actual = await png(shifted);
  const result = await compareVisualPixels(expected, actual);
  assert.equal(result.pass, false); assert.equal(result.changedRgbPixels, 120); assert.equal(result.maxRgbChannelDelta, 128);
});
test("embedded ICC conversion cannot hide changed encoded RGB channels", async () => {
  const expected = await sharp({ create: { width: 10, height: 10, channels: 3, background: "red" } }).png().toBuffer();
  const actual = await sharp(expected).withIccProfile("p3").png().toBuffer();
  const a = await sharp(expected, { ignoreIcc: true }).raw().toBuffer();
  const b = await sharp(actual, { ignoreIcc: true }).raw().toBuffer();
  let changed = 0, maxDelta = 0;
  for (let offset = 0; offset < a.length; offset += 3) {
    let delta = 0; for (let c = 0; c < 3; c++) delta = Math.max(delta, Math.abs(a[offset + c] - b[offset + c]));
    if (delta) changed++; maxDelta = Math.max(maxDelta, delta);
  }
  assert.equal(changed, 100); assert.ok(maxDelta > 4);
  const result = await compareVisualPixels(expected, actual);
  assert.equal(result.pass, false); assert.match(result.reason, /unprofiled/);
});
test("ICC presence fails even when encoded RGB is exactly unchanged", async () => {
  const expected = await sharp({ create: { width: 10, height: 10, channels: 3, background: "red" } }).png().toBuffer();
  const actual = await sharp(expected).withIccProfile("srgb").png().toBuffer();
  assert.deepEqual(await sharp(expected, { ignoreIcc: true }).raw().toBuffer(), await sharp(actual, { ignoreIcc: true }).raw().toBuffer());
  assert.ok((await sharp(actual).metadata()).icc.length);
  assert.equal((await compareVisualPixels(expected, actual)).pass, false);
  assert.equal((await compareVisualPixels(actual, actual)).pass, false);
});
test("inversion fails; RGB and opaque RGBA decode identically", async () => {
  const bytes = Buffer.from(base); for (let i = 0; i < bytes.length; i += 4) for (let c = 0; c < 3; c++) bytes[i + c] = 0;
  assert.equal((await compareVisualPixels(await png(base), await png(bytes))).pass, false);
  const rgba = await png(base), rgb = await sharp(rgba).removeAlpha().png().toBuffer();
  assert.equal((await compareVisualPixels(rgb, rgba)).pass, true);
});
