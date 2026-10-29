const { test: base, expect } = require("@playwright/test");
const AxeBuilder = require("@axe-core/playwright").default;
const { createIsolatedProject, loadPrismaClient } = require("./isolated-project.cjs");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { validateBaseline } = require("./check-baselines.cjs");
const { VISUAL_PIXEL_POLICY, compareVisualPixels } = require("./visual-pixel-budget.cjs");

const { FIXED_TIME, LONG_TITLE } = require("./design-data.cjs");

// Install before navigation: networkidle on its own can precede a React commit,
// font swap, lazy view, or a socket reconnect. Never persist URLs/payloads here.
const activityByPage = new WeakMap();
function observeActivity(page) {
  const state = { pending: new Set(), revision: 0, socketFrames: 0 };
  // Socket.IO is a long-lived transport and NextAuth's /api/auth/_log is a
  // fire-and-forget telemetry ping; neither ever completes, so neither may hold
  // the stability wait open.
  const relevant = request => {
    const path = new URL(request.url()).pathname;
    return !path.startsWith("/socket.io/") && path !== "/api/auth/_log";
  };
  page.on("request", request => {
    if (relevant(request)) { state.pending.add(request); state.revision++; }
  });
  const finished = request => {
    if (state.pending.delete(request)) state.revision++;
  };
  page.on("requestfinished", finished);
  page.on("requestfailed", finished);
  page.on("websocket", socket => {
    state.revision++;
    const frame = () => { state.revision++; state.socketFrames++; };
    socket.on("framereceived", frame);
    socket.on("framesent", frame);
    socket.on("close", () => { state.revision++; });
  });
  activityByPage.set(page, state);
}

async function renderedFonts(page) {
  // FontFace has no public `src` property. Inspect the fonts Chromium actually
  // paints, including Cyrillic/fallback glyphs, rather than guessing from CSS.
  const session = await page.context().newCDPSession(page);
  try {
    await session.send("DOM.enable");
    await session.send("CSS.enable");
    const { root } = await session.send("DOM.getDocument", { depth: -1, pierce: true });
    const nodes = [];
    function visit(node) {
      if (node.children?.some(child => child.nodeType === 3 && child.nodeValue.trim())) nodes.push(node.nodeId);
      for (const child of node.children ?? []) visit(child);
    }
    visit(root);
    const used = new Map();
    for (const nodeId of nodes) {
      const { fonts } = await session.send("CSS.getPlatformFontsForNode", { nodeId });
      for (const { familyName, postScriptName, isCustomFont, glyphCount } of fonts) {
        if (glyphCount) used.set(`${familyName}:${postScriptName}`, { familyName, postScriptName, isCustomFont });
      }
    }
    if (!used.size) throw new Error("No rendered fonts found");
    return [...used.values()].sort((a, b) => a.postScriptName.localeCompare(b.postScriptName));
  } finally { await session.detach(); }
}

