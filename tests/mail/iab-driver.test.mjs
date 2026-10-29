import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../scripts/mail/iab-store.mjs';
import { readListDom, readTopicDom, collectBatch } from '../../scripts/mail/iab-driver.mjs';
import { classifyIab } from '../../scripts/mail/iab-report.mjs';
import { classifyTopicActivity } from '../../scripts/mail/mail-date-window.mjs';

const base = 'https://mail.example.test/basemail.php?folder=all';
const topicUrl = `${base}&topicid=8&folderid=0`;
const topic = { topic_id: '8', title: 'Synthetic topic', source_url: topicUrl, message_count_hint: 1 };
const list = extra => ({ url: base, topics: [topic], page_links: [], recognized: true, filter_confirmed: true, pagination_verified: true, ...extra });
const page = extra => ({ url: topicUrl, topic_id: '8', title: topic.title, messages: [{ source_message_id: 'post_1', body_text: 'Synthetic', content_status: 'complete' }], page_links: [], recognized: true, pagination_verified: true, content_verified: true, ...extra });
async function fixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'iab-driver-'));
  const store = await openStore({ dir, scope: base });
  try { await fn(store, dir); } finally { store.close(); await rm(dir, { force: true, recursive: true }); }
}
function fakeTab(responses, { gotoThrows = false } = {}) {
  let calls = 0, pressed = false;
  const events = [];
  return { events,
    async goto() { events.push('goto'); if (gotoThrows) throw new Error('timeout'); },
    async getAXState() { events.push('snapshot'); },
    playwright: {
      locator() { return { first() { return { async waitFor() { events.push('ready'); } }; } }; },
      async evaluate() { events.push('evaluate'); return structuredClone(responses[Math.min(calls++, responses.length - 1)]); },
      getByRole() { return { async isVisible() { return false; }, async press() { pressed = true; events.push('press'); }, async waitFor() { assert.ok(pressed); events.push('wait'); } }; },
    },
  };
}

test('valid rendered page survives navigation timeout and checkpoints before returning', async () => fixture(async store => {
  let checkpoints = 0;
  const original = store.checkpoint;
  store.checkpoint = async () => { checkpoints++; return original(); };
  const tab = fakeTab([list()], { gotoThrows: true });
  const result = await collectBatch({ tab, store });
  assert.equal(result.results[0].navigation_timed_out, true);
  assert.equal(result.progress.completed_list_pages, 1);
  assert.equal(checkpoints, 1);
  assert.deepEqual(tab.events, ['goto', 'ready', 'ready', 'snapshot', 'evaluate']);
}));

test('stale rendered URL is durably recorded rather than ingesting another page', async () => fixture(async store => {
  const result = await collectBatch({ tab: fakeTab([list({ url: `${base}&page=2` })]), store });
  assert.equal(result.results[0].code, 'STALE_OR_UNEXPECTED_PAGE');
  assert.equal(result.progress.discovered_unique_topics, 0);
  assert.equal(result.progress.failed_pages, 1);
}));

test('show all activation is awaited and verified before ingesting', async () => fixture(async store => {
  const tab = fakeTab([list({ filter_confirmed: false, button_text: 'Показать все темы' }), list({ button_text: 'Скрыть все темы' })]);
  const result = await collectBatch({ tab, store });
  assert.equal(result.progress.completed_list_pages, 1);
  assert.deepEqual(tab.events, ['goto', 'ready', 'ready', 'snapshot', 'evaluate', 'press', 'wait', 'snapshot', 'evaluate']);
}));

test('a still filtered list is never certified as the archive', async () => fixture(async store => {
  const result = await collectBatch({ tab: fakeTab([list({ filter_confirmed: false })]), store });
  assert.equal(result.results[0].code, 'ALL_TOPICS_FILTER_NOT_CONFIRMED');
}));

