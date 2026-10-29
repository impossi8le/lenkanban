import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { collectMailbox, safePageUrl, messageRecord, extractDom, meaningfulMessageSignature } from '../../scripts/mail/collector-core.mjs';

const base = 'https://mail.example.test/modules/basemail/basemail.php?folder=all';
const topicUrl = id => `${base}&topicid=${id}&folderid=0`;
const listPage = n => `${base}&page=${n}`;
const topic = id => ({ topic_id: String(id), title: `Synthetic topic ${id}`, source_url: topicUrl(id) });
const list = (ids, links = []) => ({ recognized: true, topics: ids.map(topic), page_links: links });
const detail = (messages, links = []) => ({ recognized: true, messages, page_links: links });

test('observed list DOM chooses title over read-more and extracts the message count hint', () => {
  const originalDocument = globalThis.document;
  const anchor = (innerText, href, tbodyText = '') => ({ innerText, href, hash: new URL(href).hash, closest: selector => selector === 'tbody' ? { innerText: tbodyText } : null });
  const links = [
    anchor('Читать далее…', topicUrl(1) + '#add_post_form_link', 'Сообщений: 17'),
    anchor('Actual synthetic title', topicUrl(1) + '#add_post_form_link', 'Сообщений: 17'),
    anchor('Another synthetic title', topicUrl(2) + '#add_post_form_link'),
    anchor('2', listPage(2)),
  ];
  globalThis.document = { querySelectorAll: selector => { assert.equal(selector, 'a[href]'); return links; } };
  try {
    const result = extractDom({ kind: 'list' });
    assert.equal(result.recognized, true);
    assert.equal(result.topics.length, 2);
    assert.equal(result.topics[0].title, 'Actual synthetic title');
    assert.equal(result.topics[0].message_count_hint, 17);
    assert.equal(result.topics[1].message_count_hint, null);
    assert.deepEqual(result.page_links, [listPage(2)]);
  } finally { if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument; }
});

test('only observed read-only scope URLs pass navigation validation', () => {
  assert.equal(safePageUrl(topicUrl(5) + '#add_post_form_link', base, 5), topicUrl(5));
  for (const url of [base + '&delete=1', base + '&topicid=4', base.replace('mail.example.test', 'evil.test'), base.replace('basemail.php', 'logout.php'), base + '&page=-1'])
    assert.equal(safePageUrl(url, base), null);
  assert.equal(safePageUrl(topicUrl(6), base, 5), null);
  assert.equal(safePageUrl(base + '&folder=other', base), null);
  assert.equal(safePageUrl(topicUrl(1) + '&topicid=2', base, 1), null);
  assert.equal(safePageUrl(base + '&page=1&page=2', base), null);
  assert.equal(safePageUrl(topicUrl(1) + '&folderid=1', base, 1), null);
});

test('enumerates all observed list and topic pages without merging identical text', async () => {
  const calls = [];
  const pages = new Map([
    [base, list([1], [listPage(2), base + '&delete=1'])],
    [listPage(2), list([1, 2], [base])],
    [topicUrl(1), detail([{ source_message_id: '001', body_text: 'same' }], [topicUrl(1) + '&page=2'])],
    [topicUrl(1) + '&page=2', detail([{ source_message_id: '002', body_text: 'same' }], [topicUrl(1)])],
    [topicUrl(2), detail([{ source_message_id: '003', body_text: 'third', attachments: [{ name: 'x.pdf', url: 'https://files.example/x.pdf', availability: 'linked_not_downloaded' }] }])],
  ]);
  const result = await collectMailbox({ url: base, load: async url => { calls.push(url); return pages.get(url); } });
  assert.equal(result.manifest.discovered_unique_topics, 2);
  assert.equal(result.manifest.collected_unique_messages, 3);
  assert.equal(result.manifest.coverage_status, 'unverified');
  assert.deepEqual(result.messages.map(m => m.source_message_id), ['001', '002', '003']);
  assert.equal(calls.length, 5);
  assert.equal(result.messages[2].attachments[0].availability, 'linked_not_downloaded');
});

