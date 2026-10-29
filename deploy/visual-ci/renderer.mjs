import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const hash = value => createHash('sha256').update(value).digest('hex');
function treeHash(root) {
  const entries = [];
  function visit(relative = '') {
    const absolute = path.join(root, relative), stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) entries.push([relative, 'symlink', fs.readlinkSync(absolute)]);
    else if (stat.isDirectory()) for (const name of fs.readdirSync(absolute).sort()) visit(relative ? `${relative}/${name}` : name);
    else if (stat.isFile()) entries.push([relative, 'file', hash(fs.readFileSync(absolute))]);
    else throw new Error('Unexpected renderer filesystem entry');
  }
  visit(); return { entries: entries.length, sha256: hash(JSON.stringify(entries)) };
}
export function collectRenderer() {
  assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'x64');
  const chrome = '/ms-playwright/chromium-1208/chrome-linux64/chrome';
  const packages = execFileSync('dpkg-query', ['-W', '-f=${Package} ${Version} ${Status}\n'], { encoding: 'utf8' }).trim().split('\n').sort();
  const fontList = execFileSync('fc-list', ['-f', '%{file}::%{family}::%{style}\n'], { encoding: 'utf8' }).trim().split('\n').sort();
  return { schemaVersion: 1, platform: process.platform, architecture: process.arch, node: process.version,
    nodeSha256: hash(fs.readFileSync(process.execPath)), npm: execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim(),
    browser: execFileSync(chrome, ['--version'], { encoding: 'utf8' }).trim(), browserSha256: hash(fs.readFileSync(chrome)),
    osReleaseSha256: hash(fs.readFileSync('/etc/os-release')), packages: { count: packages.length, sha256: hash(JSON.stringify(packages)) },
    fonts: treeHash('/usr/share/fonts'), fontConfig: treeHash('/etc/fonts'), resolvedFontList: { count: fontList.length, sha256: hash(JSON.stringify(fontList)) } };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const actual = collectRenderer();
  if (process.argv[2] === '--record') process.stdout.write(JSON.stringify(actual, null, 2) + '\n');
  else {
    assert.deepEqual(actual, JSON.parse(fs.readFileSync(process.argv[2] || new URL('./renderer.expected.json', import.meta.url), 'utf8')), 'Canonical renderer drift');
    const record = { verified: true, stable: actual, provenance: { kernel: os.release(), cpuArchitecture: os.arch() } };
    if (process.argv[3]) fs.writeFileSync(process.argv[3], JSON.stringify(record, null, 2) + '\n');
    process.stdout.write(JSON.stringify(record) + '\n');
  }
}
