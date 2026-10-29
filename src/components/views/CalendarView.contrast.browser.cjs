// Run explicitly: node --test src/components/views/CalendarView.contrast.browser.cjs
// Real Chromium/CSS cascade regression; no app server, network or database.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { before, after, test } = require("node:test");
const { chromium } = require("@playwright/test");
const { transform } = require("lightningcss");
const postcss = require("postcss");
const axe = require("axe-core");

const read = (file) => readFileSync(path.resolve(__dirname, file), "utf8");
const globals = postcss.parse(read("../../app/globals.css"));
// Resolve the actual design-system import below. Tailwind directives do not
// define the unlayered calendar selectors tested here.
globals.walkAtRules("import", (rule) => rule.remove());
const moduleCss = transform({
  filename: "CalendarView.module.css",
  code: Buffer.from(read("CalendarView.module.css")),
  cssModules: true,
});
const vendor = readFileSync(require.resolve("react-big-calendar/lib/css/react-big-calendar.css"), "utf8");
const foundation = read("../../app/design-system.css");
function luminance(cssColor) {
  const components = cssColor.match(/[\d.]+/g).map(Number);
  assert.equal(components.length, 3, `Expected opaque computed RGB: ${cssColor}`);
  return components.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
}
function contrast(foreground, background) {
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
let browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });

for (const theme of ["light", "dark"]) {
  for (const order of ["vendor-first", "vendor-last"]) {
    test(`${theme}: toolbar text contrast survives ${order}, including interaction states`, async (t) => {
      const page = await browser.newPage();
      await page.route("**/*", (route) => route.abort());
      const css = [foundation, ...(order === "vendor-first" ? [vendor, globals.toString()] : [globals.toString(), vendor]), moduleCss.code.toString()].join("\n");
      const measurements = [];
      try {
        // Toolbar structure/classes from react-big-calendar; all colors come
        // from the imported source styles rather than a copied palette.
        await page.setContent(`<html lang="ru" class="${theme === "dark" ? "dark" : ""}"><head><title>Calendar contrast fixture</title><style>${css}</style></head><body><main class="${moduleCss.exports.calendar.name}" style="background:var(--card);color:var(--foreground)"><div class="rbc-toolbar"><span class="rbc-btn-group"><button type="button">Сегодня</button><button type="button">Назад</button><button type="button">Вперёд</button></span><span class="rbc-toolbar-label">Январь</span><span class="rbc-btn-group"><button type="button" class="rbc-active">Месяц</button><button type="button">Неделя</button><button type="button">День</button><button type="button">Список</button></span></div></main></body></html>`);
        await page.addScriptTag({ content: axe.source });
        assert.equal(await page.locator(".rbc-toolbar button").count(), 7);
        const axeResult = await page.evaluate(async () => window.axe.run(document, { runOnly: { type: "rule", values: ["color-contrast"] } }));
        assert.deepEqual(axeResult.violations.map(({ id, nodes }) => ({ id, targets: nodes.map((node) => node.target) })), []);

        for (const state of ["normal", "hover", "focus", "pressed", "selected", "selected-hover", "selected-focus", "selected-pressed"]) {
          await page.mouse.move(1200, 800);
          await page.locator("button").evaluateAll((buttons) => buttons.forEach((button) => button.blur()));
          const button = page.locator(state.startsWith("selected") ? "button.rbc-active" : "button:not(.rbc-active)").first();
          if (state.includes("hover") || state.includes("pressed")) await button.hover();
          if (state.includes("focus")) await button.focus();
          if (state.includes("pressed")) await page.mouse.down();
          // Respect the actual global toolbar's 200ms transition.
          await page.waitForTimeout(250);
          const colors = await button.evaluate((element) => {
            const style = getComputedStyle(element);
            let background = style.backgroundColor;
            let ancestor = element.parentElement;
            while (background === "rgba(0, 0, 0, 0)" && ancestor) {
              background = getComputedStyle(ancestor).backgroundColor;
              ancestor = ancestor.parentElement;
            }
            return { foreground: style.color, background };
          });
          if (state.includes("pressed")) await page.mouse.up();
          const ratio = contrast(colors.foreground, colors.background);
          measurements.push({ state, ...colors, ratio });
          assert.ok(ratio >= 4.5, `${theme}/${order}/${state}: ${JSON.stringify(colors)} = ${ratio}:1`);
        }
      } finally {
        t.diagnostic(JSON.stringify(measurements));
        await page.close();
      }
    });
  }
}
