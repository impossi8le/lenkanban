// @ts-check
const {
  test,
  expect,
} = require("./fixtures/isolated-project.cjs");
const {
  shouldSkipLegacyMutationTest,
} = require("./fixtures/legacy-mutation.cjs");
const { withOrdinaryResponsibleGroup } = require("./fixtures/design.cjs");
const { taskByTitle } = require("./fixtures/regression.cjs");
const { randomUUID } = require("node:crypto");

const MOVE_URL_PATTERN = /\/api\/tasks\/[^/]+\/move(?:\?|$)/;
const TOUCH_PROJECTS = new Set(["pixel-7", "iphone-13", "chromium-mobile", "webkit-mobile"]);

function skipPointerDragOnTouch(testInfo) {
  test.skip(
    TOUCH_PROJECTS.has(testInfo.project.name),
    "pointer drag is desktop-only; mobile coverage uses tap/menu",
  );
}

async function expectColumnOrder(project, page, column, expected) {
  await expect
    .poll(() => project.taskTitles(page, column), {
      message: `Expected exact order in column "${column}"`,
      timeout: 10_000,
    })
    .toEqual(expected);
}

function watchPageHealth(page) {
  const consoleErrors = [];
  const failedMoveRequests = [];

  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });
  page.on("requestfailed", (request) => {
    if (MOVE_URL_PATTERN.test(request.url())) {
      failedMoveRequests.push(
        `${request.method()} ${request.url()}: ${
          request.failure()?.errorText ?? "unknown failure"
        }`,
      );
    }
  });
  page.on("response", (response) => {
    if (MOVE_URL_PATTERN.test(response.url()) && !response.ok()) {
      failedMoveRequests.push(
        `${response.request().method()} ${response.url()}: ${
          response.status()
        }`,
      );
    }
  });

  return { consoleErrors, failedMoveRequests };
}

