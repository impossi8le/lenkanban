const { randomUUID } = require("node:crypto");
const {
  test, expect, tasks, taskByTitle, details, openTask,
  scalarResponse,
} = require("./fixtures/regression.cjs");

test.use({ trace: "off", screenshot: "off", video: "off" });

test.describe("#59 controlled failures — real persistence, injected transport failures", () => {
  test.describe.configure({ timeout: 60_000 });
  test("board → card → mutation → React failure retains full navigation breadcrumbs", async ({ page, project }) => {
    // Stub collector transport and corrupt only the browser's fresh read after
    // a real visible title save. No hidden checklist UI or synthetic ErrorEvent.
    const events = [];
    await page.route("**/api/telemetry", async route => {
      const body = route.request().postDataJSON();
      if (body.kind === "session.start") {
        const expiry = Date.now() + 60 * 60 * 1000;
        return route.fulfill({ json: { success: true, data: {
          sessionId: body.sessionId,
          sessionToken: `v1.${expiry}.${"0".repeat(64)}`,
          expiresAt: new Date(expiry).toISOString(),
        } } });
      }
      events.push(...body.events);
      return route.fulfill({ json: { success: true, data: {
        accepted: body.events.map(event => event.eventId),
      } } });
    });
    await project.openBoard(page);
    const task = await taskByTitle(page, project);
    const panel = await openTask(page, project);
    await expect.poll(() => events.some(event =>
      event.event === "ui.action" && event.screen === "task.detail",
    )).toBe(true);
    const canary = `private-react-input-${project.runId}`;
    const before = await details(page, task.id);
    const path = `**/api/tasks/${task.id}`;
    const readPath = url => url.pathname === `/api/tasks/${task.id}` && url.searchParams.get("view") === "details";
    const attempts = [];
    await page.route(path, async route => {
      if (route.request().method() !== "PATCH") return route.continue();
      const actionId = route.request().headers()["x-action-id"];
      expect(typeof actionId).toBe("string");
      expect(actionId.length).toBeGreaterThan(0);
      attempts.push(actionId);
      const committed = await route.fetch({ maxRetries: 0 });
      expect(committed.status()).toBe(200);
      expect((await committed.json()).success).toBe(true);
      await route.fulfill({ response: committed });
    });
    let corruptedReads = 0;
    const canonicalReadActionIds = [];
    await page.route(readPath, async route => {
      if (attempts.length !== 1 || typeof attempts[0] !== "string" || !attempts[0]
        || route.request().headers()["x-action-id"] !== attempts[0]) return route.continue();
      expect(route.request().method()).toBe("GET");
      canonicalReadActionIds.push(route.request().headers()["x-action-id"]);
      const response = await route.fetch({ maxRetries: 0 });
      expect(response.status()).toBe(200);
      const body = await response.json();
      expect(body.success).toBe(true);
      expect(body.data.title).toBe(canary);
      // TaskDetailPanel's real heading renders task.title. The persisted title
      // remains a string; only this browser's canonical read has an object child.
      body.data.title = { [canary]: canary };
      corruptedReads++;
      await route.fulfill({ response, json: body });
    });
    await panel.getByLabel("Название задачи", { exact: true }).fill(canary);
    await expect(page.getByRole("heading", { name: "Что-то пошло не так", exact: true })).toBeVisible();
    const reference = page.getByText(/^Код ошибки: /);
    await expect(reference).toHaveText(/^Код ошибки: [a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i);
    const errorId = (await reference.innerText()).replace("Код ошибки: ", "").trim();
    await expect.poll(() => events.filter(event =>
      event.event === "client.render.failed" && event.errorId === errorId,
    ).length).toBe(1);
    const failure = events.find(event => event.event === "client.render.failed" && event.errorId === errorId);
    expect(failure.action).toBe("app.render");
    expect(failure.errorCode).toBe("RENDER_FAILURE");
    expect(failure.actionId).toMatch(/^[a-f0-9-]{36}$/i);
    expect(failure.traceId).toMatch(/^[a-f0-9]{32}$/i);
    const trail = events.filter(event => event.event === "client.breadcrumb" && event.actionId === failure.actionId);
    // Keep the full acceptance requirement, including board navigation. Missing
    // production instrumentation must fail this test rather than become a skip.
    const uniqueSteps = [
      ["navigation", "board"],
      ["dialog", "task.detail"],
      ["operation", "task.update"],
      ["operation", "app.render"],
    ].map(([kind, name]) => {
      const matches = trail.filter(event => event.kind === kind && event.name === name);
      expect(matches).toHaveLength(1);
      return matches[0];
    });
    const requests = trail.filter(event => event.kind === "request" && event.name === "/api/tasks/:id")
      .sort((a, b) => a.seq - b.seq);
    expect(requests).toHaveLength(1); // One truthful write completion; GET correlation is asserted below.
    const steps = [...uniqueSteps.slice(0, 3), ...requests, uniqueSteps[3]];
    for (let index = 0; index < steps.length; index++) {
      expect(steps[index].sessionId).toBe(failure.sessionId);
      expect(steps[index].traceId).toBe(failure.traceId);
      expect(steps[index].seq).toBeLessThan(failure.seq);
      if (index) expect(steps[index - 1].seq).toBeLessThan(steps[index].seq);
    }
    for (const request of requests) {
      expect(request.outcome).toBe("success");
      expect(request.statusCode).toBe(200);
    }
    const results = events.filter(event => event.event === "client.request.result" && event.actionId === attempts[0]);
    expect(results).toHaveLength(1);
    for (const result of results) {
      expect(result.outcome).toBe("success");
      expect(result.statusCode).toBe(200);
      expect(result.sessionId).toBe(failure.sessionId);
      expect(result.seq).toBeLessThan(failure.seq);
    }
    expect(attempts).toHaveLength(1);
    expect(corruptedReads).toBe(1);
    expect(canonicalReadActionIds).toEqual([attempts[0]]);
    expect([canary, project.password, project.email, project.projectName]
      .some(value => JSON.stringify(events).includes(value)), "Telemetry must omit private text and credentials").toBe(false);
    await page.unroute(path);
    await page.unroute(readPath);
    await page.getByRole("button", { name: "Перезагрузить страницу", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Что-то пошло не так", exact: true })).toHaveCount(0);
    const after = await details(page, task.id);
    expect(after.title).toBe(canary);
    expect(after.version).toBe(before.version + 1);
    expect(after.checklistItems).toHaveLength(0);
    expect((await tasks(page, project)).length).toBe(4);
  });

  test("lost committed ACK → explicit retry reuses command and increments version only once", async ({ page, project }) => {
    await project.openBoard(page);
    const before = await taskByTitle(page, project);
    const panel = await openTask(page, project);
    const path = `**/api/tasks/${before.id}`;
    const attempts = [];
    await page.route(path, async route => {
      if (route.request().method() !== "PATCH") return route.continue();
      attempts.push({ body: route.request().postDataJSON(), actionId: route.request().headers()["x-action-id"] });
      if (attempts.length === 1) {
        // Commit on the real test server, then lose its ACK at the browser boundary.
        const committed = await route.fetch({ maxRetries: 0 });
        expect(committed.status()).toBe(200);
        return route.abort("connectionfailed");
      }
      return route.continue();
    });
    await panel.getByLabel("Название задачи", { exact: true }).fill("Synthetic committed retry");
    const retry = panel.getByRole("button", { name: "Повторить ту же команду" });
    await expect(retry).toBeVisible();
    await expect(panel.getByRole("status", { name: "Название сохранено" })).toHaveCount(0);
    const response = scalarResponse(page, before.id);
    await retry.click();
    expect((await response).status()).toBe(200);
    await expect(panel.getByRole("status", { name: "Название сохранено" })).toBeVisible();
    expect(attempts.length).toBe(2);
    expect(Boolean(attempts[0].actionId)).toBe(true);
    expect(attempts[1]).toEqual(attempts[0]);
    await page.unroute(path);
    await page.reload();
    const after = await details(page, before.id);
    expect(after.title).toBe("Synthetic committed retry");
    expect(after.version).toBe(before.version + 1);
    expect((await tasks(page, project)).length).toBe(4);
    const history = await page.request.get(`/api/activities?taskId=${before.id}`);
    expect(history.status()).toBe(200);
    expect((await history.json()).data.filter(event => event.action === "title_changed").length).toBe(1);
    await expect(page.getByLabel("Название задачи", { exact: true })).toHaveValue(after.title);
  });

  test("real stale-version 409 → refresh does not resend a stale draft or show success", async ({ page, project }) => {
    await project.openBoard(page);
    const before = await taskByTitle(page, project);
    const panel = await openTask(page, project);
    // Freeze an actual browser command before the competing commit. A prior
    // socket/background read may correctly preempt an idle stale draft entirely.
    const path = `**/api/tasks/${before.id}`;
    const attempts = [];
    let release;
    const held = new Promise(resolve => { release = resolve; });
    const holdFirstPatch = async route => {
      if (route.request().method() !== "PATCH") return route.continue();
      attempts.push(route.request().postDataJSON());
      if (attempts.length === 1) await held;
      return route.continue(); // Real guarded server response; never fabricate409.
    };
    await page.route(path, holdFirstPatch);
    try {
      await panel.getByLabel("Название задачи", { exact: true }).fill("Synthetic stale draft");
      await expect.poll(() => attempts.length).toBe(1);
      const frozen = attempts[0];
      expect(frozen.expectedVersion).toBe(before.version);
      expect(frozen.changes).toEqual({ title: "Synthetic stale draft" });
      expect(frozen.operationId).toMatch(/^[0-9a-f-]{36}$/i);
      // The API request context bypasses browser interception, but commits through
      // the same authenticated guarded endpoint and frozen expectedVersion.
      const response = await page.request.patch(`/api/tasks/${before.id}`, {
        headers: { Origin: new URL(page.url()).origin },
        data: { operationId: randomUUID(), expectedVersion: frozen.expectedVersion, changes: { title: "Synthetic competing writer" } },
      });
      expect(response.status()).toBe(200);
      const conflict = scalarResponse(page, before.id);
      release();
      expect((await conflict).status()).toBe(409);
      await expect(panel.getByRole("status", { name: "Название сохранено" })).toHaveCount(0);
      await panel.getByRole("button", { name: "Загрузить после конфликта" }).click();
      await expect(page.getByLabel("Название задачи", { exact: true })).toHaveValue("Synthetic competing writer");
      await page.reload();
      const after = await details(page, before.id);
      expect(after.title).toBe("Synthetic competing writer");
      expect(after.version).toBe(before.version + 1);
      expect((await tasks(page, project)).length).toBe(4);
      // The rejected stale draft left no second history row and no duplicate task.
      const history = await page.request.get(`/api/activities?taskId=${before.id}`);
      expect(history.status()).toBe(200);
      const titleChanges = (await history.json()).data.filter(
        (event) => event.action === "title_changed",
      );
      expect(titleChanges.length).toBe(1);
      expect((await tasks(page, project)).filter(
        (task) => task.title === "Synthetic stale draft",
      ).length).toBe(0);
      expect(attempts.length).toBe(1); // Refresh/reload must not resend the draft.
    } finally {
      release(); // Also release on assertion, competing-write or test failure.
      await page.unroute(path, holdFirstPatch);
    }
  });

  test("title save 503 shows unknown result without persisted change; ordered events omit input text", async ({ page, project }) => {
    // Local collector stub: exercises production browser instrumentation, NOT
    // collector auth/storage or the still-missing board/card navigation breadcrumbs.
    const events = [];
    let sessions = 0;
    await page.route("**/api/telemetry", async route => {
      const body = route.request().postDataJSON();
      if (body.kind === "session.start") {
        sessions++;
        const expiry = Date.now() + 60 * 60 * 1000;
        return route.fulfill({ json: { success: true, data: {
          sessionId: body.sessionId,
          sessionToken: `v1.${expiry}.${"0".repeat(64)}`,
          expiresAt: new Date(expiry).toISOString(),
        } } });
      }
      events.push(...body.events);
      return route.fulfill({ json: { success: true, data: { accepted: body.events.map(event => event.eventId) } } });
    });
    await project.openBoard(page);
    await expect.poll(() => sessions).toBeGreaterThan(0);
    const task = await taskByTitle(page, project);
    const panel = await openTask(page, project);
    const canary = `private-input-${project.runId}`;
    const errorId = randomUUID();
    const requestId = randomUUID();
    let failedRequests = 0;
    const path = `**/api/tasks/${task.id}`;
    await page.route(path, async route => {
      if (route.request().method() !== "PATCH") return route.continue();
      failedRequests++;
      return route.fulfill({ status: 503, headers: { "X-Error-Id": errorId, "X-Request-Id": requestId },
        json: { success: false, error: { code: "E2E_CONTROLLED_FAILURE", message: "Synthetic service unavailable" } } });
    });
    await panel.getByLabel("Название задачи", { exact: true }).fill(canary);
    await expect(panel.getByRole("button", { name: "Повторить ту же команду", exact: true })).toBeVisible();
    await expect(panel.getByRole("status", { name: "Название сохранено" })).toHaveCount(0);
    expect(failedRequests).toBe(1);
    await expect.poll(() => events.filter(event => event.errorId === errorId).length).toBe(1);
    const failure = events.find(event => event.errorId === errorId);
    expect(failure.event).toBe("client.request.result");
    expect(failure.outcome).toBe("failure");
    expect(failure.statusCode).toBe(503);
    expect(failure.requestId).toBe(requestId);
    const action = events.find(event => event.event === "ui.action" && event.actionId === failure.actionId);
    expect(Boolean(action)).toBe(true);
    expect(action.seq).toBeLessThan(failure.seq);
    expect(action.sessionId).toBe(failure.sessionId);
    // Assert a boolean to avoid printing a leaked payload/password in the report.
    const containsPrivateData = [canary, project.password, project.email, "Synthetic service unavailable"]
      .some(value => JSON.stringify(events).includes(value));
    expect(containsPrivateData, "Telemetry must omit private text and credentials").toBe(false);
    await page.unroute(path);
    await page.reload();
    await expect(page.getByLabel("Название задачи", { exact: true })).toHaveValue(task.title);
    const persisted = await details(page, task.id);
    expect(persisted.title).toBe(task.title);
    expect(persisted.version).toBe(task.version);
    expect(persisted.checklistItems).toHaveLength(0);
    expect((await tasks(page, project))).toHaveLength(4);
  });

  test("logout revokes authenticated API access and hides the previous task context", async ({ page, project }) => {
    await project.openBoard(page);
    const task = await taskByTitle(page, project);
    const panel = await openTask(page, project);
    await panel.getByRole("button", { name: "Закрыть", exact: true }).click();
    await page.getByRole("button", { name: "Открыть меню пользователя" }).click();
    await page.getByRole("menuitem", { name: "Выйти", exact: true }).click();
    await expect(page).toHaveURL(/\/sign-in(?:\?|$)/);
    const response = await page.request.get(`/api/tasks/${task.id}?view=details`);
    expect(response.status()).toBe(401);
    await page.goto(`/projects/${project.projectId}/board`);
    await expect(page).toHaveURL(/\/sign-in(?:\?|$)/);
    await expect(page.getByRole("dialog", { name: "Детали задачи" })).toHaveCount(0);
    await expect(page.getByText(project.projectName, { exact: true })).toHaveCount(0);
  });
});
