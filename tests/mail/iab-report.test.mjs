import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { aggregateIab, classifyIab, renderIabMarkdown, writeIabReport, readIabMessages, verifyReceiptContext, receiptContextForMessage, readIabTopicContexts } from '../../scripts/mail/iab-report.mjs';
const topic = (id, title, extra = {}) => ({ topic_id: id, title, source_url: `https://mail.example/?topicid=${id}`, ...extra });
const message = (id, title, extra = {}) => ({ ...topic(id, title), source_instance: 'https://mail.example', source_message_id: id, body_text: '', content_status: 'complete', ...extra });

test('title-only receipt category is provisional, actual expenses remain unmatched', () => {
  const provisional = classifyIab(topic('1', 'ЧЕКИ 2026'), true);
  assert.equal(provisional.primary_category, 'receipts');
  assert.equal(provisional.confidence, 'provisional_title_only');
  assert.equal(provisional.review_required, true);
  assert.equal(classifyIab(message('1', 'ЧЕКИ 2026', { body_text: 'Расходы сотрудника' })).primary_category, 'unmatched');
});
test('procurement and IT are candidates but conflicts and body-only evidence need review', () => {
  assert.equal(classifyIab(topic('1', 'Закупка картриджей'), true).primary_category, 'procurement');
  assert.equal(classifyIab(message('1', 'Установить программу')).primary_category, 'it_support');
  assert.equal(classifyIab(message('2', 'Вопрос', { body_text: 'Нужны картриджи' })).review_reason, 'body_only_evidence');
  assert.equal(classifyIab(message('3', 'Закупка картриджей — жалоба клиента')).review_reason, 'category_conflict');
});

test('explicit report process keeps embedded work subjects as secondary tags', () => {
  const result = classifyIab(message('1', 'Отчет о проделанной работе 2026', { body_text: 'Разобраны жалобы клиентов, отправлены чеки клиентам, закупка картриджей.' }));
  assert.equal(result.primary_category, 'reports');
  assert.deepEqual(result.secondary_tags, ['complaints', 'procurement', 'receipts']);
  assert.equal(result.review_required, false);
  assert.equal(classifyIab(message('2', 'Отчет о проделанной работе — жалобы клиентов')).primary_category, 'unmatched');
});

test('invoice register titles identify a candidate process without guessing ambiguous limits', () => {
  assert.equal(classifyIab(topic('1', 'Счета_ОКТЯБРЬ_ОП_2026'), true).primary_category, 'invoices');
  assert.equal(classifyIab(message('1', 'Счета_ОКТЯБРЬ_ОП_2026')).primary_category, 'invoices');
  assert.equal(classifyIab(message('2', 'Насчёт графика')).primary_category, 'unmatched');
  assert.equal(classifyIab(message('3', 'Лимиты с 10.10')).primary_category, 'unmatched');
});

test('explicit leave, break schedule and cashless statements identify distinct tools', () => {
  assert.equal(classifyIab(message('1', 'Отпуска 2026')).primary_category, 'leave_planning');
  assert.equal(classifyIab(message('2', 'ПЕРЕРЫВ новое с 02.09')).primary_category, 'breaks');
  assert.equal(classifyIab(message('3', 'ВЫПИСКИ БЕЗНАЛ ОП 2026')).primary_category, 'finance_docs');
  assert.equal(classifyIab(message('4', 'СОТРУДНИЧЕСТВО 2025')).primary_category, 'business_cooperation');
  assert.equal(classifyIab(message('5', 'Закрытый клуб друзей Ленремонта 2025 г. - ВТОРАЯ ЧАСТЬ')).primary_category, 'club');
});

test('source counter accepts current objects and historical integers without object stringification', () => {
  for (const observed_counter of [52594, { value: 52594, unit: 'unverified' }]) {
    const report = aggregateIab({ topics: [], messages: [], manifest: { observed_counter } });
    assert.equal(report.coverage.source_counter, 52594);
    const text = renderIabMarkdown(report);
    assert.ok(text.includes('52594'));
    assert.ok(!text.includes('[object Object]'));
  }
  assert.equal(aggregateIab({ topics: [], messages: [], manifest: { observed_counter: { value: 'secret', unit: 'unverified' } } }).coverage.source_counter, null);
});

