import test from 'node:test';
import assert from 'node:assert/strict';
import { showAllTopics, fullListReady } from '../../scripts/mail/list-filter.mjs';
import { collectMailbox } from '../../scripts/mail/collector-core.mjs';

test('show-all waits for asynchronous list change before returning evidence', async () => {
  const events = [];
  const before = { topic_ids: ['1','2'], pagination: [], button_text: 'Показать все темы', button_visible: true, signature: 'old' };
  const after = { topic_ids: ['1','2','3'], pagination: ['page=2'], button_text: 'Скрыть все темы', button_visible: true, signature: 'new' };
  const page = { evaluate: async () => { events.push('read'); return events.length === 1 ? before : after; }, locator: selector => { assert.equal(selector, '#basemail_showall'); return { press: async key => { assert.equal(key, 'Enter'); events.push('activate'); } }; }, waitForFunction: async (fn, arg, options) => { events.push('wait'); assert.equal(arg.signature, 'old'); assert.equal(options.timeout, 45000); } };
  assert.deepEqual(await showAllTopics(page), { confirmed: true, action: 'activated_show_all_and_verified_hide_all_label', before_topics: 2, after_topics: 3, pagination_links: 1, button_text_after: 'Скрыть все темы' });
  assert.deepEqual(events, ['read','activate','wait','read']);
});

test('unchanged DOM after show-all is rejected instead of accepting old two topics', async () => {
  const page = { evaluate: async () => ({ topic_ids: ['1','2'], pagination: [], button_text: 'Показать все темы', button_visible: true, signature: 'old' }), locator: () => ({ press: async () => {} }), waitForFunction: async () => { throw new Error('timeout'); } };
  await assert.rejects(showAllTopics(page), { code: 'ALL_TOPICS_FILTER_UPDATE_NOT_OBSERVED' });
});

test('missing control is not accepted from a prior page confirmation', async () => {
  const page = { evaluate: async () => ({ topic_ids: ['3'], pagination: [], button_text: null, button_visible: false }) };
  await assert.rejects(showAllTopics(page), { code: 'ALL_TOPICS_FILTER_NOT_CONFIRMED' });
  await assert.rejects(showAllTopics(page, true), { code: 'ALL_TOPICS_FILTER_NOT_CONFIRMED' });
});

const base = 'https://mail.example.test/basemail.php?folder=all';
test('all-topic scope rejects legacy observed checkpoint before loading', async () => {
  let calls = 0;
  const initial = await collectMailbox({ url: base, load: async () => ({ recognized: true, topics: [], page_links: [] }) });
  await assert.rejects(collectMailbox({ url: base, state: initial, listFilter: 'all_topics', load: async () => { calls++; } }), /CHECKPOINT_FILTER_MISMATCH/);
  assert.equal(calls, 0);
});

test('unconfirmed all-topic pages remain unfinished and partial', async () => {
  const result = await collectMailbox({ url: base, listFilter: 'all_topics', load: async () => ({ recognized: true, topics: [], page_links: [] }) });
  assert.equal(result.manifest.coverage_status, 'partial');
  assert.equal(result.manifest.visited_list_pages, 0);
  assert.deepEqual(result.manifest.unfinished_pages, [base]);
  assert.equal(result.manifest.errors[0].code, 'UNSUPPORTED_ALL_TOPICS_FILTER');
});


test('already active all-topic label never toggles the archive back off', async () => {
  const page = { evaluate: async () => ({ topic_ids: ['1','2'], pagination: ['page=2'], button_text: 'Скрыть все темы', button_visible: true }), locator: () => { throw new Error('must not activate'); } };
  const evidence = await showAllTopics(page);
  assert.equal(evidence.confirmed, true);
  assert.equal(evidence.action, 'already_showing_all_topics');
});

test('hide-all label with stale topic rows does not finish the async wait', () => {
  const original = globalThis.document;
  const links = ids => ids.map(id => ({ href: `${base}&topicid=${id}#add_post_form_link`, hash: '#add_post_form_link' }));
  let current = links(['1', '2']);
  globalThis.document = { querySelector: () => ({ innerText: 'Скрыть все темы' }), querySelectorAll: () => current };
  try {
    const signature = JSON.stringify([['1', '2'], []]);
    assert.equal(fullListReady({ signature }), false);
    current = links(['1', '2', '3']);
    assert.equal(fullListReady({ signature }), true);
  } finally { if (original === undefined) delete globalThis.document; else globalThis.document = original; }
});