test('capped runs resume pending discovery and do not re-read finished topics', async () => {
  const pages = new Map([[base, list([1], [listPage(2)])], [listPage(2), list([2])], [topicUrl(1), detail([{ source_message_id: '1', body_text: 'one' }])], [topicUrl(2), detail([{ source_message_id: '2', body_text: 'two' }])]]);
  const initial = await collectMailbox({ url: base, load: async url => pages.get(url), maxPages: 1 });
  assert.equal(initial.manifest.coverage_status, 'partial');
  assert.deepEqual(initial.manifest.unfinished_pages, [listPage(2)]);
  const calls = [];
  const final = await collectMailbox({ url: base, state: JSON.parse(JSON.stringify(initial)), load: async url => { calls.push(url); return pages.get(url); } });
  assert.deepEqual(calls, [listPage(2), topicUrl(2)]);
  assert.equal(final.messages.length, 2);
});

test('unsupported detail is an explicit partial result and remains resumable', async () => {
  const result = await collectMailbox({ url: base, load: async (_, kind) => kind === 'list' ? list([1]) : { recognized: false } });
  assert.equal(result.manifest.coverage_status, 'partial');
  assert.equal(result.messages.length, 0);
  assert.deepEqual(result.manifest.failed_topics, ['1']);
  assert.equal(result.manifest.errors[0].code, 'UNSUPPORTED_TOPIC_LAYOUT');
  const recovered = await collectMailbox({ url: base, state: result, load: async () => detail([{ source_message_id: 'x', body_text: 'recovered' }]) });
  assert.equal(recovered.messages.length, 1);
});

test('failed list cannot be reported as an empty complete mailbox', async () => {
  const result = await collectMailbox({ url: base, load: async () => { throw new Error('private sensitive exception'); } });
  assert.equal(result.manifest.coverage_status, 'partial');
  assert.equal(result.manifest.errors[0].code, 'PAGE_LOAD_FAILED');
  assert.ok(!JSON.stringify(result).includes('private sensitive'));
});

test('position fallback keeps duplicate texts distinct and stable within the recorded page', () => {
  const first = messageRecord({ body_text: 'same' }, topic(1), topicUrl(1), 0, 'test');
  const second = messageRecord({ body_text: 'same' }, topic(1), topicUrl(1), 1, 'test');
  assert.notEqual(first.source_message_id, second.source_message_id);
  assert.equal(first.source_message_id, messageRecord({ body_text: 'changed' }, topic(1), topicUrl(1), 0, 'test').source_message_id);
  assert.equal(first.identity_method, 'page_position_fallback');
});

test('conflicting duplicate source IDs make coverage partial', async () => {
  const result = await collectMailbox({ url: base, load: async (_, kind) => kind === 'list' ? list([1]) : detail([{ source_message_id: 'same-id', body_text: 'one' }, { source_message_id: 'same-id', body_text: 'two' }]) });
  assert.equal(result.manifest.coverage_status, 'partial');
  assert.equal(result.manifest.errors[0].code, 'SOURCE_ID_CONTENT_CONFLICT');
  const resumed = await collectMailbox({ url: base, state: result, load: async () => assert.fail('finished topic must not reload') });
  assert.equal(resumed.manifest.coverage_status, 'partial');
});

test('missing body selector does not finish a topic', async () => {
  const result = await collectMailbox({ url: base, load: async (_, kind) => kind === 'list' ? list([1]) : detail([{ body_text: '', content_status: 'missing_body' }]) });
  assert.equal(result.manifest.coverage_status, 'partial');
  assert.deepEqual(result.manifest.unfinished_topics, ['1']);
});

