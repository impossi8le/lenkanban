import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import designData from '../e2e/fixtures/design-data.cjs';
import {
  ROOT_FILES, DEPLOY_FILES, TEMPLATE_FILES, ARCHIVED_MIGRATION_INPUTS, isAllowedReleasePath,
  collectReleasePaths, validateBaselinePairs, renderManifest, assertRegularReleaseFile, assertCompleteReleaseInventory,
} from './build-release-manifest.mjs';

const baseline = 'e2e/baselines/visual-1-light/design-screens.spec.cjs/example.png';
// Actual synthetic 1x1 PNG, used only to exercise package integrity checks.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jxJkAAAAASUVORK5CYII=', 'base64');
const metadata = {
  schemaVersion: 2,
  pngSha256: createHash('sha256').update(png).digest('hex'),
  source: { digest: 'a'.repeat(64) },
  environment: { browser: 'synthetic', playwright: 'synthetic', os: { platform: 'synthetic', arch: 'synthetic' } },
  project: 'visual-1-light', viewport: { width: 1, height: 1 },
  locale: 'ru-RU', timezone: 'Europe/Moscow', fixedTime: designData.FIXED_TIME,
};

test('includes only the reviewed additive group role SQL', () => {
  assert.equal(isAllowedReleasePath('deploy/sql/group_roles_20261028.sql'), true);
  assert.equal(isAllowedReleasePath('deploy/sql/unreviewed.sql'), false);
});

test('publishes only the exact archived SQL inputs required by organization migration tests', () => {
  for (const p of [
    'prisma/migrations_legacy/20261020220000_organization_foundation/migration.sql',
    'prisma/migrations_legacy/20261020230000_organization_commands/migration.sql',
    'prisma/migrations_legacy/20261020230000_organization_commands/ROLLBACK.sql',
  ]) assert.equal(isAllowedReleasePath(p), true, p);
  assert.equal(isAllowedReleasePath('prisma/migrations_legacy/unreviewed/migration.sql'), false);
});

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'lenkanban-release-test-'));
  t.after(async () => { assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir())); assert.match(path.basename(root), /^lenkanban-release-test-/); await rm(root, { recursive: true, force: true }); });
  async function put(p, value = 'synthetic fixture') {
    await mkdir(path.dirname(path.join(root, p)), { recursive: true });
    await writeFile(path.join(root, p), value);
  }
  for (const dir of ['src', 'public', 'e2e', 'tests', 'scripts', 'prisma/migrations']) await mkdir(path.join(root, dir), { recursive: true });
  for (const p of [...ROOT_FILES, ...DEPLOY_FILES, ...TEMPLATE_FILES, ...ARCHIVED_MIGRATION_INPUTS, 'prisma/schema.prisma']) await put(p);
  return { root, put };
}

test('shared allowlist admits exact templates and canonical PNG/metadata only', () => {
  for (const p of [...TEMPLATE_FILES, baseline, `${baseline}.json`, '.github/workflows/e2e-regression.yml', 'src/lib/app.ts', 'prisma/migrations/example/migration.sql']) assert.equal(isAllowedReleasePath(p), true, p);
  for (const p of [
    'prisma/templates/other.json', 'prisma/templates/private.ts', 'prisma/seed.ts',
    'public/screenshot.png', 'e2e/screenshot.png', 'src/photo.png',
    baseline.replace('/baselines/', '/baselines.partial-20261023/'),
    baseline.replace('/visual-1-light/', '/partial-20261023/'),
    'e2e/baselines/readme.json', 'deploy/ssh/key.pub', 'deploy/mcp/index.ts',
    'src/.env', 'src/.envrc', 'src/id_ed25519', 'src/nested/database.sqlite-wal',
    'src/nested/raw.eml', 'src/nested/key.pem', 'src/logs/output.json',
    'src/uploads/file.json', 'work/source.ts', 'lenkanban/src/app.ts',
    'src/secrets/api.json', 'src/credentials/account.json', 'src/.claude/settings.json', 'src/.git/private.json',
    '../src/app.ts', 'src/../app.ts', '/src/app.ts', 'src//app.ts', 'src\\app.ts',
    'D:/private.ts', '.github/workflows/unreviewed.yml',
  ]) assert.equal(isAllowedReleasePath(p), false, p);
});

