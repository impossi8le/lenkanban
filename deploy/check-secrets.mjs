// Local manifest-only heuristic scan. Never print source lines or raw values.
import { readFile, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function mask(value) {
  // Short values must not be recoverable from overlapping prefix/suffix.
  return value.length > 5 ? `${value.slice(0, 2).replace(/[^\w]/g, '*')}***${value.slice(-2).replace(/[^\w]/g, '*')}` : '***';
}

function syntheticReason(file, value, text) {
  if (/(^|\/)(?:tests?|__tests__|fixtures?|e2e)(\/|$)|\.(?:test|spec|probe)\.[cm]?[jt]sx?$/i.test(file)) return 'test-fixture';
  if (/(^|\/)(?:\.env\.example|[^/]+\.env\.example)$/.test(file)) return 'env-example';
  if (/^(?:\$\{[^}]+\}|\$[A-Z_][A-Z0-9_]*)$/.test(value)) return 'variable-substitution';
  // A composed URL is synthetic only when BOTH credential fields are variables.
  // Mixed literal/variable credentials stay real for review.
  if (/^[a-z][a-z0-9+.-]*:\/\/\$\{[^}]+\}:\$\{[^}]+\}@/i.test(value)) return 'variable-substitution';
  if (/\.[cm]?[jt]sx?$/.test(file) && /^(?:kb2_)?(?:\$\{[^}]+\}[_:]?)+$/.test(value)) return 'source-template-expression';
  try {
    const url = new URL(value);
    if (url.hostname.toLowerCase().endsWith('.invalid')) return 'reserved-invalid-address';
    // Recognize only the exact disposable PostgreSQL service credentials, not
    // all workflow values or arbitrary connections to a host named localhost.
    if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(file) && /^\s+services:\s*\n\s+postgres:/m.test(text) &&
        ['postgres:', 'postgresql:'].includes(url.protocol) && ['127.0.0.1', 'localhost'].includes(url.hostname)) {
      // A workflow may declare several postgres services — one per job — with
      // different credentials but identical indentation. Split by job first, then
      // match the URL against that job's own USER/PASSWORD/DB triple. Reading a
      // single file-wide triple would misclassify every other job's disposable
      // credentials as real.
      const db = url.pathname.slice(1);
      const matchesDisposableService = text.split(/^ {2}[A-Za-z0-9_-]+:\s*$/m).some(block => {
        const fields = Object.fromEntries([...block.matchAll(/^[ \t]+POSTGRES_(USER|PASSWORD|DB):[ \t]*([^\r\n]+)$/gm)]
          .map(m => [m[1], m[2].trim().replace(/^['"]|['"]$/g, '')]));
        return Boolean(fields.USER && fields.PASSWORD && fields.DB === db &&
          decodeURIComponent(url.username) === fields.USER &&
          decodeURIComponent(url.password) === fields.PASSWORD);
      });
      if (/(?:^test_|_test$)/.test(db) && matchesDisposableService) return 'disposable-ci-service-fixture';
    }
  } catch { /* Not a URL; do not turn arbitrary secret suffixes into exemptions. */ }
  if (/^[^@\s]+@[A-Za-z0-9.-]+\.invalid$/i.test(value)) return 'reserved-invalid-address';
  if (/^(?:synthetic(?:[_-].*)?|example|changeme|change-me|replace[-_].*|<[^>]+>)$/i.test(value)) return 'explicit-placeholder';
  return null;
}

export function scanText(file, text) {
  const findings = [];
  const envLike = /(^|\/)(?:\.env[^/]*|[^/]+\.env(?:\.[^/]*)?)$/i.test(file);
  text.split(/\r?\n/).forEach((line, index) => {
    const seen = new Set();
    function add(type, value) {
      const key = `${type}\0${value}`;
      if (seen.has(key)) return;
      seen.add(key);
      const reason = syntheticReason(file, value, text);
      findings.push({ path: file, line: index + 1, type, classification: reason ? 'synthetic' : 'real', mask: mask(value), ...(reason ? { reason } : {}) });
    }
    const patterns = [
      ['private-key', /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/g],
      ['aws-token', /\b(?:AKIA|ASIA|AIDA|AROA)[A-Z0-9]{16}\b/g],
      ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g],
      ['openai-token', /\bsk-(?:(?:proj|svcacct)-)?[A-Za-z0-9_-]{20,}\b/g],
      ['jwt', /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g],
      ['credential-url', /[a-z][a-z0-9+.-]*:\/\/[^\s:/@"'`]+:[^\s/@"'`]+@[^\s"'`<>]+/gi],
    ];
    for (const [type, regex] of patterns) for (const match of line.matchAll(regex)) add(type, match[0]);
    // Only literal assignments are credentials: const token = await getToken()
    // is executable code, not a stored value. Dotenv accepts bare values too.
    const assignment = /\b(?:[A-Z0-9]+_)*(password|passwd|secret|api_key|token|secret_access_key)\s*=\s*(?![=>\s])(?:"([^"\r\n]*)"|'([^'\r\n]*)'|`([^`\r\n]*)`|([^\s,;"'`]+))/gi;
    for (const match of line.matchAll(assignment)) {
      const value = match[2] ?? match[3] ?? match[4] ?? match[5];
      if (!value || value === '""' || value === "''") continue;
      const bare = match[5] !== undefined;
      if (bare && /\.[cm]?[jt]sx?$/.test(file) && !envLike && !/^[A-Z_][A-Z0-9_]*\s*=/.test(line.trim()) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) continue;
      add('credential-assignment', value);
    }
    if (envLike) {
      const match = line.match(/^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*)$/);
      if (match) {
        const raw = match[1].trim();
        const value = /^["'`]/.test(raw) ? raw.slice(1, raw.indexOf(raw[0], 1) < 0 ? undefined : raw.indexOf(raw[0], 1)) : raw.replace(/\s+#.*$/, '').trim();
        if (value.length > 20) add('long-env-value', value);
      }
    }
  });
  return findings;
}

export async function scanManifest(root = projectRoot, manifest = 'deploy/RELEASE_MANIFEST.md') {
  const content = await readFile(path.join(root, manifest), 'utf8');
  const section = content.split('## Точный список путей')[1];
  const block = section?.match(/```text\r?\n([\s\S]*?)\r?\n```/);
  if (!block) throw new Error('manifest-path-list-missing');
  const candidates = [...new Set(block[1].split(/\r?\n/).filter(Boolean))];
  if (!candidates.length) throw new Error('manifest-path-list-empty');
  const findings = [], missing = [], errors = [];
  let filesScanned = 0;
  const resolvedRoot = await realpath(root);
  for (const file of candidates) {
    if (path.isAbsolute(file) || file.includes('\\') || file.split('/').some(p => p === '..' || p === '.' || p === '') || /^lenkanban\//i.test(file)) {
      errors.push({ path: file, type: 'unsafe-manifest-path' });
      continue;
    }
    try {
      const target = path.join(root, file);
      // Check every ancestor: junctions must not expand the manifest boundary.
      let current = root;
      for (const part of file.split('/')) {
        current = path.join(current, part);
        if ((await lstat(current)).isSymbolicLink()) throw new Error('symlink-not-allowed');
      }
      const relative = path.relative(resolvedRoot, await realpath(target));
      if (relative.startsWith('..') || path.isAbsolute(relative) || !(await lstat(target)).isFile()) throw new Error('not-a-contained-regular-file');
      findings.push(...scanText(file, await readFile(target, 'utf8')));
      filesScanned++;
    } catch (error) {
      if (error.code === 'ENOENT') missing.push(file);
      else errors.push({ path: file, type: error.code || 'unsafe-or-unreadable-file' });
    }
  }
  const synthetic = findings.filter(f => f.classification === 'synthetic').length;
  return { findings, missing, errors, summary: { filesScanned, findings: findings.length, synthetic, realSecrets: findings.length - synthetic, missing: missing.length, errors: errors.length } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await scanManifest();
    for (const finding of result.findings) console.log(JSON.stringify(finding));
    for (const file of result.missing) console.log(JSON.stringify({ path: file, type: 'missing-file' }));
    for (const error of result.errors) console.log(JSON.stringify(error));
    console.log(JSON.stringify({ summary: result.summary }));
    process.exitCode = result.summary.realSecrets || result.missing.length || result.errors.length ? 1 : 0;
  } catch {
    console.error(JSON.stringify({ type: 'scan-failed', message: 'Manifest could not be read or parsed; scan incomplete.' }));
    process.exitCode = 1;
  }
}
