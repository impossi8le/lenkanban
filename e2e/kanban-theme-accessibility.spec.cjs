// @ts-check
const AxeBuilder = require("@axe-core/playwright").default;
const sharp = require("sharp");
const { openTask } = require("./fixtures/regression.cjs");
const { withOrdinaryResponsibleGroup } = require("./fixtures/design.cjs");
const {
  test,
  expect,
} = require("./fixtures/isolated-project.cjs");
const {
  measureEdgeContrast,
  measureWorstRectContrast,
} = require("./fixtures/rendered-contrast.cjs");

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "tablet", width: 1024, height: 768 },
  { name: "mobile", width: 390, height: 844 },
];

async function chooseTheme(page, theme) {
  const labels = {
    light: "Светлая",
    dark: "Темная",
    system: "Системная",
  };
  await page.getByRole("banner").getByRole("button", { name: "Выбрать тему" }).click();
  // The selected item includes a visible checkmark in its accessible name.
  // Anchor the complete label so "Темная" cannot match "Системная".
  await page.getByRole("menuitem", { name: new RegExp(`^${labels[theme]}(?:\\s*✓)?$`) }).click();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.className))
    .toMatch(theme === "dark" || theme === "system" ? /dark/ : /light/);
}

async function waitForPresentedBoard(page) {
  // Visibility does not mean the column/empty-state entrance has finished.
  // Observe the real presentation; never disable motion or change its styles.
  const settled = await page.evaluate(() => {
    const ready = () => {
      const columns = Array.from(document.querySelectorAll(".workspace-column"))
        .filter(element => {
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== "hidden";
        });
      if (columns.length === 0) return false;
      const entrances = columns.flatMap(column => [
        column,
        ...column.querySelectorAll(".workspace-column-count, .py-12, .py-12 *"),
      ]);
      for (const entrance of entrances) {
        for (let element = /** @type {Element | null} */ (entrance); element; element = element.parentElement) {
          if (Number(getComputedStyle(element).opacity) !== 1) return false;
        }
      }
      return !document.getAnimations().some(animation =>
        animation.effect?.getComputedTiming().iterations !== Infinity &&
        (animation.playState === "running" || animation.pending),
      );
    };
    return new Promise(resolve => {
      let finished = false;
      let previousReady = false;
      const deadline = setTimeout(() => {
        finished = true;
        resolve(false);
      }, 5000);
      const frame = () => {
        if (finished) return;
        const currentReady = ready();
        if (previousReady && currentReady) {
          finished = true;
          clearTimeout(deadline);
          resolve(true);
          return;
        }
        previousReady = currentReady;
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
  });
  expect(settled, "Board entrance must settle before the accessibility scan").toBe(true);
}

async function seriousOrCriticalAxeViolations(page) {
  await waitForPresentedBoard(page);
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  return result.violations
    .filter(
      (violation) =>
        violation.impact === "serious" ||
        violation.impact === "critical",
    )
    .map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      help: violation.help,
      targets: violation.nodes.map((node) => node.target.join(" ")),
    }));
}

async function getByDisplayValue(page, expectedValue) {
  const controls = page.locator("input, textarea, select");
  await expect
    .poll(
      () =>
        controls.evaluateAll(
          (elements, value) =>
            elements.filter((element) => {
              if (
                !(
                  element instanceof HTMLInputElement ||
                  element instanceof HTMLTextAreaElement ||
                  element instanceof HTMLSelectElement
                )
              ) {
                return false;
              }
              const style = getComputedStyle(element);
              return (
                element.value === value &&
                style.visibility !== "hidden" &&
                style.display !== "none"
              );
            }).length,
          expectedValue,
        ),
      {
        message: `Expected a visible form control with value "${expectedValue}"`,
      },
    )
    .toBeGreaterThan(0);
}

