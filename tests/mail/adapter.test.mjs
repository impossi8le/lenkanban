import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { extractDom, messageRecord } from '../../scripts/mail/collector-core.mjs';

const adapter = JSON.parse(await readFile(new URL('../../scripts/mail/basemail-adapter.json', import.meta.url), 'utf8'));

test('observed basemail table adapter extracts stable IDs, body and date independently', () => {
  const previous = globalThis.document;
  const body = { innerText: 'Synthetic request\nSecond paragraph' };
  const nodes = new Map([[adapter.body, body], [adapter.author, { innerText: '<Synthetic Author> 20.10.2026 11:01' }], [adapter.date, { innerText: '20.10.2026 18:30' }]]);
  const row = { getAttribute: name => name === 'id' ? 'post_123' : null, querySelector: selector => nodes.get(selector) ?? null, querySelectorAll: selector => { assert.equal(selector, adapter.attachments); return []; } };
  globalThis.document = { querySelectorAll: selector => { if (selector === 'a[href]') return []; assert.equal(selector, adapter.message); return [row]; } };
  try {
    const result = extractDom({ kind: 'topic', adapter });
    assert.equal(result.recognized, true);
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0].source_message_id, 'post_123');
    assert.equal(result.messages[0].body_text, body.innerText);
    assert.equal(result.messages[0].sent_at, '20.10.2026 11:01');
    assert.equal(result.messages[0].author_text, 'Synthetic Author');
    assert.equal(result.messages[0].attachments_status, 'unverified');
    const record = messageRecord(result.messages[0], { topic_id: '9', title: 'Synthetic' }, 'https://example.test/mail?topicid=9', 0, 'synthetic');
    assert.equal(record.identity_method, 'source_id');
    assert.equal(record.source_message_id, 'post_123');
    assert.deepEqual(record.source_header_dates, { author_header: '20.10.2026 11:01', secondary_header: '20.10.2026 18:30' });
    assert.equal(record.source_date_observation.parser_version, 'basemail-author-date-v2');
  } finally { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; }
});

test('adapter limits attachment links to the observed attachment container', () => {
  assert.equal(adapter.attachments, 'div[id$="_attachments"] a[href]');
  assert.equal(adapter.attachmentsStatus, 'unverified');
  assert.equal(adapter.idAttribute, 'id');
  assert.match(adapter.message, /^table\.basemail_topic/);
  assert.equal(new RegExp(adapter.authorPattern).exec('<Synthetic Author> 20.10.2026 11:01')[1], 'Synthetic Author');
});