test('CLI offline import writes manifest and resumes without duplicate append records', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'basemail-synthetic-'));
  try {
    const input = join(dir, 'snapshots.json'), output = join(dir, 'run');
    await writeFile(input, JSON.stringify({ pages: [
      { url: base, kind: 'list', data: list([1]) },
      { url: topicUrl(1), kind: 'topic', data: detail([{ source_message_id: '007', body_text: 'synthetic only' }]) },
    ] }));
    const command = [new URL('../../scripts/mail/collect-basemail.mjs', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'), '--url', base, '--output', output, '--import', input];
    for (let i = 0; i < 2; i++) {
      const run = spawnSync(process.execPath, command, { encoding: 'utf8' });
      assert.equal(run.status, 0, run.stderr);
      assert.equal(JSON.parse(run.stdout).coverage_status, 'unverified');
    }
    const rows = (await readFile(join(output, 'messages.ndjson'), 'utf8')).trim().split('\n');
    assert.equal(rows.length, 1);
    assert.equal(JSON.parse(rows[0]).source_message_id, '007');
    assert.equal(JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8')).collected_unique_messages, 1);
    assert.equal(JSON.parse(await readFile(join(output, 'checkpoint.json'), 'utf8')).messages, undefined);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

for (const [field, changed] of [
  ['author_text', 'Changed author'],
  ['attachments', [{ name: 'new.pdf', url: 'https://files.example/new.pdf' }]],
  ['sent_at', '2026-10-20'],
  ['content_status', 'empty'],
]) {
  test(`same ID and body with changed ${field} preserves a conflict variant`, async () => {
    const original = { source_message_id: 'shared', body_text: 'identical body' };
    const result = await collectMailbox({ url: base, load: async (_, kind) => kind === 'list' ? list([1]) : detail([original, { ...original, [field]: changed }]) });
    assert.equal(result.manifest.coverage_status, 'partial');
    assert.equal(result.manifest.collected_unique_messages, 1);
    assert.equal(result.message_conflicts.length, 1);
    assert.deepEqual(result.message_conflicts[0].variant[field], changed);
    assert.equal(result.manifest.identity_conflict_variants, 1);
  });
}

test('shared source ID across topics flags topic/title change even with identical body', async () => {
  const result = await collectMailbox({ url: base, load: async (_, kind) => kind === 'list' ? list([1, 2]) : detail([{ source_message_id: 'shared', body_text: 'same' }]) });
  assert.equal(result.manifest.coverage_status, 'partial');
  assert.equal(result.messages.length, 1);
  assert.equal(result.message_conflicts[0].variant.topic_id, '2');
});

test('meaningful comparison ignores collection location/time and canonicalizes attachment object keys', () => {
  const first = { topic_id: '1', title: 'title', body_text: 'body', attachments: [{ name: 'x', url: 'https://example.test/x', availability: 'linked' }], source_url: 'first', collected_at: 'first' };
  const second = { ...first, source_url: 'second', collected_at: 'second', attachments: [{ availability: 'linked', url: 'https://example.test/x', name: 'x' }] };
  assert.equal(meaningfulMessageSignature(first), meaningfulMessageSignature(second));
});

for (const damage of ['delete', 'truncate', 'legacy', 'alter-prefix']) {
  test(`CLI refuses ${damage} message log/checkpoint without overwriting progress`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'basemail-integrity-'));
    try {
      const input = join(dir, 'snapshots.json'), output = join(dir, 'run');
      await writeFile(input, JSON.stringify({ pages: [
        { url: base, kind: 'list', data: list([1]) },
        { url: topicUrl(1), kind: 'topic', data: detail([{ source_message_id: '1', body_text: 'first' }, { source_message_id: '2', body_text: 'second' }]) },
      ] }));
      const command = [new URL('../../scripts/mail/collect-basemail.mjs', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'), '--url', base, '--output', output, '--import', input];
      const initial = spawnSync(process.execPath, command, { encoding: 'utf8' });
      assert.equal(initial.status, 0, initial.stderr);
      const checkpointPath = join(output, 'checkpoint.json'), logPath = join(output, 'messages.ndjson');
      const initialLog = await readFile(logPath, 'utf8');
      if (damage === 'delete') await rm(logPath);
      if (damage === 'truncate') await writeFile(logPath, initialLog.split('\n')[0] + '\n');
      if (damage === 'alter-prefix') await writeFile(logPath, initialLog.replace('first', 'other'));
      if (damage === 'legacy') {
        const legacy = JSON.parse(await readFile(checkpointPath, 'utf8')); delete legacy.message_log;
        await writeFile(checkpointPath, JSON.stringify(legacy));
      }
      const before = await readFile(checkpointPath, 'utf8');
      const resumed = spawnSync(process.execPath, command, { encoding: 'utf8' });
      assert.notEqual(resumed.status, 0);
      assert.equal(await readFile(checkpointPath, 'utf8'), before);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}

test('CLI rehydrates valid log ahead of checkpoint and replays without duplicate appends', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'basemail-ahead-'));
  try {
    const input = join(dir, 'snapshots.json'), output = join(dir, 'run');
    const pages = [
      { url: base, kind: 'list', data: list([1]) },
      { url: topicUrl(1), kind: 'topic', data: detail([{ source_message_id: '1', body_text: 'first' }]) },
    ];
    await writeFile(input, JSON.stringify({ pages }));
    const command = [new URL('../../scripts/mail/collect-basemail.mjs', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'), '--url', base, '--output', output, '--import', input];
    assert.equal(spawnSync(process.execPath, command, { encoding: 'utf8' }).status, 0);
    const checkpointPath = join(output, 'checkpoint.json');
    const progress = JSON.parse(await readFile(checkpointPath, 'utf8'));
    // Simulate crash after append but before a later progress snapshot.
    progress.completed_topics = [];
    progress.topics[0].pending_pages = [topicUrl(1)]; progress.topics[0].visited_pages = [];
    await writeFile(checkpointPath, JSON.stringify(progress));
    const ahead = messageRecord({ source_message_id: '2', body_text: 'second' }, topic(1), topicUrl(1), 1, new URL(base).origin);
    const logPath = join(output, 'messages.ndjson');
    await writeFile(logPath, await readFile(logPath, 'utf8') + JSON.stringify(ahead) + '\n');
    pages[1].data = detail([{ source_message_id: '1', body_text: 'first' }, { source_message_id: '2', body_text: 'second' }]);
    await writeFile(input, JSON.stringify({ pages }));
    const resumed = spawnSync(process.execPath, command, { encoding: 'utf8' });
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.equal(JSON.parse(resumed.stdout).collected_unique_messages, 2);
    assert.equal((await readFile(logPath, 'utf8')).trim().split('\n').length, 2);
    assert.equal(JSON.parse(await readFile(checkpointPath, 'utf8')).message_log.rows, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('CLI preserves conflict alternatives through checkpoint resume without increasing unique rows', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'basemail-conflict-'));
  try {
    const input = join(dir, 'snapshots.json'), output = join(dir, 'run');
    await writeFile(input, JSON.stringify({ pages: [
      { url: base, kind: 'list', data: list([1]) },
      { url: topicUrl(1), kind: 'topic', data: detail([
        { source_message_id: '1', body_text: 'same', author_text: 'original' },
        { source_message_id: '1', body_text: 'same', author_text: 'changed' },
      ]) },
    ] }));
    const command = [new URL('../../scripts/mail/collect-basemail.mjs', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'), '--url', base, '--output', output, '--import', input];
    for (let attempt = 0; attempt < 2; attempt++) {
      const run = spawnSync(process.execPath, command, { encoding: 'utf8' });
      assert.equal(run.status, 2, run.stderr);
      const manifest = JSON.parse(run.stdout);
      assert.equal(manifest.collected_unique_messages, 1);
      assert.equal(manifest.identity_conflict_variants, 1);
      const saved = JSON.parse(await readFile(join(output, 'checkpoint.json'), 'utf8'));
      assert.equal(saved.message_conflicts[0].original.author_text, 'original');
      assert.equal(saved.message_conflicts[0].variant.author_text, 'changed');
    }
    assert.equal((await readFile(join(output, 'messages.ndjson'), 'utf8')).trim().split('\n').length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
