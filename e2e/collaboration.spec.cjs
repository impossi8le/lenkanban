const {
  test, expect, taskByTitle,
} = require("./fixtures/regression.cjs");
const { createIsolatedProject } = require("./fixtures/isolated-project.cjs");

// Login credentials must not enter browser artifacts.
test.use({ trace: "off", screenshot: "off", video: "off" });

async function signIn(page, identity) {
  await page.setExtraHTTPHeaders({
    "x-forwarded-for": `e2e-${identity.runId}`,
    "x-kanban-e2e-run-id": identity.runId,
  });
  await page.goto("/sign-in");
  await page.getByLabel("Логин", { exact: true }).fill(identity.email);
  await page.getByLabel(/^Пароль/).fill(identity.password);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page).toHaveURL(/\/projects(?:\/|$)/, {
    timeout: 20_000,
  });
}

test.describe("#59 roles and membership", () => {
  test.describe.configure({ timeout: 90_000 });

  test("board membership alone denies task read; group access survives project removal and is then revoked", async ({
    page,
    browser,
    project,
  }) => {
    await project.configureLifecycle();
    await project.openBoard(page);
    const task = await taskByTitle(page, project);
    const other = await createIsolatedProject();
    let memberContext;

    try {
      // The agreed compact board hides member management for every role.
      // Exercise its retained authenticated API; board access/revocation below
      // still uses the real UI and the same existing member session.
      const added = await page.request.post(
        `/api/projects/${project.projectId}/members`,
        {
          headers: { Origin: new URL(page.url()).origin },
          data: { email: other.fixture.email, role: "MEMBER" },
        },
      );
      expect(added.status()).toBe(201);
      const memberId = (await added.json()).data.id;
      expect(typeof memberId).toBe("string");

      await expect(page.getByRole("button", { name: "Дополнительно", exact: true })).toHaveCount(0);

      memberContext = await browser.newContext({
        baseURL: test.info().project.use.baseURL,
      });
      const memberPage = await memberContext.newPage();
      await signIn(memberPage, other.fixture);
      await memberPage.goto(`/projects/${project.projectId}/board`);
      await expect(
        memberPage.getByRole("heading", {
          name: project.projectName,
          exact: true,
        }),
      ).toBeVisible();
      const boardOnly = await memberPage.request.get(`/api/tasks/${task.id}?view=details`);
      expect(boardOnly.status()).toBe(404);
      expect((await boardOnly.json()).success).toBe(false);
      await expect(project.card(memberPage, "Task A")).toHaveCount(0);
      await project.setResponsibleGroupMember(other.fixture.userId, true);
      expect((await memberPage.request.get(`/api/tasks/${task.id}?view=details`)).status()).toBe(200);
      await memberPage.reload();
      await expect(project.card(memberPage, "Task A")).toBeVisible();

      const roleChanged = await page.request.patch(`/api/projects/${project.projectId}/members/${memberId}`, {
        headers: { Origin: new URL(page.url()).origin }, data: { role: "PROJECT_ADMIN" },
      });
      expect(roleChanged.status()).toBe(200);

      const membersAfterRole = await page.request.get(
        `/api/projects/${project.projectId}/members`,
      );
      expect(membersAfterRole.status()).toBe(200);
      const roleRows = (await membersAfterRole.json()).data.items;
      expect(
        roleRows.find((row) => row.id === memberId)?.role,
      ).toBe("PROJECT_ADMIN");

      const removed = await page.request.delete(`/api/projects/${project.projectId}/members/${memberId}`, {
        headers: { Origin: new URL(page.url()).origin },
      });
      expect(removed.status()).toBe(204);
      const afterRemoval = await page.request.get(`/api/projects/${project.projectId}/members`);
      expect(afterRemoval.status()).toBe(200);
      expect((await afterRemoval.json()).data.items.some(row => row.id === memberId)).toBe(false);

      // ProjectMember is not the task-read grant. Keep the existing session
      // and prove its active responsible-group membership still grants read.
      expect((await memberPage.request.get(`/api/tasks/${task.id}?view=details`)).status()).toBe(200);
      const stillAllowed = await memberPage.goto(`/projects/${project.projectId}/board`);
      expect(stillAllowed?.status()).toBe(200);
      await expect(project.card(memberPage, "Task A")).toBeVisible();
      await project.setResponsibleGroupMember(other.fixture.userId, false);
      // Only revoking the actual group grant denies task and board read.
      const denied = await memberPage.request.get(
        `/api/tasks/${task.id}?view=details`,
      );
      expect(denied.status()).toBe(404);
      expect((await denied.json()).success).toBe(false);

      await memberPage.goto(
        `/projects/${project.projectId}/board`,
      );
      // App Router may have already streamed HTTP200 before notFound renders.
      // Assert the opaque error UI and denied data, not transport timing.
      await expect(memberPage.getByRole("heading", { name: "404", exact: true })).toBeVisible();
      await expect(project.card(memberPage, "Task A")).toHaveCount(0);
      const deniedList = await memberPage.request.get(`/api/tasks?projectId=${project.projectId}`);
      expect(deniedList.status()).toBe(200);
      expect((await deniedList.json()).data).toEqual([]);
    } finally {
      try {
        await memberContext?.close();
      } finally {
        await other.cleanup();
      }
    }
  });
});

