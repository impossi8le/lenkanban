#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { openStore } from './iab-store.mjs';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--input') {
  console.error('Usage: node scripts/mail/repair-rendering-variants.mjs --input PATH');
  process.exitCode = 1;
} else {
  let store;
  try {
    const dir = resolve(args[1]);
    const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
    store = await openStore({ dir, scope: manifest.scope });
    const result = store.resolveRenderingVariants();
    await store.checkpoint();
    console.log(JSON.stringify({ resolved: result.resolved, unresolved_conflicts: result.progress.conflict_versions, resolved_rendering_variants: result.progress.resolved_rendering_variants }));
  } catch {
    console.error('RENDERING_REPAIR_FAILED: inspect the local store; private message content is not logged.');
    process.exitCode = 1;
  } finally { store?.close(); }
}