test('canonical visual CI admits only reviewed exact recipe paths', () => {
  for (const p of ['.github/workflows/visual-canonical.yml', 'deploy/visual-ci/Dockerfile', 'deploy/visual-ci/renderer.mjs', 'deploy/visual-ci/renderer.expected.json', 'deploy/visual-ci/playwright.config.ts', 'deploy/visual-ci/coverage.cjs', 'deploy/visual-ci/coverage.test.cjs', 'deploy/visual-ci/run.sh', 'docs/engineering/CANONICAL_VISUAL_CI.md']) assert.equal(isAllowedReleasePath(p), true, p);
  for (const p of ['.github/workflows/visual-unreviewed.yml', 'deploy/visual-ci/unreviewed.json', 'deploy/visual-ci/private.env', 'deploy/visual-ci/.env', 'deploy/visual-ci/extra.sh', 'deploy/visual-ci/renderer.expected.json.backup']) assert.equal(isAllowedReleasePath(p), false, p);
});

test('trusted source directories keep API upload handlers without admitting runtime files', () => {
  for (const p of [
    'src/app/api/uploads/direct/route.ts', 'src/app/api/uploads/direct/route.test.ts',
    'src/app/api/uploads/finalize/route.ts', 'src/app/api/uploads/finalize/route.test.ts',
    'src/app/api/uploads/presign/route.ts', 'src/app/api/uploads/presign/route.test.ts',
    'src/lib/storage/adapter.ts', 'src/features/data/model.ts', 'src/components/logs/view.tsx',
  ]) assert.equal(isAllowedReleasePath(p), true, p);
  for (const p of [
    'public/uploads/direct/route.ts', 'public/data/state.json', 'public/storage/upload.svg',
    'src/uploads/payload.ts', 'src/data/state.json', 'src/storage/adapter.ts',
    'src/app/api/uploads/raw.json', 'src/lib/storage/upload.svg',
    'src/app/api/uploads/.env.local', 'src/app/api/uploads/secrets/token.ts',
    'src/app/api/uploads/artifacts/payload.ts', 'src/app/api/uploads/screenshot.png',
    'src/app/api/uploads/work/payload.ts', 'src/lib/storage/outputs/payload.ts',
    'public/runtime/upload.svg', 'public/uploads/USER.JSON', 'src/lib/storage/upload.JSON',
    'e2e/artifacts/prod-audit/summary.json', 'e2e/artifacts/route.ts',
    'tests/data/private.json', 'scripts/storage/payload.ts', 'work/route.ts',
    'uploads/route.ts', 'storage/payload.ts', 'data/state.json',
  ]) assert.equal(isAllowedReleasePath(p), false, p);
});

test('collector traverses trusted API uploads and excludes artifacts with source-looking names', async t => {
  const { root, put } = await fixture(t);
  const included = ['src/app/api/uploads/direct/route.ts', 'src/app/api/uploads/direct/route.test.ts', 'src/lib/storage/adapter.ts'];
  const excluded = ['public/uploads/route.ts', 'src/uploads/payload.ts', 'src/app/api/uploads/raw.json', 'src/app/api/uploads/artifacts/route.ts', 'e2e/artifacts/route.ts'];
  for (const p of [...included, ...excluded]) await put(p);
  const paths = await collectReleasePaths(root);
  for (const p of included) assert.ok(paths.includes(p), p);
  for (const p of excluded) assert.ok(!paths.includes(p), p);
});

