const { randomUUID, createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');
const { test, expect, taskByTitle, details } = require('./fixtures/regression.cjs');
const { createIsolatedProject, loadPrismaClient, runBestEffortCleanup } = require('./fixtures/isolated-project.cjs');

test.use({ trace: 'off', video: 'off', screenshot: 'off', storageState: { cookies: [], origins: [] } });
test.describe.configure({ timeout: 120_000 });
const optedIn = process.env.RUN_MARKED_CONTENT_E2E === '1';
test.skip(!optedIn, 'Requires the dedicated marked-content runner and approved isolated DB/storage');
if (optedIn) {
  const database = new URL(process.env.E2E_DATABASE_URL || 'invalid:');
  if (!['postgres:', 'postgresql:'].includes(database.protocol) || database.hostname !== '127.0.0.2' || database.port !== '55439' || decodeURIComponent(database.pathname) !== '/lenkanban_acceptance_test') {
    throw Error('Marked content requires the explicit approved isolated acceptance database');
  }
  storageRoot(); // Fail before Playwright can initialize any DB-backed project fixture.
}
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function privateTransport(run) {
  try { return await run(); }
  catch { throw Error('Synthetic login/upload transport failed; credential/capability details withheld'); }
}

async function lifecycle(page, taskId) {
  const response = await page.request.get(`/api/tasks/${taskId}/lifecycle`);
  expect(response.status()).toBe(200);
  return (await response.json()).data;
}
async function transition(page, taskId, action, extra = {}) {
  const current = await lifecycle(page, taskId);
  const response = await page.request.post(`/api/tasks/${taskId}`, { headers: { Origin: new URL(page.url()).origin },
    data: { action, expectedVersion: current.version, operationId: randomUUID(), ...extra } });
  expect(response.status()).toBe(200);
  return (await response.json()).data;
}
async function png() { return sharp({ create: { width: 8, height: 8, channels: 4, background: { r: 20, g: 90, b: 140, alpha: 1 } } }).png().toBuffer(); }
function storageRoot() {
  const directory = process.env.E2E_ATTACHMENT_DIR;
  if (!directory || !path.isAbsolute(directory)) throw Error('Dedicated managed E2E attachment directory required');
  const root = path.resolve(directory);
  // The dedicated candidate runner supplies storage outside the candidate tree.
  const approved = path.resolve(__dirname, '../../marked-content-storage');
  if (!root.startsWith(approved + path.sep)) throw Error('Only dedicated marked-content run storage is allowed');
  return root;
}
function taskDirectory(taskId) { return path.join(storageRoot(), 'attachments', 'v1', sha(taskId)); }
async function safeTaskDirectory(taskId) {
  const root = storageRoot(), target = taskDirectory(taskId);
  if (!target.startsWith(root + path.sep)) throw Error('Owned task storage boundary required');
  // Refuse symlink traversal before read/removal of the exact synthetic task directory.
  let current = root;
  for (const part of ['', 'attachments', 'v1', sha(taskId)]) {
    if (part) current = path.join(current, part);
    try { const stat = await fs.lstat(current); if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Unsafe task storage directory'); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  return target;
}
async function download(page, taskId, attachment) {
  const response = await page.request.get(attachment.url);
  expect(response.status()).toBe(200);
  const bytes = await response.body();
  const directory = await safeTaskDirectory(taskId);
  if (!directory) throw Error('Expected owned object directory');
  const fileId = attachment.url.split('/').at(-1);
  if (!/^[0-9a-f-]{36}$/.test(fileId)) throw Error('Canonical attachment file identifier required');
  const stored = await fs.readFile(path.join(directory, fileId));
  expect(sha(bytes)).toBe(sha(stored));
  const image = await sharp(bytes).metadata(); expect(image.format).toBe('png'); expect(image.width).toBe(8); expect(image.height).toBe(8);
  return sha(bytes);
}
async function setup({ page, browser, project, baseURL, withGroupReader = false }) {
  storageRoot();
  const db = loadPrismaClient(process.env.E2E_DATABASE_URL);
  const owned = [], contexts = []; let taskId;
  const cleanup = () => runBestEffortCleanup([
    { label: 'close exact participant browser contexts', run: async () => { for (const context of contexts) await context.close(); } },
    { label: 'delete exact run task storage and restricted lifecycle rows', run: async () => {
      if (!taskId) return;
      const own = await db.task.findFirst({ where: { id: taskId, projectId: project.projectId, project: { description: `[${project.runMarker}] isolated browser fixture` } }, select: { id: true } });
      if (!own) throw Error('Exact fixture task ownership required for cleanup');
      const directory = await safeTaskDirectory(taskId);
      if (directory) await fs.rm(directory, { recursive: true, force: true });
      await db.taskCommandOperation.deleteMany({ where: { taskId, projectId: project.projectId } });
      await db.taskRequest.deleteMany({ where: { taskId, task: { projectId: project.projectId } } });
      await db.taskWatcher.deleteMany({ where: { taskId } });
    } },
    ...[0, 1, 2].map(index => ({ label: `cleanup exact extra participant ${index}`, run: async () => { await owned[index]?.cleanup(); } })),
    { label: 'disconnect own fixture DB client', run: () => db.$disconnect() },
  ]);
  try {
    await privateTransport(() => project.openBoard(page));
    const task = await taskByTitle(page, project); taskId = task.id;
    for (let i = 0; i < (withGroupReader ? 3 : 2); i++) {
      const isolated = await createIsolatedProject(); owned.push(isolated);
      const context = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } }); contexts.push(context);
      const actor = await context.newPage(); await privateTransport(() => isolated.fixture.openBoard(actor));
    }
    const worker = contexts[0].pages()[0], watcher = contexts[1].pages()[0];
    const workerId = owned[0].fixture.userId, watcherId = owned[1].fixture.userId;
    const groupReader = withGroupReader ? contexts[2].pages()[0] : undefined;
    const groupReaderId = withGroupReader ? owned[2].fixture.userId : undefined;
    await project.configureLifecycle({ memberIds: [workerId, ...(groupReaderId ? [groupReaderId] : [])] });
    await transition(page, taskId, 'submit'); // Actual command creates TaskRequest.
    const added = await page.request.post(`/api/tasks/${taskId}/messages/watchers`, { data: { userId: watcherId } });
    expect(added.status()).toBe(201);
    expect(await db.projectMember.count({ where: { projectId: project.projectId, userId: watcherId } })).toBe(0);
    expect(await db.responsibleGroupMember.count({ where: { groupId: project.responsibleGroupId, userId: watcherId } })).toBe(0);
    if (groupReaderId) {
      expect(await db.projectMember.count({ where: { projectId: project.projectId, userId: groupReaderId } })).toBe(0);
      expect(await db.taskWatcher.count({ where: { taskId, userId: groupReaderId } })).toBe(0);
    }
    return { db, taskId, worker, watcher, workerId, watcherId, groupReader, groupReaderId, cleanup };
  } catch (error) { await cleanup(); throw error; }
}
async function businessSnapshot(db, taskId) {
  return {
    task: await db.task.findUniqueOrThrow({ where: { id: taskId } }),
    marker: await db.taskRequest.findUniqueOrThrow({ where: { taskId } }),
    activity: await db.activity.findMany({ where: { taskId }, orderBy: { id: 'asc' } }),
    receipts: await db.taskCommandOperation.findMany({ where: { taskId }, orderBy: { id: 'asc' } }),
  };
}
async function saveMarkedDescriptionThroughUi(page, project, f) {
  await page.reload();
  await project.card(page, 'Task A').getByText('Task A', { exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Детали задачи' });
  await expect(panel).toBeVisible();
  const editor = panel.getByRole('textbox', { name: 'Описание заявки', exact: true });
  await expect(editor).toHaveAttribute('contenteditable', 'true');
  const before = await businessSnapshot(f.db, f.taskId);
  const text = 'Synthetic marked description via real editor';
  const writes = [], target = `/api/tasks/${f.taskId}`;
  const observe = request => {
    const pathname = new URL(request.url()).pathname;
    if (['POST', 'PATCH'].includes(request.method()) && [target, `${target}/lifecycle`].includes(pathname)) {
      let action; try { action = request.postDataJSON()?.action; } catch { /* Non-command still recorded. */ }
      writes.push({ method: request.method(), pathname, action });
    }
  };
  page.on('request', observe);
  try {
    await editor.fill(text);
    const save = panel.getByRole('button', { name: 'Сохранить', exact: true });
    await expect(save).toBeEnabled();
    const response = page.waitForResponse(value => new URL(value.url()).pathname === target && value.request().method() === 'POST');
    await save.click();
    const saved = await response;
    expect(saved.status()).toBe(200);
    const command = saved.request().postDataJSON();
    expect(command.action).toBe('edit_description'); expect(command.expectedVersion).toBe(before.task.version);
    expect(command.operationId).toMatch(/^[0-9a-f-]{36}$/);
    const after = await businessSnapshot(f.db, f.taskId);
    expect(after.task.description).toBe(command.description); expect(after.task.description).toContain(text);
    expect(after.task.version).toBe(before.task.version + 1);
    expect(after.marker).toEqual(before.marker); expect(after.task.columnId).toBe(before.task.columnId); expect(after.task.status).toBe(before.task.status);
    expect(after.activity.filter(row => row.action === 'description_changed').length - before.activity.filter(row => row.action === 'description_changed').length).toBe(1);
    expect(writes).toEqual([{ method: 'POST', pathname: target, action: 'edit_description' }]);
    await expect(panel.getByRole('button', { name: 'Сохранено', exact: true })).toBeVisible();
    await panel.getByRole('button', { name: 'Закрыть', exact: true }).click();
    await expect(panel).not.toBeVisible();
  } finally { page.off('request', observe); }
}

test('#34/#65 marked author and task-only watcher upload survives clarification and CLOSED; revoked URLs deny', async ({ page, browser, project, baseURL }) => {
  const f = await setup({ page, browser, project, baseURL, withGroupReader: true });
  try {
    await transition(f.worker, f.taskId, 'take');
    await transition(f.worker, f.taskId, 'request_info', { reason: 'Synthetic marked attachment clarification' });
    await saveMarkedDescriptionThroughUi(page, project, f);
    const before = await businessSnapshot(f.db, f.taskId), uploaded = [];
    for (const actor of [page, f.watcher]) {
      const response = await actor.request.post('/api/uploads/direct', { multipart: { taskId: f.taskId,
        files: { name: 'synthetic.png', mimeType: 'image/png', buffer: await png() } } });
      expect(response.status()).toBe(201);
      const attachment = (await response.json()).data.uploaded[0]; uploaded.push(attachment);
      await download(actor, f.taskId, attachment);
    }
    const after = await businessSnapshot(f.db, f.taskId);
    expect(after.marker).toEqual(before.marker);
    expect(after.task.columnId).toBe(before.task.columnId); expect(after.task.status).toBe(before.task.status);
    expect(after.task.version).toBe(before.task.version + 2);
    expect(after.task.attachments).toEqual([...before.task.attachments, ...uploaded]);
    expect(after.activity.filter(row => row.action === 'attachment_added').length - before.activity.filter(row => row.action === 'attachment_added').length).toBe(2);
    expect(after.receipts).toEqual(before.receipts);
    await transition(page, f.taskId, 'answer_info', { response: { attachmentId: uploaded[0].url.split('/').at(-1) } });
    await transition(f.worker, f.taskId, 'complete'); await transition(f.worker, f.taskId, 'close');
    expect((await lifecycle(page, f.taskId)).state).toBe('CLOSED');
    const closedHash = await download(f.watcher, f.taskId, uploaded[0]);
    expect(await download(f.worker, f.taskId, uploaded[0])).toBe(closedHash);
    expect(await download(f.groupReader, f.taskId, uploaded[0])).toBe(closedHash);
    await f.db.taskWatcher.deleteMany({ where: { taskId: f.taskId, userId: f.watcherId } });
    expect((await f.watcher.request.get(uploaded[0].url)).status()).toBe(404);
    await project.setResponsibleGroupMember(f.groupReaderId, false);
    expect((await f.groupReader.request.get(uploaded[0].url)).status()).toBe(404);
    await project.setResponsibleGroupMember(f.workerId, false);
    expect((await f.db.taskRequest.findUniqueOrThrow({ where: { taskId: f.taskId } })).executorId).toBe(f.workerId);
    expect(await download(f.worker, f.taskId, uploaded[0])).toBe(closedHash);
    expect(await download(page, f.taskId, uploaded[0])).toBe(closedHash);
  } finally { await f.cleanup(); }
});

test('#34 marked presign-stage-finalize deduplicates and revoked staged watcher cannot commit', async ({ page, browser, project, baseURL }) => {
  const f = await setup({ page, browser, project, baseURL });
  try {
    const bytes = await png();
    const stage = async actor => {
      const response = await actor.request.post('/api/uploads/presign', { data: { taskId: f.taskId, filename: 'synthetic.png', mime: 'image/png', size: bytes.length } });
      expect(response.status()).toBe(201);
      const issued = (await response.json()).data;
      expect(issued.uploadUrl).toBe('/api/uploads/presign'); expect(issued.method).toBe('PUT');
      expect((await privateTransport(() => actor.request.put(issued.uploadUrl, { headers: issued.headers, data: bytes }))).status()).toBe(201);
      return issued.token; // Keep capability only in memory, never attach/print it.
    };
    const token = await stage(page), before = await businessSnapshot(f.db, f.taskId);
    const finalized = await privateTransport(() => page.request.post('/api/uploads/finalize', { data: { taskId: f.taskId, token } }));
    expect(finalized.status()).toBe(201);
    const attachment = (await finalized.json()).data.attachment;
    await download(page, f.taskId, attachment);
    const once = await businessSnapshot(f.db, f.taskId);
    expect(once.marker).toEqual(before.marker); expect(once.task.columnId).toBe(before.task.columnId); expect(once.task.status).toBe(before.task.status);
    expect(once.task.version).toBe(before.task.version + 1);
    expect(once.activity.length).toBe(before.activity.length + 1);
    expect(once.activity.filter(row => row.action === 'attachment_added').length - before.activity.filter(row => row.action === 'attachment_added').length).toBe(1);
    expect(once.receipts).toEqual(before.receipts); expect(once.task.attachments).toEqual([...before.task.attachments, attachment]);
    const replay = await privateTransport(() => page.request.post('/api/uploads/finalize', { data: { taskId: f.taskId, token } }));
    expect(replay.status()).toBe(200); expect((await replay.json()).data.created).toBe(false);
    expect(await businessSnapshot(f.db, f.taskId)).toEqual(once);
    const stagedToken = await stage(f.watcher);
    await f.db.taskWatcher.deleteMany({ where: { taskId: f.taskId, userId: f.watcherId } });
    const denied = await privateTransport(() => f.watcher.request.post('/api/uploads/finalize', { data: { taskId: f.taskId, token: stagedToken } }));
    expect(denied.status()).toBe(404);
    expect(await businessSnapshot(f.db, f.taskId)).toEqual(once);
  } finally { await f.cleanup(); }
});
