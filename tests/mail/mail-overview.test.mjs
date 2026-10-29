import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join, resolve, sep, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { classifyPreview, overviewCoverage, aggregateOverview, renderOverviewSummary } from '../../scripts/mail/mail-overview.mjs';
import { openStore } from '../../scripts/mail/iab-store.mjs';

const page = (n, status = 'done') => ({ url: `https://basa.lenremont.com/modules/basemail/basemail.php?folder=all&page=${n}`, status });
test('preview is provisional, visible excerpt helps an otherwise opaque title', () => {
  const result = classifyPreview({ title: '12345678', initial_excerpt: 'Просим установить программу и предоставить доступ в систему.' });
  assert.equal(result.category, 'it_support'); assert.equal(result.basis, 'preview'); assert.equal(result.review_required, true);
  assert.equal(classifyPreview({ title: '12345678' }).category, 'unmatched');
});
test('explicit process title retains primary purpose and empty titles remain visible', () => {
  assert.equal(classifyPreview({ title: 'Отчет о проделанной работе', initial_excerpt: 'Проверены счета, чеки, жалобы.' }).category, 'reports');
  assert.equal(classifyPreview({ title: '', initial_excerpt: '' }).reason, 'missing_title_and_preview');
});
test('employee expense receipts and competing processes are not forced into a customer board', () => {
  assert.notEqual(classifyPreview({ title: '12345', initial_excerpt: 'Авансовый отчёт сотрудника: чеки для возмещения командировочных расходов.' }).category, 'receipts');
  assert.equal(classifyPreview({ title: 'Прозвонить: сотрудничество', initial_excerpt: 'Уточнить условия.' }).reason, 'conflicting_title_rules');
});
test('equal previews with distinct source identities remain separate topics', () => {
  const rows = ['1', '2'].map(topic_id => ({ topic_id, title: '12345', initial_excerpt: 'Просим установить программу.' }));
  const output = [];
  const report = aggregateOverview({ topics: rows, coverage: overviewCoverage([page(1)], 1), onTopic: row => output.push(row) });
  assert.equal(report.counts.indexed_topics, 2); assert.equal(output.length, 2);
  assert.notEqual(output[0].topic_id, output[1].topic_id);
});
test('a complete observed page range is separate from deep mail coverage; gaps and extra pages block it', () => {
  const complete = overviewCoverage([page(1), page(2)], 2);
  assert.equal(complete.status, 'observed_range_complete'); assert.equal(complete.full_discussions_collected, false);
  assert.equal(overviewCoverage([page(1), page(3)], 3).status, 'partial');
  assert.equal(overviewCoverage([page(1), page(2), page(3, 'failed')], 2).status, 'partial');
  assert.deepEqual(overviewCoverage([page(1), page(1)], 2).missing_list_pages, [2]);
  assert.throws(() => overviewCoverage([], 0), /INVALID_EXPECTED_PAGES/);
});
test('topic balance and publication exclude source previews, titles, authors and identifiers', () => {
  const marker = 'PRIVATE_MARKER_98422';
  const rows = [{ topic_id: marker, title: 'Отчет о проделанной работе', initial_excerpt: marker, author_text: marker }, { topic_id: '2', title: '', initial_excerpt: '' }];
  const report = aggregateOverview({ topics: rows, coverage: overviewCoverage([page(1)], 2) });
  assert.equal(report.counts.indexed_topics, report.counts.provisional_grouped_topics + report.counts.unmatched_topics);
  assert.equal(report.counts.missing_title_topics, 1);
  assert.equal(JSON.stringify(report).includes(marker), false);
  assert.equal(renderOverviewSummary(report).includes(marker), false);
  assert.match(renderOverviewSummary(report), /partial/);
  assert.match(renderOverviewSummary(report), /не считаются прочитанными/);
});

