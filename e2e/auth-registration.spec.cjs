const { test, expect, loadPrismaClient, runBestEffortCleanup } = require("./fixtures/isolated-project.cjs");

// Registration inputs, cookies and the verification token must never enter
// traces, screenshots or videos.
test.use({ trace: "off", screenshot: "off", video: "off" });

const { startRegistrationDiagnostic } = require("./fixtures/registration-diagnostic.cjs");
const { encodeRequestDescription, decodeRequestDescription } = require("../src/lib/request-presentation.ts");

const SIGN_IN_PATH = "/sign-in";
const PROJECTS_PATH = /\/projects(?:\/|$)/;

test("#92 local password recovery is retired in compiled UI and API", async ({ page }) => {
  for (const route of ["/forgot-password", "/reset-password?token=synthetic-retired-token"]) {
    await page.goto(route);
    await expect(page.getByRole("heading", { name: "Восстановление доступа", exact: true })).toBeVisible();
    await expect(page.getByText("Восстановление доступа выполняется через корпоративный SSO.", { exact: true })).toBeVisible();
    await expect(page.locator("input, textarea, form")).toHaveCount(0);
    await page.getByRole("link", { name: "Вернуться ко входу", exact: true }).click();
    await expect(page).toHaveURL(/\/sign-in$/);
  }
  await expect(page.getByRole("link", { name: /забыли пароль|восстановить пароль/i })).toHaveCount(0);
  for (const route of ["/api/auth/forgot-password", "/api/auth/reset-password"]) {
    const response = await page.request.post(route, {
      // Malformed input must be ignored by the retired routes, not parsed.
      headers: { "Content-Type": "application/json", Origin: new URL(page.url()).origin },
      data: "{",
    });
    expect(response.status()).toBe(410);
    expect(await response.json()).toMatchObject({ success: false, error: { code: "RECOVERY_MANAGED_BY_SSO" } });
  }
});

async function fillSignIn(page, identity) {
  await page.goto(SIGN_IN_PATH);
  await page.getByLabel("Логин", { exact: true }).fill(identity.email);
  await page.getByLabel(/^Пароль/).fill(identity.password);
}