test('date metadata audit remains visible independently of content classification', () => {
  const base = { topics: [], messages: [message('1', 'Жалоба клиента')], manifest: {} };
  const pending = aggregateIab(base);
  assert.equal(pending.coverage.date_audit.status, 'pending_replay');
  assert.ok(renderIabMarkdown(pending).includes('pending&#95;replay'));
  const audit = { status: 'observed_author_header', parser_version: 'basemail-author-date-v2', observed_messages: 1, legacy_messages: 0 };
  const checked = aggregateIab({ ...base, manifest: { date_audit: audit } });
  assert.deepEqual(checked.coverage.date_audit, audit);
  assert.equal(checked.counts.classified_messages, pending.counts.classified_messages);
});

test('diagnostic unmatched families can overlap without changing the exclusive balance', () => {
  const report = aggregateIab({ topics: [topic('1', 'Отчет мастера'), topic('2', 'T123456')], messages: [] });
  assert.equal(report.counts.unmatched_topics, 2);
  assert.equal(report.unmatched_families.find(f => f.id === 'generic_reports').topics, 1);
  assert.equal(report.unmatched_families.find(f => f.id === 'masters').topics, 1);
  assert.equal(report.unmatched_families.find(f => f.id === 'number_only').topics, 1);
  const text = renderIabMarkdown(report);
  assert.ok(text.includes('Выборка смещена'));
  assert.ok(text.includes('не суммируются'));
  assert.ok(text.includes('временная статистика не строится'));
});

test('observed onboarding, access revocation and headset orders have explicit process rules', () => {
  assert.equal(classifyIab(message('1', 'Новый партнер')).primary_category, 'partner');
  for (const title of ['Доступ в базы новому сотруднику', 'доступ к эл. почтам', 'Добавить в тему сотрудника', 'Закрыть базу', 'В9 необходима замена БП в пк']) assert.equal(classifyIab(message('2', title)).primary_category, 'it_support');
  assert.equal(classifyIab(message('3', 'Просьба заказать гарнитуру (наушники)')).primary_category, 'procurement');
  assert.equal(classifyIab(message('4', 'Партнер', { body_text: 'Вопросы по договору' })).primary_category, 'unmatched');
});

