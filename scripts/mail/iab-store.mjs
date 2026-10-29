import { DatabaseSync } from 'node:sqlite';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { once } from 'node:events';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { safePageUrl, messageRecord, meaningfulMessageSignature } from './collector-core.mjs';

const now = () => new Date().toISOString();
const digest = value => createHash('sha256').update(value).digest('hex');

/** Exact observed hidden-table template defect, not general content merging. */
export function isConfirmedRenderingVariant(original, visible) {
  if (original.content_status !== 'complete' || visible.content_status !== 'complete' || !String(visible.body_text ?? '').trim()) return false;
  const footer = /\s*Вложения:\s*%POST_ATTACHMENTS%\s*$/u;
  if (!footer.test(String(original.body_text ?? '')) || String(visible.body_text ?? '').includes('%POST_ATTACHMENTS%')) return false;
  if (original.source_instance !== visible.source_instance || original.source_message_id !== visible.source_message_id || original.source_url !== visible.source_url) return false;
  if (meaningfulMessageSignature({ ...original, body_text: '' }) !== meaningfulMessageSignature({ ...visible, body_text: '' })) return false;
  const compact = value => String(value).replace(/\s/gu, '');
  return compact(original.body_text.replace(footer, '')) === compact(visible.body_text);
}

export function isConfirmedAuthorDateCorrection(original, observed) {
  const dates = observed.source_header_dates, evidence = observed.source_date_observation;
  if (evidence?.parser_version !== 'basemail-author-date-v2' || evidence.primary_field !== 'author_header' || evidence.secondary_semantics !== 'unverified') return false;
  if (!dates?.author_header || !dates.secondary_header || dates.author_header === dates.secondary_header || original.sent_at !== dates.secondary_header || observed.sent_at !== dates.author_header) return false;
  if (original.source_instance !== observed.source_instance || original.source_message_id !== observed.source_message_id || original.source_url !== observed.source_url) return false;
  const prior = { ...original, sent_at: observed.sent_at };
  return meaningfulMessageSignature(prior) === meaningfulMessageSignature(observed) || isConfirmedRenderingVariant(prior, observed);
}

