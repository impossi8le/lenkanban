// @ts-check
const { createHash, randomBytes, randomUUID } = require("node:crypto");
const bcrypt = require("bcryptjs");
const { LONG_TITLE, FIXED_TIME } = require("./design-data.cjs");
const { test: base, expect } = require("@playwright/test");
const {
  parseTestDatabaseUrl,
} = require("./safety.cjs");

const RUN_MARKER_PREFIX = "kanban-e2e";
const MODERN_FLAG_VALUE = "true";
const LEGACY_FLAG_VALUE = "false";

function requestedDndV2Value() {
  const requested =
    process.env.E2E_DND_V2_ENABLED ?? MODERN_FLAG_VALUE;
  if (
    requested !== MODERN_FLAG_VALUE &&
    requested !== LEGACY_FLAG_VALUE
  ) {
    throw new Error(
      "E2E_DND_V2_ENABLED must be exactly true or false",
    );
  }
  if (
    requested === LEGACY_FLAG_VALUE &&
    process.env.E2E_ALLOW_LEGACY_FLAG_MUTATION !== "1"
  ) {
    throw new Error(
      "Legacy flag mutation requires E2E_ALLOW_LEGACY_FLAG_MUTATION=1",
    );
  }
  return requested === MODERN_FLAG_VALUE;
}

function loadPrismaClient(testDatabaseUrl) {
  const { url } = parseTestDatabaseUrl(testDatabaseUrl);
  process.env.DATABASE_URL = url;
  // Loading Prisma is intentionally delayed until after the _test guard.
  const { PrismaClient } = require("@prisma/client");
  return new PrismaClient();
}

function rank(sequence) {
  return `0|${String(sequence).padStart(20, "0")}`;
}

/**
 * @param {readonly { label: string, run: () => Promise<unknown> }[]} operations
 */
async function runBestEffortCleanup(operations) {
  const errors = [];
  for (const operation of operations) {
    try {
      await operation.run();
    } catch (error) {
      errors.push(
        new Error(`Cleanup operation "${operation.label}" failed`, {
          cause: error,
        }),
      );
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      "One or more isolated E2E cleanup operations failed",
    );
  }
}

/**
 * @param {import("@playwright/test").Page} page
 * @param {string} columnTitle
 */
function columnByTitle(page, columnTitle) {
  const escaped = columnTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return page.locator("[data-column-id]").filter({
    has: page.getByRole("heading", {
      name: new RegExp(`^${escaped}(?:\\s+\\d+)?$`),
    }),
  });
}

/**
 * @param {import("@playwright/test").Page} page
 * @param {string} title
 */
function cardByTitle(page, title) {
  return page
    .locator("[data-priority]")
    .filter({ hasText: title });
}

/**
 * @param {import("@playwright/test").Page} page
 * @param {import("@playwright/test").Locator} locator
 * @param {string} label
 */
async function visibleBox(page, locator, label) {
  try {
    await locator.scrollIntoViewIfNeeded();
  } catch (error) {
    // This action pins one ElementHandle during stability checks. A pending
    // move may replace it; one fresh Locator invocation resolves the new node.
    // Do not retry timeouts, ambiguous locators or any other action failure.
    if (!(error instanceof Error) ||
        !/^locator\.scrollIntoViewIfNeeded: Element is not attached to the DOM(?:\r?\n|$)/.test(error.message)) throw error;
    await locator.scrollIntoViewIfNeeded();
  }
  const box = await locator.boundingBox();
  const viewport = page.viewportSize();
  if (!box || !viewport) {
    throw new Error(`${label} has no viewport bounding box`);
  }

  const left = Math.max(0, box.x);
  const top = Math.max(0, box.y);
  const right = Math.min(viewport.width, box.x + box.width);
  const bottom = Math.min(viewport.height, box.y + box.height);
  if (right <= left || bottom <= top) {
    throw new Error(`${label} is outside the active viewport`);
  }

  return {
    box,
    viewport,
    visible: {
      bottom,
      left,
      right,
      top,
    },
  };
}

/**
 * @param {{ width: number, height: number }} viewport
 * @param {{ x: number, y: number }} point
 * @param {string} label
 */