test.describe("#59 registration → confirmation → project → task", () => {
  test.describe.configure({ timeout: 90_000 });

  test("UI registration, email confirmation, sign-in, project and task survive reload", async ({
    page,
    registration,
  }) => {
    const db = loadPrismaClient(process.env.E2E_DATABASE_URL);
    const departmentName = `[${registration.runMarker}] registration department`;
    const projectName = `Registration board ${registration.runId}`;
    let department;
    let diagnosticTaskId;
    const diagnostic = startRegistrationDiagnostic(page);
    try {
    diagnostic.phase("registration");
    department = await db.department.create({ data: { name: departmentName } });
    await page.setExtraHTTPHeaders({
      "x-forwarded-for": `e2e-${registration.runId}`,
      "x-kanban-e2e-run-id": registration.runId,
    });

    await page.goto("/sign-up");
    await page.getByLabel("Имя", { exact: true }).fill(registration.name);
    await page.getByLabel("Email", { exact: true }).fill(registration.email);
    await page
      .getByLabel("Пароль (мин. 8 символов)", { exact: true })
      .fill(registration.password);

    const registered = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/auth/register" &&
        response.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "Создать аккаунт", exact: true })
      .click();
    expect((await registered).status()).toBe(201);

    await expect(
      page.getByRole("heading", { name: "Проверьте почту" }),
    ).toBeVisible();
    await expect(
      page.getByText(registration.email, { exact: true }),
    ).toBeVisible();

    // The managed E2E server sets EMAIL_VERIFICATION_REQUIRED=true. If it is
    // missing, this is a setup error, not a passing confirmation scenario.
    diagnostic.phase("verification");
    const token = await registration.verificationToken();
    expect(
      token,
      "EMAIL_VERIFICATION_REQUIRED must be true for the managed E2E server; " +
        "otherwise registration skips the confirmation step entirely",
    ).not.toBeNull();
    expect(token.length).toBeGreaterThan(20);

    // With verification required, the same credentials must not produce a
    // session before the address is confirmed.
    await fillSignIn(page, registration);
    await page.getByRole("button", { name: "Войти", exact: true }).click();
    await expect(page.locator("#sign-in-error")).toContainText(
      "Неверный логин или пароль",
    );
    await expect(page).toHaveURL(/\/sign-in(?:\?|$)/);
    const deniedSession = await page.request.get("/api/auth/session");
    const deniedBody = await deniedSession.json().catch(() => null);
    expect(deniedBody?.user ?? null).toBeNull();

    await page.goto(`/verify-email?token=${encodeURIComponent(token)}`);
    await expect(
      page.getByRole("heading", { name: /Успешно/ }),
    ).toBeVisible();
    await expect(
      page.getByText(registration.email, { exact: true }),
    ).toBeVisible();

    diagnostic.phase("sign_in");
    await fillSignIn(page, registration);
    await page.getByRole("button", { name: "Войти", exact: true }).click();
    await expect(page).toHaveURL(PROJECTS_PATH, { timeout: 20_000 });

    // The product lets only global administrators create boards. The synthetic
    // identity is promoted in the isolated database after registration; the
    // board itself is still created through the real UI command.
    diagnostic.phase("promotion");
    await registration.promoteToAdmin();
    await page.reload();

    diagnostic.phase("project_create");
    const createdProject = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/project-templates/builtin-project-template-tech-support/use" &&
        response.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "Новый проект", exact: true })
      .click();
    const createBoard = page.getByRole("dialog", { name: "Создать доску", exact: true });
    await createBoard.getByLabel("Подразделение доски", { exact: true }).selectOption(department.id);
    await createBoard.getByLabel("Название доски", { exact: true }).fill(projectName);
    await createBoard.getByRole("button", { name: "Создать доску", exact: true }).click();
    const projectResponse = await createdProject;
    expect(projectResponse.status()).toBe(201);
    const projectId = (await projectResponse.json()).data.id;
    expect(typeof projectId).toBe("string");

    diagnostic.phase("project_heading");
    await expect(page).toHaveURL(
      new RegExp(`/projects/${projectId}/board(?:\\?|$)`),
      { timeout: 20_000 },
    );
    await expect(
      page.getByRole("heading", { name: projectName, exact: true }),
    ).toBeVisible();

    diagnostic.phase("task_create");
    const title = `Registration task ${registration.runId}`;
    const description = `Synthetic registration task ${registration.runId}`;
    const requestDetails = { kind: "it", category: "Компьютер" };
    await page
      .getByRole("button", { name: "Добавить обращение", exact: true })
      .and(page.locator("[data-create-task]"))
      .click();
    const createDialog = page.getByRole("dialog", {
      name: "Обращение в Техподдержку",
      exact: true,
    });
    await createDialog
      .getByLabel("Кратко о проблеме", { exact: true })
      .fill(title);
    await createDialog
      .getByLabel("Подробности", { exact: true })
      .fill(description);
    await createDialog.getByRole("button", { name: requestDetails.category, exact: true }).click();
    await expect(createDialog.getByRole("button", { name: requestDetails.category, exact: true })).toHaveAttribute("aria-pressed", "true");

    const createdTask = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/tasks" &&
        response.request().method() === "POST",
    );
    const submittedTask = page.waitForResponse(
      (response) => /^\/api\/tasks\/[^/]+$/.test(new URL(response.url()).pathname) &&
        response.request().method() === "POST" && response.request().postDataJSON()?.action === "submit",
    );
    await createDialog
      .getByRole("button", { name: "Отправить обращение", exact: true })
      .click();
    const creationResponse = await createdTask;
    expect(creationResponse.status()).toBe(201);
    diagnosticTaskId = (await creationResponse.json()).data.taskId;
    expect(typeof diagnosticTaskId).toBe("string");
    const submissionResponse = await submittedTask;
    expect(new URL(submissionResponse.url()).pathname).toBe(`/api/tasks/${diagnosticTaskId}`);
    expect(submissionResponse.status()).toBe(200);
    await expect(createDialog).toHaveCount(0);

    // The request form creates a private draft, submits it through the lifecycle
    // command and opens that submitted request automatically.
    diagnostic.phase("task_open");
    const panel = page.getByRole("dialog", { name: "Детали задачи", exact: true });
    await expect(panel).toBeVisible();
    await expect(panel.getByLabel("Тема обращения", { exact: true })).toHaveValue(title);
    const lifecycle = await page.request.get(`/api/tasks/${diagnosticTaskId}/lifecycle`);
    expect(lifecycle.status()).toBe(200);
    expect((await lifecycle.json()).data).toMatchObject({
      taskId: diagnosticTaskId, projectId, marked: true, state: "SUBMITTED", deleted: false,
    });

    diagnostic.phase("task_list");
    const taskList = await page.request.get(
      `/api/tasks?projectId=${projectId}`,
    );
    expect(taskList.status()).toBe(200);
    const tasks = (await taskList.json()).data;
    expect(tasks.length).toBe(1);
    expect(tasks[0].id).toBe(diagnosticTaskId);
    expect(tasks[0].title).toBe(title);
    expect(tasks[0].description).toBe(encodeRequestDescription(description, requestDetails));
    expect(decodeRequestDescription(tasks[0].description)).toEqual({ details: requestDetails, body: description });

    // A submitted request does not permit a title PATCH. Exercise the supported
    // description editor and its canonical edit_description lifecycle command.
    diagnostic.phase("task_open");
    const updatedDescription = `${description} edited`;
    const updatedBody = `<p>${updatedDescription}</p>`;
    await panel.getByRole("button", { name: "Изменить описание", exact: true }).click();
    const editor = panel.getByRole("textbox", { name: "Описание заявки", exact: true });
    await expect(editor).toHaveAttribute("aria-readonly", "false");
    await editor.fill(updatedDescription);
    const saved = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/api/tasks/${tasks[0].id}` &&
        response.request().method() === "POST" &&
        response.request().postDataJSON()?.action === "edit_description",
    );
    await panel.getByRole("button", { name: "Сохранить", exact: true }).click();
    expect((await saved).status()).toBe(200);
    diagnostic.phase("saved_status");
    await expect(
      panel.getByRole("button", { name: "Сохранено", exact: true }),
    ).toBeDisabled();

    diagnostic.phase("reload");
    await page.reload();
    // Ordinary request dialogs retain the board URL. A full reload returns to
    // that board; reopen the same persisted request through its real control.
    await expect(page.getByRole("heading", { name: projectName, exact: true })).toBeVisible();
    await expect(page.getByRole("dialog", { name: "Детали задачи", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: `Открыть задачу «${title}»`, exact: true }).click();
    await expect(
      page.getByRole("dialog", { name: "Детали задачи", exact: true }),
    ).toBeVisible();

    const persisted = await page.request.get(
      `/api/tasks/${tasks[0].id}?view=details`,
    );
    expect(persisted.status()).toBe(200);
    const detail = (await persisted.json()).data;
    expect(detail.title).toBe(title);
    expect(detail.description).toBe(encodeRequestDescription(updatedBody, requestDetails));
    expect(decodeRequestDescription(detail.description)).toEqual({ details: requestDetails, body: updatedBody });
    const reloadedPanel = page.getByRole("dialog", { name: "Детали задачи", exact: true });
    await expect(reloadedPanel.getByLabel("Тема обращения", { exact: true })).toHaveValue(title);
    await expect(reloadedPanel.getByRole("textbox", { name: "Описание заявки", exact: true })).toHaveText(updatedDescription);

    const afterReload = await page.request.get(
      `/api/tasks?projectId=${projectId}`,
    );
    expect(afterReload.status()).toBe(200);
    const reloadedTasks = (await afterReload.json()).data;
    expect(reloadedTasks.length).toBe(1);
    expect(reloadedTasks[0]).toMatchObject({
      id: diagnosticTaskId, title, description: encodeRequestDescription(updatedBody, requestDetails),
    });
    const persistedLifecycle = await page.request.get(`/api/tasks/${diagnosticTaskId}/lifecycle`);
    expect(persistedLifecycle.status()).toBe(200);
    expect((await persistedLifecycle.json()).data).toMatchObject({
      taskId: diagnosticTaskId, projectId, marked: true, state: "SUBMITTED", deleted: false,
    });

    await page.getByRole("dialog", { name: "Детали задачи", exact: true })
      .getByRole("button", { name: "Закрыть", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/board(?:\\?|$)`));

    diagnostic.phase("reopen");
    await page
      .getByRole("button", { name: `Открыть задачу «${title}»`, exact: true })
      .click();
    await expect(
      page.getByRole("dialog", { name: "Детали задачи", exact: true })
        .getByLabel("Тема обращения", { exact: true }),
    ).toHaveValue(title);
    await expect(page.getByRole("dialog", { name: "Детали задачи", exact: true })
      .getByRole("textbox", { name: "Описание заявки", exact: true })).toHaveText(updatedDescription);
    diagnostic.phase("complete");
    } catch (originalError) {
      try {
        console.log("REGISTRATION_DIAGNOSTIC " + await diagnostic.failure({ expectedEmail: registration.email, projectName, taskId: diagnosticTaskId }));
      } catch { /* A diagnostic must never replace the original test error. */ }
      throw originalError;
    } finally {
      diagnostic.stop();
      await runBestEffortCleanup([
        { label: "remove only registration department projects and receipts", run: async () => {
          if (!department) return;
          const owned = await db.project.findMany({ where: { departmentId: department.id, name: projectName,
            owner: { email: registration.email, name: registration.name } }, select: { id: true, ownerId: true } });
          for (const project of owned) {
            await db.taskCommandOperation.deleteMany({ where: { projectId: project.id, actorId: project.ownerId } });
            await db.taskRequest.deleteMany({ where: { task: { projectId: project.id } } });
            await db.project.deleteMany({ where: { id: project.id, departmentId: department.id, ownerId: project.ownerId } });
          }
        } },
        { label: "remove exact synthetic registration department", run: async () => { if (department) await db.department.deleteMany({ where: { id: department.id, name: departmentName } }); } },
        { label: "remove exact registration preflight quota", run: () => db.rateLimit.deleteMany({ where: { key: `auth:login:preflight:e2e-${registration.runId}` } }) },
        { label: "disconnect registration flow setup", run: () => db.$disconnect() },
      ]);
    }
  });
});
