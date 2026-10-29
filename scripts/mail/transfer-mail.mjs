#!/usr/bin/env node
import { readFile, writeFile, open, rename, unlink, realpath } from 'node:fs/promises';
import { resolve, dirname, basename, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { buildTransferPlan, simulateTransfer, rollbackTransfer, emptyTransferState } from './transfer-plan.mjs';
import { executeTransfer, executeRollback } from './transfer-executor.mjs';

const fail = code => { throw new Error(code); };
const root = fileURLToPath(new URL('../../', import.meta.url));

// Synthetic, local artifacts only. The source mailbox (.mail-work) is never read.
const permitted = path => {
  const rel = relative(root, path);
  return !rel.startsWith(`..${sep}`) && !rel.startsWith('..')
    && /^(scripts|tests)[\\/]mail[\\/]/i.test(rel)
    && !rel.split(/[\\/]/).some(segment => segment.toLowerCase() === '.mail-work');
};

async function checkedPath(value, { output = false } = {}) {
  if (!value) fail('MISSING_PATH');
  const path = resolve(value);
  if (!permitted(path)) fail('PATH_NOT_ALLOWED');
  let actual;
  try { actual = await realpath(path); }
  catch (error) {
    if (!output || error.code !== 'ENOENT') throw error;
    actual = resolve(await realpath(dirname(path)), basename(path));
  }
  if (!permitted(actual)) fail('PATH_NOT_ALLOWED');
  return actual;
}

const stripBom = value => value.replace(/^\uFEFF/, '');
const readJson = async path => JSON.parse(stripBom(await readFile(path, 'utf8')));
async function readMessages(path) {
  return stripBom(await readFile(path, 'utf8')).split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
}

async function atomicWrite(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temp, path);
  } finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

const help = `Offline transfer preview and ledger (only scripts/mail/** and tests/mail/**):
  preview --report report.json --config scope.json --out plan.json [--messages messages.ndjson] [--episodes episodes.json]
  simulate --plan plan.json --state simulation.json --batch BATCH --approve PLAN_SHA256
  rollback --state simulation.json --batch BATCH
  import --plan plan.json --batch BATCH --approve PLAN_SHA256 --enable-db-import
  rollback-import --batch BATCH --enable-db-import
Preview is a dry run and never writes a database. Simulation is local JSON, not a migration.
Database import additionally requires a trusted application adapter supplied programmatically.
The preview hash binds the approved plan; any change needs a new preview and approval.`;

const ARGUMENTS = {
  preview: ['report', 'config', 'out', 'messages', 'episodes'],
  simulate: ['plan', 'state', 'batch', 'approve'],
  rollback: ['state', 'batch'],
  import: ['plan', 'batch', 'approve', 'enable-db-import'],
  'rollback-import': ['batch', 'enable-db-import'],
};

