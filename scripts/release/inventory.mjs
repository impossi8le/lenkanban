import { lstat, readdir, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Reviewed names/extensions only. Candidate metadata is not an export approval.
const ROOT_FILES = new Set([
  'package.json', 'package-lock.json', 'server.js', 'tsconfig.json', 'next-env.d.ts',
  ...['next.config', 'vitest.config', 'eslint.config', 'postcss.config', 'tailwind.config']
    .flatMap(name => ['ts', 'js', 'mjs', 'cjs'].map(extension => `${name}.${extension}`)),
  ...['sentry.client.config', 'sentry.server.config', 'sentry.edge.config', 'instrumentation']
    .flatMap(name => ['ts', 'js'].map(extension => `${name}.${extension}`)),
]);
const ROOT_DIRECTORIES = new Set(['src', 'public', 'prisma', 'e2e']);
const EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.css', '.scss', '.sass', '.less',
  '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico',
  '.woff', '.woff2', '.ttf', '.eot', '.otf', '.prisma',
]);
const EXCLUDED_NAMES = new Set([
  'lenkanban', 'node_modules', '.next', '.git', '.cache', '.turbo', '.vercel',
  '.codex', '.opencode', '.agents', '.idea', '.vscode', '.npm', '.yarn', '.pnpm-store',
  'uploads', 'upload', 'storage', 'data', 'logs', 'log', 'backups', 'backup',
  'keys', 'credentials', 'private', 'secrets', 'docs', 'work', 'outputs',
  '.mail-work', '.board-work', 'test-results', 'playwright-report',
]);
const EXCLUDED_EXTENSIONS = new Set([
  '.pem', '.key', '.p12', '.pfx', '.ppk', '.crt', '.cer', '.der',
  '.db', '.sqlite', '.sqlite3', '.dump', '.bak', '.backup', '.backup2',
  '.zip', '.7z', '.rar', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.log',
]);
const MAX_ENTRIES = 100_000;
const MAX_DEPTH = 64;

function failure(code) {
  const error = new Error(code);
  error.inventoryCode = code;
  return error;
}

function sameMetadata(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode &&
    a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

function sameIdentity(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode;
}

function denied(name, relative) {
  const lower = name.toLowerCase();
  return EXCLUDED_NAMES.has(lower) || lower.startsWith('.env') ||
    lower.startsWith('taskboard-') || EXCLUDED_EXTENSIONS.has(path.extname(lower)) ||
    /(?:credential|secret|private[-_.]?key)/i.test(name) ||
    /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)/i.test(name) ||
    (relative.startsWith('prisma/') && /^(?:seed|dump)(?:[-_.]|$)/i.test(name));
}