test.describe("#59 watchers and private files", () => {
  test.describe.configure({ timeout: 90_000 });

  test("watcher addition is idempotent and removal revokes an existing session", async ({ page, browser, project }) => {
    await project.openBoard(page);
    const task = await taskByTitle(page, project);
    const other = await createIsolatedProject();
    let context;
    try {
      context = await browser.newContext({ baseURL: test.info().project.use.baseURL });
      const watcher = await context.newPage();
      await signIn(watcher, other.fixture);
      const session = await watcher.request.get("/api/auth/session");
      expect(session.status()).toBe(200);
      const userId = (await session.json()).user.id;
      expect(typeof userId).toBe("string");
      const path = `/api/tasks/${task.id}/messages/watchers`;
      expect((await watcher.request.get(`/api/tasks/${task.id}?view=details`)).status()).toBe(404);
      const added = await page.request.post(path, { data: { userId } });
      expect(added.status()).toBe(201);
      expect((await added.json()).data.added).toBe(true);
      const replay = await page.request.post(path, { data: { userId } });
      expect(replay.status()).toBe(200);
      expect((await replay.json()).data.added).toBe(false);
      const list = await watcher.request.get(path);
      expect(list.status()).toBe(200);
      expect((await list.json()).data.items.filter(row => row.userId === userId)).toHaveLength(1);
      expect((await watcher.request.get(`/api/tasks/${task.id}?view=details`)).status()).toBe(200);
      const commentPayload = {
        data: { clientId: require("node:crypto").randomUUID(), contentText: "Synthetic watcher comment", visibility: "PUBLIC" },
      };
      // A watcher read grant does not turn an unmarked legacy card into a
      // submitted request. Exercise the canonical discussion rule explicitly.
      expect((await watcher.request.post(`/api/tasks/${task.id}/messages`, commentPayload)).status()).toBe(404);
      await project.configureLifecycle({ memberIds: [project.userId] });
      const lifecycle = await page.request.get(`/api/tasks/${task.id}/lifecycle`);
      expect(lifecycle.status()).toBe(200);
      const submitted = await page.request.post(`/api/tasks/${task.id}`, {
        headers: { Origin: new URL(page.url()).origin },
        data: { action: "submit", expectedVersion: (await lifecycle.json()).data.version,
          operationId: require("node:crypto").randomUUID() },
      });
      expect(submitted.status()).toBe(200);
      const comment = await watcher.request.post(`/api/tasks/${task.id}/messages`, commentPayload);
      expect(comment.status()).toBe(201);
      // Visibility must not confer status/assignment authority.
      const currentLifecycle = await page.request.get(`/api/tasks/${task.id}/lifecycle`);
      expect(currentLifecycle.status()).toBe(200);
      const currentRequest = (await currentLifecycle.json()).data;
      const forbidden = await watcher.request.post(`/api/tasks/${task.id}`, {
        headers: { Origin: new URL(watcher.url()).origin },
        data: { operationId: require("node:crypto").randomUUID(), expectedVersion: currentRequest.version, action: "take" },
      });
      expect(forbidden.status()).toBe(403);
      expect((await forbidden.json()).error.code).toBe("FORBIDDEN_ROLE");
      expect((await (await page.request.get(`/api/tasks/${task.id}/lifecycle`)).json()).data).toEqual(currentRequest);
      const removed = await page.request.delete(path, { data: { userId } });
      expect(removed.status()).toBe(200);
      expect((await removed.json()).data.removed).toBe(true);
      for (const url of [`/api/tasks/${task.id}?view=details`, path, `/api/tasks/${task.id}/messages`]) {
        const denied = await watcher.request.get(url);
        expect(denied.status()).toBe(404);
        expect((await denied.json()).success).toBe(false);
      }
      expect((await watcher.request.post(`/api/tasks/${task.id}/messages`, {
        data: { contentText: "Rejected after revocation" },
      })).status()).toBe(404);
    } finally {
      try { await context?.close(); } finally { await other.cleanup(); }
    }
  });

  test("real local upload uses group grant, survives project member removal and denies after group revocation", async ({ page, browser, project }) => {
    const fs = require("node:fs/promises");
    const path = require("node:path");
    const { createHash } = require("node:crypto");
    // The server and test must share a dedicated, explicit, workspace-local
    // sink. Never silently use /data/attachments or an S3 account.
    const root = path.resolve(__dirname, "artifacts/storage");
    if (process.env.ATTACHMENT_STORAGE !== "local" || !process.env.ATTACHMENT_LOCAL_DIR
      || path.resolve(process.env.ATTACHMENT_LOCAL_DIR) !== root) {
      throw new Error("BLOCKED #59: configure ATTACHMENT_STORAGE=local and ATTACHMENT_LOCAL_DIR=<root>/e2e/artifacts/storage for both server and runner");
    }
    await project.configureLifecycle();
    await project.openBoard(page);
    const task = await taskByTitle(page, project);
    const other = await createIsolatedProject();
    let context, storedFile;
    try {
      const added = await page.request.post(`/api/projects/${project.projectId}/members`, {
        data: { email: other.fixture.email, role: "MEMBER" },
      });
      expect(added.status()).toBe(201);
      const memberId = (await added.json()).data.id;
      context = await browser.newContext({ baseURL: test.info().project.use.baseURL });
      const member = await context.newPage();
      await signIn(member, other.fixture);
      expect((await member.request.get(`/api/tasks/${task.id}?view=details`)).status()).toBe(404);
      const bytes = await require("sharp")({ create: { width: 2, height: 2, channels: 3, background: "red" } }).png().toBuffer();
      const upload = await page.request.post("/api/uploads/direct", {
        multipart: { taskId: task.id, files: { name: "synthetic.png", mimeType: "image/png", buffer: bytes } },
      });
      expect(upload.status()).toBe(201);
      const uploaded = (await upload.json()).data;
      expect(uploaded.count).toBe(1);
      expect(uploaded.uploaded).toHaveLength(1);
      const file = uploaded.uploaded[0];
      expect(file.url).toMatch(new RegExp(`^/api/tasks/${task.id}/files/[0-9a-f-]{36}$`));
      const fileId = file.url.split("/").pop();
      expect(fileId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      storedFile = path.join(root, "attachments/v1", createHash("sha256").update(task.id).digest("hex"), fileId);
      const ownerDownload = await page.request.get(file.url);
      expect(ownerDownload.status()).toBe(200);
      const storedBytes = await ownerDownload.body();
      expect(storedBytes.length).toBeGreaterThan(0);
      // Images may be normalized by the production validator. Compare the
      // actual stored object with both authenticated HTTP downloads.
      expect(await fs.readFile(storedFile)).toEqual(storedBytes);
      expect(ownerDownload.headers()["content-type"]).toBe("application/octet-stream");
      expect(ownerDownload.headers()["x-content-type-options"]).toBe("nosniff");
      expect(ownerDownload.headers()["content-disposition"]).toMatch(/^attachment;/);
      expect((await member.request.get(file.url)).status()).toBe(404);
      await project.setResponsibleGroupMember(other.fixture.userId, true);
      const memberDownload = await member.request.get(file.url);
      expect(memberDownload.status()).toBe(200);
      expect(await memberDownload.body()).toEqual(storedBytes);
      await page.reload();
      const detail = await page.request.get(`/api/tasks/${task.id}?view=details`);
      expect(detail.status()).toBe(200);
      expect((await detail.json()).data.attachments.filter(item => item.url === file.url)).toHaveLength(1);
      expect((await page.request.delete(`/api/projects/${project.projectId}/members/${memberId}`)).status()).toBe(204);
      expect((await member.request.get(file.url)).status()).toBe(200);
      expect((await member.request.get(`/api/tasks/${task.id}?view=details`)).status()).toBe(200);
      await project.setResponsibleGroupMember(other.fixture.userId, false);
      const denied = await member.request.get(file.url);
      expect(denied.status()).toBe(404);
      expect((await denied.json()).success).toBe(false);
      expect((await member.request.get(`/api/tasks/${task.id}?view=details`)).status()).toBe(404);
      expect((await page.request.get(file.url)).status()).toBe(200);
    } finally {
      const { runBestEffortCleanup } = require("./fixtures/isolated-project.cjs");
      await runBestEffortCleanup([
        { label: "close file member", run: async () => { await context?.close(); } },
        { label: "remove exact uploaded object", run: async () => { if (storedFile) await fs.unlink(storedFile); } },
        { label: "cleanup file member", run: () => other.cleanup() },
      ]);
    }
  });
});

// Actual file controls against the rebuilt app/socket and a dedicated local sink.
// Keep opt-in before fixtures: default suites must not create data merely to skip.
test.describe("#34 actual UI attachment acceptance", () => {
  test.skip(process.env.RUN_UI_ATTACHMENT_E2E !== "1", "Requires explicit local UI attachment runner, storage and socket");

  for (const surface of ["card", "chat"]) {
    test(`${surface} file selection uploads a marked request attachment and native download preserves SHA`, async ({ page, project }) => {
      const fs = require("node:fs/promises");
      const path = require("node:path");
      const { createHash, randomUUID } = require("node:crypto");
      const { loadPrismaClient, runBestEffortCleanup } = require("./fixtures/isolated-project.cjs");
      if (process.env.E2E_SOCKET !== "1" || process.env.ATTACHMENT_STORAGE !== "local") {
        throw Error("UI attachment acceptance requires the real socket and explicit local adapter");
      }
      const configured = process.env.E2E_ATTACHMENT_DIR || process.env.ATTACHMENT_LOCAL_DIR;
      if (!configured || !path.isAbsolute(configured)) throw Error("Explicit absolute isolated attachment directory required");
      const root = path.resolve(configured);
      const approved = [path.resolve(__dirname, "artifacts/storage"),
        path.resolve(__dirname, "../work/board-completion-20261024"),
        path.resolve(__dirname, "../../marked-content-storage")];
      if (!approved.some(directory => root === directory || root.startsWith(directory + path.sep))) {
        throw Error("UI attachment sink must stay within an existing isolated test-storage namespace");
      }
      if (process.env.ATTACHMENT_LOCAL_DIR && path.resolve(process.env.ATTACHMENT_LOCAL_DIR) !== root) {
        throw Error("Runner and server attachment directory settings must agree");
      }
      const sha = bytes => createHash("sha256").update(bytes).digest("hex");
      const filename = `ui-${surface}-${project.runId}.pdf`;
      const bytes = Buffer.from(`%PDF-1.4\n% isolated ${surface} ${project.runId}\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n`);
      const db = loadPrismaClient(process.env.E2E_DATABASE_URL);
      let taskId, taskDirectory, browserDownload;
      try {
        await project.configureLifecycle({ memberIds: [project.userId] });
        await project.openBoard(page);
        const task = await taskByTitle(page, project); taskId = task.id;
        const metadata = await page.request.get(`/api/tasks/${taskId}/lifecycle`);
        expect(metadata.status()).toBe(200);
        const snapshot = (await metadata.json()).data;
        // Setup only: the real canonical transition marks this exact fixture task.
        const submitted = await page.request.post(`/api/tasks/${taskId}`, {
          headers: { Origin: new URL(page.url()).origin },
          data: { action: "submit", expectedVersion: snapshot.version, operationId: randomUUID() },
        });
        expect(submitted.status()).toBe(200);
        expect((await db.taskRequest.findUniqueOrThrow({ where: { taskId } })).state).toBe("SUBMITTED");
        const before = await db.task.findUniqueOrThrow({ where: { id: taskId }, select: { version: true, columnId: true, status: true } });
        taskDirectory = path.join(root, "attachments", "v1", sha(taskId));
        await page.reload();
        await project.card(page, "Task A").getByText("Task A", { exact: true }).click();
        const panel = page.getByRole("dialog", { name: "Детали задачи", exact: true });
        await expect(panel).toBeVisible();
        let link;
        if (surface === "card") {
          const detailsRegion = panel.getByRole("region", { name: "Описание и свойства задачи", exact: true });
          const uploaded = page.waitForResponse(response => new URL(response.url()).pathname === "/api/uploads/direct" && response.request().method() === "POST");
          await detailsRegion.locator('input[type="file"]').setInputFiles({ name: filename, mimeType: "application/pdf", buffer: bytes });
          expect((await uploaded).status()).toBe(201);
          await expect(detailsRegion.getByRole("link", { name: filename, exact: true })).toBeVisible();
          link = detailsRegion.getByRole("link", { name: filename, exact: true });
        } else {
          const mobileChat = panel.getByRole("button", { name: "Чат", exact: true });
          if (await mobileChat.isVisible()) await mobileChat.click();
          const discussion = panel.getByRole("region", { name: "Обсуждение и история задачи", exact: true });
          const finalized = page.waitForResponse(response => new URL(response.url()).pathname === "/api/uploads/finalize" && response.request().method() === "POST");
          await discussion.getByLabel("Прикрепить файлы к сообщению", { exact: true })
            .setInputFiles({ name: filename, mimeType: "application/pdf", buffer: bytes });
          expect((await finalized).status()).toBe(201);
          const messageText = `Synthetic UI attachment ${project.runId}`;
          await discussion.getByRole("textbox", { name: "Сообщение", exact: true }).fill(messageText);
          const send = discussion.getByRole("button", { name: "Отправить сообщение", exact: true });
          await expect(send).toBeEnabled(); // Real socket membership is required.
          await send.click();
          await expect.poll(() => db.chatMessage.count({ where: { taskId, authorId: project.userId, contentText: messageText } })).toBe(1);
          await expect(discussion.getByText(messageText, { exact: true })).toBeVisible();
          link = discussion.getByRole("link", { name: `${filename} · 0 KB`, exact: true });
          const message = await db.chatMessage.findFirstOrThrow({ where: { taskId, contentText: messageText }, select: { attachments: true } });
          expect(message.attachments).toEqual([expect.objectContaining({ name: filename, mime: "application/pdf", size: bytes.length })]);
        }
        await expect(link).toBeVisible();
        const stored = await db.task.findUniqueOrThrow({ where: { id: taskId }, select: { attachments: true, version: true, columnId: true, status: true } });
        const files = stored.attachments.filter(file => file.name === filename);
        expect(files).toHaveLength(1);
        expect(files[0]).toMatchObject({ mime: "application/pdf", size: bytes.length });
        expect(files[0].url).toMatch(new RegExp(`^/api/tasks/${taskId}/files/[0-9a-f-]{36}$`));
        expect(await link.getAttribute("href")).toBe(files[0].url);
        expect(stored.version).toBeGreaterThan(before.version);
        expect(stored.columnId).toBe(before.columnId); expect(stored.status).toBe(before.status);
        expect((await db.taskRequest.findUniqueOrThrow({ where: { taskId } })).state).toBe("SUBMITTED");
        const downloadEvent = page.waitForEvent("download");
        await link.click();
        browserDownload = await downloadEvent;
        expect(await browserDownload.failure()).toBeNull();
        const downloadedPath = await browserDownload.path();
        expect(downloadedPath).not.toBeNull();
        expect(sha(await fs.readFile(downloadedPath))).toBe(sha(bytes));
        const fileId = files[0].url.split("/").at(-1);
        expect(fileId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        expect(sha(await fs.readFile(path.join(taskDirectory, fileId)))).toBe(sha(bytes));
      } finally {
        await runBestEffortCleanup([
          { label: "delete exact browser download", run: async () => { await browserDownload?.delete(); } },
          { label: "remove only exact synthetic task objects", run: async () => {
            if (!taskId || !taskDirectory) return;
            expect(await db.task.count({ where: { id: taskId, projectId: project.projectId,
              project: { description: `[${project.runMarker}] isolated browser fixture` } } })).toBe(1);
            // No recursive delete. Refuse any symlink in the explicit task path.
            let current = root;
            for (const part of ["", "attachments", "v1", sha(taskId)]) {
              if (part) current = path.join(current, part);
              try { const stat = await fs.lstat(current); if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error("Unsafe fixture storage path"); }
              catch (error) { if (error.code === "ENOENT") return; throw error; }
            }
            for (const fileId of await fs.readdir(taskDirectory)) {
              if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(fileId)) throw Error("Unexpected synthetic task storage object");
              const file = path.join(taskDirectory, fileId), stat = await fs.lstat(file);
              if (!stat.isFile() || stat.isSymbolicLink()) throw Error("Unsafe fixture storage object");
              await fs.unlink(file);
            }
            await fs.rmdir(taskDirectory);
          } },
          { label: "disconnect UI upload client", run: () => db.$disconnect() },
        ]);
      }
    });
  }
});
