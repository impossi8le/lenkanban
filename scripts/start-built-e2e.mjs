import { cp, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import safety from '../e2e/fixtures/safety.cjs';
import managedServer from '../e2e/fixtures/managed-server.cjs';

// The managed production-mode server has the same test-only boundary as dev.
safety.parseTestDatabaseUrl(process.env.DATABASE_URL);
safety.assertManagedServerBaseUrl(safety.parseSafeBaseUrl(process.env.NEXTAUTH_URL));
if (process.env.HOSTNAME !== '127.0.0.1' || process.env.PORT !== '3555') {
  throw new Error('Built E2E server requires loopback port 3555');
}
const root = path.resolve(import.meta.dirname, '..');
managedServer.prepareBuiltE2E({ args: process.argv.slice(2), env: process.env, root });
const standalone = path.join(root, '.next/standalone');
await stat(path.join(standalone, 'server.js'));
const buildId = (await readFile(path.join(root, '.next/BUILD_ID'), 'utf8')).trim();
if (!/^[A-Za-z0-9_-]{1,128}$/.test(buildId)) throw new Error('Invalid compiled E2E build identity');
// Same asset layout as the Docker runner, completed before Next inventories it.
await cp(path.join(root, 'public'), path.join(standalone, 'public'), { recursive: true, force: true });
await cp(path.join(root, '.next/static'), path.join(standalone, '.next/static'), { recursive: true, force: true });
// Same pre-listen observer as the Docker CMD; Next register is idempotent.
await import(pathToFileURL(path.join(standalone, 'api-observation-preload.cjs')).href);
console.info('[e2e-server] ' + JSON.stringify({ phase: 'compiled-start', buildId }));
await import(pathToFileURL(path.join(standalone, 'server.js')).href);
