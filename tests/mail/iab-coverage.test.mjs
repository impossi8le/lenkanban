import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../scripts/mail/iab-store.mjs';

const base = 'https://mail.example.test/basemail.php?folder=all';
const topicUrl = id => `${base}&topicid=${id}`;
async function fixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'iab-coverage-'));
  const store = await openStore({ dir, scope: base });
  try { await fn(store, dir); } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
}
const topic = id => ({ topic_id: String(id), title: 'Synthetic report', source_url: topicUrl(id), message_count_hint: 5 });
const list = extra => ({ url: base, topics: [topic(1)], page_links: [], filter_confirmed: true, pagination_verified: true, ...extra });
const page = extra => ({ topic_id: '1', url: topicUrl(1), title: 'Synthetic report', messages: [{ source_message_id: 'post_1', body_text: 'Synthetic body' }], page_links: [], pagination_verified: true, content_verified: true, ...extra });

test('last-list-page observation does not mean that intermediate pages or topic messages were read', async () => fixture(async store => {
  store.ingestListPage(list({ page_links: [`${base}&page=2`, `${base}&page=2630`], observed_counter: { value: 52594, unit: 'unknown' } }));
  const state = store.ingestListPage(list({ url: `${base}&page=2630`, topics: [topic(2)] }));
  assert.equal(state.completed_list_pages, 2);
  assert.equal(state.discovered_unique_topics, 2);
  assert.equal(state.collected_unique_messages, 0);
  assert.equal(state.coverage_status, 'partial');
  assert.equal(store.nextListPage().url.includes('page=2'), true);
  assert.equal(state.observed_counter.unit, 'unknown');
}));

test('a repeated source message on overlapping topic pages is counted once while identical bodies with different IDs survive', async () => fixture(async store => {
  store.ingestListPage(list());
  store.ingestTopicPage(page({ page_links: [`${topicUrl(1)}&page=2`] }));
  const state = store.ingestTopicPage(page({ url: `${topicUrl(1)}&page=2`, messages: [
    { source_message_id: 'post_1', body_text: 'Synthetic body' },
    { source_message_id: 'post_2', body_text: 'Synthetic body' },
  ] }));
  assert.equal(state.collected_unique_messages, 2);
  assert.equal(state.completed_topic_pages, 2);
  assert.equal(state.coverage_status, 'unverified');
  assert.equal(state.attachment_downloads, 'not_collected_links_only');
}));

test('unresolved content versions and unverified pagination prevent successful coverage', async () => fixture(async store => {
  store.ingestListPage(list());
  store.ingestTopicPage(page());
  let state = store.ingestTopicPage(page({ messages: [{ source_message_id: 'post_1', body_text: 'Changed synthetic body' }] }));
  assert.equal(state.conflict_versions, 1);
  assert.equal(state.collected_unique_messages, 1);
  assert.equal(state.coverage_status, 'partial');
  state = store.ingestTopicPage(page({ url: `${topicUrl(1)}&page=2`, pagination_verified: false }));
  assert.equal(state.quarantined_pages, 1);
  assert.equal(state.coverage_status, 'partial');
}));

test('failure is durable and remains retryable without silently disappearing from progress', async () => fixture(async (store, dir) => {
  store.ingestListPage(list());
  store.recordFailure({ url: topicUrl(1), kind: 'topic', topic_id: '1', code: 'PAGE_LOAD_FAILED' });
  let state = await store.checkpoint();
  assert.equal(state.failed_pages, 1);
  assert.equal(state.coverage_status, 'partial');
  store.retryFailures();
  assert.equal(store.nextTopicPage().topic_id, '1');
  store.ingestTopicPage(page());
  state = await store.exportNdjson();
  assert.equal(state.failed_pages, 0);
  assert.equal(state.collected_unique_messages, 1);
  assert.notEqual(state.coverage_status, 'complete');
}));

test('same page content returned for another list number is quarantined instead of proving progress', async () => fixture(async store => {
  store.ingestListPage(list({ page_links: [`${base}&page=2`] }));
  const state = store.ingestListPage(list({ url: `${base}&page=2` }));
  assert.equal(state.discovered_unique_topics, 1);
  assert.equal(state.completed_list_pages, 1);
  assert.equal(state.repeated_page_responses, 1);
  assert.equal(state.quarantined_pages, 1);
  assert.equal(state.coverage_status, 'partial');
}));

test('a source ID appearing under a second topic is a conflict rather than a second message', async () => fixture(async store => {
  store.ingestListPage(list({ topics: [topic(1), topic(2)] }));
  store.ingestTopicPage(page());
  const state = store.ingestTopicPage(page({ topic_id: '2', url: topicUrl(2) }));
  assert.equal(state.collected_unique_messages, 1);
  assert.equal(state.conflict_versions, 1);
  assert.equal(state.coverage_status, 'partial');
}));

test('live counter changes retain both observations without inventing the counter unit', async () => fixture(async store => {
  store.ingestListPage(list({ page_links: [`${base}&page=2`], observed_counter: { value: 52594, unit: 'unknown' } }));
  const state = store.ingestListPage(list({ url: `${base}&page=2`, topics: [topic(2)], observed_counter: { value: 52596, unit: 'unknown' } }));
  assert.equal(state.first_counter_observation.value.value, 52594);
  assert.equal(state.last_counter_observation.value.value, 52596);
  assert.equal(state.first_counter_observation.value.unit, 'unknown');
  assert.ok(state.first_counter_observation.observed_at);
  assert.notEqual(state.first_counter_observation.url, state.last_counter_observation.url);
}));

test('an empty topic extraction cannot certify an unreadable page as done', async () => fixture(async store => {
  store.ingestListPage(list());
  const state = store.ingestTopicPage(page({ messages: [] }));
  assert.equal(state.completed_topic_pages, 0);
  assert.equal(state.quarantined_pages, 1);
  assert.equal(state.coverage_status, 'partial');
}));
