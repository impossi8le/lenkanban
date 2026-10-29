import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import test from 'node:test';

test('public nginx overwrites client IP headers for both application upstreams', async () => {
  const source = await readFile(new URL('./nginx/taskboard.conf.template', import.meta.url), 'utf8');
  assert.equal((source.match(/proxy_set_header X-Forwarded-For \$remote_addr;/g) ?? []).length, 2);
  assert.equal((source.match(/proxy_set_header X-Real-IP \$remote_addr;/g) ?? []).length, 2);
  assert.doesNotMatch(source, /proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;/);
});