test('missing message body quarantines topic and preserves raw extracted content', async () => fixture(async store => {
  store.ingestListPage(list());
  const result = await collectBatch({ tab: fakeTab([page({ content_verified: false, messages: [{ source_message_id: 'post_1', content_status: 'missing_body' }] })]), store, kind: 'topic' });
  assert.equal(result.results[0].status, 'quarantined');
  assert.equal(result.progress.completed_topic_pages, 0);
  assert.equal(result.progress.collected_unique_messages, 1);
}));

test('message count discrepancy without pagination quarantines instead of claiming complete topic', async () => fixture(async store => {
  store.ingestListPage(list());
  const result = await collectBatch({ tab: fakeTab([page()]), store, kind: 'topic', getTopic: async () => ({ title: topic.title, message_count_hint: 172 }) });
  assert.equal(result.results[0].count_mismatch.expected_hint, 172);
  assert.equal(result.results[0].count_mismatch.reason, 'source_count_not_reconciled');
  assert.equal(result.progress.quarantined_pages, 1);
}));

test('batch budget leaves remaining list pages pending', async () => fixture(async store => {
  const result = await collectBatch({ tab: fakeTab([list({ page_links: [`${base}&page=2`] })]), store, maxPages: 1 });
  assert.equal(result.results.length, 1);
  assert.equal(store.nextListPage().url.includes('page=2'), true);
}));

test('URL of requested second page cannot mask stale first-page DOM', async () => fixture(async store => {
  store.ingestListPage(list({ page_links: [`${base}&page=2`] }));
  const result = await collectBatch({ tab: fakeTab([list({ url: `${base}&page=2`, active_page: 1 })]), store });
  assert.equal(result.results[0].code, 'STALE_OR_UNEXPECTED_PAGE');
  assert.equal(result.progress.completed_list_pages, 1);
}));

test('observed active second page is processed after readiness wait', async () => fixture(async store => {
  store.ingestListPage(list({ page_links: [`${base}&page=2`] }));
  const tab = fakeTab([list({ url: `${base}&page=2`, active_page: 2, topics: [{ ...topic, topic_id: '9', source_url: `${base}&topicid=9` }] })]);
  const result = await collectBatch({ tab, store, maxPages: 1 });
  assert.equal(result.progress.completed_list_pages, 2);
  assert.equal(tab.events.filter(e => e === 'ready').length, 3);
}));

test('repeated page fingerprint reports quarantine in batch results as well as durable progress', async () => fixture(async store => {
  store.ingestListPage(list({ page_links: [`${base}&page=2`] }));
  const result = await collectBatch({ tab: fakeTab([list({ url: `${base}&page=2`, active_page: 2 })]), store });
  assert.equal(result.results[0].status, 'quarantined');
  assert.equal(result.progress.repeated_page_responses, 1);
}));

test('long discussions are read in bounded chunks with stable IDs and complete union', async () => fixture(async store => {
  store.ingestListPage(list());
  const makeChunk = (offset, size) => page({ total_dom_messages: 1200, message_offset: offset, messages: Array.from({ length: size }, (_, i) => ({ source_message_id: `post_${offset + i}`, body_text: 'Synthetic', content_status: 'complete' })) });
  const result = await collectBatch({ tab: fakeTab([makeChunk(0, 500), makeChunk(500, 500), makeChunk(1000, 200)]), store, kind: 'topic', getTopic: () => ({ ...topic, message_count_hint: 1200 }) });
  assert.equal(result.progress.collected_unique_messages, 1200);
  assert.equal(result.results[0].status, 'done');
}));

test('changing message count during chunks fails safely instead of certifying mixed content', async () => fixture(async store => {
  store.ingestListPage(list());
  const result = await collectBatch({ tab: fakeTab([page({ total_dom_messages: 2, message_offset: 0 }), page({ total_dom_messages: 3, message_offset: 1 })]), store, kind: 'topic' });
  assert.equal(result.results[0].code, 'SOURCE_CHANGED_DURING_PAGE');
  assert.equal(result.progress.collected_unique_messages, 0);
}));

