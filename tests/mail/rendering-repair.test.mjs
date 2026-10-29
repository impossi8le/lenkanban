import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, isConfirmedRenderingVariant } from '../../scripts/mail/iab-store.mjs';

const base = 'https://mail.example.test/basemail.php?folder=all';
const source = `${base}&topicid=1`;
const original = { source_instance: 'https://mail.example.test', source_message_id: 'post_1', topic_id: '1', source_url: source, title: 'Synthetic', body_text: 'Synthetic request 2 items12:00\n Вложения:\n %POST_ATTACHMENTS%', author_text: 'Synthetic author', sent_at: '2026-10-20', attachments: [], attachments_status: 'unverified', content_status: 'complete' };
const visible = { ...original, body_text: 'Synthetic request\n2 items\n12:00' };

test('only the observed footer plus whitespace rendering difference is eligible', () => {
  assert.equal(isConfirmedRenderingVariant(original, visible), true);
  for (const changed of [
    { ...visible, body_text: 'Synthetic request\n3 items\n12:00' },
    { ...visible, author_text: 'Another author' },
    { ...visible, attachments: [{ name: 'new', url: 'https://mail.example.test/file' }] },
    { ...visible, topic_id: '2' },
    { ...visible, source_url: `${source}&page=2` },
    { ...visible, content_status: 'missing_body' },
    { ...visible, body_text: '' },
  ]) assert.equal(isConfirmedRenderingVariant(original, changed), false);
  assert.equal(isConfirmedRenderingVariant({ ...original, body_text: 'Synthetic request 2 items12:00' }, visible), false);
  assert.equal(isConfirmedRenderingVariant({ ...original, body_text: original.body_text + '\nMeaningful tail' }, visible), false);
});

test('repair preserves original and alternate raw versions, resolves only proven rendering variants and is idempotent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rendering-repair-'));
  const store = await openStore({ dir, scope: base });
  try {
    store.ingestListPage({ url: base, topics: [{ topic_id: '1', title: original.title, source_url: source }], page_links: [], filter_confirmed: true, pagination_verified: true });
    const ingest = messages => store.ingestTopicPage({ topic_id: '1', url: source, title: original.title, messages, page_links: [], pagination_verified: true, content_verified: true });
    ingest([original, { ...original, source_message_id: 'post_2' }]);
    ingest([visible, { ...visible, source_message_id: 'post_2', body_text: 'Real changed request 99 items' }]);
    assert.equal(store.progress().conflict_versions, 2);
    let result = store.resolveRenderingVariants();
    assert.equal(result.resolved, 1);
    assert.equal(result.progress.conflict_versions, 1);
    assert.equal(result.progress.resolved_rendering_variants, 1);
    assert.equal(store.resolveRenderingVariants().resolved, 0);
    await store.exportNdjson();
    const records = (await readFile(join(dir, 'messages.ndjson'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(records.find(x => x.source_message_id === 'post_1').body_text, visible.body_text);
    assert.equal(records.find(x => x.source_message_id === 'post_2').body_text, original.body_text);
    const audit = JSON.parse((await readFile(join(dir, 'conflict-resolutions.ndjson'), 'utf8')).trim());
    assert.equal(audit.original.body_text, original.body_text);
    assert.equal(audit.canonical.body_text, visible.body_text);
    assert.equal((await readFile(join(dir, 'conflicts.ndjson'), 'utf8')).trim().split('\n').length, 2);
    ingest([visible]);
    assert.equal(store.progress().conflict_versions, 1);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});
