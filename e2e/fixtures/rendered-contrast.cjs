// @ts-check

/**
 * @typedef {{ r: number, g: number, b: number, a: number }} Rgba
 * @typedef {{ x: number, y: number, width: number, height: number }} Rect
 * @typedef {{ data: Buffer, width: number, height: number, channels: number }} RawImage
 */

/**
 * @param {string} value
 * @returns {Rgba}
 */
function parseCssColor(value) {
  const match = value.match(
    /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)/i,
  );
  if (!match) {
    throw new Error(`Unsupported computed color: ${value}`);
  }
  return {
    r: Number(match[1]),
    g: Number(match[2]),
    b: Number(match[3]),
    a: match[4] === undefined ? 1 : Number(match[4]),
  };
}

/**
 * @param {Rgba} foreground
 * @param {Rgba} background
 * @returns {Rgba}
 */
function composite(foreground, background) {
  const alpha = foreground.a + background.a * (1 - foreground.a);
  if (alpha === 0) {
    return { r: 255, g: 255, b: 255, a: 1 };
  }
  return {
    r:
      (foreground.r * foreground.a +
        background.r * background.a * (1 - foreground.a)) /
      alpha,
    g:
      (foreground.g * foreground.a +
        background.g * background.a * (1 - foreground.a)) /
      alpha,
    b:
      (foreground.b * foreground.a +
        background.b * background.a * (1 - foreground.a)) /
      alpha,
    a: alpha,
  };
}

/**
 * @param {number} channel
 */
function linearChannel(channel) {
  const normalized = channel / 255;
  return normalized <= 0.04045
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
}

/**
 * @param {Rgba} color
 */
function luminance(color) {
  return (
    0.2126 * linearChannel(color.r) +
    0.7152 * linearChannel(color.g) +
    0.0722 * linearChannel(color.b)
  );
}

/**
 * @param {Rgba} first
 * @param {Rgba} second
 */
function contrastRatio(first, second) {
  const firstLuminance = luminance(first);
  const secondLuminance = luminance(second);
  const lighter = Math.max(firstLuminance, secondLuminance);
  const darker = Math.min(firstLuminance, secondLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * @param {RawImage} image
 * @param {number} x
 * @param {number} y
 * @returns {Rgba}
 */
function pixelAt(image, x, y) {
  if (
    !Number.isInteger(x) ||
    !Number.isInteger(y) ||
    x < 0 ||
    x >= image.width ||
    y < 0 ||
    y >= image.height ||
    image.channels < 3
  ) {
    throw new Error(`Pixel (${x}, ${y}) is outside the rendered image`);
  }
  const offset = (y * image.width + x) * image.channels;
  const pixel = {
    r: image.data[offset],
    g: image.data[offset + 1],
    b: image.data[offset + 2],
    a:
      image.channels >= 4
        ? image.data[offset + 3] / 255
        : 1,
  };
  return pixel.a < 1
    ? composite(pixel, { r: 255, g: 255, b: 255, a: 1 })
    : pixel;
}

/**
 * @param {RawImage} image
 * @param {Rect} rect
 * @param {Rgba} foreground
 */
function measureWorstRectContrast(image, rect, foreground) {
  const left = Math.max(0, Math.floor(rect.x));
  const top = Math.max(0, Math.floor(rect.y));
  const right = Math.min(image.width, Math.ceil(rect.x + rect.width));
  const bottom = Math.min(image.height, Math.ceil(rect.y + rect.height));
  if (right <= left || bottom <= top) {
    throw new Error("Contrast sample rectangle is outside the screenshot");
  }

  let minimum = Number.POSITIVE_INFINITY;
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const background = pixelAt(image, x, y);
      const renderedForeground = composite(foreground, background);
      minimum = Math.min(
        minimum,
        contrastRatio(renderedForeground, background),
      );
    }
  }
  return minimum;
}

/**
 * @param {RawImage} image
 * @param {{ cardRect: Rect, borderWidth: number, insideOffset?: number, outsideOffset?: number }} input
 */
function measureEdgeContrast(image, input) {
  const insideOffset = input.insideOffset ?? 1;
  const outsideOffset = input.outsideOffset ?? 1;
  const edgeX = Math.floor(
    input.cardRect.x + Math.max(0, input.borderWidth / 2),
  );
  const insideX = Math.ceil(
    input.cardRect.x +
      input.borderWidth -
      1 +
      insideOffset,
  );
  const outsideX = Math.floor(input.cardRect.x - outsideOffset);
  const startY = Math.max(
    0,
    Math.ceil(input.cardRect.y + input.cardRect.height * 0.25),
  );
  const endY = Math.min(
    image.height - 1,
    Math.floor(input.cardRect.y + input.cardRect.height * 0.75),
  );
  if (
    input.borderWidth <= 0 ||
    startY > endY ||
    edgeX < 0 ||
    edgeX >= image.width ||
    insideX < 0 ||
    insideX >= image.width ||
    outsideX < 0 ||
    outsideX >= image.width
  ) {
    throw new Error("Priority edge cannot be sampled inside the screenshot");
  }

  let minimum = Number.POSITIVE_INFINITY;
  for (let y = startY; y <= endY; y += 1) {
    const edgePixel = pixelAt(image, edgeX, y);
    minimum = Math.min(
      minimum,
      contrastRatio(edgePixel, pixelAt(image, insideX, y)),
      contrastRatio(edgePixel, pixelAt(image, outsideX, y)),
    );
  }
  return minimum;
}

module.exports = {
  composite,
  contrastRatio,
  measureEdgeContrast,
  measureWorstRectContrast,
  parseCssColor,
};
