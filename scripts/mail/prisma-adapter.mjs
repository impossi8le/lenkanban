import { fileURLToPath } from 'node:url';
import { register } from 'node:module';
import { digest } from './transfer-plan.mjs';

const STATE_ID = 'mail-import';
const fail = code => { throw new Error(code); };
const include = {
  messages: { orderBy: { id: 'asc' } }, activities: { orderBy: { id: 'asc' } },
  tags: { orderBy: { id: 'asc' } }, assignees: { orderBy: { id: 'asc' } },
  checklistItems: { orderBy: { id: 'asc' } }, watchers: { orderBy: { id: 'asc' } },
  moveOperations: { orderBy: { id: 'asc' } }, request: true, recurringOccurrence: true,
};
const fingerprint = task => digest(JSON.parse(JSON.stringify(task)));

let modulesPromise;
const creationModules = () => modulesPromise ??= loadCreationModules();

// Load the same creation port as the HTTP API. Node runs hooks last-in-first-out:
// the alias hook must rewrite URLs before tsx infers extensions and formats.
async function loadCreationModules() {
  const { register: registerTsx, tsImport } = await import('tsx/esm/api');
  const tsconfig = fileURLToPath(new URL('../../tsconfig.json', import.meta.url));
  registerTsx({ tsconfig });
  register('./app-alias-loader.mjs', import.meta.url);
  const load = async path => {
    const loaded = await tsImport(path, { parentURL: import.meta.url, tsconfig });
    return loaded.default ?? loaded;
  };
  const [port, rank, workflow, policy] = await Promise.all([
    load('../../src/features/kanban/server/task-creation-port.ts'),
    load('../../src/features/kanban/rank/rank-service.ts'),
    load('../../src/features/kanban/server/move-contract.ts'),
    load('../../src/lib/access-policy.ts'),
  ]);
  return { ...port, ...rank, ...workflow, ...policy };
}

/** One system-wide ledger row (mail-import), independent of execution batch IDs.
 * Its transaction advisory lock serializes ledger transitions and importKey
 * lookups; the unique Task index is the final database duplicate barrier.
 * All methods require authorizeTransfer in the same transaction. No logging.
 */
