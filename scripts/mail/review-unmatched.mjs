#!/usr/bin/env node
import { DatabaseSync } from 'node:sqlite';
import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { buildReviewedOverview } from './review-ledger.mjs';
import { overviewCoverage, renderOverviewSummary } from './mail-overview.mjs';

async function main() {
  const args = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i++) {
    if (!['--input', '--review-dir', '--output'].includes(args[i]) || !args[i + 1]) throw Error('INVALID_ARGUMENTS');
    options[args[i].slice(2)] = args[++i];
  }
  if (!options.input || !options['review-dir']) throw Error('MISSING_ARGUMENTS');
  const input = resolve(options.input), reviewDir = resolve(options['review-dir']);
  const output = resolve(options.output ?? join(reviewDir, 'result'));
  const json = async path => JSON.parse(await readFile(path, 'utf8'));
  const manifest = await json(join(reviewDir, 'manifest.json'));
  const range = /^1-(\d+)$/.exec(manifest.scope?.selected_list_pages ?? '');
  if (!range || !Array.isArray(manifest.chunks) || !manifest.chunks.length) throw Error('INVALID_MANIFEST');
  const corpusText = await readFile(join(reviewDir, 'topics.ndjson'), 'utf8');
  if (createHash('sha256').update(corpusText).digest('hex') !== manifest.safe_corpus_sha256) throw Error('CORRUPTED_CORPUS_FILE');
  const corpus = corpusText.trim().split('\n').filter(Boolean).map(JSON.parse);
  const mapping = await json(join(reviewDir, 'mapping.json'));
  const frozen = await json(join(reviewDir, 'source-baseline.json'));
  const firstReview = [...await json(join(reviewDir, 'native-a.json')), ...await json(join(reviewDir, 'native-b.json'))];
  const secondReview = await json(join(reviewDir, 'independent.json'));
  let adjudications = [];
  try { adjudications = await json(join(reviewDir, 'adjudications.json')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const db = new DatabaseSync(join(input, 'mail.sqlite'), { readOnly: true });
  let topics, coverage;
  try {
    db.exec('PRAGMA busy_timeout=5000; BEGIN');
    topics = db.prepare('SELECT record_json FROM topics ORDER BY CAST(topic_id AS INTEGER)').all().map(row => JSON.parse(row.record_json));
    const pages = db.prepare("SELECT url,status FROM pages WHERE kind='list'").all().filter(p => p.status !== 'pending' || Number(new URL(p.url).searchParams.get('page') || 1) <= Number(range[1]));
    coverage = { ...overviewCoverage(pages, Number(range[1])), scope: 'selected_list_page_range', period_completeness: 'not_independently_verified_beyond_selected_pages' };
    db.exec('ROLLBACK');
  } finally { db.close(); }
  const detailed = [], unmatched = [];
  const report = buildReviewedOverview({ topics, coverage, window: { from: manifest.scope.from, to: manifest.scope.to }, mapping, corpus, baselineSnapshotSha256: frozen.sha256, firstReview, secondReview, adjudications,
    onTopic: row => { detailed.push(row); if (row.category === 'unmatched') unmatched.push(row); },
  });
  report.review_audit.reviewers = { primary: 'Codex subagents: two non-overlapping halves', independent: 'Separate Codex subagent: all baseline topics' };
  const goStatus = await json(join(reviewDir, 'go-status.json'));
  if (goStatus.status !== 'usage_limit' || goStatus.reviewed_topics !== 0 || goStatus.limit !== '5 hour') throw Error('INVALID_GO_STATUS');
  report.review_audit.opencode_go = { status: goStatus.status, reviewed_topics: 0, limit: goStatus.limit };
  await mkdir(output, { recursive: true });
  const suffix = `.${randomUUID()}.tmp`, temporary = [];
  try {
    for (const [name, content] of [
      ['reviewed-overview.json', JSON.stringify(report, null, 2) + '\n'],
      ['reviewed-overview.md', renderOverviewSummary(report)],
      ['reviewed-topics.ndjson', detailed.map(row => JSON.stringify(row)).join('\n') + '\n'],
      ['reviewed-unmatched.ndjson', unmatched.map(row => JSON.stringify(row)).join('\n') + (unmatched.length ? '\n' : '')],
    ]) {
      const path = join(output, name); temporary.push(path + suffix);
      await writeFile(path + suffix, content, { mode: 0o600 });
      await rename(path + suffix, path);
    }
  } finally { await Promise.allSettled(temporary.map(path => unlink(path))); }
  console.log(JSON.stringify({ counts: report.counts, review_audit: report.review_audit }));
  process.exitCode = report.review_audit.disagreements > report.review_audit.adjudicated || coverage.status !== 'observed_range_complete' ? 2 : 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(() => { console.error('MAIL_REVIEW_FAILED: invalid, missing or stale review evidence; source content is not printed.'); process.exitCode = 1; });
