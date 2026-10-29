const { test, expect } = require('@playwright/test');
const { randomUUID } = require('node:crypto');

// Passwords and authenticated browser contents must not enter saved artifacts.
test.use({ trace: 'off', video: 'off', screenshot: 'off', storageState: { cookies: [], origins: [] } });

const PROJECT_ID = 'demo_project_1';
const BOARD = `/projects/${PROJECT_ID}/board`;
const DELIVERY_TIMEOUT = 30_000;

function password(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Required credential is missing: ${name}`);
  return value;
}

async function installNotifications(context) {
  await context.addInitScript(() => {
    window.__notes = [];
    class RecordedNotification {
      static permission = 'granted';
      static async requestPermission() { return 'granted'; }
      constructor(title, options = {}) {
        window.__notes.push({ title, options });
      }
      close() { this.onclose?.(); }
    }
    Object.defineProperty(window, 'Notification', {
      configurable: true, value: RecordedNotification,
    });
  });
}

// Observe the real personal-room ACK before triggering a notification. Waiting
// for the login redirect alone races the application's socket subscription.
function notificationRoom(page) {
  let joined = false;
  page.on('websocket', socket => {
    if (!new URL(socket.url()).pathname.startsWith('/socket.io')) return;
    const joins = new Set();
    socket.on('framesent', ({ payload }) => {
      const match = String(payload).match(/^42(\d+)\["notification:join"\]$/);
      if (match) joins.add(match[1]);
    });
    socket.on('framereceived', ({ payload }) => {
      const match = String(payload).match(/^43(\d+)(\[.*\])$/);
      if (match && joins.has(match[1])) {
        joined = JSON.parse(match[2])[0]?.ok === true;
      }
    });
    socket.on('close', () => { joined = false; });
  });
  return () => expect.poll(() => joined, {
    message: 'The real notification socket must join the authenticated personal room',
    timeout: DELIVERY_TIMEOUT,
  }).toBe(true);
}

async function signIn(page, email, secret) {
  // Clicking before hydration performs a native form submit and the page just
  // reloads back to /sign-in, so wait for the client bundle and a settled page.
  await page.goto('/sign-in', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => Boolean(document.querySelector('#email')), null, { timeout: 30_000 });
  // React must have attached its props before the click, otherwise the browser
  // performs a native submit and the page reloads back to /sign-in.
  await page.waitForFunction(() => {
    const form = document.querySelector('form');
    return Boolean(form) && Object.keys(form ?? {}).some(key => key.startsWith('__react'));
  }, null, { timeout: 30_000 });
  await page.getByLabel('Логин', { exact: true }).fill(email);
  await page.getByLabel(/^Пароль/).fill(secret);
  await expect(page.getByRole('button', { name: 'Войти', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page).toHaveURL(/\/projects(?:\/|$)/, { timeout: 30_000 });
  const response = await page.request.get('/api/auth/session');
  expect(response.status()).toBe(200);
  expect((await response.json()).user.email).toBe(email);
}

async function boardTasks(page) {
  const rows = [];
  // Traverse every board API page: absence on page 1 alone proves nothing.
  for (let number = 1; number <= 100; number += 1) {
    const response = await page.request.get(
      `/api/tasks?projectId=${PROJECT_ID}&page=${number}&limit=100`,
    );
    expect(response.status(), 'Board API must succeed, including for user2').toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    expect(typeof body.meta?.hasMore).toBe('boolean');
    rows.push(...body.data);
    if (!body.meta.hasMore) return rows;
  }
  throw new Error('Board pagination exceeded 100 pages; absence has not been proven');
}

async function expectDelivery(page, taskId, type, title) {
  let notification;
  await expect.poll(async () => {
    const response = await page.request.get('/api/notifications?limit=100');
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    notification = body.data.find(row => row.type === type && row.title === title
      && row.metadata?.taskId === taskId && row.metadata?.projectId === PROJECT_ID);
    return Boolean(notification);
  }, { message: `${type} must be delivered in-app for the created task`, timeout: DELIVERY_TIMEOUT }).toBe(true);
  expect(notification.id).toEqual(expect.any(String));
  // Correlate the constructor call with this exact persisted notification;
  // an old or unrelated system notification cannot satisfy the assertion.
  await expect.poll(() => page.evaluate(({ id, title }) =>
    window.__notes.some(note => note.title === title && note.options.tag === id),
  { id: notification.id, title }), {
    message: `${type} must also invoke window.Notification`, timeout: DELIVERY_TIMEOUT,
  }).toBe(true);
  expect(await page.evaluate(() => window.__notes.length)).toBeGreaterThan(0);
}

test('#89 пользователь создаёт заявку, поддержка уточняет, посторонний её не видит', async ({ browser, baseURL }) => {
  test.setTimeout(180_000);
  // No fallback credentials, generated seed users, database writes or servers.
  const credentials = {
    user: password('SEED_USER1_PASSWORD'),
    support: password('SEED_SUPPORT1_PASSWORD'),
    outsider: password('SEED_USER2_PASSWORD'),
  };
  expect(baseURL, 'A configured external application baseURL is required').toBeTruthy();
  const contexts = [];
  try {
    for (let index = 0; index < 3; index += 1) {
      const context = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
      contexts.push(context);
      await installNotifications(context);
    }
    const [user, support, outsider] = await Promise.all(contexts.map(context => context.newPage()));
    const userReady = notificationRoom(user);
    const supportReady = notificationRoom(support);
    const title = `E2E #89 ${randomUUID()}`;
    let taskId;

    await test.step('A и B входят в независимых контекстах и открывают доску', async () => {
      await signIn(user, 'user1@example.invalid', credentials.user);
      await signIn(support, 'support1@example.invalid', credentials.support);
      await user.goto(BOARD);
      await support.goto(BOARD);
      // Two controls share the accessible name: the header button and the
      // per-column add. Target the header one explicitly.
      await expect(user.locator('button[data-create-task="true"]')).toBeVisible();
      await expect(support.getByRole('button', { name: 'Уведомления', exact: true })).toBeEnabled();
      await userReady();
      await supportReady();
    });

    await test.step('A создаёт заявку через диалог', async () => {
      await user.locator('button[data-create-task="true"]').click();
      const dialog = user.getByRole('dialog', { name: 'Новая задача', exact: true });
      await expect(dialog).toBeVisible();
      await dialog.getByLabel('Название', { exact: true }).fill(title);
      await dialog.getByLabel('Описание', { exact: true }).fill('Синтетическая заявка для двухролевой проверки #89');
      const created = user.waitForResponse(response =>
        new URL(response.url()).pathname === '/api/tasks' && response.request().method() === 'POST');
      await dialog.getByRole('button', { name: 'Создать задачу', exact: true }).click();
      const response = await created;
      expect(response.status()).toBe(201);
      const body = await response.json();
      expect(body.success).toBe(true);
      taskId = body.data.id;
      expect(taskId).toEqual(expect.any(String));
      expect(taskId.length).toBeGreaterThan(0);
      await expect(dialog).toHaveCount(0);
      expect(await boardTasks(user)).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: taskId, title }),
      ]));
    });

    // A created task is a draft: the queue notification belongs to submission
    // (docs/REQUEST_LIFECYCLE.md: Черновик → Отправить → «На рассмотрении»).
    await test.step('A отправляет заявку в очередь', async () => {
      const details = await user.request.get(`/api/tasks/${taskId}?view=details`);
      expect(details.status()).toBe(200);
      const current = await details.json();
      // Mutations require a trusted Origin header (src/lib/mutation-origin.ts),
      // which a raw APIRequestContext does not send; issue the call from the page.
      const submit = await user.evaluate(async ({ id, version, operationId }) => {
        const response = await fetch(`/api/tasks/${id}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ operationId, expectedVersion: version, action: 'submit' }),
        });
        return { status: response.status, body: await response.text() };
      }, { id: taskId, version: current.data.version, operationId: randomUUID() });
      expect(submit.status).toBe(200);
      expect(JSON.parse(submit.body).success).toBe(true);
    });

    await test.step('B видит заявку и получает оба уведомления очереди', async () => {
      await expectDelivery(support, taskId, 'task_assigned', 'Заявка в очереди');
      expect(await boardTasks(support)).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: taskId, title }),
      ]));
      await support.reload();
      await expect(support.getByText(title, { exact: true })).toBeVisible();
    });

    await test.step('B публикует уточняющий комментарий из браузера', async () => {
      const result = await support.evaluate(async ({ taskId, clientId }) => {
        const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/messages`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clientId, contentText: 'Уточните, пожалуйста, условия возникновения проблемы.', visibility: 'PUBLIC' }),
        });
        return { status: response.status, body: await response.json() };
      }, { taskId, clientId: randomUUID() });
      expect(result.status).toBe(201);
      expect(result.body.success).toBe(true);
      expect(result.body.data.id).toEqual(expect.any(String));
    });

    await test.step('A получает chat_message внутри приложения и через Notification', async () => {
      await expectDelivery(user, taskId, 'chat_message', 'Новое сообщение в задаче');
    });

    await test.step('Третий независимый контекст user2 не получает чужую заявку в board API', async () => {
      await signIn(outsider, 'user2@example.invalid', credentials.outsider);
      await outsider.goto(BOARD);
      const rows = await boardTasks(outsider);
      expect(rows.some(row => row.id === taskId || row.title === title)).toBe(false);
      await expect(outsider.getByText(title, { exact: true })).toHaveCount(0);
    });
  } finally {
    await Promise.all(contexts.map(context => context.close()));
  }
});