async function measuredPriorityContrast(page) {
  const cards = page.locator("[data-priority]");
  const measurements = [];

  for (let index = 0; index < (await cards.count()); index += 1) {
    const card = cards.nth(index);
    await card.scrollIntoViewIfNeeded();
    const descriptor = await card.evaluate((cardElement) => {
      const title =
        cardElement.querySelector(
          '[aria-label^="Открыть задачу"]',
        ) ??
        Array.from(cardElement.querySelectorAll("p")).find(
          (candidate) =>
            candidate.classList.contains("font-bold") &&
            candidate.classList.contains("text-sm"),
        );
      const dragHandle = cardElement.querySelector(
        "[data-kanban-drag-handle]",
      );
      if (!title) {
        throw new Error("Priority card title is missing");
      }

      const toRect = (element) => {
        const rect = element.getBoundingClientRect();
        return {
          height: rect.height,
          width: rect.width,
          x: rect.x,
          y: rect.y,
        };
      };
      const colorToRgba = (value) => {
        const canvas = document.createElement("canvas");
        canvas.width = 1;
        canvas.height = 1;
        const context = canvas.getContext("2d", {
          willReadFrequently: true,
        });
        if (!context) {
          throw new Error("Canvas color conversion is unavailable");
        }
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = value;
        context.fillRect(0, 0, 1, 1);
        const pixel = context.getImageData(0, 0, 1, 1).data;
        return {
          r: pixel[0],
          g: pixel[1],
          b: pixel[2],
          a: pixel[3] / 255,
        };
      };
      const hideForeground = (element) => {
        const htmlElement = /** @type {HTMLElement} */ (element);
        htmlElement.dataset.e2eContrastColor =
          htmlElement.style.getPropertyValue("color");
        htmlElement.dataset.e2eContrastColorPriority =
          htmlElement.style.getPropertyPriority("color");
        htmlElement.dataset.e2eContrastTextShadow =
          htmlElement.style.getPropertyValue("text-shadow");
        htmlElement.dataset.e2eContrastTextShadowPriority =
          htmlElement.style.getPropertyPriority("text-shadow");
        htmlElement.style.setProperty("color", "transparent", "important");
        htmlElement.style.setProperty(
          "text-shadow",
          "none",
          "important",
        );
        htmlElement.dataset.e2eContrastHidden = "1";
      };

      const titleStyle = getComputedStyle(title);
      const handleStyle = dragHandle
        ? getComputedStyle(dragHandle)
        : null;
      const cardStyle = getComputedStyle(cardElement);
      const descriptor = {
        borderWidth: Number.parseFloat(cardStyle.borderLeftWidth),
        cardRect: toRect(cardElement),
        handleColor: handleStyle
          ? colorToRgba(handleStyle.color)
          : null,
        handleRect: dragHandle ? toRect(dragHandle) : null,
        priority: cardElement.getAttribute("data-priority"),
        titleColor: colorToRgba(titleStyle.color),
        titleFontSize: Number.parseFloat(titleStyle.fontSize),
        titleFontWeight:
          Number.parseInt(titleStyle.fontWeight, 10) || 400,
        titleRect: toRect(title),
      };

      hideForeground(title);
      if (dragHandle) {
        hideForeground(dragHandle);
      }
      return descriptor;
    });

    try {
      const screenshot = await page.screenshot({
        animations: "disabled",
        fullPage: false,
        scale: "css",
      });
      const rendered = await sharp(screenshot)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const image = {
        channels: rendered.info.channels,
        data: rendered.data,
        height: rendered.info.height,
        width: rendered.info.width,
      };
      const isLarge =
        descriptor.titleFontSize >= 24 ||
        (descriptor.titleFontSize >= 18.66 &&
          descriptor.titleFontWeight >= 700);
      measurements.push({
        edgeRatio: measureEdgeContrast(image, {
          borderWidth: descriptor.borderWidth,
          cardRect: descriptor.cardRect,
        }),
        indicatorRatio:
          descriptor.handleColor && descriptor.handleRect
            ? measureWorstRectContrast(
                image,
                descriptor.handleRect,
                descriptor.handleColor,
              )
            : null,
        priority: descriptor.priority,
        titleMinimum: isLarge ? 3 : 4.5,
        titleRatio: measureWorstRectContrast(
          image,
          descriptor.titleRect,
          descriptor.titleColor,
        ),
      });
    } finally {
      await page
        .locator("[data-e2e-contrast-hidden='1']")
        .evaluateAll((elements) => {
          for (const element of elements) {
            const htmlElement = /** @type {HTMLElement} */ (element);
            const color =
              htmlElement.dataset.e2eContrastColor ?? "";
            const colorPriority =
              htmlElement.dataset.e2eContrastColorPriority ?? "";
            const textShadow =
              htmlElement.dataset.e2eContrastTextShadow ?? "";
            const textShadowPriority =
              htmlElement.dataset.e2eContrastTextShadowPriority ?? "";
            if (color === "") {
              htmlElement.style.removeProperty("color");
            } else {
              htmlElement.style.setProperty(
                "color",
                color,
                colorPriority,
              );
            }
            if (textShadow === "") {
              htmlElement.style.removeProperty("text-shadow");
            } else {
              htmlElement.style.setProperty(
                "text-shadow",
                textShadow,
                textShadowPriority,
              );
            }
            delete htmlElement.dataset.e2eContrastColor;
            delete htmlElement.dataset.e2eContrastColorPriority;
            delete htmlElement.dataset.e2eContrastTextShadow;
            delete htmlElement.dataset
              .e2eContrastTextShadowPriority;
            delete htmlElement.dataset.e2eContrastHidden;
          }
        });
    }
  }

  return measurements;
}