function assertViewportPoint(viewport, point, label) {
  if (
    point.x < 0 ||
    point.x >= viewport.width ||
    point.y < 0 ||
    point.y >= viewport.height
  ) {
    throw new Error(
      `${label} (${point.x}, ${point.y}) is outside ${viewport.width}x${viewport.height}`,
    );
  }
}

/**
 * @param {import("@playwright/test").Page} page
 * @param {string} title
 * @param {boolean} dndV2Enabled
 */
async function startPointerDrag(page, title, dndV2Enabled) {
  const card = cardByTitle(page, title);
  const modernHandle = card.getByRole("button", {
    name: `Переместить задачу «${title}»`,
  });
  // A pending V2 move temporarily removes the handle. Wait for its real
  // enabled replacement instead of treating that transient absence as legacy.
  const dragSurface =
    dndV2Enabled || (await modernHandle.count()) > 0 ? modernHandle : card;
  if (dndV2Enabled || (await modernHandle.count()) > 0) {
    await expect(modernHandle).toBeEnabled();
  } else {
    await expect(card).toBeVisible();
  }
  const { visible, viewport } = await visibleBox(
    page,
    dragSurface,
    `Drag surface for "${title}"`,
  );
  const start = {
    x: visible.left + (visible.right - visible.left) / 2,
    y: visible.top + (visible.bottom - visible.top) / 2,
  };
  // DnD sorts the dragged card center, not the handle/pointer position.
  // Capture its pickup offset before activation replaces the card with feedback.
  const cardBox = await card.boundingBox();
  if (!cardBox) throw new Error("Drag card has no viewport bounding box");
  const centerOffset = {
    x: cardBox.x + cardBox.width / 2 - start.x,
    y: cardBox.y + cardBox.height / 2 - start.y,
  };
  const activated = {
    x: Math.min(viewport.width - 1, start.x + 10),
    y: Math.min(viewport.height - 1, start.y + 10),
  };
  assertViewportPoint(viewport, start, "Drag start");
  assertViewportPoint(viewport, activated, "Drag activation");
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(activated.x, activated.y, { steps: 4 });
  return centerOffset;
}

function visualUserId() {
  // Control synthetic visual input while retaining a fresh UUID's entropy.
  // Card's existing six-color ID palette uses the character sum; one ASCII
  // digit fixes its bucket without replacing actor identity or rendered CSS.
  const prefix = `e2e-visual-${randomUUID()}-`;
  const sum = Array.from(prefix).reduce((total, character) => total + character.charCodeAt(0), 0);
  return prefix + String((6 - sum % 6) % 6);
}

