import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mask, scanText, scanManifest } from './check-secrets.mjs';

test('all requested patterns detect literals without disclosing values', () => {
  const samples = [
    ['private-key', '-----BEGIN RSA PRIVATE KEY-----'],
    ['aws-token', 'AKIA' + 'A'.repeat(16)],
    ['github-token', 'ghp_' + 'b'.repeat(36)],
    ['github-token', 'github_pat_' + 'c'.repeat(30)],
    ['openai-token', 'sk-proj-' + 'd'.repeat(40)],
    ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature'],
    ['credential-url', 'postgresql://alice:long-password@localhost/database'],
    ...['password', 'passwd', 'secret', 'api_key', 'token'].map(name => ['credential-assignment', `${name}=nonempty-value`]),
    ['long-env-value', 'PUBLIC_SETTING=' + 'z'.repeat(21)],
  ];
  for (const [type, value] of samples) {
    const hits = scanText('.env.local', `# heading\n${value}`);
    assert.ok(hits.some(hit => hit.type === type && hit.line === 2 && hit.classification === 'real'), type);
    assert.ok(!JSON.stringify(hits).includes(value), 'raw input leaked');
  }
  assert.equal(mask('abc'), '***');
  assert.equal(mask('abcdef'), 'ab***ef');
});

test('synthetic inputs, empty values and executable expressions', () => {
  for (const file of ['.env.example', 'deploy/taskboard.env.example', 'tests/fixture.txt', 'src/auth.test.ts']) {
    assert.equal(scanText(file, 'password="nonempty-value"')[0].classification, 'synthetic');
  }
  for (const value of ['${TOKEN}', 'https://alice:password@service.invalid/db', 'postgresql://${USER}:${PASSWORD}@db/name']) {
    assert.ok(scanText('config.env', `TOKEN=${value}`).every(hit => hit.classification === 'synthetic'));
  }
  assert.ok(scanText('config.env', 'URL=postgresql://${USER}:literal-password@db/name').some(hit => hit.classification === 'real'));
  assert.equal(scanText('config.env', 'PASSWORD=not-an-address.invalid')[0].classification, 'real');
  assert.equal(scanText('.env', 'TOKEN=\nPASSWORD=""\nSECRET=\'\'').length, 0);
  assert.equal(scanText('auth.ts', 'const token = response.NextContinuationToken;').length, 0);
  assert.equal(scanText('auth.ts', 'const token = "literal-password";')[0].classification, 'real');
  assert.equal(scanText('auth.ts', 'const token = `literal-password-${suffix}`;')[0].classification, 'real');
  assert.equal(scanText('auth.ts', 'const token = `kb2_${prefix}_${secret}`;')[0].classification, 'synthetic');
});

test('manifest uses exact paths, counts missing files and refuses traversal', async () => {
  const deploy = path.dirname(fileURLToPath(import.meta.url));
  const root = await mkdtemp(path.join(deploy, '.secret-scan-test-'));
  try {
    await mkdir(path.join(root, 'deploy'));
    await writeFile(path.join(root, 'allowed.env'), 'TOKEN=literal-password');
    await writeFile(path.join(root, 'unlisted.env'), 'TOKEN=unlisted-password');
    await writeFile(path.join(root, 'deploy/RELEASE_MANIFEST.md'), '## Точный список путей\n```text\nallowed.env\nmissing.env\n../outside.env\n```\n');
    const result = await scanManifest(root);
    assert.equal(result.summary.filesScanned, 1);
    assert.equal(result.summary.realSecrets, 1);
    assert.equal(result.summary.missing, 1);
    assert.equal(result.summary.errors, 1);
    assert.ok(result.findings.every(hit => hit.path === 'allowed.env'));
  } finally {
    assert.equal(path.dirname(root), deploy);
    await rm(root, { recursive: true, force: true });
  }
});

test('workflow exemption requires exact disposable test service credentials', () => {
  const fixture = '    services:\n      postgres:\n        env:\n          POSTGRES_USER: fixture_user\n          POSTGRES_PASSWORD: fixture_password\n          POSTGRES_DB: fixture_test\n';
  const synthetic = scanText('.github/workflows/ci.yml', fixture + 'DATABASE_URL: postgresql://fixture_user:fixture_password@127.0.0.1/fixture_test');
  assert.equal(synthetic[0].classification, 'synthetic');
  for (const url of ['postgresql://fixture_user:other-password@127.0.0.1/fixture_test', 'postgresql://fixture_user:fixture_password@production/fixture_test']) {
    assert.equal(scanText('.github/workflows/ci.yml', fixture + 'DATABASE_URL: ' + url)[0].classification, 'real');
  }
});