test.describe("Kanban theme and accessibility", () => {
  test("light, dark, and system themes render at desktop, tablet, and mobile sizes", async ({
    page,
    project,
  }, testInfo) => {
    await page.emulateMedia({
      colorScheme: "dark",
      reducedMotion: "reduce",
    });
    await project.openBoard(page);

    for (const viewport of VIEWPORTS) {
      await page.setViewportSize({
        width: viewport.width,
        height: viewport.height,
      });
      for (const theme of ["light", "dark", "system"]) {
        await chooseTheme(page, theme);
        const screenshot = await page.screenshot({
          animations: "disabled",
          fullPage: true,
        });
        await testInfo.attach(
          `kanban-${theme}-${viewport.name}-${testInfo.project.name}`,
          { body: screenshot, contentType: "image/png" },
        );
      }
    }
  });

  test("system theme follows dark-light-dark without reopening menu", async ({
    page,
    project,
  }) => {
    await page.emulateMedia({
      colorScheme: "dark",
      reducedMotion: "reduce",
    });
    await project.openBoard(page);
    await chooseTheme(page, "system");

    await page.emulateMedia({
      colorScheme: "light",
      reducedMotion: "reduce",
    });
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.className),
      )
      .toMatch(/light/);

    await page.emulateMedia({
      colorScheme: "dark",
      reducedMotion: "reduce",
    });
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.className),
      )
      .toMatch(/dark/);
  });

  for (const theme of ["light", "dark", "system"]) {
    test(`${theme} priority text and drag indicators meet computed contrast`, async ({
      page,
      project,
    }) => {
      await withOrdinaryResponsibleGroup(project, async () => {
        await page.emulateMedia({
          colorScheme: "dark",
          reducedMotion: "reduce",
        });
        await project.openBoard(page);
        const permission = await page.request.get(`/api/projects/${project.projectId}/task-permissions`);
        expect(permission.status()).toBe(200);
        expect((await permission.json()).data.canChangeStatus).toBe(true);
        await chooseTheme(page, theme);

        const measurements = await measuredPriorityContrast(page);
        expect(measurements).toHaveLength(4);
        for (const measurement of measurements) {
          expect(
            measurement.titleRatio,
            `${measurement.priority} title contrast`,
          ).toBeGreaterThanOrEqual(measurement.titleMinimum);
          expect(
            measurement.edgeRatio,
            `${measurement.priority} rendered priority-edge contrast`,
          ).toBeGreaterThanOrEqual(3);
          // Explicit active-group authority is asserted above. Both current
          // renderers expose a real handle for this actor; a feature flag alone
          // must never stand in for permission or excuse a missing indicator.
          expect(
            measurement.indicatorRatio,
            `${measurement.priority} authorized drag handle exists`,
          ).not.toBeNull();
          expect(
            measurement.indicatorRatio ?? 0,
            `${measurement.priority} rendered drag-handle contrast`,
          ).toBeGreaterThanOrEqual(3);
        }
      });
    });
  }

  test("axe has no serious or critical findings on the board", async ({
    page,
    project,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await project.openBoard(page);
    expect(await seriousOrCriticalAxeViolations(page)).toEqual([]);
  });

  test("axe has no serious or critical findings with the move menu open", async ({
    page,
    project,
  }) => {
    await withOrdinaryResponsibleGroup(project, async () => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await project.openBoard(page);
      const permission = await page.request.get(`/api/projects/${project.projectId}/task-permissions`);
      expect(permission.status()).toBe(200);
      expect((await permission.json()).data.canChangeStatus).toBe(true);
      await project
        .card(page, "Task B")
        .getByRole("button", { name: "Действия задачи «Task B»" })
        .click();
      await expect(
        page.getByRole("menuitem", {
          name: "В колонку «На проверке»",
        }),
      ).toBeVisible();
      expect(await seriousOrCriticalAxeViolations(page)).toEqual([]);
    });
  });

  test("axe has no serious or critical findings with task details open", async ({
    page,
    project,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await project.openBoard(page);
    await openTask(page, project);
    await expect(page).toHaveURL(/\/tasks\/[^/?]+/);
    await expect(
      page.getByRole("dialog", { name: "Детали задачи" }),
    ).toBeVisible();
    await getByDisplayValue(page, "Task A");
    expect(await seriousOrCriticalAxeViolations(page)).toEqual([]);
  });
});