test('a too-large AX frame does not prevent verified bounded DOM extraction', async () => fixture(async store => {
  store.ingestListPage(list());
  const tab = fakeTab([page()]);
  tab.getAXState = async () => { throw new Error('native frame limit'); };
  const result = await collectBatch({ tab, store, kind: 'topic' });
  assert.equal(result.results[0].status, 'done');
}));

function domFixture(fn) {
  const previous = globalThis.document;
  try { fn(); } finally { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; }
}
const anchor = (href, innerText, nested = false) => ({ href, innerText, closest: () => nested ? {} : null });

test('list DOM ignores compose links, body links and foreign pagination', () => domFixture(() => {
  const title = { id: 'topictitle_8', innerText: topic.title, href: topicUrl, closest: () => ({ innerText: 'Сообщений: 1' }) };
  globalThis.document = { location: { href: base }, querySelector: selector => selector === '#basemail_showall' ? { innerText: 'Скрыть все темы' } : selector === 'li.active a[href]' ? { href: base } : { innerText: 'Synthetic excerpt' }, querySelectorAll: selector => selector.startsWith('a[id') ? [title] : [
    anchor(`${base}&page=2`, '2'), anchor(`${base}&page=3&act=newmail`, '3'), anchor(`${base}&page=4`, '4', true), anchor('https://other.example.test/basemail.php?folder=all&page=5', '5'),
  ] };
  const result = readListDom();
  assert.equal(result.topics[0].message_count_hint, 1);
  assert.equal(result.topics[0].initial_excerpt, 'Synthetic excerpt');
  assert.deepEqual(result.page_links, [`${base}&page=2`]);
}));

test('topic DOM keeps stable IDs, attachments and flags absent body', () => domFixture(() => {
  const header = { querySelector: selector => ({ innerText: selector.includes('first-child') ? '<Synthetic Author> 20.10.2026 12:00' : '20.10.2026 18:30' }) };
  const body = { innerText: 'Synthetic body', querySelectorAll: () => [{ alt: 'inline', src: 'https://mail.example.test/image.png' }] };
  const row = { id: 'post_99', querySelector: selector => selector.startsWith('td[') ? body : header, querySelectorAll: () => [{ innerText: 'file', href: 'https://mail.example.test/modules/attachment/file' }] };
  const missing = { ...row, id: 'post_100', querySelector: selector => selector.startsWith('td[') ? null : header };
  globalThis.document = { location: { href: topicUrl }, querySelector: () => ({ innerText: topic.title }), querySelectorAll: selector => selector.startsWith('table.') ? [row, missing] : [anchor(`${topicUrl}&page=2`, '2'), anchor(`${topicUrl}&page=3`, '3', true)] };
  const result = readTopicDom();
  assert.equal(result.messages[0].source_message_id, 'post_99');
  assert.equal(result.messages[0].author_text, 'Synthetic Author');
  assert.equal(result.messages[0].sent_at, '20.10.2026 12:00');
  assert.deepEqual(result.messages[0].source_header_dates, { author_header: '20.10.2026 12:00', secondary_header: '20.10.2026 18:30' });
  assert.equal(result.messages[0].source_date_observation.secondary_semantics, 'unverified');
  assert.equal(result.messages[0].attachments.length, 2);
  assert.equal(result.messages[1].content_status, 'missing_body');
  assert.equal(result.content_verified, false);
  assert.deepEqual(result.page_links, [`${topicUrl}&page=2`]);
}));

test('list DOM observes the sidebar counter without guessing its unit or inventing zero', () => domFixture(() => {
  let sidebar = 'Вся почта (52594)';
  globalThis.document = { location: { href: base }, querySelector: selector => selector === '#mail_int_left' ? { innerText: sidebar } : null, querySelectorAll: () => [] };
  assert.deepEqual(readListDom().observed_counter, { value: 52594, unit: 'unverified' });
  sidebar = 'Вся почта (52\u00a0594)';
  assert.equal(readListDom().observed_counter.value, 52594);
  sidebar = 'Нет счётчика';
  assert.equal(Object.hasOwn(readListDom(), 'observed_counter'), false);
}));