export async function main(args, { adapter } = {}) {
  if (args.length === 1 && args[0] === '--help') { console.log(help); return; }
  const [command, ...rest] = args;
  const allowed = ARGUMENTS[command];
  if (!allowed) fail('INVALID_COMMAND');
  const database = command === 'import' || command === 'rollback-import';
  if (database && !rest.includes('--enable-db-import')) fail('DATABASE_IMPORT_DISABLED');

  const options = {};
  for (let index = 0; index < rest.length; index++) {
    const flag = rest[index];
    const key = flag.replace(/^--/, '');
    if (!flag.startsWith('--') || !allowed.includes(key) || Object.hasOwn(options, key)) fail('INVALID_ARGUMENTS');
    if (key === 'enable-db-import') { options[key] = true; continue; }
    const value = rest[index + 1];
    if (!value || value.startsWith('--')) fail('INVALID_ARGUMENTS');
    options[key] = value;
    index++;
  }

  if (database) {
    if (!options.batch || (command === 'import' && (!options.plan || !options.approve))) fail('INVALID_ARGUMENTS');
    if (!adapter || typeof adapter.transaction !== 'function') fail('APPLICATION_ADAPTER_REQUIRED');
    const result = command === 'import'
      ? await executeTransfer({
        plan: await readJson(await checkedPath(options.plan)), approval: options.approve,
        batch_id: options.batch, enabled: options['enable-db-import'], adapter,
      })
      : await executeRollback({ batch_id: options.batch, enabled: options['enable-db-import'], adapter });
    console.log(JSON.stringify(result));
    return;
  }

  if (command === 'preview') {
    if (!options.report || !options.config || !options.out) fail('INVALID_ARGUMENTS');
    const paths = Object.fromEntries(await Promise.all(['report', 'config', 'messages', 'episodes']
      .filter(key => options[key]).map(async key => [key, await checkedPath(options[key])])));
    const output = await checkedPath(options.out, { output: true });
    if (Object.values(paths).includes(output)) fail('INVALID_PREVIEW_PATHS');
    // Never overwrite an existing artifact: a changed preview gets a new filename.
    const reservation = await open(output, 'wx', 0o600);
    try {
      const plan = buildTransferPlan({
        report: await readJson(paths.report), config: await readJson(paths.config),
        messages: paths.messages ? await readMessages(paths.messages) : [],
        episodes: paths.episodes ? await readJson(paths.episodes) : undefined,
      });
      await reservation.writeFile(`${JSON.stringify(plan, null, 2)}\n`);
      console.log(JSON.stringify({ mode: 'dry-run', plan_sha256: plan.plan_sha256, counts: plan.counts }));
    } catch (error) {
      await reservation.close();
      await unlink(output).catch(() => {});
      throw error;
    } finally { await reservation.close(); }
    return;
  }

  if (!options.batch || !options.state || (command === 'simulate' && (!options.plan || !options.approve))) {
    fail('INVALID_ARGUMENTS');
  }
  const statePath = await checkedPath(options.state, { output: true });
  const planPath = command === 'simulate' ? await checkedPath(options.plan) : null;
  if (statePath === planPath) fail('INVALID_STATE_PATH');
  const lockPath = `${statePath}.lock`;
  const lock = await open(lockPath, 'wx', 0o600);
  try {
    let state;
    try { state = await readJson(statePath); }
    catch (error) {
      if (error.code === 'ENOENT' && command === 'simulate') state = emptyTransferState();
      else throw error;
    }
    const transition = command === 'simulate'
      ? simulateTransfer(await readJson(planPath), state, { batch_id: options.batch, approval: options.approve })
      : rollbackTransfer(state, options.batch);
    await atomicWrite(statePath, transition.state);
    console.log(JSON.stringify(transition.result));
  } finally {
    await lock.close();
    await unlink(lockPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    // Never print parser errors, source text, paths, credentials or arbitrary exceptions.
    const codes = new Set([
      'INVALID_REPORT', 'INVALID_TRANSFER_SCOPE', 'DUPLICATE_SELECTION', 'INVALID_REPORT_IDENTITY',
      'DUPLICATE_REPORT_IDENTITY', 'UNEXPECTED_SOURCE_MESSAGE', 'DUPLICATE_SOURCE_MESSAGE',
      'STALE_CLASSIFIED_REPORT', 'STALE_EPISODES', 'UNKNOWN_SELECTED_EPISODE', 'UNKNOWN_EPISODE_MESSAGE',
      'PREVIEW_APPROVAL_REQUIRED', 'SCOPE_NOT_CONFIRMED', 'INVALID_BATCH_ID', 'INVALID_SIMULATION_STATE',
      'BATCH_CONFLICT', 'NO_SELECTED_CARDS', 'SELECTED_CARDS_REQUIRE_REVIEW', 'IMPORTED_CARD_CONFLICT',
      'IMPORTED_MESSAGE_CONFLICT', 'UNKNOWN_BATCH', 'ROLLBACK_CONFLICT', 'BATCH_IN_USE', 'MISSING_PATH',
      'PATH_NOT_ALLOWED', 'INVALID_PREVIEW_PATHS', 'DATABASE_IMPORT_DISABLED', 'APPLICATION_ADAPTER_REQUIRED',
      'MISSING_IMPORTED_CARD_ID', 'INVALID_IMPORTED_CARD_ID', 'DUPLICATE_IMPORTED_CARD_ID',
      'INVALID_COMMAND', 'INVALID_ARGUMENTS', 'INVALID_STATE_PATH',
    ]);
    const code = codes.has(error?.message) ? error.message
      : error?.code === 'EEXIST' ? 'OUTPUT_OR_STATE_LOCK_EXISTS' : 'TRANSFER_FAILED';
    console.error(code);
    process.exitCode = 1;
  });
}
