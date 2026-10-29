import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../scripts/mail/iab-store.mjs';

const url = 'https://mail.example/modules/basemail/basemail.php?folder=all';
const topicUrl = id => `${url}&topicid=${id}&folderid=0`;
const list = { url, topics: [{ topic_id: '1', title: 'Отчёт', source_url: topicUrl(1), message_count_hint: 2 }], page_links: [], filter_confirmed: true, pagination_verified: true };
const topic = { topic_id: '1', url: topicUrl(1), title: 'Отчёт', messages: [{ source_message_id: '99', body_text: 'Работа выполнена', content_status: 'complete' }], page_links: [], pagination_verified: true, content_verified: true };
async function fixture(t) { const dir = await mkdtemp(join(tmpdir(), 'iab-store-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }

test('transactions survive restart; duplicate UI pages do not duplicate messages', async t => {
  const dir = await fixture(t); let s = await openStore({ dir, scope: url });
  assert.equal(s.nextListPage().url, url);
  s.ingestListPage(list); s.ingestTopicPage(topic); s.ingestTopicPage(topic);
  assert.equal(s.progress().collected_unique_messages, 1);
  assert.equal(s.nextTopicPage(), null); s.close();
  s = await openStore({ dir, scope: url });
  assert.equal(s.progress().collected_unique_messages, 1);
  assert.equal(s.nextListPage(), null);
  await s.exportNdjson();
  const rows = (await readFile(join(dir, 'messages.ndjson'), 'utf8')).trim().split('\n');
  assert.equal(rows.length, 1); assert.equal(JSON.parse(rows[0]).source_message_id, '99');
  assert.notEqual(s.progress().coverage_status, 'complete'); s.close();
});

test('invalid links roll back entire page; filter is mandatory', async t => {
  const dir = await fixture(t), s = await openStore({ dir, scope: url });
  assert.throws(() => s.ingestListPage({ ...list, filter_confirmed: false }), /FILTER/);
  assert.throws(() => s.ingestListPage({ ...list, page_links: ['https://evil.example/steal'] }), /PAGE_URL/);
  assert.equal(s.progress().discovered_unique_topics, 0);
  assert.equal(s.progress().completed_list_pages, 0); s.close();
});

test('changed source message is retained as conflict, no overwrite', async t => {
  const dir = await fixture(t), s = await openStore({ dir, scope: url });
  s.ingestListPage(list); s.ingestTopicPage(topic);
  s.ingestTopicPage({ ...topic, messages: [{ source_message_id: '99', body_text: 'Изменено' }] });
  s.ingestTopicPage({ ...topic, messages: [{ source_message_id: '99', body_text: 'Изменено' }] });
  assert.equal(s.progress().conflict_versions, 1);
  assert.equal(s.progress().coverage_status, 'partial');
  await s.exportNdjson();
  assert.equal(JSON.parse((await readFile(join(dir, 'messages.ndjson'), 'utf8')).trim()).body_text, 'Работа выполнена');
  assert.equal(JSON.parse((await readFile(join(dir, 'conflicts.ndjson'), 'utf8')).trim()).body_text, 'Изменено'); s.close();
});

test('failure is retryable and success clears it; unverified pages quarantined', async t => {
  const dir = await fixture(t), s = await openStore({ dir, scope: url });
  s.recordFailure({ url, code: 'SERVER_TIMEOUT' }); assert.equal(s.nextListPage(), null);
  assert.equal(s.progress().failed_pages, 1); s.retryFailures();
  assert.ok(s.nextListPage()); s.ingestListPage({ ...list, pagination_verified: false });
  assert.equal(s.progress().failed_pages, 0); assert.equal(s.progress().quarantined_pages, 1);
  s.retryFailures(); s.ingestListPage(list); assert.equal(s.progress().quarantined_pages, 0); s.close();
});

test('scope immutable and globally repeated source ID across topics recorded as conflict', async t => {
  const dir = await fixture(t), s = await openStore({ dir, scope: url });
  s.ingestListPage(list); s.ingestTopicPage(topic);
  s.ingestTopicPage({ ...topic, topic_id: '2', url: topicUrl(2) });
  assert.equal(s.progress().collected_unique_messages, 1); assert.equal(s.progress().conflict_versions, 1); s.close();
  await assert.rejects(openStore({ dir, scope: url.replace('mail.example', 'other.example') }), /SCOPE_MISMATCH/);
});

test('surface list excerpts survive restart and export without becoming collected messages', async t => {
  const dir = await fixture(t);
  let s = await openStore({ dir, scope: url });
  s.ingestListPage({ ...list, topics: [{ ...list.topics[0], initial_excerpt: 'Synthetic opening excerpt for a provisional process grouping.' }] });
  s.close();
  s = await openStore({ dir, scope: url });
  try {
    await s.exportNdjson();
    const saved = JSON.parse((await readFile(join(dir, 'topics.ndjson'), 'utf8')).trim());
    assert.equal(saved.initial_excerpt, 'Synthetic opening excerpt for a provisional process grouping.');
    assert.equal(saved.message_count_hint, 2);
    assert.equal(s.progress().discovered_unique_topics, 1);
    assert.equal(s.progress().collected_unique_messages, 0);
  } finally { s.close(); }
});

test('blank-title topic remains an exported identity among all twenty list topics', async t => {
  const dir=await fixture(t);const s=await openStore({dir,scope:url});
  try {
    const topics=Array.from({length:20},(_,i)=>({topic_id:String(i+1),title:i===7?'':`Synthetic ${i+1}`,title_status:i===7?'missing':'present',source_url:topicUrl(i+1),initial_excerpt:''}));
    s.ingestListPage({...list,topics});await s.exportNdjson();
    const rows=(await readFile(join(dir,'topics.ndjson'),'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(rows.length,20);assert.equal(s.progress().discovered_unique_topics,20);assert.equal(rows.find(x=>x.topic_id==='8').title_status,'missing');assert.equal(rows.find(x=>x.topic_id==='8').title,'');
  } finally {s.close();}
});
