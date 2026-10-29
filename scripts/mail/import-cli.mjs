import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { createPrismaTransferAdapter } from './prisma-adapter.mjs';
import { executeTransfer, executeRollback } from './transfer-executor.mjs';

const codes = new Set([
  'FORBIDDEN', 'INVALID_BATCH_ID', 'PREVIEW_APPROVAL_REQUIRED', 'SCOPE_NOT_CONFIRMED',
  'NO_SELECTED_CARDS', 'SELECTED_CARDS_REQUIRE_REVIEW', 'BATCH_CONFLICT', 'BATCH_IN_USE',
  'IMPORTED_CARD_CONFLICT', 'IMPORTED_MESSAGE_CONFLICT', 'IMPORTED_CARD_CHANGED',
  'UNKNOWN_BATCH', 'ROLLBACK_CONFLICT', 'INVALID_IMPORTED_CARD', 'INVALID_IMPORT_TARGET',
  'INVALID_IMPORTED_MESSAGE', 'INVALID_IMPORTED_AUTHOR', 'ATTACHMENT_IMPORT_UNSUPPORTED',
]);

/** Actor identity comes from the trusted local operator, never from the plan.
 * Usage: npx.cmd tsx scripts/mail/import-cli.mjs PLAN --approve SHA256
 *   --actor USER_ID --batch BATCH_ID [--rollback]
 * Plain node is also supported. No default approval, actor or batch is inferred.
 */
export async function runImportCli(args, makePrisma = () => new PrismaClient({ log: [] })) {
  let prisma;
  try {
    const [file, ...flags] = args;
    if (!file || file.startsWith('--')) throw Error('CLI_ARGUMENTS_REQUIRED');
    const options = {};
    for (let index = 0; index < flags.length; index++) {
      const flag = flags[index];
      if (!['--approve', '--actor', '--batch', '--rollback'].includes(flag) || Object.hasOwn(options, flag)) throw Error('CLI_ARGUMENTS_REQUIRED');
      options[flag] = flag === '--rollback' ? true : flags[++index];
      if (options[flag] !== true && (!options[flag] || options[flag].startsWith('--'))) throw Error('CLI_ARGUMENTS_REQUIRED');
    }
    if (!options['--actor'] || !options['--batch'] || !/^[a-f0-9]{64}$/.test(options['--approve'] ?? '')) throw Error('CLI_ARGUMENTS_REQUIRED');
    const plan = JSON.parse(await readFile(file, 'utf8'));
    // Approval is also required for destructive rollback of this exact preview.
    const { verifyPlan } = await import('./transfer-plan.mjs');
    verifyPlan(plan, options['--approve']);
    prisma = makePrisma();
    const adapter = createPrismaTransferAdapter({ prisma, actorId: options['--actor'] });
    const input = { plan, approval: options['--approve'], batch_id: options['--batch'], adapter, enabled: true };
    if (options['--rollback']) {
      // Bind rollback to the supplied preview, not just an operator-typed batch ID.
      const transaction = adapter.transaction;
      adapter.transaction = fn => transaction(async tx => {
        await tx.authorizeTransfer({ operation: 'rollback', batch_id: input.batch_id });
        const state = await tx.loadTransferState();
        if (state?.batches?.[input.batch_id]?.plan_sha256 !== plan.plan_sha256) throw Error('BATCH_CONFLICT');
        return fn(tx);
      });
    }
    const result = options['--rollback'] ? await executeRollback(input) : await executeTransfer(input);
    return { code: result.status.toUpperCase(), created: result.created ?? 0, reused: result.reused ?? 0, removed: result.removed ?? 0 };
  } catch (error) {
    const code = error?.message === 'CLI_ARGUMENTS_REQUIRED' || codes.has(error?.message) ? error.message : 'IMPORT_FAILED';
    return { code };
  } finally {
    if (prisma) await prisma.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // No raw exception, filenames, database URL, actor ID or message content.
  runImportCli(process.argv.slice(2)).then(result => {
    console.log(JSON.stringify(result));
    if (!['APPLIED', 'ALREADY_APPLIED', 'ROLLED_BACK', 'ALREADY_ROLLED_BACK'].includes(result.code)) process.exitCode = 1;
  }).catch(() => {
    console.log(JSON.stringify({ code: 'IMPORT_FAILED' }));
    process.exitCode = 1;
  });
}