test('recurring callbacks and timesheets are separate from sales and salary decisions', () => {
  assert.equal(classifyIab(topic('1', 'прозвонить 08.11'), true).primary_category, 'callbacks');
  assert.equal(classifyIab(topic('2', 'табель-сотрудник'), true).primary_category, 'timesheets');
  assert.equal(classifyIab(topic('3', 'ДОСТУП', { initial_excerpt: 'Настроить VPN, доступ к БМ/БЛ и внутренний номер' }), true).primary_category, 'it_support');
  assert.equal(classifyIab(topic('4', 'ДОСТУП'), true).primary_category, 'unmatched');
  assert.equal(classifyIab(topic('5', 'Доступ на территорию'), true).primary_category, 'unmatched');
  assert.equal(classifyIab(topic('6', 'Устойчивость'), true).primary_category, 'unmatched');
  assert.equal(classifyIab(topic('7', 'табельный номер'), true).primary_category, 'unmatched');
  const report = aggregateIab({ topics: [topic('2', 'табель-сотрудник')], messages: [] });
  const group = report.groups.find(g => g.id === 'timesheets');
  assert.equal(group.proposal_type, 'registry');
  assert.ok(group.access.includes('уполномоченные'));
});
test('provisional topics never inflate message counts; unseen archive never becomes unmatched', () => {
  const report = aggregateIab({ topics: [topic('1', 'Закупка картриджей'), topic('2', 'Привет')], messages: [message('1', 'Закупка картриджей')], manifest: { coverage_status: 'partial', expected_pages: 2630, discovered_unique_topics: 2, collected_unique_messages: 1, source_counter: 52594 } });
  assert.deepEqual(report.counts, { discovered_unique_topics: 2, provisional_assigned_topics: 1, unmatched_topics: 1, collected_unique_messages: 1, classified_messages: 1, unmatched_messages: 0, complete_content_messages: 1, review_required_messages: 0 });
  assert.equal(report.coverage.status, 'partial');
  assert.equal(report.coverage.source_counter_unit, 'unverified');
});
test('complete declaration is insufficient for missing contents, mismatched counts or failures', () => {
  const base = { topics: [topic('1', 'Жалоба')], messages: [message('1', 'Жалоба')], manifest: { coverage_status: 'complete', discovered_unique_topics: 1, collected_unique_messages: 1 } };
  assert.equal(aggregateIab(base).coverage.status, 'complete');
  for (const patch of [{ unfinished_pages: 1 }, { failed_topics: ['1'] }, { discovered_unique_topics: 50 }]) assert.equal(aggregateIab({ ...base, manifest: { ...base.manifest, ...patch } }).coverage.status, 'partial');
  assert.equal(aggregateIab({ ...base, messages: [message('1', 'Жалоба', { content_status: 'unsupported' })] }).coverage.status, 'partial');
  assert.equal(aggregateIab({ topics: [], messages: [], manifest: { coverage_status: 'complete' } }).coverage.status, 'unverified');
});
test('streaming aggregation retains only bounded examples and no bodies/contacts', () => {
  function* messages() { for (let i = 0; i < 10000; i++) yield message(String(i), 'Жалоба клиента', { body_text: 'PRIVATEBODY', author_text: 'PRIVATEAUTHOR', attachments: [{ name: 'PRIVATEFILE' }] }); }
  const report = aggregateIab({ topics: [], messages: messages() });
  assert.equal(report.counts.collected_unique_messages, 10000);
  assert.equal(report.groups.find(g => g.id === 'complaints').examples.length, 5);
  assert.ok(!JSON.stringify(report).includes('PRIVATE'));
});
test('Markdown escapes untrusted titles and strips unsafe links', () => {
  const output = renderIabMarkdown(aggregateIab({ topics: [topic('1', 'Жалоба <script>alert(1)</script>|[x](javascript:a)', { source_url: 'javascript:alert(1)' })], messages: [] }));
  assert.ok(!output.includes('<script>'));
  assert.ok(!output.includes('](javascript:'));
});
test('complete audit files contain every result and preserve unique different IDs', async () => {
  const output = await mkdtemp(join(tmpdir(), 'iab-report-'));
  try {
    const report = await writeIabReport({ topics: [topic('1', 'Привет'), topic('2', 'Привет')], messages: [message('a', 'Привет'), message('b', 'Привет')], manifest: {}, output });
    assert.equal(report.counts.unmatched_messages, 2);
    const rows = (await readFile(join(output, 'unmatched-messages.ndjson'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(rows.map(r => r.source_message_id), ['a', 'b']);
    assert.equal(rows.every(r => r.review_reason === 'no_matching_rule'), true);
    assert.equal((await readFile(join(output, 'topics-classified.ndjson'), 'utf8')).trim().split('\n').length, 2);
    assert.ok((await readFile(join(output, 'report.md'), 'utf8')).includes('unverified'));
  } finally { await rm(output, { recursive: true, force: true }); }
});
test('identity fallbacks and conflicts are visible and store progress fields are preserved', () => {
  assert.equal(classifyIab(message('1', 'Жалоба', { identity_method: 'page_position_fallback' })).review_reason, 'unstable_identity');
  assert.equal(classifyIab(message('1', 'Жалоба', { identity_conflict: true })).review_reason, 'conflicting_duplicate');
  const report = aggregateIab({ topics: [], messages: [], manifest: { coverage_status: 'complete', conflict_versions: 1, completed_list_pages: 12, completed_topic_pages: 5, observed_counter: 52594, quarantined_pages: 2 } });
  assert.equal(report.coverage.status, 'partial');
  assert.equal(report.coverage.collected_pages, 12);
  assert.equal(report.coverage.source_counter, 52594);
  assert.equal(report.coverage.quarantined_pages, 2);
});

test('SQLite audit resolution clears only its exact variant, future conflicts stay unmatched', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE messages(identity TEXT PRIMARY KEY,topic_id TEXT,record_json TEXT); CREATE TABLE conflicts(identity TEXT,signature TEXT); CREATE TABLE conflict_resolutions(identity TEXT,signature TEXT);');
    db.prepare('INSERT INTO messages VALUES(?,?,?)').run('id1', '1', JSON.stringify(message('1', 'Жалоба клиента')));
    db.prepare('INSERT INTO conflicts VALUES(?,?)').run('id1', 'old-rendering');
    assert.equal(classifyIab([...readIabMessages(db)][0]).review_reason, 'conflicting_duplicate');
    db.prepare('INSERT INTO conflict_resolutions VALUES(?,?)').run('id1', 'old-rendering');
    assert.equal([...readIabMessages(db)][0].identity_conflict, false);
    db.prepare('INSERT INTO conflicts VALUES(?,?)').run('id1', 'new-content');
    db.prepare('INSERT INTO conflict_resolutions VALUES(?,?)').run('different-identity', 'new-content');
    assert.equal(classifyIab([...readIabMessages(db)][0]).review_reason, 'conflicting_duplicate');
  } finally { db.close(); }
});

test('historical SQLite without resolution table keeps conflicts on review', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE messages(identity TEXT PRIMARY KEY,topic_id TEXT,record_json TEXT); CREATE TABLE conflicts(identity TEXT,signature TEXT);');
    db.prepare('INSERT INTO messages VALUES(?,?,?)').run('id1', '1', JSON.stringify(message('1', 'Жалоба клиента')));
    db.prepare('INSERT INTO conflicts VALUES(?,?)').run('id1', 'variant');
    assert.equal([...readIabMessages(db)][0].identity_conflict, true);
  } finally { db.close(); }
});

