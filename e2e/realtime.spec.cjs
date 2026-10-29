const {
  test, expect, taskByTitle,
} = require("./fixtures/regression.cjs");
const { createIsolatedProject } = require("./fixtures/isolated-project.cjs");

// Cookies and chat text must not enter browser artifacts.
test.use({ trace: "off", screenshot: "off", video: "off" });

const SOCKET_OPT_IN =
  process.env.E2E_SOCKET === "1"
    ? null
    : "BLOCKED: realtime requires the separate Socket.IO process. Start it with " +
      "E2E_SOCKET=1, which adds src/socket/server.ts to the managed web servers " +
      "and points NEXT_PUBLIC_SOCKET_URL at the isolated origin. HTTP polling or " +
      "a reload would not prove realtime delivery.";

function chatHeader(panel) {
  // The header is the only element whose whole text is "Чат задачи" plus the
  // conditional " · офлайн" suffix; ancestors are excluded by the anchors.
  return panel
    .getByText(/^Чат задачи(?: · офлайн)?(?: \(.+\))?$/)
    .first();
}

function offlineState(panel) {
  return async () => {
    const header = chatHeader(panel);
    if ((await header.count()) === 0) return null;
    return (await header.innerText()).includes("офлайн");
  };
}

const socketFacts = new WeakMap();
const navigationFacts = new WeakMap();
function routeClass(rawUrl) {
  const pathname = new URL(rawUrl).pathname;
  if (/^\/projects\/[^/]+\/board\/?$/.test(pathname)) return "board";
  if (/^\/projects\/[^/]+\/tasks\/[^/]+\/?$/.test(pathname)) return "task";
  if (pathname === "/sign-in") return "sign-in";
  return "other";
}
function observeTaskNavigation(page) {
  const facts = { requests: [], bodyChecks: [], committedRouteClasses: [], pageErrorClasses: [], consoleErrorClasses: [] };
  const pending = new WeakMap();
  navigationFacts.set(page, facts);
  page.on("request", request => {
    const kind = routeClass(request.url());
    if (kind !== "task" && kind !== "board") return;
    const entry = { routeClass: kind, rsc: request.headers().rsc === "1", resourceType: request.resourceType(), status: 0, contentTypeClass: null, redirectHeaderPresent: false, finished: false, failed: false, failureClass: null, startedAt: Date.now(), elapsedMs: 0 };
    pending.set(request, entry);
    facts.requests.push(entry);
  });
  page.on("response", response => {
    const entry = pending.get(response.request());
    if (entry) {
      const headers = response.headers(), contentType = headers["content-type"] || "";
      entry.status = response.status();
      entry.contentTypeClass = contentType.includes("text/x-component") ? "RSC" : contentType.includes("text/html") ? "HTML" : contentType.includes("application/json") ? "JSON" : "Other";
      entry.redirectHeaderPresent = ["location", "x-nextjs-redirect", "x-action-redirect"].some(key => Object.hasOwn(headers, key));
    }
  });
  page.on("requestfinished", request => {
    const entry = pending.get(request);
    if (entry) {
      entry.finished = true; entry.elapsedMs = Date.now() - entry.startedAt;
      if (entry.routeClass === "task" && entry.rsc) facts.bodyChecks.push((async () => {
        try {
          const response = await request.response();
          const body = await response.text();
          entry.bodyFlags = { nextRedirect: body.includes("NEXT_REDIRECT"), unauthorized: /Unauthorized|NEXT_HTTP_ERROR_FALLBACK;401/.test(body), errorDigestPresent: /["']digest["']\s*:/.test(body) };
        } catch { entry.bodyUnavailable = true; }
      })());
    }
  });
  page.on("requestfailed", request => {
    const entry = pending.get(request);
    if (entry) {
      const failure = request.failure()?.errorText || "";
      entry.failureClass = failure.includes("ERR_ABORTED") ? "Aborted"
        : failure.includes("ERR_INCOMPLETE_CHUNKED_ENCODING") ? "IncompleteChunked"
        : failure.includes("ERR_CONTENT_DECODING_FAILED") ? "ContentDecoding"
        : /ERR_CONNECTION_(CLOSED|RESET)/.test(failure) ? "ConnectionClosed" : "OtherNetwork";
      entry.failed = true; entry.elapsedMs = Date.now() - entry.startedAt;
    }
  });
  page.on("framenavigated", frame => { if (frame === page.mainFrame() && facts.committedRouteClasses.length < 30) facts.committedRouteClasses.push(routeClass(frame.url())); });
  const classify = message => /ChunkLoadError|Loading chunk/i.test(message) ? "ChunkLoadError"
    : /hydration|hydrating|Minified React error #4(?:18|23|25)/i.test(message) ? "HydrationError"
    : /Minified React error|ReactServerComponents|Server Components render/i.test(message) ? "ReactRenderError" : "OtherError";
  page.on("pageerror", error => { if (facts.pageErrorClasses.length < 20) facts.pageErrorClasses.push(classify(error.message)); });
  page.on("console", message => { if (message.type() === "error" && facts.consoleErrorClasses.length < 20) facts.consoleErrorClasses.push(classify(message.text())); });
}

function observeSocketTransport(page) {
  observeTaskNavigation(page);
  const facts = { websocketPorts: [], namespaceErrors: [], pollingStatuses: [], websocketErrors: 0 };
  socketFacts.set(page, facts);
  page.on("websocket", socket => {
    const url = new URL(socket.url());
    if (url.pathname !== "/socket.io/") return;
    facts.websocketPorts.push(Number(url.port || (url.protocol === "wss:" ? 443 : 80)));
    socket.on("socketerror", () => { facts.websocketErrors++; });
    socket.on("framereceived", frame => {
      if (typeof frame.payload !== "string" || !frame.payload.startsWith("44")) return;
      let category = "OtherNamespaceError";
      try { if (JSON.parse(frame.payload.slice(2)).message === "Unauthorized") category = "Unauthorized"; } catch { /* No raw frame output. */ }
      facts.namespaceErrors.push(category);
    });
  });
  page.on("response", response => {
    if (new URL(response.url()).pathname === "/socket.io/") facts.pollingStatuses.push(response.status());
  });
}

async function diagnoseSocket(page) {
  let handshakeStatus = 0;
  try { handshakeStatus = (await page.request.get("http://127.0.0.1:3556/socket.io/?EIO=4&transport=polling", { timeout: 5_000 })).status(); } catch { /* Report status only. */ }
  const cookies = await page.context().cookies("http://127.0.0.1:3555");
  const cookie = cookies.map(item => `${item.name}=${item.value}`).join("; ");
  const nodeAuthentication = await new Promise(resolve => {
    const socket = require("socket.io-client").io("http://127.0.0.1:3556", {
      transports: ["websocket"], reconnection: false, timeout: 8_000,
      extraHeaders: { Cookie: cookie, Origin: "http://127.0.0.1:3555" },
    });
    const finish = category => { clearTimeout(timer); socket.disconnect(); resolve(category); };
    const timer = setTimeout(() => finish("Timeout"), 9_000);
    socket.once("connect", () => finish("Authenticated"));
    socket.once("connect_error", error => finish(error.message === "Unauthorized" ? "Unauthorized" : error.message === "timeout" ? "Timeout" : "TransportError"));
  });
  // Facts contain statuses/classes/port numbers only: no frames, bodies or cookies.
  console.info("Realtime socket setup facts", JSON.stringify({ handshakeStatus, nodeAuthentication, browser: socketFacts.get(page) }));
}

async function expectChatConnected(panel, page) {
  try { await expect.poll(offlineState(panel), { timeout: 30_000 }).toBe(false); }
  catch (error) { await diagnoseSocket(page); throw error; }
}

async function expectChatOffline(panel) {
  await expect.poll(offlineState(panel), { timeout: 30_000 }).toBe(true);
}

async function readOpenAccess(page, taskId, actorId) {
  try {
    const session = await page.request.get("/api/auth/session");
    const identity = await session.json();
    const task = await page.request.get(`/api/tasks/${taskId}?view=details`);
    return { sessionStatus: session.status(), expectedActor: identity.user?.id === actorId, taskStatus: task.status() };
  } catch {
    return { sessionStatus: 0, expectedActor: false, taskStatus: 0 };
  }
}

async function openChat(page, project, taskTitle, taskId, actorId) {
  const before = await readOpenAccess(page, taskId, actorId);
  expect(before, "Authenticated actor and task-read grant before opening chat").toEqual({ sessionStatus: 200, expectedActor: true, taskStatus: 200 });
  // The compact card uses its root open control when selection/drag controls
  // are hidden. Click the visible title in either accessible presentation.
  await project.card(page, taskTitle).getByText(taskTitle, { exact: true }).click();
  const panel = page.getByRole("dialog", { name: "Детали задачи", exact: true });
  try {
    // A cold dev intercepted RSC route compiles on its first navigation.
    // Keep the same required dialog; give server render a bounded deadline.
    await expect(panel).toBeVisible({ timeout: 25_000 });
  } catch (error) {
    const after = await readOpenAccess(page, taskId, actorId);
    // Safe setup diagnosis only: never emit cookies, bodies, URLs or actor IDs.
    console.info("Realtime openChat access after missing panel", JSON.stringify(after));
    const facts = navigationFacts.get(page);
    await Promise.allSettled(facts?.bodyChecks || []);
    const requests = facts?.requests.map(({ startedAt, ...entry }) => ({ ...entry, elapsedMs: entry.finished || entry.failed ? entry.elapsedMs : Date.now() - startedAt }));
    console.info("Realtime modal navigation facts", JSON.stringify({
      currentRouteClass: routeClass(page.url()), expectedTargetRouteClass: "task", requests,
      committedRouteClasses: facts?.committedRouteClasses,
      pageErrorClasses: facts?.pageErrorClasses, consoleErrorClasses: facts?.consoleErrorClasses,
      pendingOverlayTimedOut: await page.getByText("Загрузка занимает больше времени, чем обычно.", { exact: true }).isVisible(),
    }));
    throw error;
  }
  const sectionSwitch = panel.getByRole("group", {
    name: "Раздел карточки",
  });
  // Mobile layouts show one section at a time; desktop already renders chat.
  if (await sectionSwitch.isVisible()) {
    await sectionSwitch
      .getByRole("button", { name: "Чат", exact: true })
      .click();
  }
  await expect(panel.getByTestId("chat-composer")).toBeVisible();
  await expectChatConnected(panel, page);
  return panel;
}

async function sendChatMessage(panel, text) {
  await panel.getByLabel("Сообщение", { exact: true }).fill(text);
  const button = panel.getByRole("button", {
    name: "Отправить сообщение",
    exact: true,
  });
  await expect(button).toBeEnabled();
  await button.click();
  await expect(panel.getByText(text, { exact: true })).toBeVisible({
    timeout: 15_000,
  });
}

function messagesPath(taskId) {
  return `/api/tasks/${taskId}/messages`;
}

function countMessageFetches(page, taskId) {
  let count = 0;
  page.on("request", (request) => {
    if (
      request.method() === "GET" &&
      new URL(request.url()).pathname === messagesPath(taskId)
    ) {
      count++;
    }
  });
  return () => count;
}

async function signInAs(page, identity) {
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

test.describe("#91 two-client chat realtime and reconnect", () => {
  test.describe.configure({ timeout: 120_000 });

  test("group reader receives live messages, reconnects and loses access after group revocation", async ({
    page,
    browser,
    project,
  }) => {
    test.skip(Boolean(SOCKET_OPT_IN), SOCKET_OPT_IN);

    observeSocketTransport(page);
    await project.openBoard(page);
    await project.configureLifecycle();
    const task = await taskByTitle(page, project);
    const other = await createIsolatedProject();
    let otherContext;

    try {
      const added = await page.request.post(
        `/api/projects/${project.projectId}/members`,
        {
          headers: { Origin: new URL(page.url()).origin },
          data: { email: other.fixture.email, role: "MEMBER" },
        },
      );
      expect(added.status()).toBe(201);
      const memberId = (await added.json()).data.id;

      otherContext = await browser.newContext({
        baseURL: test.info().project.use.baseURL,
      });
      const otherPage = await otherContext.newPage();
      observeSocketTransport(otherPage);
      await signInAs(otherPage, other.fixture);
      // Board membership alone is not a task grant.
      expect((await otherPage.request.get(`/api/tasks/${task.id}?view=details`)).status()).toBe(404);
      await project.setResponsibleGroupMember(other.fixture.userId, true);
      expect((await otherPage.request.get(`/api/tasks/${task.id}?view=details`)).status()).toBe(200);
      await otherPage.goto(`/projects/${project.projectId}/board`);
      await expect(
        otherPage.getByRole("heading", {
          name: project.projectName,
          exact: true,
        }),
      ).toBeVisible({ timeout: 20_000 });

      const senderPanel = await openChat(page, project, "Task A", task.id, project.userId);
      const receiverPanel = await openChat(
        otherPage,
        other.fixture,
        "Task A",
        task.id,
        other.fixture.userId,
      );
      // Let the join catch-up snapshot finish before counting live deliveries.
      await otherPage.waitForLoadState("networkidle");
      await page.waitForLoadState("networkidle");
      // Group membership independently keeps this existing subscription valid.
      expect((await page.request.delete(`/api/projects/${project.projectId}/members/${memberId}`)).status()).toBe(204);
      expect((await otherPage.request.get(`/api/tasks/${task.id}?view=details`)).status()).toBe(200);

      const liveText = `Synthetic live ${project.runId}`;
      const fetchCount = countMessageFetches(otherPage, task.id);
      const fetchesBeforeLive = fetchCount();
      await sendChatMessage(senderPanel, liveText);
      await expect(
        receiverPanel.getByText(liveText, { exact: true }),
      ).toBeVisible({ timeout: 15_000 });
      // Realtime delivery, not a polling refetch: the receiving page issued no
      // additional message snapshot request while the message arrived.
      expect(fetchCount()).toBe(fetchesBeforeLive);

      // A real transport interruption: the browser context goes offline. The
      // synthetic "offline" event makes engine.io-client close its transport
      // immediately (its listener is registered for non-localhost hosts, and
      // the managed config uses 127.0.0.1) instead of waiting for the ping
      // timeout. Reconnection attempts then fail until connectivity returns.
      const receiverContext = otherPage.context();
      await receiverContext.setOffline(true);
      await otherPage.evaluate(() => {
        window.dispatchEvent(new Event("offline"));
      });
      await expectChatOffline(receiverPanel);

      const missedText = `Synthetic missed ${project.runId}`;
      await sendChatMessage(senderPanel, missedText);
      await expect(
        receiverPanel.getByText(missedText, { exact: true }),
      ).toHaveCount(0);

      await receiverContext.setOffline(false);
      await otherPage.evaluate(() => {
        // Some engine.io-client versions listen for "online"; others rely on
        // the manager retry loop, which is why the assertion waits up to 30s.
        window.dispatchEvent(new Event("online"));
      });
      await expectChatConnected(receiverPanel, otherPage);
      // Rejoin triggers the catch-up snapshot; the missed message appears
      // without a manual reload.
      await expect(
        receiverPanel.getByText(missedText, { exact: true }),
      ).toBeVisible({ timeout: 20_000 });
      expect(fetchCount()).toBeGreaterThan(fetchesBeforeLive);

      // Exactly one persisted row per message: reconnect must not duplicate.
      const persisted = await otherPage.request.get(
        `${messagesPath(task.id)}?limit=50`,
      );
      expect(persisted.status()).toBe(200);
      const items = (await persisted.json()).data.items;
      for (const text of [liveText, missedText]) {
        expect(
          items.filter((message) => message.contentText === text).length,
        ).toBe(1);
      }
      await expect(
        receiverPanel.getByText(liveText, { exact: true }),
      ).toHaveCount(1);
      await expect(
        receiverPanel.getByText(missedText, { exact: true }),
      ).toHaveCount(1);

      await project.setResponsibleGroupMember(other.fixture.userId, false);
      for (const url of [`/api/tasks/${task.id}?view=details`, messagesPath(task.id)]) {
        expect((await otherPage.request.get(url)).status()).toBe(404);
      }
      // The real server sweep/fanout emits auth.revoked; the client clears
      // protected caches and navigates away. No manual reload triggers this.
      await expect(otherPage).toHaveURL(/\/projects\/?$/, { timeout: 20_000 });
      await expect(otherPage.getByText(liveText, { exact: true })).toHaveCount(0);
      await expect(otherPage.getByText(missedText, { exact: true })).toHaveCount(0);
      const revokedText = `Synthetic denied after revocation ${project.runId}`;
      await sendChatMessage(senderPanel, revokedText);
      await expect(otherPage.getByText(revokedText, { exact: true })).toHaveCount(0);
      expect((await otherPage.request.post(messagesPath(task.id), {
        data: { contentText: "Synthetic rejected after group revocation" },
      })).status()).toBe(404);
    } finally {
      try {
        await otherContext?.close();
      } finally {
        await other.cleanup();
      }
    }
  });
});