async function awaitStable(page, { timeout = 15_000, quiet = 1_200 } = {}) {
  const activity = activityByPage.get(page);
  if (!activity) throw new Error("awaitStable requires observeActivity before navigation");
  const start = performance.now();
  let previous, stableSince = performance.now(), last, samples = 0;
  const timedOut = () => new Error(`awaitStable timed out after ${timeout}ms: ${JSON.stringify(last)}`);
  const bounded = async promise => {
    let timer;
    try {
      return await Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(timedOut()), Math.max(0, timeout - (performance.now() - start)));
      })]);
    } finally { clearTimeout(timer); }
  };
  // Match the screenshot's animation policy during measurement as well.
  await bounded(page.addStyleTag({ content: "*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }" }));
  while (performance.now() - start < timeout) {
    const reading = await bounded(page.evaluate(() => {
      const visible = element => {
        const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };
      const elements = [...document.body.querySelectorAll("*")].filter(visible);
      const loading = elements.filter(el => el.matches('[aria-busy="true"], [role="progressbar"], .animate-spin, .animate-pulse, [data-loading="true"]')
        || (el.childElementCount === 0 && /^(Загрузка(?:\.\.\.|…)?|Loading(?:\.\.\.|…)?)$/i.test(el.textContent.trim())));
      const images = [...document.images].filter(visible);
      // next/font's local Arial metric fallback can legitimately be unavailable
      // on Linux. A failed real face must never be accepted as "fonts ready".
      const failedFonts = [...document.fonts].filter(font => font.status === "error" && !/fallback/i.test(font.family)).length;
      const rect = el => {
        const r = el.getBoundingClientRect();
        return [r.x, r.y, r.width, r.height, el.scrollWidth, el.scrollHeight, el.scrollTop, el.scrollLeft];
      };
      // Exact live DOM/geometry is compared only in memory within this page.
      // IDs remain real; random IDs cannot invalidate an intra-page comparison.
      const layout = elements.map(el => {
        const style = getComputedStyle(el);
        return [el.tagName, rect(el), el.getAttribute("class"), el.getAttribute("style"),
          el.getAttribute("d"), el.getAttribute("points"), el.getAttribute("transform"),
          el.getAttribute("src"), el.getAttribute("aria-label"),
          "value" in el ? el.value : null,
          style.fontFamily, style.fontSize, style.fontWeight, style.lineHeight,
          style.color, style.backgroundColor, style.opacity, style.transform];
      });
      return {
        ready: document.readyState === "complete" && document.fonts.status === "loaded"
          && !failedFonts && !loading.length && images.every(img => img.complete && img.naturalWidth > 0),
        loading: loading.length, pendingImages: images.filter(img => !img.complete || !img.naturalWidth).length,
        fontStatus: document.fonts.status,
        failedFonts,
        dimensions: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight,
          bodyHeight: document.body.scrollHeight },
        content: document.body.innerText,
        layout,
      };
    }));
    const revision = activity.revision;
    const digest = createHash("sha256").update(JSON.stringify(reading)).digest("hex");
    const signature = `${revision}:${digest}`;
    last = { ready: reading.ready, pendingRequests: activity.pending.size, loading: reading.loading,
      pendingImages: reading.pendingImages, fontStatus: reading.fontStatus, dimensions: reading.dimensions,
      failedFonts: reading.failedFonts, socketFrames: activity.socketFrames, digest, revision };
    samples++;
    if (!reading.ready || activity.pending.size || signature !== previous) stableSince = performance.now();
    else if (performance.now() - stableSince >= quiet) {
      // Readiness is explicitly awaited, bounded by the same overall deadline.
      await bounded(page.evaluate(() => document.fonts.ready.then(() => undefined)));
      const fonts = await bounded(renderedFonts(page));
      if (activity.pending.size || activity.revision !== revision) { stableSince = performance.now(); continue; }
      return { ...last, contentSha256: createHash("sha256").update(reading.content).digest("hex"), samples, quietMs: quiet, fonts };
    }
    previous = signature;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw timedOut();
}

// Fingerprint exact source bytes in this snapshot; no invented git revision.
function sourceVersion() {
  const root = path.resolve(__dirname, "../..");
  const hash = createHash("sha256");
  function visit(relative) {
    const absolute = path.join(root, relative);
    if (!fs.existsSync(absolute)) return;
    if (fs.statSync(absolute).isDirectory()) {
      for (const child of fs.readdirSync(absolute).sort()) visit(`${relative}/${child}`);
    } else {
      hash.update(relative); hash.update("\0"); hash.update(fs.readFileSync(absolute));
    }
  }
  for (const entry of ["src", "prisma/schema.prisma", "package.json", "package-lock.json", "next.config.mjs", "playwright.config.ts", "e2e/playwright.ci.config.ts", "e2e/fixtures", "e2e/design-screens.spec.cjs", "e2e/design-states.spec.cjs"]) visit(entry);
  return { commit: null, reason: "Source snapshot without .git", algorithm: "sha256", digest: hash.digest("hex") };
}