test.describe("Kanban DnD v2 — isolated movement", () => {
  test.beforeEach(({ project }, testInfo) => {
    test.skip(
      shouldSkipLegacyMutationTest({
        dndV2Enabled: project.dndV2Enabled,
        testTitle: testInfo.title,
      }),
      "Legacy mutation runs only the two named behavioral RED checks",
    );
  });

  test("same-column order persists after reload", async ({
    page,
    project,
  }, testInfo) => {
    skipPointerDragOnTouch(testInfo);

    await withOrdinaryResponsibleGroup(project, async () => {
      await project.openBoard(page);
      await project.dragTask(page, "Task C", {
        column: "К выполнению",
        before: "Task A",
      });
      await expectColumnOrder(project, page, "К выполнению", [
        "Task C",
        "Task A",
        "Task B",
      ]);

      await page.reload();
      await expect(project.card(page, "Task C")).toBeVisible();
      await expectColumnOrder(project, page, "К выполнению", [
        "Task C",
        "Task A",
        "Task B",
      ]);
    });
  });

  test("cross-column move and return persist exact order", async ({
    page,
    project,
  }, testInfo) => {
    skipPointerDragOnTouch(testInfo);

    await withOrdinaryResponsibleGroup(project, async () => {
      await project.openBoard(page);
      await project.dragTask(page, "Task C", { column: "В работе" });
      await expectColumnOrder(project, page, "К выполнению", [
        "Task A",
        "Task B",
      ]);
      await expectColumnOrder(project, page, "В работе", [
        "Task D",
        "Task C",
      ]);

      await project.dragTask(page, "Task C", {
        column: "К выполнению",
        before: "Task A",
      });
      await expectColumnOrder(project, page, "К выполнению", [
        "Task C",
        "Task A",
        "Task B",
      ]);
      await expectColumnOrder(project, page, "В работе", ["Task D"]);

      await page.reload();
      await expectColumnOrder(project, page, "К выполнению", [
        "Task C",
        "Task A",
        "Task B",
      ]);
    });
  });

  test("empty-column background accepts a task", async ({
    page,
    project,
  }, testInfo) => {
    skipPointerDragOnTouch(testInfo);

    await withOrdinaryResponsibleGroup(project, async () => {
      await project.openBoard(page);
      await expectColumnOrder(project, page, "На проверке", []);
      await project.dragTask(page, "Task B", { column: "На проверке" });
      await expectColumnOrder(project, page, "К выполнению", [
        "Task A",
        "Task C",
      ]);
      await expectColumnOrder(project, page, "На проверке", ["Task B"]);

      await page.reload();
      await expectColumnOrder(project, page, "На проверке", ["Task B"]);
    });
  });

  test("Escape restores the pre-drag order without a move request", async ({
    page,
    project,
  }, testInfo) => {
    skipPointerDragOnTouch(testInfo);
    const moveRequests = [];
    page.on("request", (request) => {
      if (MOVE_URL_PATTERN.test(request.url())) {
        moveRequests.push(request.url());
      }
    });


    await withOrdinaryResponsibleGroup(project, async () => {
      await project.openBoard(page);
      await project.cancelDrag(page, "Task C");
      await expectColumnOrder(project, page, "К выполнению", [
        "Task A",
        "Task B",
        "Task C",
      ]);
      expect(moveRequests).toEqual([]);
    });
  });

  test("outside drop restores the pre-drag order without a move request", async ({
    page,
    project,
  }, testInfo) => {
    skipPointerDragOnTouch(testInfo);
    const moveRequests = [];
    page.on("request", (request) => {
      if (MOVE_URL_PATTERN.test(request.url())) {
        moveRequests.push(request.url());
      }
    });


    await withOrdinaryResponsibleGroup(project, async () => {
      await project.openBoard(page);
      await project.dropOutside(page, "Task B");
      await expectColumnOrder(project, page, "К выполнению", [
        "Task A",
        "Task B",
        "Task C",
      ]);
      expect(moveRequests).toEqual([]);
    });
  });

  test("click or tap move menu moves a task and restores useful focus", async ({
    page,
    project,
  }, testInfo) => {

    await withOrdinaryResponsibleGroup(project, async () => {
      await project.openBoard(page);
      const trigger = project.card(page, "Task C").getByRole("button", {
        name: "Действия задачи «Task C»",
      });
      const isTouchProject = TOUCH_PROJECTS.has(testInfo.project.name);

      if (isTouchProject) {
        await trigger.tap();
      } else {
        await trigger.click();
      }
      const menuItem = page.getByRole("menuitem", { name: "В начало" });
      if (isTouchProject) {
        await menuItem.tap();
      } else {
        await menuItem.click();
      }

      await expectColumnOrder(project, page, "К выполнению", [
        "Task C",
        "Task A",
        "Task B",
      ]);
      await expect(trigger).toBeFocused();
      await expect(
        page.getByRole("status").filter({
          hasText: /Задача «Task C» перемещена.*К выполнению/i,
        }),
      ).toBeAttached();
    });
  });

  test("keyboard drag announces Russian instructions and Escape restoration", async ({
    page,
    project,
  }) => {

    await withOrdinaryResponsibleGroup(project, async () => {
      await project.openBoard(page);
      const handle = project.card(page, "Task A").getByRole("button", {
        name: "Переместить задачу «Task A»",
      });

      if (!project.dndV2Enabled) {
        await expect(handle).toHaveCount(0);
        const legacyCard = project.card(page, "Task A");
        await expect(legacyCard).toHaveAttribute("role", "button");
        await legacyCard.focus();
        await expect(legacyCard).toBeFocused();
        await legacyCard.press("Space");
        await expect(page).toHaveURL(/\/tasks\/[^/?]+/);
        await expect(
          page.getByRole("status").filter({
            hasText: /Поднята задача «Task A» из колонки «К выполнению»/i,
          }),
          "Legacy Space opens task details instead of announcing a drag",
        ).toBeAttached();
        return;
      }

      await expect(handle).toHaveCount(1);
      await handle.focus();
      await expect(handle).toBeFocused();
      await handle.press("Space");
      await expect(
        page.getByRole("status").filter({
          hasText: /Поднята задача «Task A» из колонки «К выполнению»/i,
        }),
      ).toBeAttached();
      await page.keyboard.press("Escape");
      await expect(
        page.getByRole("status").filter({
          hasText: /Перемещение задачи «Task A» отменено/i,
        }),
      ).toBeAttached();
      await expectColumnOrder(project, page, "К выполнению", [
        "Task A",
        "Task B",
        "Task C",
      ]);
    });
  });

  test("board filters stay hidden after reload and movement requires actual support membership", async ({
    page,
    project,
  }) => {
    await project.openBoard(page);
    const taskAHandle = project.card(page, "Task A").getByRole("button", {
      name: "Переместить задачу «Task A»",
    });
    await expect(page.getByRole("combobox")).toHaveCount(0);
    await expect(taskAHandle).toHaveCount(0);
    const permission = await page.request.get(`/api/projects/${project.projectId}/task-permissions`);
    expect(permission.status()).toBe(200);
    expect((await permission.json()).data.canChangeStatus).toBe(false);
    const snapshot = async () => {
      const response = await page.request.get(`/api/tasks?projectId=${project.projectId}`);
      expect(response.status()).toBe(200);
      return (await response.json()).data.map(({ id, columnId, rank, status, version }) => ({ id, columnId, rank, status, version }))
        .sort((a, b) => a.id.localeCompare(b.id));
    };
    const before = await snapshot();
    const task = await taskByTitle(page, project, "Task A");
    const taskId = task.id;
    const denied = await page.request.post(`/api/tasks/${taskId}/move`, {
      headers: { Origin: new URL(page.url()).origin }, data: { toColumnId: project.columns["На проверке"],
        beforeTaskId: null, afterTaskId: null, operationId: randomUUID(), expectedVersion: task.version },
    });
    expect(denied.status()).toBe(404); // Shared move policy deliberately conceals denied tasks.
    expect(await snapshot()).toEqual(before);
    await page.reload();
    await expect(page.getByRole("combobox")).toHaveCount(0);
    await expect(taskAHandle).toHaveCount(0);
    await withOrdinaryResponsibleGroup(project, async () => {
      await page.reload();
      const authorized = await page.request.get(`/api/projects/${project.projectId}/task-permissions`);
      expect(authorized.status()).toBe(200);
      expect((await authorized.json()).data.canChangeStatus).toBe(true);
      await expect(taskAHandle).toBeEnabled();
      await expect(page.getByRole("combobox")).toHaveCount(0);
      await page.reload();
      await expect(taskAHandle).toBeEnabled();
      await expect(page.getByRole("combobox")).toHaveCount(0);
      expect(await snapshot()).toEqual(before);
    });
  });

  test("409 conflict rolls optimistic order back", async ({
    page,
    project,
  }, testInfo) => {
    skipPointerDragOnTouch(testInfo);

    await withOrdinaryResponsibleGroup(project, async () => {
      await project.openBoard(page);
      await page.route("**/api/tasks/*/move", async (route) => {
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({
            success: false,
            error: {
              code: "STALE_TASK_VERSION",
              message: "Forced E2E conflict",
            },
          }),
        });
      });

      await project.dragTask(page, "Task C", {
        column: "К выполнению",
        before: "Task A",
      });
      await expectColumnOrder(project, page, "К выполнению", [
        "Task A",
        "Task B",
        "Task C",
      ]);
      await expect(page.getByText("Задача уже изменена", { exact: true })).toBeVisible();
    });
  });

  test("network failure rolls back and a deliberate retry succeeds", async ({
    page,
    project,
  }, testInfo) => {
    skipPointerDragOnTouch(testInfo);
    let abortNextMove = true;

    await withOrdinaryResponsibleGroup(project, async () => {
      await project.openBoard(page);
      await page.route("**/api/tasks/*/move", async (route) => {
        if (abortNextMove) {
          abortNextMove = false;
          await route.abort("connectionfailed");
          return;
        }
        await route.continue();
      });

      await project.dragTask(page, "Task C", {
        column: "К выполнению",
        before: "Task A",
      });
      await expectColumnOrder(project, page, "К выполнению", [
        "Task A",
        "Task B",
        "Task C",
      ]);

      const successfulMove = page.waitForResponse(
        (response) =>
          MOVE_URL_PATTERN.test(response.url()) && response.ok(),
      );
      await project.dragTask(page, "Task C", {
        column: "К выполнению",
        before: "Task A",
      });
      await successfulMove;
      await expectColumnOrder(project, page, "К выполнению", [
        "Task C",
        "Task A",
        "Task B",
      ]);
    });
  });

  test("successful movement has no console errors or failed move requests", async ({
    page,
    project,
  }) => {
    await withOrdinaryResponsibleGroup(project, async () => {
      await project.openBoard(page);
      const health = watchPageHealth(page);
      const successfulMove = page.waitForResponse(
        (response) =>
          MOVE_URL_PATTERN.test(response.url()) && response.ok(),
      );
      await project.moveWithMenu(
        page,
        "Task A",
        "В колонку «В работе»",
      );
      await successfulMove;
      await expectColumnOrder(project, page, "В работе", [
        "Task D",
        "Task A",
      ]);

      expect(health.failedMoveRequests).toEqual([]);
      expect(health.consoleErrors).toEqual([]);
    });
  });
});