export function createPrismaTransferAdapter({ prisma, actorId }) {
  return {
    transaction(fn) {
      return prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${STATE_ID}, 0))::text AS locked`;
        let authorizedBatch;
        let originalState;
        const receipts = new Map();
        const authorized = batch => {
          if (!authorizedBatch || (batch !== undefined && batch !== authorizedBatch)) fail('FORBIDDEN');
        };
        const checkAdmin = async () => {
          if (typeof actorId !== 'string' || !actorId) fail('FORBIDDEN');
          const actor = await tx.user.findUnique({ where: { id: actorId }, select: { id: true, globalRole: true, isBlocked: true } });
          if (!actor || actor.id !== actorId || actor.globalRole !== 'ADMIN' || actor.isBlocked) fail('FORBIDDEN');
        };
        const readTask = key => tx.task.findUnique({ where: { importKey: key }, include });
        return fn({
          async authorizeTransfer({ operation, batch_id, plan }) {
            if (!['import', 'rollback'].includes(operation) || !/^[a-zA-Z0-9_-]{1,64}$/.test(batch_id ?? '')) fail('INVALID_BATCH_ID');
            await checkAdmin();
            // Match the HTTP creation port's Project -> Column -> Task -> User
            // order, including replay. Lock all selected resources before the
            // actor so append maintenance never acquires Task locks after User.
            let projectIds;
            if (operation === 'import') {
              projectIds = (plan?.cards ?? []).filter(card => card.selected).map(card => card.board_id);
            } else {
              const row = await tx.mailImportBatch.findUnique({ where: { batchId: STATE_ID } });
              const batch = row?.state?.batches?.[batch_id];
              const importKeys = batch?.created ?? [];
              const targets = importKeys.length ? await tx.task.findMany({ where: { importKey: { in: importKeys } }, select: { projectId: true } }) : [];
              projectIds = targets.map(task => task.projectId);
            }
            for (const projectId of [...new Set(projectIds)].sort()) {
              if (typeof projectId !== 'string' || !projectId) fail('INVALID_IMPORT_TARGET');
              await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${projectId} FOR UPDATE`;
              await tx.$queryRaw`SELECT "id" FROM "ProjectColumn" WHERE "projectId" = ${projectId} ORDER BY "id" FOR UPDATE`;
              await tx.$queryRaw`SELECT "id" FROM "Task" WHERE "projectId" = ${projectId} ORDER BY "id" FOR UPDATE`;
            }
            await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${actorId} FOR SHARE`;
            await checkAdmin();
            authorizedBatch = batch_id;
          },
          async loadTransferState() {
            authorized();
            const row = await tx.mailImportBatch.findUnique({ where: { batchId: STATE_ID } });
            originalState = row?.state;
            return originalState == null ? null : structuredClone(originalState);
          },
          async saveTransferState(state) {
            authorized();
            const saved = structuredClone(state);
            for (const [key, receipt] of receipts) {
              if (!saved.cards[key] || saved.cards[key].batch_id !== authorizedBatch) fail('IMPORTED_CARD_CHANGED');
              // Capture at the end: append-rank maintenance for later cards can
              // legitimately change earlier cards inside this transaction.
              saved.cards[key].prisma_receipt = { ...receipt, fingerprint: fingerprint(await readTask(key)) };
            }
            await tx.mailImportBatch.upsert({
              where: { batchId: STATE_ID },
              create: { batchId: STATE_ID, createdBy: actorId, state: saved },
              update: { state: saved },
            });
          },
          async createImportedCard({ import_key, batch_id, payload }) {
            authorized(batch_id);
            const existing = await tx.task.findUnique({ where: { importKey: import_key }, select: { id: true } });
            if (existing) return existing.id;
            if (!payload || typeof payload.board_id !== 'string' || typeof payload.title !== 'string'
              || !payload.title.trim() || !Array.isArray(payload.messages)) fail('INVALID_IMPORTED_CARD');
            // Attachment ACLs cannot be inferred from source URLs. Reject rather
            // than publish an internal attachment through ordinary Task fields.
            if (payload.messages.some(message => !Array.isArray(message.attachments) || message.attachments.length)) fail('ATTACHMENT_IMPORT_UNSUPPORTED');
            const column = await tx.projectColumn.findFirst({
              where: { projectId: payload.board_id }, orderBy: [{ position: 'asc' }, { id: 'asc' }], select: { id: true },
            });
            if (!column) fail('INVALID_IMPORT_TARGET');
            const { prepareLegacyTaskCreation, createBase36RankService, derivedTaskStatus, ownTaskProjectIds } = await creationModules();
            const prepared = await prepareLegacyTaskCreation(tx, createBase36RankService(), {
              actorId, projectId: payload.board_id, columnId: column.id,
            });
            // The creation port holds the actor SHARE lock. Recheck ADMIN after
            // acquiring resource locks, following the application's lock order.
            await checkAdmin();
            const last = await tx.task.findFirst({ where: { projectId: payload.board_id, columnId: column.id }, orderBy: { position: 'desc' }, select: { position: true } });
            const task = await tx.task.create({ data: {
              importKey: import_key, title: payload.title, projectId: payload.board_id,
              columnId: column.id, rank: prepared.rank, position: (last?.position ?? 0) + 1024,
              status: derivedTaskStatus(prepared.column.workflowKey), createdById: actorId,
            } });
            if (ownTaskProjectIds(process.env.LENKANBAN_OWN_TASK_PROJECT_IDS).includes(payload.board_id)) {
              await tx.taskRequest.create({ data: { taskId: task.id, contractVersion: 1, state: 'DRAFT', authorId: actorId } });
            }
            // Preserve mapped source authors and times, without fabricating a
            // user or converting source links into downloadable attachments.
            for (const message of payload.messages) {
              if (typeof message.author_id !== 'string' || typeof message.body_text !== 'string'
                || !message.sent_at || !Number.isFinite(Date.parse(message.sent_at))) fail('INVALID_IMPORTED_MESSAGE');
              const author = await tx.user.findUnique({ where: { id: message.author_id }, select: { id: true } });
              if (!author) fail('INVALID_IMPORTED_AUTHOR');
              await tx.chatMessage.create({ data: {
                taskId: task.id, authorId: author.id, contentText: message.body_text,
                createdAt: new Date(message.sent_at),
              } });
            }
            await tx.activity.create({ data: { taskId: task.id, userId: actorId, action: 'created' } });
            receipts.set(import_key, { task_id: task.id, batch_id, actor_id: actorId });
            return task.id;
          },
          async deleteImportedCard({ import_key, batch_id }) {
            authorized(batch_id);
            const stored = originalState?.cards?.[import_key];
            const receipt = stored?.prisma_receipt;
            if (stored?.batch_id !== batch_id || receipt?.batch_id !== batch_id || !receipt.task_id) fail('IMPORTED_CARD_CHANGED');
            // Follow resource-before-actor ordering. Task FOR UPDATE also blocks
            // concurrent child inserts (FK KEY SHARE); SERIALIZABLE detects
            // concurrent child edits/deletes after the snapshot was read.
            await tx.$queryRaw`SELECT "id" FROM "Task" WHERE "importKey" = ${import_key} FOR UPDATE`;
            await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${actorId} FOR SHARE`;
            await checkAdmin();
            const task = await readTask(import_key);
            if (!task || task.id !== receipt.task_id || task.createdById !== receipt.actor_id
              || fingerprint(task) !== receipt.fingerprint) fail('IMPORTED_CARD_CHANGED');
            await tx.task.delete({ where: { importKey: import_key } });
          },
        });
      }, { isolationLevel: 'Serializable', timeout: 60_000 });
    },
  };
}