async function createIsolatedProject({ visual = false } = {}) {
  const { url } = parseTestDatabaseUrl(
    process.env.E2E_DATABASE_URL,
  );
  const dndV2Enabled = requestedDndV2Value();
  const prisma = loadPrismaClient(url);
  const runId = randomUUID();
  const runMarker = `${RUN_MARKER_PREFIX}:${runId}`;
  const email = `kanban-e2e+${runId}@example.invalid`;
  const password = randomBytes(24).toString("base64url");
  const projectName = visual ? "Синтетическая доска — обслуживание объектов" : `[${runMarker}] Надёжная доска`;
  const userName = visual ? "Тестовый участник" : `E2E ${runId}`;
  const passwordHash = await bcrypt.hash(password, 10);

  let userId = null;
  let projectId = null;
  let responsibleGroupId = null;
  /** @type {{contractVersion: number, submittedColumnId: string, inProgressColumnId: string, needsInfoColumnId: string, completedColumnId: string, closedColumnId: string} | null} */
  let lifecycleColumnMap = null;
  const cleanupExactRun = () =>
    runBestEffortCleanup([
      {
        label: "delete exact project lifecycle markers and receipts",
        run: async () => {
          if (!projectId) return;
          const owned = await prisma.project.findFirst({ where: { id: projectId, description: `[${runMarker}] isolated browser fixture` }, select: { id: true } });
          if (!owned) return;
          await prisma.taskCommandOperation.deleteMany({ where: { projectId } });
          await prisma.taskRequest.deleteMany({ where: { task: { projectId } } });
        },
      },
      {
        label: "delete exact project",
        run: async () => {
          if (!projectId) {
            return;
          }
          await prisma.project.deleteMany({
            where: {
              id: projectId,
              name: projectName,
              description: `[${runMarker}] isolated browser fixture`,
            },
          });
        },
      },
      {
        label: "delete exact fixture responsible group",
        run: async () => {
          if (responsibleGroupId) await prisma.responsibleGroup.deleteMany({ where: { id: responsibleGroupId, name: runMarker } });
        },
      },
      {
        label: "delete exact user",
        run: async () => {
          if (!userId) {
            return;
          }
          await prisma.user.deleteMany({
            where: {
              id: userId,
              email,
              name: userName,
            },
          });
        },
      },
      {
        label: "delete exact login rate limit",
        run: async () => {
          await prisma.rateLimit.deleteMany({
            where: { key: `auth:login:e2e-${runId}` },
          });
        },
      },
      {
        label: "disconnect Prisma",
        run: async () => {
          await prisma.$disconnect();
        },
      },
    ]);

  try {
    const user = await prisma.user.create({
      data: {
        ...(visual ? { id: visualUserId() } : {}),
        email,
        name: userName,
        passwordHash,
        emailVerified: visual ? new Date("2026-10-21T09:00:00Z") : new Date(),
      },
      select: { id: true },
    });
    userId = user.id;

    const project = await prisma.project.create({
      data: {
        name: projectName,
        description: `[${runMarker}] isolated browser fixture`,
        ownerId: user.id,
        dndV2Enabled,
        columns: {
          create: [
            {
              name: "К выполнению",
              color: "#2563eb",
              position: 0,
              workflowKey: "TODO",
            },
            {
              name: "В работе",
              color: "#d97706",
              position: 1,
              workflowKey: "IN_PROGRESS",
            },
            {
              name: "На проверке",
              color: "#7c3aed",
              position: 2,
              workflowKey: "REVIEW",
            },
            {
              name: "Готово",
              color: "#059669",
              position: 3,
              workflowKey: "DONE",
            },
          ],
        },
      },
      include: { columns: true },
    });
    projectId = project.id;

    const columns = Object.fromEntries(
      project.columns.map((column) => [column.workflowKey, column]),
    );
    const todoColumn = columns.TODO;
    const workColumn = columns.IN_PROGRESS;
    if (!todoColumn || !workColumn) {
      throw new Error("The isolated fixture did not create required columns");
    }

    await prisma.task.createMany({
      data: [
        {
          title: "Task A",
          description: visual ? "Синтетическое описание задачи для проверки вёрстки." : `[${runMarker}] LOW`,
          status: "TODO",
          priority: "LOW",
          position: 0,
          version: 0,
          rank: rank(1),
          projectId: project.id,
          columnId: todoColumn.id,
          createdById: user.id,
        },
        {
          title: visual ? LONG_TITLE : "Task B",
          description: visual ? "Синтетическое описание." : `[${runMarker}] MEDIUM`,
          status: "TODO",
          priority: "MEDIUM",
          position: 1024,
          version: 0,
          rank: rank(2),
          projectId: project.id,
          columnId: todoColumn.id,
          createdById: user.id,
        },
        {
          title: "Task C",
          description: visual ? "Синтетическое описание." : `[${runMarker}] HIGH`,
          status: "TODO",
          priority: "HIGH",
          position: 2048,
          version: 0,
          rank: rank(3),
          projectId: project.id,
          columnId: todoColumn.id,
          createdById: user.id,
        },
        {
          title: "Task D",
          description: visual ? "Синтетическое описание." : `[${runMarker}] URGENT`,
          status: "IN_PROGRESS",
          priority: "URGENT",
          position: 0,
          version: 0,
          rank: rank(1),
          projectId: project.id,
          columnId: workColumn.id,
          createdById: user.id,
        },
      ],
    });

    if (visual) {
      const rows = await prisma.task.findMany({ where: { projectId }, orderBy: { title: "asc" } });
      for (const [index, row] of rows.entries()) {
        // Unique internal IDs, stable displayed suffixes; never rewrite the DOM.
        await prisma.task.update({ where: { id: row.id }, data: {
          id: `${runId}-visual-000${index}`,
          createdAt: new Date(`2026-10-20T09:00:0${index}Z`),
          updatedAt: new Date("2026-10-21T09:00:00Z"),
          deadline: new Date("2026-10-23T09:00:00Z"),
        } });
        await prisma.taskAssignee.create({ data: { taskId: `${runId}-visual-000${index}`, userId } });
        if (row.title === "Task A") {
          await prisma.chatMessage.create({ data: {
            taskId: `${runId}-visual-000${index}`, authorId: userId,
            contentText: "Синтетическое обсуждение. " + LONG_TITLE,
            createdAt: new Date(FIXED_TIME),
          } });
        }
      }
    }

    const fixture = {
      runId,
      runMarker,
      email,
      password,
      userId: user.id,
      projectId: project.id,
      projectName,
      dndV2Enabled,
      columns: Object.fromEntries(
        project.columns.map((column) => [column.name, column.id]),
      ),
      get lifecycleColumnMap() { return lifecycleColumnMap; },
      get responsibleGroupId() { return responsibleGroupId; },

      /** Explicit test setup only. Existing DnD/visual fixtures retain their
       * four legacy columns until a lifecycle test opts in. No name guessing. */
      async configureLifecycle({ memberIds = [], leaderId = null } = {}) {
        if (responsibleGroupId || lifecycleColumnMap) throw new Error("Fixture lifecycle is already configured");
        const ids = [...new Set(memberIds)];
        if (leaderId !== null && !ids.includes(leaderId)) throw new Error("Fixture leader must be an explicit group member");
        const waitingId = randomUUID();
        const map = { contractVersion: 1, submittedColumnId: columns.TODO.id, inProgressColumnId: columns.IN_PROGRESS.id,
          needsInfoColumnId: waitingId, completedColumnId: columns.REVIEW.id, closedColumnId: columns.DONE.id };
        if (new Set(Object.values(map).filter(value => typeof value === "string")).size !== 5) throw new Error("Five distinct fixture lifecycle columns required");
        const group = await prisma.$transaction(async tx => {
          await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${project.id} FOR UPDATE`;
          const owned = await tx.project.findFirst({ where: { id: project.id, description: `[${runMarker}] isolated browser fixture` }, select: { id: true } });
          if (!owned) throw new Error("Fixture project ownership marker changed");
          if (await tx.user.count({ where: { id: { in: ids }, email: { endsWith: "@example.invalid" } } }) !== ids.length) throw new Error("Only explicit synthetic fixture users may join the group");
          // Free the two unique position slots using only exact fixture IDs.
          await tx.projectColumn.update({ where: { id: columns.DONE.id }, data: { position: 5 } });
          await tx.projectColumn.update({ where: { id: columns.REVIEW.id }, data: { position: 4 } });
          await tx.projectColumn.update({ where: { id: columns.REVIEW.id }, data: { position: 3 } });
          await tx.projectColumn.update({ where: { id: columns.DONE.id }, data: { position: 4 } });
          await tx.projectColumn.create({ data: { id: waitingId, projectId: project.id, name: "Ожидает ответа", color: "#b45309", position: 2, workflowKey: `COLUMN_${waitingId}` } });
          const group = await tx.responsibleGroup.create({ data: { name: runMarker, leaderId, members: { create: ids.map(userId => ({ userId })) } } });
          await tx.project.update({ where: { id: project.id }, data: { lifecycleColumnMap: map, responsibleGroupId: group.id } });
          return group;
        });
        responsibleGroupId = group.id; lifecycleColumnMap = map;
        fixture.columns["Ожидает ответа"] = waitingId;
        return { lifecycleColumnMap: map, responsibleGroupId: group.id };
      },

      /** Grant/revoke only on the group created for this exact synthetic run. */
      async setResponsibleGroupMember(memberId, member) {
        if (!responsibleGroupId) throw new Error("Configure the fixture lifecycle group first");
        const group = await prisma.responsibleGroup.findFirst({ where: { id: responsibleGroupId, name: runMarker, projects: { some: { id: project.id, description: `[${runMarker}] isolated browser fixture` } } }, select: { id: true } });
        if (!group || !await prisma.user.findFirst({ where: { id: memberId, email: { endsWith: "@example.invalid" } }, select: { id: true } })) throw new Error("Synthetic fixture group/user scope required");
        if (member) await prisma.responsibleGroupMember.createMany({ data: [{ groupId: group.id, userId: memberId }], skipDuplicates: true });
        else await prisma.responsibleGroupMember.deleteMany({ where: { groupId: group.id, userId: memberId } });
      },

      async openBoard(page) {
        await page.setExtraHTTPHeaders({
          "x-forwarded-for": `e2e-${runId}`,
          "x-kanban-e2e-run-id": runId,
        });
        // A click before hydration performs a native submit and the page reloads
        // back to /sign-in, so wait for React to attach to the form first. One
        // retry covers a cold compile; a real denial still fails the test.
        let submitted = false;
        page.setDefaultNavigationTimeout(120_000);
        for (let attempt = 0; attempt < 2 && !submitted; attempt += 1) {
          await page.goto("/sign-in", { waitUntil: "networkidle" });
          // The marker exists in most builds but not all; treat it as a hint so a
          // missing key cannot fail the run by itself.
          await page.waitForFunction(() => {
            const form = document.querySelector("form");
            return Boolean(form) && Object.keys(form).some(key => key.startsWith("__react"));
          }, null, { timeout: 15_000 }).catch(() => undefined);
          await page.getByLabel("Логин", { exact: true }).fill(email);
          await page.getByLabel("Пароль").fill(password);
          await page.getByRole("button", { name: "Войти" }).click();
          // Any authenticated route is a successful sign-in; the app lands on the
          // dashboard root, not necessarily on /projects.
          submitted = await page
            .waitForURL(url => !url.pathname.startsWith("/sign-in"), { timeout: 20_000 })
            .then(() => true)
            .catch(() => false);
          if (submitted) {
            const session = await page.request.get("/api/auth/session");
            const body = session.ok() ? await session.json() : null;
            submitted = body?.user?.email === email;
          }
        }
        if (!submitted) throw new Error(`E2E sign-in did not complete for ${email}`);
        await page.goto(`/projects/${project.id}/board`);
        await expect(
          page.getByRole("heading", { name: projectName }),
        ).toBeVisible({ timeout: 15_000 });
        await expect(
          page.getByRole("heading", { name: "Канбан-доска" }),
        ).toBeAttached();
        await expect(cardByTitle(page, "Task A")).toBeVisible({
          timeout: 15_000,
        });
      },

      column(page, title) {
        return columnByTitle(page, title);
      },

      card(page, title) {
        return cardByTitle(page, title);
      },

      async taskTitles(page, columnTitle) {
        return columnByTitle(page, columnTitle)
          .locator("[data-priority]")
          .evaluateAll((cards) =>
            cards.map((card) => {
              const title =
                card.querySelector(
                  'button[aria-label^="Открыть задачу"]',
                ) ??
                Array.from(card.querySelectorAll("p")).find(
                  (candidate) =>
                    candidate.classList.contains("font-bold") &&
                    candidate.classList.contains("text-sm"),
                );
              if (!title?.textContent) {
                throw new Error("Kanban card title is missing");
              }
              return title.textContent.trim();
            }),
          );
      },

      async dragTask(page, title, destination) {
        const centerOffset = await startPointerDrag(page, title, dndV2Enabled);
        const target = destination.before
          ? cardByTitle(page, destination.before)
          : columnByTitle(page, destination.column);
        const { visible, viewport } = await visibleBox(
          page,
          target,
          `Drop target in "${destination.column}"`,
        );
        const destinationPoint = {
          x: visible.left + (visible.right - visible.left) / 2 - centerOffset.x,
          y: (destination.before
            ? Math.min(visible.bottom - 1, visible.top + 12)
            : visible.top + (visible.bottom - visible.top) * 0.7) - centerOffset.y,
        };
        assertViewportPoint(
          viewport,
          destinationPoint,
          "Drag destination",
        );
        await page.mouse.move(destinationPoint.x, destinationPoint.y, {
          steps: 14,
        });
        await page.mouse.up();
      },

      async cancelDrag(page, title) {
        await startPointerDrag(page, title, dndV2Enabled);
        await page.keyboard.press("Escape");
        await page.mouse.up();
      },

      async dropOutside(page, title) {
        await startPointerDrag(page, title, dndV2Enabled);
        const viewport = page.viewportSize();
        if (!viewport) {
          throw new Error("Outside drop requires an active viewport");
        }
        const outsidePoint = { x: 2, y: 2 };
        assertViewportPoint(viewport, outsidePoint, "Outside drop");
        await page.mouse.move(outsidePoint.x, outsidePoint.y, {
          steps: 12,
        });
        await page.mouse.up();
      },

      async moveWithMenu(page, title, itemName) {
        const card = cardByTitle(page, title);
        const trigger = card.getByRole("button", {
          name: `Действия задачи «${title}»`,
        });
        await trigger.click();
        await page.getByRole("menuitem", { name: itemName }).click();
      },
    };

    return {
      fixture,
      cleanup: cleanupExactRun,
    };
  } catch (setupError) {
    try {
      await cleanupExactRun();
    } catch (cleanupError) {
      throw new AggregateError(
        [setupError, cleanupError],
        "Isolated E2E setup failed and cleanup also reported errors",
      );
    }
    throw setupError;
  }
}

/** @typedef {Awaited<ReturnType<typeof createIsolatedProject>>["fixture"]} IsolatedProjectFixture */

function loginRateLimitKey(email) {
  return createHash("sha256").update(email, "utf8").digest("hex").slice(0, 32);
}

/**
 * A registration identity has no pre-created user or project: the spec drives
 * `/sign-up`, `/verify-email` and `/sign-in` itself. Cleanup resolves the user
 * by the unique run email, so it also works when registration never happened.
 */
async function createRegistrationIdentity() {
  const { url } = parseTestDatabaseUrl(
    process.env.E2E_DATABASE_URL,
  );
  const prisma = loadPrismaClient(url);
  const runId = randomUUID();
  const runMarker = `${RUN_MARKER_PREFIX}:${runId}`;
  const email = `kanban-e2e+${runId}@example.invalid`;
  const password = randomBytes(24).toString("base64url");
  const name = `E2E registration ${runId}`;

  async function readUser() {
    return prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        emailVerified: true,
        verificationToken: true,
        globalRole: true,
      },
    });
  }

  const cleanup = () =>
    runBestEffortCleanup([
      {
        label: "delete projects owned by the registration run",
        run: async () => {
          const user = await prisma.user.findUnique({
            where: { email },
            select: { id: true },
          });
          if (!user) {
            return;
          }
          await prisma.project.deleteMany({ where: { ownerId: user.id } });
        },
      },
      {
        label: "delete exact registration user",
        run: async () => {
          await prisma.user.deleteMany({ where: { email, name } });
        },
      },
      {
        label: "delete registration rate limits",
        run: async () => {
          await prisma.rateLimit.deleteMany({
            where: {
              key: {
                in: [
                  `auth:register:e2e-${runId}`,
                  `auth:login:e2e-${runId}`,
                  `auth:login:email:${loginRateLimitKey(email)}`,
                ],
              },
            },
          });
        },
      },
      {
        label: "disconnect Prisma",
        run: async () => {
          await prisma.$disconnect();
        },
      },
    ]);

  const identity = {
    runId,
    runMarker,
    email,
    password,
    name,

    /** The verification token is read from the isolated database, never email. */
    async verificationToken() {
      const user = await readUser();
      return user?.verificationToken ?? null;
    },

    /** Registration never grants admin rights; the board UI requires ADMIN. */
    async promoteToAdmin() {
      const user = await readUser();
      if (!user) {
        throw new Error(
          "The registration identity does not exist yet",
        );
      }
      await prisma.user.update({
        where: { id: user.id },
        data: { globalRole: "ADMIN" },
      });
    },
  };

  return { identity, cleanup };
}

/** @typedef {Awaited<ReturnType<typeof createRegistrationIdentity>>["identity"]} RegistrationIdentityFixture */

/** @type {import("@playwright/test").TestType<import("@playwright/test").PlaywrightTestArgs & { project: IsolatedProjectFixture, registration: RegistrationIdentityFixture }, import("@playwright/test").PlaywrightWorkerArgs>} */
const test = base.extend(/** @type {any} */ ({
  project: async ({}, provideFixture) => {
    const isolated = await createIsolatedProject();
    try {
      await provideFixture(isolated.fixture);
    } finally {
      await isolated.cleanup();
    }
  },
  registration: async ({}, provideFixture) => {
    const isolated = await createRegistrationIdentity();
    try {
      await provideFixture(isolated.identity);
    } finally {
      await isolated.cleanup();
    }
  },
}));

module.exports = {
  createIsolatedProject,
  createRegistrationIdentity,
  expect,
  loadPrismaClient,
  runBestEffortCleanup,
  test,
  validateTestDatabaseUrl: parseTestDatabaseUrl,
};
