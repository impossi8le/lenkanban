import {build} from 'esbuild';
// Next bundles zod internally, so standalone has no public node_modules/zod.
// Keep only the native Prisma client and traced Pino package external.
await build({entryPoints:['scripts/provision-request-boards.ts'],outfile:'request-board-provision.cjs',bundle:true,platform:'node',target:'node22',format:'cjs',external:['@prisma/client','pino'],tsconfig:'tsconfig.json'});
