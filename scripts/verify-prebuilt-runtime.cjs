'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const role = process.env.IMAGE_ROLE;
assert(['app', 'socket'].includes(role));
assert.equal(process.platform, 'linux');
assert.equal(process.arch, 'x64');
assert.equal(process.version, 'v22.22.2');
const client = require('/app/node_modules/@prisma/client');
assert.equal(client.Prisma.prismaVersion.client, '6.19.2');
const engineFile = '/app/node_modules/.prisma/client/libquery_engine-debian-openssl-3.0.x.so.node';
const engine = require(engineFile).version();
assert.equal(engine.commit, client.Prisma.prismaVersion.engine);
for (const name of ['prisma', 'tsx', 'typescript', 'esbuild', 'vitest', '@playwright/test']) {
  assert(!fs.existsSync('/app/node_modules/' + name), 'Build tool leaked into runtime');
}
assert(!fs.readdirSync('/app').some(name => name.startsWith('.env')));
const entry = role === 'app' ? '/app/server.js' : '/app/dist/socket/server.js';
assert(fs.statSync(entry).isFile());
if (role === 'app') assert(fs.statSync('/app/api-observation-preload.cjs').isFile());
const buildId = role === 'app' ? fs.readFileSync('/app/.next/BUILD_ID', 'utf8').trim() : null;
if (role === 'app') assert(/^[A-Za-z0-9_-]+$/.test(buildId));
const sharp = require('/app/node_modules/sharp');
assert(typeof sharp.versions.vips === 'string');
console.log(JSON.stringify({ role, platform: process.platform, arch: process.arch, node: process.version,
  prismaClient: client.Prisma.prismaVersion.client, generatedEngine: engine.commit,
  engineSha256: crypto.createHash('sha256').update(fs.readFileSync(engineFile)).digest('hex'),
  vips: sharp.versions.vips, buildId,
  entrySha256: crypto.createHash('sha256').update(fs.readFileSync(entry)).digest('hex'),
  databaseConnected: false, serverStarted: false }));
