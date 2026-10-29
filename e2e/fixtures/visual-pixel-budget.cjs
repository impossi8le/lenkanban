const sharp = require("sharp");

const VISUAL_PIXEL_POLICY = Object.freeze({ schemaVersion: 1, threshold: 0.02, maxDiffPixels: 0,
  maxChangedRgbPixels: 64, maxRgbChannelDelta: 4, maxAlphaChannelDelta: 0 });

async function decode(buffer) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!Buffer.isBuffer(buffer) || buffer.length < 33 || !buffer.subarray(0, 8).equals(signature)
    || buffer.toString("ascii", 12, 16) !== "IHDR" || buffer[24] !== 8 || ![2, 6].includes(buffer[25])) {
    throw new Error("Expected an 8-bit RGB/RGBA PNG");
  }
  // Screenshots in this contract are unprofiled. Different ICC interpretation
  // can change visible colour even when the encoded RGB bytes are identical.
  for (let offset = 8; offset + 12 <= buffer.length;) {
    if (buffer.toString("ascii", offset + 4, offset + 8) === "iCCP") throw new Error("ICC-profiled PNG is unsupported");
    offset += 12 + buffer.readUInt32BE(offset);
  }
  // Identical decoding only: no resize, gamma, blur, premultiply or colour correction.
  return sharp(buffer, { ignoreIcc: true }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
}

async function compareVisualPixels(expectedBuffer, actualBuffer, { includeDiff = false } = {}) {
  const result = { policy: VISUAL_PIXEL_POLICY, pass: false, changedRgbPixels: 0,
    maxRgbChannelDelta: 0, maxAlphaChannelDelta: 0, bbox: null };
  let expected, actual;
  try {
    expected = await decode(expectedBuffer);
    actual = await decode(actualBuffer);
  } catch {
    result.reason = "PNG decoding/setup failed (unprofiled 8-bit RGB/RGBA required)";
    result.diff = await sharp({ create: { width: 64, height: 64, channels: 4, background: "magenta" } }).png().toBuffer();
    return result;
  }
  result.expectedDimensions = { width: expected.info.width, height: expected.info.height };
  result.actualDimensions = { width: actual.info.width, height: actual.info.height };
  if (expected.info.width !== actual.info.width || expected.info.height !== actual.info.height) {
    result.reason = "PNG dimensions differ";
    result.diff = await sharp({ create: { width: actual.info.width, height: actual.info.height, channels: 4, background: "magenta" } }).png().toBuffer();
    return result;
  }
  const diff = Buffer.from(actual.data);
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
  for (let offset = 0; offset < actual.data.length; offset += 4) {
    let rgbDelta = 0;
    for (let channel = 0; channel < 3; channel++) rgbDelta = Math.max(rgbDelta, Math.abs(expected.data[offset + channel] - actual.data[offset + channel]));
    const alphaDelta = Math.abs(expected.data[offset + 3] - actual.data[offset + 3]);
    if (rgbDelta) result.changedRgbPixels++;
    result.maxRgbChannelDelta = Math.max(result.maxRgbChannelDelta, rgbDelta);
    result.maxAlphaChannelDelta = Math.max(result.maxAlphaChannelDelta, alphaDelta);
    if (rgbDelta || alphaDelta) {
      const x = offset / 4 % actual.info.width, y = Math.floor(offset / 4 / actual.info.width);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      diff.set([255, 0, 255, 255], offset);
    }
  }
  if (maxX >= 0) result.bbox = { minX, minY, maxX, maxY };
  result.pass = result.changedRgbPixels <= VISUAL_PIXEL_POLICY.maxChangedRgbPixels
    && result.maxRgbChannelDelta <= VISUAL_PIXEL_POLICY.maxRgbChannelDelta
    && result.maxAlphaChannelDelta === 0;
  result.reason = result.pass ? "Within explicit measured-variance budget" : "Full-frame pixel budget exceeded";
  if (!result.pass || includeDiff) result.diff = await sharp(diff, { raw: { ...result.actualDimensions, channels: 4 } }).png().toBuffer();
  return result;
}

module.exports = { VISUAL_PIXEL_POLICY, compareVisualPixels };
