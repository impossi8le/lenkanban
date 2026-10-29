import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, realpath } from 'node:fs/promises';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const cli = fileURLToPath(new URL('./inventory.mjs', import.meta.url));

async function fixture(t) {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), 'release-inventory-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  async function file(relative, value = 'synthetic fixture') {
    const destination = path.join(root, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, value);
  }
  return { root, file };
}

function run(root, extra = []) {
  return spawnSync(process.execPath, [cli, '--root', root, ...extra], { encoding: 'utf8' });
}

function inventory(result) {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

async function linkOrSkip(t, target, destination, type) {
  try { await symlink(target, destination, type); return true; }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP', 'ENOSYS'].includes(error.code)) {
      t.skip(`Host cannot create test symlink (${error.code})`);
      return false;
    }
    throw error;
  }
}

test('emits deterministic metadata-only candidates and explicit publication limitations', async t => {
  const f = await fixture(t);
  for (const name of ['package.json', 'package-lock.json', 'server.js', 'next.config.ts', 'tsconfig.json',
    'src/z.ts', 'src/a.tsx', 'public/icon.svg', 'prisma/schema.prisma',
    'prisma/migrations/20260101_init/migration.sql', 'e2e/basic.spec.ts', 'scripts/release/example.mjs']) {
    await f.file(name);
  }
  await mkdir(path.join(f.root, '.git'));
  const output = inventory(run(f.root));
  assert.equal(output.schemaVersion, 1);
  assert.equal(output.rootHasGit, true);
  assert.equal(output.complete, true);
  assert.equal(output.readyForPublication, false);
  assert.equal(output.contentReview, 'not-performed');
  assert.equal(output.integrity, 'metadata-only');
  assert.equal(output.candidates.length, 12);
  assert.deepEqual(output.candidates.map(item => item.path), output.candidates.map(item => item.path).sort());
  assert.equal(output.candidates.find(item => item.path === 'src/a.tsx').bytes, 17);
  assert(output.candidates.every(item => !('hash' in item) && !('content' in item)));
  assert.deepEqual(inventory(run(f.root)).candidates, output.candidates);
  const inventoryModule = await import('./inventory.mjs');
  assert.deepEqual((await inventoryModule.scanReleaseInventory(f.root)).candidates, output.candidates);
});

test('default-deny roots and nested secret/runtime/access paths precede extension allowlists', async t => {
  const f = await fixture(t);
  const denied = ['unknown.js', '.env', '.env.production', 'credentials.json',
    'Taskboard-taskboard.lenremontn8n.ru/connect.ps1', 'docs/source.md', 'work/secret.json',
    'outputs/source.ts', 'scripts/mail/private.mjs', 'lenkanban/src/main.ts',
    'src/.ENV.local', 'src/credentials.json', 'src/private-key.json', 'src/keys/looks-like-source.ts',
    'src/node_modules/source.ts', 'src/lenkanban/source.ts', 'src/.git/source.ts',
    'src/storage/source.ts', 'src/data/source.ts', 'src/logs/source.ts', 'src/backups/source.ts',
    'src/Taskboard-access/source.ts', 'src/example.zip', 'src/example.sqlite', 'src/unknown.exe',
    'prisma/seed.ts', 'prisma/seed-users.ts', 'prisma/dev.db', 'prisma/dump.sql'];
  for (const name of denied) await f.file(name, 'SYNTHETIC_PAYLOAD_MUST_NOT_BE_EMITTED');
  await f.file('src/allowed.ts', 'ok');
  const result = run(f.root);
  const output = inventory(result);
  assert.deepEqual(output.candidates.map(item => item.path), ['src/allowed.ts']);
  assert(!result.stdout.includes('SYNTHETIC_PAYLOAD'));
  assert(output.rejected.excluded > 0);
  assert(output.rejected.unknownRoot > 0);
  assert(output.rejected.unsupportedExtension > 0);
});

test('does not follow directory junctions/symlinks', async t => {
  const f = await fixture(t);
  await mkdir(path.join(f.root, 'outside'));
  await f.file('outside/hidden.ts');
  await mkdir(path.join(f.root, 'src'));
  if (!await linkOrSkip(t, path.join(f.root, 'outside'), path.join(f.root, 'src/linked'), 'junction')) return;
  const output = inventory(run(f.root));
  assert.deepEqual(output.candidates, []);
  assert.equal(output.rejected.symlink, 1);
});

test('does not follow file symlinks', async t => {
  const f = await fixture(t);
  await f.file('outside/hidden.ts');
  await mkdir(path.join(f.root, 'src'));
  if (!await linkOrSkip(t, path.join(f.root, 'outside/hidden.ts'), path.join(f.root, 'src/file.ts'), 'file')) return;
  const output = inventory(run(f.root));
  assert.deepEqual(output.candidates, []);
  assert.equal(output.rejected.symlink, 1);
});

test('rejects a linked scan root and a linked ancestor of a scan root', async t => {
  const f = await fixture(t);
  await mkdir(path.join(f.root, 'target/inside'), { recursive: true });
  if (!await linkOrSkip(t, path.join(f.root, 'target'), path.join(f.root, 'alias'), 'junction')) return;
  for (const root of [path.join(f.root, 'alias'), path.join(f.root, 'alias/inside')]) {
    const result = run(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /ROOT_UNAVAILABLE/);
    assert(!result.stderr.includes(root));
  }
});

