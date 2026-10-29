import test from 'node:test';
import assert from 'node:assert/strict';
import { collectMailbox } from '../../scripts/mail/collector-core.mjs';

const base = 'https://mail.example.test/modules/basemail/basemail.php?folder=all';
const listPage = n => `${base}&page=${n}`;
const topicUrl = id => `${base}&topicid=${id}&folderid=0`;

test('shallow collection mode collects only topic headers, dates and URLs without reading messages', async () => {
  const calls = [];
  const pages = new Map([
    [base, {
      recognized: true,
      topics: [
        { topic_id: '101', title: 'Тема один', source_url: topicUrl(101), message_count_hint: 5, initial_excerpt: 'Вступление один', list_header_dates: { author_header: '01.01.2025 10:00', secondary_header: '20.10.2026 18:00' } },
        { topic_id: '102', title: 'Тема два', source_url: topicUrl(102), message_count_hint: 1, initial_excerpt: 'Вступление два', list_header_dates: { author_header: '05.02.2025 12:00', secondary_header: '05.02.2025 12:00' } },
      ],
      page_links: [listPage(2)],
    }],
    [listPage(2), {
      recognized: true,
      topics: [
        { topic_id: '103', title: 'Тема три', source_url: topicUrl(103), message_count_hint: 2, initial_excerpt: 'Вступление три', list_header_dates: { author_header: '10.03.2025 09:00', secondary_header: '10.03.2025 09:00' } },
      ],
      page_links: [],
    }],
    [topicUrl(101), { recognized: true, messages: [{ source_message_id: 'm1', body_text: 'deep message' }] }],
  ]);

  const load = async (url, kind) => {
    calls.push({ url, kind });
    return pages.get(url);
  };

  const result = await collectMailbox({ url: base, load, shallow: true });

  // Verify only list pages were visited
  assert.equal(calls.length, 2);
  assert.ok(calls.every(c => c.kind === 'list'));
  assert.equal(calls[0].url, base);
  assert.equal(calls[1].url, listPage(2));

  // Verify topics collected, but zero messages collected
  assert.equal(result.topics.length, 3);
  assert.equal(result.messages.length, 0);

  // Manifest correctly documents shallow mode and coverage
  assert.equal(result.manifest.shallow_mode, true);
  assert.equal(result.manifest.discovered_unique_topics, 3);
  assert.equal(result.manifest.collected_unique_messages, 0);
  assert.equal(result.manifest.coverage_status, 'unverified');
  assert.ok(result.manifest.coverage_reason.includes('Shallow topic overview only'));
  assert.equal(result.manifest.read_state_side_effect, 'none; shallow list mode does not open topics');
  assert.equal(result.manifest.unfinished_topics.length, 0);
});

test('shallow collection supports resume and deduplication across page re-reads', async () => {
  const pages = new Map([
    [base, {
      recognized: true,
      topics: [{ topic_id: '201', title: 'Тема 201', source_url: topicUrl(201) }],
      page_links: [listPage(2)],
    }],
    [listPage(2), {
      recognized: true,
      topics: [{ topic_id: '201', title: 'Тема 201', source_url: topicUrl(201) }, { topic_id: '202', title: 'Тема 202', source_url: topicUrl(202) }],
      page_links: [],
    }],
  ]);

  // First run with maxPages = 1
  const firstRun = await collectMailbox({ url: base, load: async url => pages.get(url), maxPages: 1, shallow: true });
  assert.equal(firstRun.topics.length, 1);
  assert.equal(firstRun.manifest.coverage_status, 'partial');
  assert.deepEqual(firstRun.manifest.unfinished_pages, [listPage(2)]);

  // Resume with previous state
  const resumed = await collectMailbox({
    url: base,
    state: JSON.parse(JSON.stringify(firstRun)),
    load: async url => pages.get(url),
    shallow: true,
  });

  // Deduplication preserved topic_id 201
  assert.equal(resumed.topics.length, 2);
  assert.deepEqual(resumed.topics.map(t => t.topic_id), ['201', '202']);
  assert.equal(resumed.messages.length, 0);
  assert.equal(resumed.manifest.coverage_status, 'unverified');
});

test('shallow collection records list errors without failing whole process silently', async () => {
  const pages = new Map([
    [base, { recognized: true, topics: [{ topic_id: '301', title: 'Т 301', source_url: topicUrl(301) }], page_links: [listPage(2)] }],
  ]);

  const load = async (url) => {
    if (url === listPage(2)) throw new Error('NETWORK_TIMEOUT');
    return pages.get(url);
  };

  const result = await collectMailbox({ url: base, load, shallow: true });
  assert.equal(result.manifest.coverage_status, 'partial');
  assert.equal(result.manifest.errors.length, 1);
  assert.equal(result.manifest.errors[0].stage, 'list');
  assert.equal(result.manifest.errors[0].code, 'PAGE_LOAD_FAILED');
  assert.equal(result.topics.length, 1);
});
