// @ts-check
const assert = require("node:assert/strict");
const {
  measureEdgeContrast,
  measureWorstRectContrast,
  parseCssColor,
} = require("./rendered-contrast.cjs");

const pixels = Buffer.from([
  255, 255, 255, 255,
  255, 255, 255, 255,
  0, 0, 0, 255,
  0, 0, 0, 255,
  255, 255, 255, 255,
  255, 255, 255, 255,
]);
const image = { data: pixels, width: 3, height: 2, channels: 4 };

assert.deepEqual(parseCssColor("rgba(10, 20, 30, 0.5)"), {
  r: 10,
  g: 20,
  b: 30,
  a: 0.5,
});
assert.equal(
  measureWorstRectContrast(
    image,
    { x: 0, y: 0, width: 3, height: 2 },
    parseCssColor("rgb(0, 0, 0)"),
  ),
  1,
);
assert.ok(
  measureWorstRectContrast(
    image,
    { x: 0, y: 0, width: 2, height: 1 },
    parseCssColor("rgba(0, 0, 0, 0.5)"),
  ) > 3,
);
assert.equal(
  measureEdgeContrast(image, {
    cardRect: { x: 1, y: 0, width: 2, height: 2 },
    borderWidth: 1,
    outsideOffset: 1,
  }),
  1,
  "The interior neighbor must prevent an exterior-only false GREEN",
);

console.log("rendered contrast probes: OK");