test('accepts a new relative JSON output only inside work/release and refuses overwrite', async t => {
  const f = await fixture(t);
  await f.file('package.json', '{}');
  const args = ['--output', 'work/release/check.json'];
  const first = run(f.root, args);
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(JSON.parse(first.stdout), {
    output: 'work/release/check.json', candidateCount: 1, complete: true, readyForPublication: false,
  });
  const outputPath = path.join(f.root, 'work/release/check.json');
  const saved = await readFile(outputPath, 'utf8');
  assert.equal(JSON.parse(saved).readyForPublication, false);
  const second = run(f.root, args);
  assert.equal(second.status, 1);
  assert.match(second.stderr, /OUTPUT_UNAVAILABLE/);
  assert.equal(await readFile(outputPath, 'utf8'), saved);
});

test('rejects absolute, drive, UNC and either-separator traversal output paths', async t => {
  const f = await fixture(t);
  for (const value of ['/tmp/out.json', 'C:\\out.json', '\\\\server\\out.json', '../out.json',
    'work/release/../out.json', 'work\\release\\..\\out.json', 'other/out.json',
    'work/release/out.txt', 'work/release/nested/out.json', 'work/release/./out.json']) {
    const result = run(f.root, ['--output', value]);
    assert.equal(result.status, 1, value);
    assert.match(result.stderr, /INVALID_ARGUMENTS/);
    assert(!result.stderr.includes(value));
  }
});

test('refuses a linked work output ancestor', async t => {
  const f = await fixture(t);
  await mkdir(path.join(f.root, 'outside'));
  if (!await linkOrSkip(t, path.join(f.root, 'outside'), path.join(f.root, 'work'), 'junction')) return;
  const parent = run(f.root, ['--output', 'work/release/out.json']);
  assert.equal(parent.status, 1);
  assert.match(parent.stderr, /OUTPUT_UNAVAILABLE/);
});

test('refuses a linked release output parent', async t => {
  const f = await fixture(t);
  await mkdir(path.join(f.root, 'outside'));
  await mkdir(path.join(f.root, 'work'));
  if (!await linkOrSkip(t, path.join(f.root, 'outside'), path.join(f.root, 'work/release'), 'junction')) return;
  const parent = run(f.root, ['--output', 'work/release/out.json']);
  assert.equal(parent.status, 1);
  assert.match(parent.stderr, /OUTPUT_UNAVAILABLE/);
});

test('refuses an existing symlink output file', async t => {
  const f = await fixture(t);
  await mkdir(path.join(f.root, 'work/release'), { recursive: true });
  await f.file('outside/target.json', 'unchanged');
  if (!await linkOrSkip(t, path.join(f.root, 'outside/target.json'), path.join(f.root, 'work/release/out.json'), 'file')) return;
  const leaf = run(f.root, ['--output', 'work/release/out.json']);
  assert.equal(leaf.status, 1);
  assert.match(leaf.stderr, /OUTPUT_UNAVAILABLE/);
  assert.equal(await readFile(path.join(f.root, 'outside/target.json'), 'utf8'), 'unchanged');
});

test('bounded traversal returns incomplete inventory and a nonzero CLI status', async t => {
  const f = await fixture(t);
  const nested = `src/${Array.from({ length: 66 }, () => 'nested').join('/')}/source.ts`;
  await f.file(nested);
  const result = run(f.root);
  assert.equal(result.status, 1);
  const output = JSON.parse(result.stdout);
  assert.equal(output.complete, false);
  assert.equal(output.readyForPublication, false);
  assert(output.rejected.limit > 0);
  assert.deepEqual(output.candidates, []);
});

test('final verification catches an earlier candidate changed while later candidates are scanned', async t => {
  const f = await fixture(t);
  await f.file('src/a.ts', 'a');
  await f.file('src/z.ts', 'z');
  const changedPath = path.join(f.root, 'src/a.ts');
  const laterPath = path.join(f.root, 'src/z.ts');
  const originalLstat = fsPromises.lstat;
  let changed = false;
  fsPromises.lstat = async (...args) => {
    if (!changed && path.resolve(String(args[0])) === laterPath) {
      changed = true;
      await writeFile(changedPath, 'changed-value');
    }
    return originalLstat(...args);
  };
  syncBuiltinESMExports();
  let output;
  try {
    const inventoryModule = await import('./inventory.mjs');
    output = await inventoryModule.scanReleaseInventory(f.root);
  } finally {
    fsPromises.lstat = originalLstat;
    syncBuiltinESMExports();
  }
  assert.equal(changed, true, 'fixture changes a.ts only once scanner reaches later z.ts');
  assert.equal(output.complete, false);
  assert(output.rejected.changed > 0);
  assert(!output.candidates.some(item => item.path === 'src/a.ts'));
});

test('rejects malformed arguments with fixed errors and no payload/path disclosure', async t => {
  const f = await fixture(t);
  for (const args of [['--unknown', 'SYNTHETIC_SECRET'], ['--root'], ['--root', f.root, '--root', f.root], ['--output']]) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', cwd: f.root });
    assert.equal(result.status, 1);
    assert.equal(result.stderr, 'Release inventory failed: INVALID_ARGUMENTS\n');
    assert.equal(result.stdout, '');
  }
  const absent = run(path.join(f.root, 'SYNTHETIC_SECRET'));
  assert.equal(absent.status, 1);
  assert.equal(absent.stderr, 'Release inventory failed: ROOT_UNAVAILABLE\n');
  assert.equal(absent.stdout, '');
});