// Check every existing root ancestor: a linked parent is also outside the contract.
async function checkedAncestors(directory) {
  const resolved = path.resolve(directory);
  const chain = [];
  let current = resolved;
  while (true) {
    chain.unshift(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const observed = [];
  for (const target of chain) {
    const stat = await lstat(target);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure('UNSAFE_PATH');
    observed.push({ target, stat });
  }
  return observed;
}

async function unchanged(observed) {
  for (const { target, stat } of observed) {
    const after = await lstat(target);
    if (after.isSymbolicLink() || !after.isDirectory() || !sameMetadata(stat, after)) return false;
  }
  return true;
}

export async function scanReleaseInventory(root = process.cwd()) {
  const directory = path.resolve(root);
  let ancestors;
  try { ancestors = await checkedAncestors(directory); }
  catch { throw failure('ROOT_UNAVAILABLE'); }
  const result = {
    schemaVersion: 1,
    rootHasGit: false,
    complete: true,
    readyForPublication: false,
    contentReview: 'not-performed',
    integrity: 'metadata-only',
    candidates: [],
    rejected: { excluded: 0, unknownRoot: 0, unsupportedExtension: 0, symlink: 0, unavailable: 0, changed: 0, limit: 0 },
  };
  let visited = 0;
  const observations = [];
  function incomplete(reason) {
    result.complete = false;
    result.rejected[reason] += 1;
  }
  async function walk(absolute, relative, depth) {
    if (depth > MAX_DEPTH || visited >= MAX_ENTRIES) { incomplete('limit'); return; }
    let before;
    let entries;
    try {
      const lineage = await checkedAncestors(absolute);
      before = lineage.at(-1).stat;
      entries = await readdir(absolute, { withFileTypes: true });
    } catch { incomplete('unavailable'); return; }
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      if (visited >= MAX_ENTRIES) { incomplete('limit'); break; }
      visited += 1;
      const item = relative ? `${relative}/${entry.name}` : entry.name;
      if (!relative && entry.name.toLowerCase() === '.git') result.rootHasGit = true;
      if (denied(entry.name, item)) { result.rejected.excluded += 1; continue; }
      const target = path.join(absolute, entry.name);
      let stat;
      try { stat = await lstat(target); }
      catch { incomplete('unavailable'); continue; }
      if (stat.isSymbolicLink()) { result.rejected.symlink += 1; continue; }
      if (stat.isDirectory()) {
        const allowed = relative || ROOT_DIRECTORIES.has(entry.name) || entry.name === 'scripts';
        if (!allowed || (relative === 'scripts' && entry.name !== 'release')) {
          result.rejected.unknownRoot += 1;
          continue;
        }
        await walk(target, item, depth + 1);
        continue;
      }
      if (!stat.isFile()) { result.rejected.excluded += 1; continue; }
      if ((!relative && !ROOT_FILES.has(entry.name)) || relative === 'scripts') {
        result.rejected.unknownRoot += 1;
        continue;
      }
      const extension = path.extname(entry.name).toLowerCase();
      const migration = item.startsWith('prisma/migrations/') && extension === '.sql';
      if (relative && !EXTENSIONS.has(extension) && !migration) {
        result.rejected.unsupportedExtension += 1;
        continue;
      }
      try {
        // No payload read: detect changes observed between two metadata snapshots.
        const lineage = await checkedAncestors(absolute);
        const after = await lstat(target);
        if (!sameMetadata(stat, after) || after.isSymbolicLink() || !after.isFile() ||
          !sameMetadata(before, lineage.at(-1).stat)) { incomplete('changed'); continue; }
        if (!Number.isSafeInteger(stat.size) || stat.size < 0 || !Number.isFinite(stat.mtimeMs)) {
          incomplete('unavailable'); continue;
        }
        const candidate = { path: item, bytes: stat.size, mtimeMs: stat.mtimeMs };
        observations.push({ target, candidate, stat, lineage });
      } catch { incomplete('unavailable'); }
    }
    try {
      const after = await lstat(absolute);
      if (after.isSymbolicLink() || !after.isDirectory() || !sameMetadata(before, after)) incomplete('changed');
    } catch { incomplete('unavailable'); }
  }
  await walk(directory, '', 0);
  // A candidate accepted early may change while the rest of the tree is walked.
  // Revalidate all accepted metadata at the end; this is still not an atomic snapshot.
  for (const { target, candidate, stat, lineage } of observations) {
    try {
      const finalLineage = await checkedAncestors(path.dirname(target));
      const after = await lstat(target);
      if (lineage.length !== finalLineage.length ||
        lineage.some((entry, index) => !sameMetadata(entry.stat, finalLineage[index].stat)) ||
        after.isSymbolicLink() || !after.isFile() || !sameMetadata(stat, after)) {
        incomplete('changed');
        continue;
      }
      result.candidates.push(candidate);
    } catch { incomplete('unavailable'); }
  }
  try { if (!await unchanged(ancestors)) incomplete('changed'); }
  catch { incomplete('unavailable'); }
  result.candidates.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return result;
}

function parseArguments(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!['--root', '--output'].includes(flag) || flag in values || !value || value.startsWith('--')) {
      throw failure('INVALID_ARGUMENTS');
    }
    values[flag] = value;
  }
  if (values['--output'] && !/^work\/release\/[A-Za-z0-9][A-Za-z0-9_-]*\.json$/.test(values['--output'])) {
    throw failure('INVALID_ARGUMENTS');
  }
  return { root: values['--root'] ?? process.cwd(), output: values['--output'] };
}

async function writeNewOutput(root, relative, json) {
  try {
    await checkedAncestors(root);
    for (const target of [path.join(root, 'work'), path.join(root, 'work/release')]) {
      try { await mkdir(target); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      await checkedAncestors(target);
    }
    const parents = await checkedAncestors(path.join(root, 'work/release'));
    const handle = await open(path.join(root, ...relative.split('/')), 'wx', 0o600);
    try {
      const afterCreate = await checkedAncestors(path.join(root, 'work/release'));
      // Exclusive creation legitimately changes only the final parent metadata.
      if (parents.length !== afterCreate.length || parents.some(({ stat }, index) =>
        !sameIdentity(stat, afterCreate[index].stat) ||
        (index !== parents.length - 1 && !sameMetadata(stat, afterCreate[index].stat)))) {
        throw failure('UNSAFE_PATH');
      }
      await handle.writeFile(json, 'utf8');
      if (!await unchanged(afterCreate)) throw failure('UNSAFE_PATH');
    } finally { await handle.close(); }
  } catch { throw failure('OUTPUT_UNAVAILABLE'); }
}

async function main() {
  try {
    const args = parseArguments(process.argv.slice(2));
    const root = path.resolve(args.root);
    const result = await scanReleaseInventory(root);
    const json = `${JSON.stringify(result, null, 2)}\n`;
    if (args.output) {
      await writeNewOutput(root, args.output, json);
      process.stdout.write(`${JSON.stringify({ output: args.output, candidateCount: result.candidates.length,
        complete: result.complete, readyForPublication: false })}\n`);
    }
    else process.stdout.write(json);
    if (!result.complete) process.exitCode = 1;
  } catch (error) {
    const allowed = new Set(['INVALID_ARGUMENTS', 'ROOT_UNAVAILABLE', 'OUTPUT_UNAVAILABLE']);
    const code = allowed.has(error?.inventoryCode) ? error.inventoryCode : 'SCAN_UNAVAILABLE';
    process.stderr.write(`Release inventory failed: ${code}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