test('date-window overview separates missing and historical dates and exposes current evidence without inventing recurrence', () => {
  const make = (id, date) => ({ topic_id: id, title: 'Отчет о проделанной работе', list_header_dates: { author_header: '01.01.2020 00:00', secondary_header: date } });
  const rows = [make('1', '20.10.2026 23:59'), make('2', '01.01.2025 00:00'), make('3', '31.12.2024 23:59'), make('4', null), make('5', '21.10.2026 00:00')];
  const report = aggregateOverview({ topics: rows, coverage: overviewCoverage([page(1)], 100), window: { from: '2025-01-01', to: '2026-10-20' } });
  assert.deepEqual(report.temporal.buckets, { in_window: 2, before_window: 1, after_window: 1, unknown: 1 });
  assert.equal(report.counts.indexed_topics, 2);
  assert.equal(report.groups[0].activity.latest, '2026-10-20T23:59:00');
  assert.deepEqual(report.groups[0].activity.year_counts, { '2025': 1, '2026': 1 });
  assert.equal(report.groups[0].activity.recommendation, 'candidate_requires_process_owner_validation');
  assert.match(renderOverviewSummary(report), /не доказывают повторяемость/);
  assert.match(renderOverviewSummary(report), /дата неизвестна — 1/);
  const stale = aggregateOverview({ topics: [make('2', '01.01.2025 00:00')], coverage: overviewCoverage([page(1)], 100), window: { from: '2025-01-01', to: '2026-10-20' } });
  assert.equal(stale.groups[0].activity.recommendation, 'insufficient_recent_evidence');
});
test('CLI audits every preview and finishes a list range while deep queues remain explicitly unreviewed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mail-overview-test-'));
  const url = 'https://basa.lenremont.com/modules/basemail/basemail.php?folder=all';
  let store;
  try {
    store = await openStore({ dir, scope: { url, filter: 'all_topics' } });
    const input = (n, id) => ({ url: `${url}&page=${n}`, filter_confirmed: true, pagination_verified: true,
      topics: [{ topic_id: id, title: 'PRIVATE_SAMPLE_3929', initial_excerpt: 'PRIVATE_PREVIEW_9441', source_url: `${url}&topicid=${id}`, message_count_hint: 2 }], page_links: [`${url}&page=2`] });
    store.ingestListPage(input(1, '1'));
    await store.checkpoint();
    const command = () => spawnSync(process.execPath, [fileURLToPath(new URL('../../scripts/mail/mail-overview.mjs', import.meta.url)), '--input', dir, '--expected-list-pages', '2'], { encoding: 'utf8' });
    assert.equal(command().status, 2);
    store.ingestListPage(input(2, '2'));
    await store.checkpoint();
    assert.ok(store.nextTopicPage(), 'deep-read queue deliberately remains pending');
    assert.equal(command().status, 0);
    const summary = await readFile(join(dir, 'overview', 'overview.md'), 'utf8');
    assert.equal(summary.includes('PRIVATE_'), false);
    const detailed = (await readFile(join(dir, 'overview', 'topics-overview.ndjson'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(detailed.length, 2);
    assert.notEqual(detailed[0].topic_id, detailed[1].topic_id);
    const result = JSON.parse(await readFile(join(dir, 'overview', 'overview.json'), 'utf8'));
    assert.equal(result.coverage.full_discussions_collected, false);
    assert.equal(result.coverage.status, 'observed_range_complete');
    const fixtureDb = new DatabaseSync(join(dir, 'mail.sqlite'));
    fixtureDb.prepare('UPDATE topics SET record_json=? WHERE topic_id=?').run('invalid JSON', '2');
    fixtureDb.close();
    assert.equal(command().status, 1);
    assert.equal(await readFile(join(dir, 'overview', 'overview.md'), 'utf8'), summary, 'last good summary survives failed generation');
    assert.deepEqual((await readdir(join(dir, 'overview'))).filter(name => name.endsWith('.tmp')), [], 'failed generation removes its private partial files');
  } finally {
    await store?.close();
    const target = resolve(dir), parent = resolve(tmpdir());
    if (!target.startsWith(parent + sep) || !basename(target).startsWith('mail-overview-test-')) throw Error('INVALID_TEST_CLEANUP_TARGET');
    await rm(target, { recursive: true, force: true });
  }
});
