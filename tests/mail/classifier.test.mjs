import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildReport, classifyMessage, renderMarkdown } from '../../scripts/mail/classifier-core.mjs';

const message = (id, title, body_text = '', extra = {}) => ({ source_instance: 'https://mail.example', source_message_id: id, topic_id: id, source_url: `https://mail.example/?topicid=${id}`, title, body_text, content_status: 'complete', ...extra });

test('receipt requests need customer context; expense receipts remain unmatched', () => {
  assert.equal(classifyMessage(message('1', 'ЧЕКИ 2026', 'Клиент просит отправить чек по SMS')).primary_category, 'receipts');
  assert.equal(classifyMessage(message('2', 'Чеки', 'Прикладываю расходы сотрудника')).primary_category, 'unmatched');
});
test('clear report title is actionable but weak body-only evidence needs review', () => {
  assert.equal(classifyMessage(message('1', 'Отчет о проделанной работе 2026')).primary_category, 'reports');
  const weak = classifyMessage(message('2', 'Вопрос', 'Отчет о проделанной работе'));
  assert.equal(weak.primary_category, 'unmatched');
  assert.equal(weak.review_reason, 'low_confidence');
});
test('competing categories remain unmatched with separate candidate tags', () => {
  const item = classifyMessage(message('1', 'Отчет о проделанной работе — жалоба клиента'));
  assert.equal(item.primary_category, 'unmatched');
  assert.equal(item.review_reason, 'category_conflict');
  assert.deepEqual(item.secondary_tags, ['complaints', 'reports']);
});
test('identity dedup preserves identical content with different IDs and quarantines conflicts', () => {
  const a = message('a', 'Отчет о проделанной работе');
  const result = buildReport([a, { ...a, collected_at: 'later' }, message('b', a.title), { ...a, body_text: 'changed' }], [], { coverage_status: 'complete', collected_unique_messages: 2 });
  assert.equal(result.counts.collected_unique_messages, 2);
  assert.equal(result.counts.exact_duplicate_rows, 1);
  assert.equal(result.counts.conflicting_identities, 1);
  assert.equal(result.counts.classified_messages, 1);
  assert.equal(result.counts.unmatched_messages, 1);
  assert.equal(result.coverage.coverage_status, 'unverified');
  assert.equal(result.messages.find(m => m.source_message_id === 'a').review_reason, 'conflicting_duplicate');
});
test('partial coverage and topics without collected messages are separate from unmatched', () => {
  const result = buildReport([message('1', 'Неясная тема')], [{ topic_id: '2', source_url: 'https://mail.example/?topicid=2' }], { coverage_status: 'partial', discovered_unique_topics: 50, unfinished_pages: ['page3'], collected_unique_messages: 1 });
  assert.equal(result.counts.unmatched_messages, 1);
  assert.equal(result.counts.discovered_topics_without_messages, 1);
  assert.equal(result.counts.collected_message_topics, 1);
  assert.equal(result.coverage.coverage_status, 'partial');
  assert.equal(result.coverage.discovered_unique_topics, 50);
});
test('report deterministic across input order and does not expose bodies or authors', () => {
  const a = message('a', 'Жалоба клиента', 'SECRET_BODY', { author_text: 'SECRET_AUTHOR' });
  const b = message('b', 'Вопрос');
  assert.deepEqual(buildReport([a, b]), buildReport([b, a]));
  const repeated = { ...a, source_url: 'https://mail.example/?page=2' };
  assert.deepEqual(buildReport([a, repeated]), buildReport([repeated, a]));
  const output = JSON.stringify(buildReport([a]));
  assert.ok(!output.includes('SECRET_BODY'));
  assert.ok(!output.includes('SECRET_AUTHOR'));
});
test('markdown neutralizes HTML, table pipes and unsafe links', () => {
  const output = renderMarkdown(buildReport([message('1', '<script>x</script>|[click](javascript:x)', '', { source_url: 'javascript:alert(1)' })]));
  assert.ok(!output.includes('<script>'));
  assert.ok(!output.includes('](javascript:'));
  assert.ok(output.includes('&#124;'));
});
test('claimed complete coverage with unfinished pages is downgraded', () => {
  const result = buildReport([], [], { coverage_status: 'complete', unfinished_pages: 2 });
  assert.equal(result.coverage.coverage_status, 'partial');
});
test('missing IDs fail explicitly rather than merge unidentified rows', () => {
  assert.throws(() => buildReport([{ title: 'test' }]), /INVALID_MESSAGE_IDENTITY/);
});

test('unfinished topics and discovered topics with no messages prevent complete coverage', () => {
  const manifest = { coverage_status: 'complete', discovered_unique_topics: 1, collected_unique_messages: 0 };
  const topics = [{ topic_id: '1' }];
  assert.equal(buildReport([], topics, { ...manifest, unfinished_topics: ['1'] }).coverage.coverage_status, 'partial');
  assert.equal(buildReport([], topics, manifest).coverage.coverage_status, 'partial');
  const mismatch = buildReport([], topics, { ...manifest, discovered_unique_topics: 20 });
  assert.equal(mismatch.coverage.coverage_status, 'unverified');
  assert.ok(mismatch.coverage.validation_issues.includes('MANIFEST_TOPIC_COUNT_MISMATCH'));
});
test('CLI writes both reports, returns partial exit code, and hides invalid row content', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lenkanban-classifier-'));
  const cli = fileURLToPath(new URL('../../scripts/mail/classify-mail.mjs', import.meta.url));
  try {
    await writeFile(join(directory, 'messages.ndjson'), JSON.stringify(message('1', 'Отчет о проделанной работе')) + '\n');
    await writeFile(join(directory, 'manifest.json'), JSON.stringify({ coverage_status: 'partial', collected_unique_messages: 1 }));
    let run = spawnSync(process.execPath, [cli, '--input', directory], { encoding: 'utf8' });
    assert.equal(run.status, 2, run.stderr);
    const report = JSON.parse(await readFile(join(directory, 'report', 'report.json'), 'utf8'));
    assert.equal(report.counts.classified_messages, 1);
    assert.match(await readFile(join(directory, 'report', 'report.md'), 'utf8'), /partial/);
    await writeFile(join(directory, 'manifest.json'), JSON.stringify({ coverage_status: 'complete', collected_unique_messages: 1 }));
    run = spawnSync(process.execPath, [cli, '--input', directory], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    await writeFile(join(directory, 'messages.ndjson'), 'PRIVATE_INVALID_CONTENT');
    run = spawnSync(process.execPath, [cli, '--input', directory], { encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /INVALID_NDJSON line 1/);
    assert.ok(!run.stderr.includes('PRIVATE_INVALID_CONTENT'));
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    await rm(directory, { recursive: true, force: true });
  }
});