const test = base.extend({
  project: async ({}, run) => {
    const isolated = await createIsolatedProject({ visual: true });
    try { await run(isolated.fixture); } finally { await isolated.cleanup(); }
  },
  designReady: [async ({ page, project }, run, info) => {
    observeActivity(page);
    const manualCiUpdate = process.env.GITHUB_EVENT_NAME === "workflow_dispatch"
      && process.env.E2E_CI_UPDATE_BASELINES === "1";
    if (process.env.CI && info.config.updateSnapshots !== "none" && !manualCiUpdate) throw new Error("CI must not update baselines outside an explicit manual update");
    await page.clock.setFixedTime(new Date(FIXED_TIME));
    await page.route("**/socket.io/**", route => route.abort("connectionfailed"));
    await page.routeWebSocket(/socket\.io/, socket => socket.close());
    // Only the browser session display email is synthetic; actor IDs/auth stay real.
    await page.route("**/api/auth/session", async route => {
      const response = await route.fetch();
      const session = await response.json();
      if (session.user) session.user.email = "visual@example.invalid";
      await route.fulfill({ response, json: session });
    });
    await project.openBoard(page);
    const theme = info.project.metadata.theme;
    await page.getByRole("banner").getByRole("button", { name: "Выбрать тему" }).click();
    const themeLabel = { light: "Светлая", dark: "Темная", system: "Системная" }[theme];
    await page.getByRole("menuitem", { name: new RegExp(`^${themeLabel}(?:\\s*✓)?$`) }).click();
    // System must render the OS preference, rather than merely retain a token.
    const dark = theme === "dark" || (theme === "system" && info.project.use.colorScheme === "dark");
    await expect(page.locator("html")).toHaveClass(dark ? /dark/ : /light/);
    await run(true);
  }, { auto: true }],
});

async function accessible(page) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  // Do not hide moderate/minor failures in the new coverage.
  expect(results.violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) }))).toEqual([]);
}

// Visual cases use the actual request panel contract. The shared legacy
// regression helper still targets the former "Название задачи" field.
async function openTask(page, project, title = "Task A") {
  const opener = project.card(page, title).getByRole("button", {
    name: `Открыть задачу «${title}»`, exact: true,
  });
  await expect(opener).toBeVisible();
  await opener.click();
  const panel = page.getByRole("dialog", { name: "Детали задачи", exact: true });
  await expect(panel).toBeVisible();
  const input = panel.getByRole("textbox", { name: "Тема обращения", exact: true });
  await expect(input).toHaveValue(title);
  await expect(input).toBeEnabled();
  return panel;
}

async function activeRequestBoard(page, { empty = false } = {}) {
  const board = page.getByRole("region", { name: "Колонки обращений", exact: true });
  await expect(board).toBeVisible();
  await expect(board.locator("[data-request-stage]")).toHaveCount(4);
  for (const [state, name] of [["SUBMITTED", "Новые"], ["IN_PROGRESS", "В работе"],
    ["NEEDS_INFO", "Ждём сотрудника"], ["COMPLETED", "Решено"]]) {
    const column = board.locator(`[data-request-stage="${state}"]`);
    await expect(column.getByRole("heading")).toContainText(name);
    if (empty) await expect(column.getByText("Здесь пока нет обращений", { exact: true })).toBeVisible();
  }
  if (empty) await expect(board.locator("[data-task-id]")).toHaveCount(0);
  return board;
}

