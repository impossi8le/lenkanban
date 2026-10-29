// Local metadata only: never publishes or traverses excluded working directories.
import { readdir, lstat, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import baselines from '../e2e/fixtures/check-baselines.cjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const denied = /(^|\/)(?:\.env[^/]*|\.git|\.codex|\.agents|\.opencode|\.claude|secrets|credentials|private|keys|\.ssh-taskboard|\.mail-work|\.board-work|node_modules|\.next|lenkanban|\.auth|artifacts|work|outputs?|screenshots|videos|__pycache__|test-results|playwright-report|coverage|partial[^/]*|baselines[.-][^/]*)(\/|$)|(^|\/)id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)|\.(?:db(?:-.*)?|sqlite3?(?:-.*)?|dump|bak|backup2?|log|eml|mbox|pst|ost|zip|tar|tgz|gz|7z|pem|key|ppk|p12|pfx|pyc)$/i;
const operationalDirectory = /(^|\/)(?:logs|data|uploads|storage|backups|runtime)(\/|$)/i;
const trustedSourceLocation = p => /^src\/(?:app|components|features|hooks|lib|middleware|mcp|socket|test|types)(?:\/|$)/.test(p);
const sourceCode = p => /\.(?:[cm]?js|jsx|ts|tsx|css|prisma)$/.test(p);
// An API namespace is source code, not the attachment volume. Operational
// directory names remain forbidden outside reviewed source roots; inside them
// only source extensions qualify, never uploaded JSON/assets or secret files.
const excludedTree = p => denied.test(p) || (operationalDirectory.test(p) && !trustedSourceLocation(p));
const code = p => /\.(?:[cm]?js|jsx|ts|tsx|json|css|svg|ico|woff2?|ttf|prisma|toml)$/.test(p);
// Board templates are imported by src/lib/project-template-loader.ts; without
// them the published tree fails typecheck and board creation.
export const TEMPLATE_FILES = Object.freeze(['prisma/templates/tech-support.json', 'prisma/templates/validate.ts', 'prisma/templates/validate.test.ts']);
// Historical SQL is read by organization-migration.test.ts. Keep these exact
// offline review inputs outside active prisma/migrations; never apply them.
export const ARCHIVED_MIGRATION_INPUTS = Object.freeze([
  'prisma/migrations_legacy/20261020220000_organization_foundation/migration.sql',
  'prisma/migrations_legacy/20261020230000_organization_commands/migration.sql',
  'prisma/migrations_legacy/20261020230000_organization_commands/ROLLBACK.sql',
]);
export const ROOT_FILES = Object.freeze(['.dockerignore', '.gitignore', '.gitattributes', '.github/workflows/ci.yml', '.github/workflows/e2e-regression.yml', '.github/workflows/visual-canonical.yml', '.github/ISSUE_TEMPLATE/task.yml', 'Dockerfile', 'compose.taskboard.yaml', 'ecosystem.config.js', 'openapi.yaml', 'package.json', 'package-lock.json', 'components.json', 'next-env.d.ts', 'next.config.mjs', 'tsconfig.json', 'postcss.config.mjs', 'eslint.config.mjs', 'vitest.config.ts', 'playwright.config.ts', 'instrumentation.ts', 'sentry.client.config.ts', 'sentry.server.config.ts', 'sentry.server.config.test.ts', 'server.js', 'README.md']);
// Exact deployment inputs; never recurse into deploy/ssh or deploy/mcp.
export const DEPLOY_FILES = Object.freeze(['deploy/RELEASE_MANIFEST.md', 'deploy/RUNBOOK.md', 'deploy/RUNBOOK_ACCEPTANCE.md', 'deploy/PREFLIGHT.md', 'deploy/DB_BOOTSTRAP_TASKBOARD.md', 'deploy/taskboard.env.example', 'deploy/compose.validation.env.example', 'deploy/nginx/taskboard.conf.template', 'deploy/sql/verify_taskboard_schema.sql', 'deploy/sql/group_roles_20261028.sql', 'deploy/build-release-manifest.mjs', 'deploy/check-secrets.mjs', 'deploy/check-secrets.test.mjs', 'deploy/verify-release.mjs', 'deploy/release-manifest.test.mjs', 'deploy/nginx-client-ip.test.mjs', 'deploy/nginx-observation.test.mjs', 'deploy/visual-ci/Dockerfile', 'deploy/visual-ci/renderer.mjs', 'deploy/visual-ci/renderer.expected.json', 'deploy/visual-ci/playwright.config.ts', 'deploy/visual-ci/coverage.cjs', 'deploy/visual-ci/coverage.test.cjs', 'deploy/visual-ci/run.sh', 'docs/engineering/CANONICAL_VISUAL_CI.md']);

export function isAllowedReleasePath(p) {
  if (typeof p !== 'string' || !p || p.includes('\\') || p.includes(':') || p.split('/').some(part => !part || part === '.' || part === '..') || excludedTree(p)) return false;
  if (operationalDirectory.test(p) && !sourceCode(p)) return false;
  if (ROOT_FILES.includes(p) || DEPLOY_FILES.includes(p) || TEMPLATE_FILES.includes(p) || ARCHIVED_MIGRATION_INPUTS.includes(p) || p === 'prisma/schema.prisma') return true;
  if (p.startsWith('prisma/migrations/')) return /\.(?:sql|toml)$/.test(p);
  if (p.startsWith('e2e/baselines/')) return /^e2e\/baselines\/(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.png(?:\.json)?$/.test(p);
  return /^(?:src|public|e2e|tests|scripts)\//.test(p) && code(p);
}

export async function assertRegularReleaseFile(root, p) {
  if (!isAllowedReleasePath(p)) throw new Error(`Excluded candidate: ${p}`);
  const parts = p.split('/');
  for (let index = 0; index <= parts.length; index++) {
    const stat = await lstat(path.join(root, ...parts.slice(0, index)));
    if (stat.isSymbolicLink() || (index < parts.length ? !stat.isDirectory() : !stat.isFile())) throw new Error(`Not a regular release path: ${p}`);
  }
}

export async function validateBaselinePairs(root, paths) {
  const selected = new Set(paths);
  for (const p of paths.filter(p => p.startsWith('e2e/baselines/'))) {
    const png = p.endsWith('.json') ? p.slice(0, -5) : p;
    if (!selected.has(png) || !selected.has(`${png}.json`)) throw new Error(`Unpaired baseline: ${png}`);
    if (p.endsWith('.json')) continue;
    baselines.validateBaseline(await readFile(path.join(root, png)), JSON.parse(await readFile(path.join(root, `${png}.json`), 'utf8')));
  }
}

export async function collectReleasePaths(root) {
  const paths = new Set();
  async function include(p) {
    await assertRegularReleaseFile(root, p);
    paths.add(p);
  }
  async function walk(dir) {
    const stat = await lstat(path.join(root, dir));
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Not a regular directory: ${dir}`);
    for (const entry of await readdir(path.join(root, dir), { withFileTypes: true })) {
      const p = `${dir}/${entry.name}`;
      if (excludedTree(p) || entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await walk(p);
      else if (isAllowedReleasePath(p)) await include(p);
    }
  }
  for (const dir of ['src', 'public', 'e2e', 'tests', 'scripts', 'prisma/migrations']) await walk(dir);
  for (const p of [...ROOT_FILES, ...DEPLOY_FILES, ...TEMPLATE_FILES, ...ARCHIVED_MIGRATION_INPUTS, 'prisma/schema.prisma']) await include(p);
  const sorted = [...paths].sort();
  await validateBaselinePairs(root, sorted);
  return sorted;
}

export async function assertCompleteReleaseInventory(root, paths) {
  const expected = await collectReleasePaths(root);
  const actual = new Set(paths);
  if (actual.size !== paths.length || actual.size !== expected.length || expected.some(p => !actual.has(p))) throw new Error('Snapshot inventory differs from current release source allowlist');
}

export function renderManifest(current, sorted) {
  const heading = current.indexOf('## Точный список путей');
  if (heading < 0) throw new Error('Manifest section missing');
  const intro = current.slice(0, heading)
    .replace(/Список исходников не является доказательством успешной сборки\.[\s\S]*?Шаблон окружения —/, 'Список исходников не является доказательством успешной сборки. Включены ровно три\nпроверенных источника шаблона: prisma/templates/tech-support.json, validate.ts и\nvalidate.test.ts в том же каталоге. Загрузчик импортирует validator и читает JSON;\nтест validator входит в исходный пакет. Остальные prisma/templates/** исключены.\nШаблон окружения —')
    .replace(/`prisma\/templates\/\*\*` исключены по границам задачи;[\s\S]*?Private `deploy\/ssh\/\*\*`/, 'Канонические e2e/baselines/**/*.png включаются только вместе с соответствующими\n.png.json после проверки SHA256 и provenance; partial-* и произвольные скриншоты\nисключены. Эти проверки не доказывают полную visual-матрицу или browser acceptance.\nВключены ci.yml, e2e-regression.yml и visual-canonical.yml; канонический renderer и coverage guard входят только точными путями deploy/visual-ci.\nPrivate `deploy/ssh/**`');
  return intro + `## Точный список путей\n\n${sorted.length} регулярных файлов, отсортированных относительно корня.\nСгенерировано: \`npx.cmd --no-install -c "node deploy/build-release-manifest.mjs"\`.\n\n\`\`\`text\n${sorted.join('\n')}\n\`\`\`\n`;
}

async function main() {
const root = process.cwd();
const sorted = await collectReleasePaths(root);
const manifestPath = path.join(root, 'deploy/RELEASE_MANIFEST.md');
const current = await readFile(manifestPath, 'utf8');
await writeFile(manifestPath, renderManifest(current, sorted), 'utf8');
const files = [];
for (const p of sorted) {
  const bytes = await readFile(path.join(root, p));
  files.push({ path: p, bytes: bytes.length, sha256: sha(bytes) });
}
// Index does not hash itself: identity = UTF-8 JSON.stringify(files), no timestamp.
const id = sha(JSON.stringify(files));
await writeFile(path.join(root, 'deploy/RELEASE_SNAPSHOT.json'), JSON.stringify({ schemaVersion: 1, version: `snapshot-${id}`, gitCommit: null, published: false, identity: 'sha256(JSON.stringify(files)) UTF-8; index excluded from self-hash', files }, null, 2) + '\n');
console.log(JSON.stringify({ files: files.length, version: `snapshot-${id}`, published: false }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();