/** Local-only durable sink. Browser traversal stays outside this module. */
export async function openStore({ dir, scope }) {
  const input = typeof scope === 'string' ? { url: scope } : scope;
  const base = safePageUrl(input?.url, input?.url);
  if (!base || (input.folder && input.folder !== 'all') || (input.filter && input.filter !== 'all_topics')) throw new Error('INVALID_SCOPE');
  const canonicalUrl = (value, topicId = null) => {
    const result = safePageUrl(value, base, topicId);
    if (!result) throw new Error('INVALID_PAGE_URL');
    const u = new URL(result);
    if (u.searchParams.get('page') === '1') u.searchParams.delete('page');
    u.searchParams.sort();
    return u.href;
  };
  const first = canonicalUrl(base);
  const scopeJson = JSON.stringify({ url: first, folder: 'all', filter: 'all_topics' });
  await mkdir(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, 'mail.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS pages(url TEXT PRIMARY KEY,kind TEXT NOT NULL,topic_id TEXT,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,observed_at TEXT,metadata TEXT);
    CREATE INDEX IF NOT EXISTS pages_queue ON pages(kind,status);
    CREATE TABLE IF NOT EXISTS topics(topic_id TEXT PRIMARY KEY,record_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS messages(identity TEXT PRIMARY KEY,topic_id TEXT NOT NULL,record_json TEXT NOT NULL,signature TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS messages_topic ON messages(topic_id);
    CREATE TABLE IF NOT EXISTS conflicts(identity TEXT NOT NULL,signature TEXT NOT NULL,record_json TEXT NOT NULL,observed_at TEXT NOT NULL,PRIMARY KEY(identity,signature));
    CREATE TABLE IF NOT EXISTS conflict_resolutions(identity TEXT NOT NULL,signature TEXT NOT NULL,record_json TEXT NOT NULL,observed_at TEXT NOT NULL,PRIMARY KEY(identity,signature));
    CREATE TABLE IF NOT EXISTS date_observations(identity TEXT NOT NULL,observation_signature TEXT NOT NULL,record_json TEXT NOT NULL,observed_at TEXT NOT NULL,PRIMARY KEY(identity,observation_signature));
    CREATE TABLE IF NOT EXISTS failures(url TEXT PRIMARY KEY,kind TEXT NOT NULL,topic_id TEXT,code TEXT NOT NULL,observed_at TEXT NOT NULL);
  `);
  const meta = key => db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value;
  if (meta('scope') && meta('scope') !== scopeJson) { db.close(); throw new Error('CHECKPOINT_SCOPE_MISMATCH'); }
  db.prepare('INSERT OR IGNORE INTO meta VALUES (?,?)').run('scope', scopeJson);
  db.prepare('INSERT OR IGNORE INTO meta VALUES (?,?)').run('snapshot_at', now());
  const enqueue = db.prepare('INSERT OR IGNORE INTO pages(url,kind,topic_id) VALUES (?,?,?)');
  enqueue.run(first, 'list', null);
  const tx = fn => { db.exec('BEGIN IMMEDIATE'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (e) { db.exec('ROLLBACK'); throw e; } };
  const count = query => Number(db.prepare(query).get().n);
  const progress = () => {
    const pending = count("SELECT count(*) n FROM pages WHERE status='pending'");
    const failed = count('SELECT count(*) n FROM failures');
    const conflicts = count('SELECT count(*) n FROM conflicts c WHERE NOT EXISTS (SELECT 1 FROM conflict_resolutions r WHERE r.identity=c.identity AND r.signature=c.signature)');
    const unverified = count("SELECT count(*) n FROM pages WHERE status='quarantined'");
    const fallback = count("SELECT count(*) n FROM messages WHERE json_extract(record_json,'$.identity_method')='page_position_fallback'");
    const dated = count("SELECT count(*) n FROM messages WHERE json_extract(record_json,'$.source_date_observation.parser_version')='basemail-author-date-v2'");
    const totalMessages = count('SELECT count(*) n FROM messages');
    return {
      schema_version: '1.0', scope: first, list_filter: 'all_topics', snapshot_at: meta('snapshot_at'), updated_at: now(),
      coverage_status: pending || failed || conflicts || unverified ? 'partial' : 'unverified',
      coverage_reason: 'Live mailbox: no source-consistent snapshot or independently verified archive total.',
      discovered_unique_topics: count('SELECT count(*) n FROM topics'), collected_unique_messages: totalMessages,
      date_audit: { status: totalMessages > 0 && dated === totalMessages ? 'observed_author_header' : 'pending_replay', parser_version: 'basemail-author-date-v2', observed_messages: dated, legacy_messages: totalMessages - dated },
      completed_list_pages: count("SELECT count(*) n FROM pages WHERE kind='list' AND status='done'"),
      completed_topic_pages: count("SELECT count(*) n FROM pages WHERE kind='topic' AND status='done'"),
      unfinished_pages: pending, failed_pages: failed, quarantined_pages: unverified, conflict_versions: conflicts,
      resolved_rendering_variants: count("SELECT count(*) n FROM conflict_resolutions WHERE json_extract(record_json,'$.reason')='confirmed_hidden_table_attachment_placeholder'"),
      resolved_date_parsing_variants: count("SELECT count(*) n FROM conflict_resolutions WHERE json_extract(record_json,'$.reason')='verified_author_header_date_parser_correction'"),
      fallback_identity_messages: fallback, attachment_downloads: 'not_collected_links_only',
      observed_counter: meta('observed_counter') ? JSON.parse(meta('observed_counter')) : null,
      first_counter_observation: meta('first_counter_observation') ? JSON.parse(meta('first_counter_observation')) : null,
      last_counter_observation: meta('last_counter_observation') ? JSON.parse(meta('last_counter_observation')) : null,
      repeated_page_responses: count("SELECT count(*) n FROM pages WHERE json_extract(metadata,'$.repeated_page_response')=1"),
      failed_topics: db.prepare('SELECT DISTINCT topic_id FROM failures WHERE topic_id IS NOT NULL').all().map(x => x.topic_id),
      errors: db.prepare('SELECT url,kind,topic_id,code,observed_at FROM failures LIMIT 100').all(),
    };
  };
  const finishPage = (url, metadata, verified) => {
    const current = db.prepare('SELECT kind,topic_id FROM pages WHERE url=?').get(url);
    if (metadata.identity_fingerprint && db.prepare("SELECT url FROM pages WHERE url<>? AND kind=? AND topic_id IS ? AND json_extract(metadata,'$.identity_fingerprint')=? LIMIT 1").get(url, current.kind, current.topic_id, metadata.identity_fingerprint)) {
      metadata.repeated_page_response = true;
      verified = false;
    }
    db.prepare('UPDATE pages SET status=?,observed_at=?,metadata=? WHERE url=?').run(verified ? 'done' : 'quarantined', now(), JSON.stringify(metadata), url);
    db.prepare('DELETE FROM failures WHERE url=?').run(url);
  };
  const api = {
    dbPath: join(dir, 'mail.sqlite'),
    progress,
    nextListPage: () => db.prepare("SELECT url,topic_id FROM pages WHERE kind='list' AND status='pending' ORDER BY rowid LIMIT 1").get() ?? null,
    nextTopicPage: () => db.prepare("SELECT url,topic_id FROM pages WHERE kind='topic' AND status='pending' ORDER BY rowid LIMIT 1").get() ?? null,
    ingestListPage(page) {
      const url = canonicalUrl(page.url);
      if (page.filter_confirmed !== true) throw new Error('ALL_TOPICS_FILTER_NOT_CONFIRMED');
      if (!Array.isArray(page.topics) || !Array.isArray(page.page_links)) throw new Error('INVALID_LIST_PAGE');
      tx(() => {
        enqueue.run(url, 'list', null);
        for (const topic of page.topics) {
          if (!/^\d+$/.test(String(topic.topic_id))) throw new Error('INVALID_TOPIC_ID');
          const id = String(topic.topic_id), source = canonicalUrl(topic.source_url ?? topic.url, id);
          const record = { ...topic, topic_id: id, source_url: source, collected_at: now() };
          db.prepare('INSERT INTO topics VALUES (?,?) ON CONFLICT(topic_id) DO UPDATE SET record_json=excluded.record_json').run(id, JSON.stringify(record));
          enqueue.run(source, 'topic', id);
        }
        for (const link of page.page_links) enqueue.run(canonicalUrl(typeof link === 'string' ? link : link.url), 'list', null);
        if (page.observed_counter !== undefined) {
          const observation = JSON.stringify({ value: page.observed_counter, url, observed_at: now() });
          db.prepare('INSERT OR IGNORE INTO meta VALUES (?,?)').run('first_counter_observation', observation);
          db.prepare('INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('last_counter_observation', observation);
          db.prepare('INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('observed_counter', JSON.stringify(page.observed_counter));
        }
        finishPage(url, { topic_count: page.topics.length, filter_confirmed: true, identity_fingerprint: page.topics.length ? digest(JSON.stringify(page.topics.map(t => String(t.topic_id)))) : null }, page.pagination_verified === true && (page.topics.length > 0 || page.empty_verified === true));
      });
      return progress();
    },
    ingestTopicPage(page) {
      const id = String(page.topic_id);
      if (!/^\d+$/.test(id) || !Array.isArray(page.messages) || !Array.isArray(page.page_links)) throw new Error('INVALID_TOPIC_PAGE');
      const url = canonicalUrl(page.url, id);
      tx(() => {
        enqueue.run(url, 'topic', id);
        const old = db.prepare('SELECT record_json FROM topics WHERE topic_id=?').get(id);
        const topic = { ...(old ? JSON.parse(old.record_json) : {}), topic_id: id, title: page.title ?? (old ? JSON.parse(old.record_json).title : ''), source_url: url };
        db.prepare('INSERT OR IGNORE INTO topics VALUES (?,?)').run(id, JSON.stringify(topic));
        page.messages.forEach((m, index) => {
          const record = { ...messageRecord(m, topic, url, index, new URL(base).origin),
            ...(m.source_header_dates ? { source_header_dates: m.source_header_dates } : {}),
            ...(m.source_date_observation ? { source_date_observation: m.source_date_observation } : {}) };
          const identity = digest(JSON.stringify([record.source_instance, record.source_message_id]));
          const signature = meaningfulMessageSignature(record);
          const previous = db.prepare('SELECT signature,record_json FROM messages WHERE identity=?').get(identity);
          if (previous && previous.signature !== signature) db.prepare('INSERT OR IGNORE INTO conflicts VALUES (?,?,?,?)').run(identity, signature, JSON.stringify(record), now());
          else if (previous && record.source_date_observation) {
            const oldRecord = JSON.parse(previous.record_json);
            if (!oldRecord.source_date_observation) {
              const observedAt = now();
              const evidence = { reason: 'author_header_date_observed_without_content_change', original: oldRecord, source_header_dates: record.source_header_dates, source_date_observation: record.source_date_observation, observed_at: observedAt };
              db.prepare('INSERT OR IGNORE INTO date_observations VALUES (?,?,?,?)').run(identity, digest(JSON.stringify([record.source_header_dates, record.source_date_observation])), JSON.stringify(evidence), observedAt);
              db.prepare('UPDATE messages SET record_json=? WHERE identity=?').run(JSON.stringify({ ...oldRecord, source_header_dates: record.source_header_dates, source_date_observation: record.source_date_observation }), identity);
            }
          } else db.prepare('INSERT OR IGNORE INTO messages VALUES (?,?,?,?)').run(identity, id, JSON.stringify(record), signature);
        });
        for (const link of page.page_links) enqueue.run(canonicalUrl(typeof link === 'string' ? link : link.url, id), 'topic', id);
        finishPage(url, { message_count: page.messages.length, ...(page.count_mismatch ? { count_mismatch: page.count_mismatch } : {}), identity_fingerprint: page.messages.length && page.messages.every(m => m.source_message_id != null) ? digest(JSON.stringify(page.messages.map(m => String(m.source_message_id)))) : null }, page.pagination_verified === true && page.content_verified === true && (page.messages.length > 0 || page.empty_verified === true));
      });
      return progress();
    },
    recordFailure({ url, kind = 'list', topic_id = null, code = 'PAGE_LOAD_FAILED' }) {
      if (!['list', 'topic'].includes(kind)) throw new Error('INVALID_PAGE_KIND');
      const safe = canonicalUrl(url, kind === 'topic' ? String(topic_id) : null);
      if (!/^[A-Z0-9_]{1,80}$/.test(code)) code = 'PAGE_LOAD_FAILED';
      tx(() => {
        enqueue.run(safe, kind, topic_id);
        db.prepare("UPDATE pages SET status='failed',attempts=attempts+1 WHERE url=?").run(safe);
        db.prepare('INSERT INTO failures VALUES (?,?,?,?,?) ON CONFLICT(url) DO UPDATE SET code=excluded.code,observed_at=excluded.observed_at').run(safe, kind, topic_id, code, now());
      });
      return progress();
    },
    retryFailures() { db.exec("UPDATE pages SET status='pending' WHERE status IN ('failed','quarantined')"); },
    resolveRenderingVariants() {
      let resolved = 0;
      tx(() => {
        const rows = db.prepare('SELECT c.identity,c.signature,c.record_json,m.record_json original_json FROM conflicts c JOIN messages m ON m.identity=c.identity WHERE NOT EXISTS (SELECT 1 FROM conflict_resolutions r WHERE r.identity=c.identity AND r.signature=c.signature)').all();
        for (const row of rows) {
          const original = JSON.parse(row.original_json), visible = JSON.parse(row.record_json);
          if (!isConfirmedRenderingVariant(original, visible)) continue;
          const timestamp = now();
          const audit = { identity: row.identity, variant_signature: row.signature, reason: 'confirmed_hidden_table_attachment_placeholder', resolved_at: timestamp, original, canonical: visible };
          db.prepare('INSERT INTO conflict_resolutions VALUES (?,?,?,?)').run(row.identity, row.signature, JSON.stringify(audit), timestamp);
          db.prepare('UPDATE messages SET record_json=?,signature=? WHERE identity=?').run(row.record_json, meaningfulMessageSignature(visible), row.identity);
          resolved++;
        }
      });
      return { resolved, progress: progress() };
    },
    resolveDateParsingCorrections() {
      let resolved = 0;
      tx(() => {
        const rows = db.prepare('SELECT c.identity,c.signature,c.record_json,m.record_json original_json FROM conflicts c JOIN messages m ON m.identity=c.identity WHERE NOT EXISTS (SELECT 1 FROM conflict_resolutions r WHERE r.identity=c.identity AND r.signature=c.signature)').all();
        for (const row of rows) {
          const original = JSON.parse(row.original_json), observed = JSON.parse(row.record_json);
          if (!isConfirmedAuthorDateCorrection(original, observed)) continue;
          const timestamp = now();
          const audit = { identity: row.identity, variant_signature: row.signature, reason: 'verified_author_header_date_parser_correction', resolved_at: timestamp, evidence: observed.source_date_observation, source_header_dates: observed.source_header_dates, original, canonical: observed };
          db.prepare('INSERT INTO conflict_resolutions VALUES (?,?,?,?)').run(row.identity, row.signature, JSON.stringify(audit), timestamp);
          db.prepare('UPDATE messages SET record_json=?,signature=? WHERE identity=?').run(row.record_json, meaningfulMessageSignature(observed), row.identity);
          resolved++;
        }
      });
      return { resolved, progress: progress() };
    },
    async checkpoint() {
      const manifest = progress();
      const temporary = join(dir, `manifest.${randomUUID()}.tmp`);
      await writeFile(temporary, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
      await rename(temporary, join(dir, 'manifest.json'));
      return manifest;
    },
    async exportNdjson() {
      for (const [file, table, order] of [['topics.ndjson', 'topics', 'topic_id'], ['messages.ndjson', 'messages', 'identity'], ['conflicts.ndjson', 'conflicts', 'identity,signature'], ['conflict-resolutions.ndjson', 'conflict_resolutions', 'identity,signature'], ['date-observations.ndjson', 'date_observations', 'identity,observation_signature']]) {
        const stream = createWriteStream(join(dir, file + '.tmp'), { mode: 0o600 });
        let streamError;
        stream.on('error', error => { streamError = error; });
        try {
          for (const row of db.prepare(`SELECT record_json FROM ${table} ORDER BY ${order}`).iterate()) {
            if (streamError) throw streamError;
            if (!stream.write(row.record_json + '\n')) await once(stream, 'drain');
          }
          stream.end();
          await once(stream, 'finish');
          await rename(join(dir, file + '.tmp'), join(dir, file));
        } catch (error) { stream.destroy(); throw error; }
      }
      return api.checkpoint();
    },
    close() { db.close(); },
  };
  return api;
}