async function controlsFit(page, controls) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "No document horizontal overflow").toBe(true);
  for (const control of await controls.all()) {
    await expect(control).toBeVisible();
    await control.scrollIntoViewIfNeeded();
    const fit = await control.evaluate(el => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      const rect = value => ({ x: value.x, y: value.y, width: value.width, height: value.height,
        left: value.left, right: value.right, top: value.top, bottom: value.bottom });
      const describe = element => element ? { tag: element.tagName, role: element.getAttribute("role"),
        classes: typeof element.className === "string" ? element.className.slice(0, 256) : "" } : null;
      const paintContainment = style => /\b(paint|strict|content)\b/.test(style.contain);
      const fixedContainingBlock = element => {
        for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
          const style = getComputedStyle(ancestor);
          if ([style.transform, style.perspective, style.filter, style.backdropFilter,
            style.translate, style.rotate, style.scale].some(value => value && value !== "none")
            || /\b(layout|paint|strict|content)\b/.test(style.contain)
            || /\b(transform|perspective|filter|backdrop-filter)\b/.test(style.willChange)
            || style.contentVisibility === "auto") return ancestor;
        }
        return null; // The viewport: intervening ordinary overflow does not clip fixed descendants.
      };
      let firstClippingAncestor = null;
      let child = el, skipUntil;
      for (let parent = el.parentElement; parent; parent = parent.parentElement) {
        // Keep clipping inside a fixed panel, then follow its actual containing
        // block chain. A fixed descendant escapes overflow between it and that
        // block, including an ordinary scrolling main above a viewport-fixed panel.
        if (getComputedStyle(child).position === "fixed") skipUntil = fixedContainingBlock(child);
        child = parent;
        if (skipUntil !== undefined) {
          if (parent !== skipUntil) continue;
          skipUntil = undefined;
        }
        const style = getComputedStyle(parent), p = parent.getBoundingClientRect();
        const clipsX = (paintContainment(style) || /(hidden|clip|auto|scroll)/.test(style.overflowX)) && (r.left < p.left - 1 || r.right > p.right + 1);
        const clipsY = (paintContainment(style) || /(hidden|clip|auto|scroll)/.test(style.overflowY)) && (r.top < p.top - 1 || r.bottom > p.bottom + 1);
        if ((clipsX || clipsY) && !firstClippingAncestor) firstClippingAncestor = {
          ...describe(parent), rect: rect(p), overflowX: style.overflowX, overflowY: style.overflowY, clipsX, clipsY };
      }
      const details = { control: { ...describe(el), label: (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 256),
        disabled: el.matches(":disabled, [aria-disabled=true]"), pointerEvents: getComputedStyle(el).pointerEvents },
        rect: rect(r), viewport: { width: innerWidth, height: innerHeight }, scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth, hit: describe(hit), firstClippingAncestor };
      if (r.width <= 0 || r.height <= 0 || r.left < -1 || r.right > innerWidth + 1 || r.top < -1 || r.bottom > innerHeight + 1) return { fits: false, reason: "viewport", ...details };
      if (el.scrollWidth > el.clientWidth + 1) return { fits: false, reason: "content-overflow", ...details };
      // Disabled menu entries remain subject to every geometry/overflow check.
      // Radix intentionally makes them pointer-transparent, so their center is
      // not an interactive hit target. Enabled controls must still receive hits.
      if (!details.control.disabled && (!hit || !(el === hit || el.contains(hit)))) return { fits: false, reason: "hit-test", ...details };
      if (firstClippingAncestor) return { fits: false, reason: "clipped-ancestor", ...details };
      return { fits: true, ...details };
    });
    if (!fit.fits && process.env.VISUAL60_ARTIFACT_DIRECTORY) {
      const directory = process.env.VISUAL60_ARTIFACT_DIRECTORY;
      const output = path.join(directory, "controls-fit-failure.json");
      if (!fs.existsSync(output)) {
        fs.writeFileSync(output, JSON.stringify(fit, null, 2));
        await page.screenshot({ path: path.join(directory, "controls-fit-failure.png"), fullPage: true,
          animations: "disabled", caret: "hide", scale: "css" });
      }
    }
    expect(fit.fits, `Important control is unclipped and hit-testable: ${JSON.stringify(fit)}`).toBe(true);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
}

// Ordinary-board move controls require actual active support membership. Never
// configure a lifecycle map just to expose generic status/drag controls (#106).
async function withOrdinaryResponsibleGroup(project, run) {
  const db = loadPrismaClient(process.env.E2E_DATABASE_URL);
  let groupId = null;
  try {
    groupId = await db.$transaction(async tx => {
      const board = await tx.project.findFirstOrThrow({ where: {
        id: project.projectId, ownerId: project.userId,
        description: `[${project.runMarker}] isolated browser fixture`,
      }, select: { lifecycleColumnMap: true, responsibleGroupId: true } });
      expect(board).toEqual({ lifecycleColumnMap: null, responsibleGroupId: null });
      expect(await tx.user.count({ where: { id: project.userId, email: project.email,
        globalRole: "USER", isBlocked: false, blockedAt: null } })).toBe(1);
      const group = await tx.responsibleGroup.create({ data: { name: project.runMarker,
        members: { create: { userId: project.userId } } } });
      const linked = await tx.project.updateMany({ where: { id: project.projectId,
        ownerId: project.userId, description: `[${project.runMarker}] isolated browser fixture`,
        responsibleGroupId: null }, data: { responsibleGroupId: group.id } });
      expect(linked.count).toBe(1);
      return group.id;
    });
    await run();
  } finally {
    try {
      if (groupId) {
        await db.project.updateMany({ where: { id: project.projectId, ownerId: project.userId,
          description: `[${project.runMarker}] isolated browser fixture`, responsibleGroupId: groupId },
          data: { responsibleGroupId: null } });
        await db.responsibleGroup.deleteMany({ where: { id: groupId, name: project.runMarker } });
      }
    } finally { await db.$disconnect(); }
  }
}