test('valid topic identities survive a blank title instead of silently shrinking the list', () => domFixture(() => {
  const titles=Array.from({length:20},(_,i)=>({id:`topictitle_${i+1}`,innerText:i===7?'':`Synthetic ${i+1}`,href:`${base}&topicid=${i+1}`,closest:()=>({innerText:'Сообщений: 1'})}));
  globalThis.document={location:{href:base},querySelector:selector=>selector==='#basemail_showall'?{innerText:'Скрыть все темы'}:null,querySelectorAll:selector=>selector.startsWith('a[id')?titles:[]};
  const result=readListDom();assert.equal(result.topics.length,20);assert.equal(result.topics[7].topic_id,'8');assert.equal(result.topics[7].title,'');assert.equal(result.topics[7].title_status,'missing');
}));

test('a retained topic with no title or excerpt stays unmatched rather than inventing a board', () => {
  assert.equal(classifyIab({topic_id:'8',title:'',title_status:'missing',initial_excerpt:'',body_text:''},true).primary_category,'unmatched');
});

test('list DOM reads per-topic header dates and sort flags without duplicating authors', () => domFixture(() => {
  const em = innerText => ({ innerText });
  const activityRow = { querySelector: selector => selector.includes('first-child') ? em('<Автор Тест> 01.02.2025 10:30') : selector.includes('nth-child(2)') ? em('05.03.2025 22:05') : null };
  const table = { innerText: 'Сообщений: 1', querySelector: selector => selector.includes('nth-child(2)') ? activityRow : null };
  const title = { id: 'topictitle_8', innerText: topic.title, href: topicUrl, closest: () => table };
  globalThis.document = { location: { href: base },
    querySelector: selector => selector === '#basemail_showall' ? { innerText: 'Скрыть все темы' } : null,
    querySelectorAll: selector => selector.startsWith('a[id') ? [title] : selector.startsWith('input') ? [
      { name: 'date', checked: true, labels: [{ innerText: 'по дате' }] },
      { name: 'relevance', checked: false, labels: [{ innerText: 'по релевантности' }] }] : [] };
  const result = readListDom();
  assert.deepEqual(result.topics[0].list_header_dates, { author_header: '01.02.2025 10:30', secondary_header: '05.03.2025 22:05' });
  assert.equal(classifyTopicActivity(result.topics[0]), 'in_window');
  assert.deepEqual(result.list_sort, { date_checked: true, relevance_checked: false, semantics: 'search_controls_not_verified_list_order' });
  assert.equal(JSON.stringify(result.topics[0]).includes('Автор Тест'), false);
}));

test('list DOM keeps null header dates and unchecked sort flags when row 2 lacks parsable dates', () => domFixture(() => {
  const activityRow = { querySelector: selector => selector.includes('first-child') ? { innerText: '<Автор> без даты' } : null };
  const table = { innerText: 'Сообщений: 1', querySelector: selector => selector.includes('nth-child(2)') ? activityRow : null };
  const title = { id: 'topictitle_8', innerText: '', href: topicUrl, closest: () => table };
  globalThis.document = { location: { href: base },
    querySelector: selector => selector === '#basemail_showall' ? { innerText: 'Скрыть все темы' } : null,
    querySelectorAll: selector => selector.startsWith('a[id') ? [title] : [] };
  const result = readListDom();
  assert.deepEqual(result.topics[0].list_header_dates, { author_header: null, secondary_header: null });
  assert.equal(result.topics[0].title_status, 'missing');
  assert.deepEqual(result.list_sort, { date_checked: false, relevance_checked: false, semantics: 'search_controls_not_verified_list_order' });
}));
