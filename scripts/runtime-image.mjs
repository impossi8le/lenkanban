import { access, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// These images use Debian/OpenSSL 3, not Alpine/musl. schema.prisma is unchanged.
const targets = { x64: 'debian-openssl-3.0.x', arm64: 'linux-arm64-openssl-3.0.x' };
const forbidden = ['prisma', 'tsx', 'typescript', 'esbuild', 'lighthouse',
  'playwright', '@playwright/test', 'vitest', 'jsdom', '@prisma/engines'];

async function exists(file) {
  try { await access(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function size(directory) {
  if (!(await exists(directory))) return 0;
  const info = await stat(directory);
  if (!info.isDirectory()) return info.size;
  let bytes = 0;
  for (const item of await readdir(directory)) bytes += await size(path.join(directory, item));
  return bytes;
}

export async function prepareRuntime(directory) {
  const root = path.resolve(directory);
  const target = targets[process.arch];
  if (process.platform !== 'linux' || !target) throw new Error('Unsupported runtime image platform');
  for (const item of await readdir(root)) {
    if (/^\.env/.test(item) || ['.ssh-taskboard', 'lenkanban', 'work', 'output', 'outputs'].includes(item)) {
      throw new Error(`Local file leaked into runtime: ${item}`);
    }
  }
  // Next traces the TypeScript compiler into standalone because next.config.mjs
  // is typed, but the runner only executes the compiled server. Drop it, then
  // keep the hard failure for every other build tool.
  await rm(path.join(root, 'node_modules', 'typescript'), { recursive: true, force: true });
  await rm(path.join(root, 'node_modules', '@types'), { recursive: true, force: true });
  await rm(path.join(root, 'node_modules', 'esbuild'), { recursive: true, force: true });
  await rm(path.join(root, 'node_modules', '@esbuild'), { recursive: true, force: true });
  for (const name of forbidden) {
    if (await exists(path.join(root, 'node_modules', name))) {
      throw new Error(`Build tooling leaked into runtime: ${name}`);
    }
  }

  const client = path.join(root, 'node_modules/.prisma/client');
  const engine = `libquery_engine-${target}.so.node`;
  await access(path.join(client, engine));
  for (const item of await readdir(client)) {
    if (/^(?:libquery_engine-|query_engine-|query-engine-)/.test(item) && item !== engine) {
      await rm(path.join(client, item));
    }
  }
  // Keep traced Sentry/OpenTelemetry files: removing them can disable diagnostics.
  // Print actual category sizes during the eventual authorized image build.
  const categories = ['@sentry', '@opentelemetry', '@prisma', '.prisma', 'jspdf', 'jspdf-autotable'];
  const bytes = {};
  for (const name of categories) bytes[name] = await size(path.join(root, 'node_modules', name));
  console.log(JSON.stringify({ runtime: path.basename(root), engine, bytes }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await prepareRuntime(process.argv[2]);
}