async function capture(page, info, name) {
  const stability = await awaitStable(page);
  await info.attach(`${name}-stability`, { body: Buffer.from(JSON.stringify(stability, null, 2)), contentType: "application/json" });
  const metadata = {
    schemaVersion: 2, source: sourceVersion(),
    environment: { browser: page.context().browser().version(), os: { platform: os.platform(), release: os.release(), arch: os.arch() }, playwright: require("@playwright/test/package.json").version },
    project: info.project.name, viewport: page.viewportSize(), locale: "ru-RU", timezone: "Europe/Moscow", fixedTime: FIXED_TIME,
    pixelPolicy: VISUAL_PIXEL_POLICY,
    stability,
  };
  const sidecar = info.snapshotPath(`${name}.png`) + ".json";
  const updating = info.config.updateSnapshots !== "none";
  if (!updating) {
    expect(fs.existsSync(sidecar), "Baseline provenance missing; generate and review baseline + JSON together").toBe(true);
    const baseline = JSON.parse(fs.readFileSync(sidecar, "utf8"));
    validateBaseline(fs.readFileSync(info.snapshotPath(`${name}.png`)), baseline);
    // Record kernel release for provenance, but compare stable rendering
    // inputs: runner kernel patches alone do not change browser/font versions.
    const renderingEnvironment = env => ({ ...env, os: { platform: env.os.platform, arch: env.os.arch } });
    expect(renderingEnvironment(baseline.environment), "Use the same browser/OS as the reviewed baseline").toEqual(renderingEnvironment(metadata.environment));
    for (const field of ["project", "viewport", "locale", "timezone", "fixedTime"]) expect(baseline[field]).toEqual(metadata[field]);
    expect(baseline.stability, "Baseline has no stability evidence; recapture baseline + JSON").toBeTruthy();
    expect(stability.fonts, "Rendered fonts differ from capture run").toEqual(baseline.stability.fonts);
    expect(stability.dimensions, "Full-page dimensions differ from capture run").toEqual(baseline.stability.dimensions);
  }
  // Explicit measured-variance policy; no masks or hidden functional zones.
  const captureOptions = { fullPage: true, animations: "disabled", caret: "hide", scale: "css" };
  const comparisonOptions = { threshold: VISUAL_PIXEL_POLICY.threshold, maxDiffPixels: 0, maxDiffPixelRatio: 0 };
  let pageFailure;
  try { await expect(page).toHaveScreenshot(`${name}.png`, { ...captureOptions, ...comparisonOptions }); }
  catch (error) { pageFailure = error; }
  if (updating) {
    if (pageFailure) throw pageFailure;
    // This is the last accepted baseline PNG write; hash its exact final bytes.
    metadata.pngSha256 = createHash("sha256").update(fs.readFileSync(info.snapshotPath(`${name}.png`))).digest("hex");
    fs.mkdirSync(path.dirname(sidecar), { recursive: true });
    fs.writeFileSync(sidecar, JSON.stringify(metadata, null, 2) + "\n");
    return;
  }
  const expected = fs.readFileSync(info.snapshotPath(`${name}.png`));
  const actual = await page.screenshot(captureOptions);
  let bufferFailure;
  // Both additional gates inspect these exact bytes, never different captures.
  try { await expect(actual).toMatchSnapshot(`${name}.png`, comparisonOptions); }
  catch (error) { bufferFailure = error; }
  const raw = await compareVisualPixels(expected, actual, { includeDiff: Boolean(pageFailure || bufferFailure) });
  const { diff, ...statistics } = raw;
  const diagnostic = { ...statistics, expectedSha256: createHash("sha256").update(expected).digest("hex"),
    actualSha256: createHash("sha256").update(actual).digest("hex") };
  await info.attach(`${name}-pixel-budget`, { body: Buffer.from(JSON.stringify(diagnostic, null, 2)), contentType: "application/json" });
  if (pageFailure || bufferFailure || !raw.pass) {
    await info.attach(`${name}-expected`, { body: expected, contentType: "image/png" });
    await info.attach(`${name}-actual`, { body: actual, contentType: "image/png" });
    await info.attach(`${name}-raw-diff`, { body: diff, contentType: "image/png" });
    throw new AggregateError([pageFailure, bufferFailure, !raw.pass && new Error(raw.reason)].filter(Boolean),
      `Visual comparison rejected: ${raw.changedRgbPixels} RGB pixels, RGB delta ${raw.maxRgbChannelDelta}, alpha delta ${raw.maxAlphaChannelDelta}`);
  }
}

module.exports = { test, expect, capture, awaitStable, accessible, controlsFit, openTask, activeRequestBoard, withOrdinaryResponsibleGroup, LONG_TITLE };