test('real application route/page/layout inventory independently survives collection', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const entrypoints = [];
  // This oracle does not use the allowlist or the collector pruning predicate.
  // It reads directory entries only, never contents or symbolic link targets.
  async function discover(dir) {
    for (const entry of await readdir(path.join(root, dir), { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const p = `${dir}/${entry.name}`;
      if (entry.isDirectory()) await discover(p);
      else if (entry.isFile() && /^(?:route|page|layout)\.tsx?$/.test(entry.name)) entrypoints.push(p);
    }
  }
  await discover('src/app');
  assert.ok(entrypoints.includes('src/app/api/uploads/direct/route.ts'));
  assert.ok(entrypoints.some(p => p.endsWith('/page.tsx')));
  assert.ok(entrypoints.some(p => p.endsWith('/layout.tsx')));
  const selected = new Set(await collectReleasePaths(root));
  assert.deepEqual(entrypoints.filter(p => !selected.has(p)), [], 'Application entrypoint omitted from candidate');
});

test('completeness gate rejects omitted upload handlers, unexpected entries and duplicates', async t => {
  const { root, put } = await fixture(t);
  const route = 'src/app/api/uploads/direct/route.ts';
  await put(route);
  const paths = await collectReleasePaths(root);
  await assertCompleteReleaseInventory(root, paths);
  await assert.rejects(assertCompleteReleaseInventory(root, paths.filter(p => p !== route)), /Snapshot inventory differs/);
  await assert.rejects(assertCompleteReleaseInventory(root, [...paths, route]), /Snapshot inventory differs/);
  await assert.rejects(assertCompleteReleaseInventory(root, [...paths, 'public/uploads/route.ts']), /Snapshot inventory differs/);
});

test('source namespace exemption does not traverse linked upload directories', async t => {
  const { root, put } = await fixture(t);
  await put('outside/route.ts');
  await mkdir(path.join(root, 'src/app/api'), { recursive: true });
  await symlink(path.join(root, 'outside'), path.join(root, 'src/app/api/uploads'), 'junction');
  await assert.rejects(assertRegularReleaseFile(root, 'src/app/api/uploads/route.ts'), /Not a regular release path/);
  assert.ok(!(await collectReleasePaths(root)).includes('src/app/api/uploads/route.ts'));
});

test('collector packages required templates, workflow and complete baseline pair while ignoring excluded trees', async t => {
  const { root, put } = await fixture(t);
  await put(baseline, png);
  await put(`${baseline}.json`, JSON.stringify(metadata));
  const excluded = ['prisma/templates/other.json', 'e2e/baselines.partial-old/metadata.png.json', 'e2e/screenshots/private.json', 'src/uploads/secret.json', 'src/.envtaskboard', 'src/mail.eml', 'public/screenshot.png'];
  for (const p of excluded) await put(p);
  const paths = await collectReleasePaths(root);
  for (const p of [...TEMPLATE_FILES, ...ARCHIVED_MIGRATION_INPUTS, baseline, `${baseline}.json`, '.github/workflows/e2e-regression.yml']) assert.ok(paths.includes(p), p);
  for (const p of excluded) assert.ok(!paths.includes(p), p);
});

test('collector rejects orphan PNG or provenance instead of publishing an incomplete pair', async t => {
  const { root, put } = await fixture(t);
  await put(`${baseline}.json`, JSON.stringify(metadata));
  await assert.rejects(collectReleasePaths(root), /Unpaired baseline/);
  await put(baseline, png);
  await assert.rejects(validateBaselinePairs(root, [baseline]), /Unpaired baseline/);
});

test('collector rejects baseline content mismatching its provenance', async t => {
  const { root, put } = await fixture(t);
  await put(baseline, png);
  await put(`${baseline}.json`, JSON.stringify({ ...metadata, pngSha256: '0'.repeat(64) }));
  await assert.rejects(collectReleasePaths(root), /hash mismatch/);
});

test('verifier path check refuses a linked ancestor and collector never traverses it', async t => {
  const { root, put } = await fixture(t);
  await put('outside/payload.ts');
  await symlink(path.join(root, 'outside'), path.join(root, 'src/linked'), 'junction');
  await assert.rejects(assertRegularReleaseFile(root, 'src/linked/payload.ts'), /Not a regular release path/);
  assert.ok(!(await collectReleasePaths(root)).includes('src/linked/payload.ts'));
});

test('import from a different working directory creates no manifest or snapshot', async t => {
  const { root } = await fixture(t);
  const generator = new URL('./build-release-manifest.mjs', import.meta.url).href;
  const before = await readFile(path.join(root, 'deploy/RELEASE_MANIFEST.md'), 'utf8');
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(generator)});`], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(await readFile(path.join(root, 'deploy/RELEASE_MANIFEST.md'), 'utf8'), before);
  await assert.rejects(readFile(path.join(root, 'deploy/RELEASE_SNAPSHOT.json')), { code: 'ENOENT' });
});

test('generator prose removes outdated exclusions without claiming browser acceptance', async () => {
  const current = await readFile(fileURLToPath(new URL('./RELEASE_MANIFEST.md', import.meta.url)), 'utf8');
  const rendered = renderManifest(current, [baseline, `${baseline}.json`, ...TEMPLATE_FILES]);
  assert.ok(rendered.includes('Канонические e2e/baselines/**/*.png'));
  assert.ok(rendered.includes('не доказывают полную visual-матрицу'));
  assert.ok(!rendered.includes('prisma/templates/** не исследовался и не добавлен'));
  assert.equal(renderManifest(rendered, [baseline, `${baseline}.json`, ...TEMPLATE_FILES]), rendered);
});

