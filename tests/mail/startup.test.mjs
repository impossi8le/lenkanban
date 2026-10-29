import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('startup diagnostics expose fixed import code without private path or exception', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mail-startup-'));
  try {
    const privatePath = join(dir, 'private-user-secret-snapshot.json');
    const run = spawnSync(process.execPath, [fileURLToPath(new URL('../../scripts/mail/collect-basemail.mjs', import.meta.url)), '--import', privatePath, '--output', join(dir, 'output')], { encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.deepEqual(JSON.parse(run.stderr.trim()), { error_code: 'STARTUP_IMPORT_FAILED' });
    assert.ok(!run.stderr.includes(privatePath));
    assert.ok(!run.stderr.includes('private-user-secret'));
    assert.ok(!run.stderr.includes('ENOENT'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
