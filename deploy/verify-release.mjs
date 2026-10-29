// Read-only local verification. Config JSON stays in memory; no daemon commands.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { assertRegularReleaseFile, validateBaselinePairs, assertCompleteReleaseInventory } from './build-release-manifest.mjs';
const sha = data => createHash('sha256').update(data).digest('hex');
const snapshot = JSON.parse(await readFile('deploy/RELEASE_SNAPSHOT.json', 'utf8'));
assert.equal(snapshot.version, `snapshot-${sha(JSON.stringify(snapshot.files))}`);
assert.equal(new Set(snapshot.files.map(f => f.path)).size, snapshot.files.length, 'Duplicate snapshot paths');
await assertCompleteReleaseInventory(process.cwd(), snapshot.files.map(f => f.path));
for (const f of snapshot.files) {
  await assertRegularReleaseFile(process.cwd(), f.path);
  const data = await readFile(f.path);
  assert.equal(data.length, f.bytes, `size changed: ${f.path}`);
  assert.equal(sha(data), f.sha256, `hash changed: ${f.path}`);
}
await validateBaselinePairs(process.cwd(), snapshot.files.map(f => f.path));
const configs = [];
for (const project of ['taskboard', 'taskboard-restore']) {
  const env = { ...process.env, COMPOSE_ENV_FILES: 'deploy/compose.validation.env.example', TASKBOARD_ENV_FILE: 'deploy/compose.validation.env.example' };
  const result = spawnSync('docker', ['compose', '-f', 'compose.taskboard.yaml', '-p', project, '--profile', 'tools', 'config', '--format', 'json'], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, 'Compose config failed (credentials/config output suppressed)');
  const config = JSON.parse(result.stdout);
  const names = [];
  for (const [name, svc] of Object.entries(config.services)) {
    assert(!svc.privileged && svc.network_mode !== 'host' && !svc.pid && !svc.ipc, `${name}: isolation`);
    assert(!svc.container_name && !svc.devices && !svc.cap_add, `${name}: host access`);
    assert.deepEqual(Object.keys(svc.networks), ['taskboard_net']);
    for (const volume of svc.volumes ?? []) {
      assert.equal(volume.type, 'volume', `${name}: bind mount`);
      assert(['taskboard_pgdata', 'taskboard_attachments'].includes(volume.source));
    }
    for (const port of svc.ports ?? []) assert.equal(port.host_ip, '127.0.0.1');
    if (['db', 'redis', 'migrate'].includes(name)) assert.equal((svc.ports ?? []).length, 0);
  }
  for (const section of ['networks', 'volumes']) {
    for (const resource of Object.values(config[section])) {
      assert(!resource.external);
      assert(resource.name.startsWith(`${project}_`));
      names.push(resource.name);
    }
  }
  configs.push(names);
}
assert(configs[0].every(name => !configs[1].includes(name)), 'Restore shares production resources');
console.log(JSON.stringify({ verifiedFiles: snapshot.files.length, version: snapshot.version, composeProjects: ['taskboard', 'taskboard-restore'], isolated: true, daemonChecked: false }));