const receiptOpening = () => message('post_1', 'ЧЕКИ 2026', { topic_id: 'receipt-topic', body_text: 'Специальная группа: если звонят клиенты и просят отправить чек, пишите сюда.' });

test('receipt context has provenance without changing own classification or counting episodes', () => {
  const context = verifyReceiptContext(receiptOpening());
  assert.equal(context.evidence_source_message_id, 'post_1');
  assert.equal(context.scope, 'thread_process_only');
  const short = message('post_2', 'ЧЕКИ 2026', { topic_id: 'receipt-topic', body_text: 'Сформировать, не отправлять' });
  assert.equal(classifyIab(short).primary_category, 'unmatched');
  const report = aggregateIab({ topics: [], messages: [receiptOpening(), short], topicContexts: new Map([['receipt-topic', context]]) });
  assert.equal(report.counts.collected_unique_messages, 2);
  assert.equal(report.counts.classified_messages, 1);
  assert.equal(report.topic_process_context.counts.supported_messages, 2);
  assert.equal(report.topic_process_context.counts.inherited_only_messages, 1);
  assert.equal(report.topic_process_context.counts.own_and_context_messages, 1);
  assert.ok(!JSON.stringify(report.topic_process_context).includes('Специальная'));
});

test('unverified openings, staff expenses, substantive conflicts never inherit receipts', () => {
  assert.equal(verifyReceiptContext({ ...receiptOpening(), identity_conflict: true }), null);
  assert.equal(verifyReceiptContext({ ...receiptOpening(), body_text: 'Чеки расходов сотрудников' }), null);
  const context = verifyReceiptContext(receiptOpening());
  for (const row of [message('2', 'ЧЕКИ 2026', { body_text: 'Авансовый отчёт командировочных расходов' }), message('3', 'ЧЕКИ 2026', { identity_conflict: true }), message('4', 'ЧЕКИ 2026', { body_text: 'Прошу возместить расходы на поездку' }), message('5', 'ЧЕКИ 2026', { content_status: 'missing_body' })]) assert.equal(receiptContextForMessage(row, classifyIab(row), context).status, 'excluded');
});

test('SQLite context uses earliest stable opening only after source counts match', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE messages(identity TEXT PRIMARY KEY,topic_id TEXT,record_json TEXT); CREATE TABLE topics(topic_id TEXT PRIMARY KEY,record_json TEXT); CREATE TABLE conflicts(identity TEXT,signature TEXT);');
    const opening = receiptOpening();
    db.prepare('INSERT INTO messages VALUES(?,?,?)').run('id1', opening.topic_id, JSON.stringify(opening));
    db.prepare('INSERT INTO topics VALUES(?,?)').run(opening.topic_id, JSON.stringify({ message_count_hint: 2 }));
    assert.equal(readIabTopicContexts(db).size, 0);
    db.prepare('INSERT INTO messages VALUES(?,?,?)').run('id2', opening.topic_id, JSON.stringify({ ...opening, source_message_id: 'post_2', body_text: 'Готово' }));
    assert.equal(readIabTopicContexts(db).size, 1);
    db.prepare('INSERT INTO conflicts VALUES(?,?)').run('id1', 'changed');
    assert.equal(readIabTopicContexts(db).size, 0);
  } finally { db.close(); }
});
