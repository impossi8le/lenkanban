import { build } from 'esbuild';
// Explicit one-time entrypoint; the application never invokes it on startup.
await build({ entryPoints: ['scripts/provision-beznal-op.ts'], outfile: 'beznal-op-provision.cjs',
  bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['@prisma/client', 'pino'], tsconfig: 'tsconfig.json' });
