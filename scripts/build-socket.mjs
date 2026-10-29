// Build only inside the socket-builder stage; never starts a server or connects to DB.
//
// Everything is bundled into one file except Prisma: its query engine is a
// native binary loaded at runtime, so the generated client is copied verbatim.
// Bundling instead of file-tracing keeps the runtime image free of the
// development dependencies and avoids tracing platform binaries that the
// socket process never loads (sharp, image codecs).
import { build } from 'esbuild';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { prepareRuntime } from './runtime-image.mjs';

const root = process.cwd();
const output = path.join(root, 'socket-runtime');
const entry = 'dist/socket/server.js';

await rm(output, { recursive: true, force: true });

await build({
  entryPoints: ['src/socket/server.ts'],
  outfile: entry,
  bundle: true,
  // Prisma resolves its engine through the filesystem, so it must stay a real
  // package on disk. ws accelerators are optional and absent by design.
  external: ['@prisma/client', '.prisma/client', 'sharp', 'bufferutil', 'utf-8-validate'],
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  tsconfig: 'tsconfig.json',
  treeShaking: true,
  sourcemap: false,
  // Fold development-only logger transport selection before bundling.
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'warning',
});

await mkdir(path.join(output, 'dist', 'socket'), { recursive: true });
await cp(entry, path.join(output, entry), { dereference: true });

// The generated client carries the schema types and the native engine.
await cp('node_modules/.prisma/client', path.join(output, 'node_modules/.prisma/client'), {
  recursive: true,
  dereference: true,
});
// @prisma/client is a thin re-export over .prisma/client; the runtime requires it.
await cp('node_modules/@prisma/client', path.join(output, 'node_modules/@prisma/client'), {
  recursive: true,
  dereference: true,
});
// sharp is required by the shared attachment code and loads a native binary.
// Its own runtime dependencies are not bundled because sharp stays external.
for (const name of ['sharp', '@img', 'detect-libc', 'semver']) {
  await cp(path.join('node_modules', name), path.join(output, 'node_modules', name), {
    recursive: true,
    dereference: true,
  });
}

await writeFile(path.join(output, 'package.json'), '{"private":true,"type":"commonjs"}\n');
await prepareRuntime(output);
