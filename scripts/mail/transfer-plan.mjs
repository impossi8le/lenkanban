import { createHash } from 'node:crypto';
import { buildReport } from './classifier-core.mjs';
import { normalizeMessageContent, processThreadEpisodes } from './normalizer-episodes.mjs';

export const TRANSFER_PLAN_SCHEMA = 'mail-transfer-1';
export const TRANSFER_LEDGER_SCHEMA = 'mail-transfer-ledger-1';

const fail = code => { throw new Error(code); };
const order = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const text = value => typeof value === 'string' && value.trim().length > 0;
const unique = rows => [...new Set(rows)].sort(order);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort(order).map(key => [key, canonical(value[key])]));
  }
  return value;
}

export const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

/** Stable identity of one collected message; never derived from its content. */
export const messageKey = row => digest([row.source_instance, String(row.source_message_id)]);

const OFFSET = /^(?:Z|[+-](?:(?:0\d|1[0-3]):[0-5]\d|14:00))$/;
const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;
const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const daysInMonth = (year, month) => month === 2 && ((year % 4 === 0 && year % 100 !== 0) || year % 400 === 0)
  ? 29 : MONTH_LENGTHS[month - 1];

/** Strict ISO-8601 timestamp with an explicit offset; local wall-clock values are not dates. */
export function isTransferTimestamp(value) {
  if (typeof value !== 'string') return false;
  const match = ISO_TIMESTAMP.exec(value);
  if (!match || !OFFSET.test(match[4])) return false;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return false;
  return Number.isFinite(Date.parse(value));
}

/**
 * Links from mail are inert metadata. Only http(s) links without credentials, fragments
 * or unknown query fields are retained; nothing is ever fetched.
 */
export function transferUrl(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) return null;
    const seen = new Set();
    for (const [key, item] of url.searchParams) {
      if (seen.has(key) || !['folder', 'folderid', 'topicid', 'page', 'attachmentid', 'id'].includes(key)) return null;
      if (key === 'folder' ? item !== 'all' : !/^\d+$/.test(item)) return null;
      seen.add(key);
    }
    return url.href;
  } catch { return null; }
}

const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function validateScope(config) {
  if (!isPlainObject(config) || !text(config.source_instance) || !text(config.export_method)
    || !isTransferTimestamp(config.from) || !isTransferTimestamp(config.until)
    || Date.parse(config.from) >= Date.parse(config.until)
    || !Array.isArray(config.selected_episode_ids)
    || config.selected_episode_ids.some(id => !text(id))
    || (config.source_utc_offset != null && !OFFSET.test(config.source_utc_offset))
    || (config.process_map != null && !isPlainObject(config.process_map))
    || (config.authors != null && !isPlainObject(config.authors))
    || (config.attachment_reviews != null && !isPlainObject(config.attachment_reviews))) {
    fail('INVALID_TRANSFER_SCOPE');
  }
  if (new Set(config.selected_episode_ids).size !== config.selected_episode_ids.length) fail('DUPLICATE_SELECTION');
}

function validateReport(report, sourceInstance) {
  if (report?.schema_version !== '1.0' || !Array.isArray(report.messages)) fail('INVALID_REPORT');
  const identities = new Set();
  for (const row of report.messages) {
    if (row?.source_instance !== sourceInstance || !text(String(row.source_message_id ?? ''))
      || !text(String(row.topic_id ?? ''))) fail('INVALID_REPORT_IDENTITY');
    const key = messageKey(row);
    if (identities.has(key)) fail('DUPLICATE_REPORT_IDENTITY');
    identities.add(key);
  }
  return identities;
}

function validateSources(messages, sourceInstance, reportIdentities) {
  if (!Array.isArray(messages)) fail('INVALID_REPORT');
  const raw = new Map();
  for (const row of messages) {
    if (!row || row.source_instance !== sourceInstance || !text(String(row.source_message_id ?? ''))) {
      fail('UNEXPECTED_SOURCE_MESSAGE');
    }
    const key = messageKey(row);
    if (!reportIdentities.has(key)) fail('UNEXPECTED_SOURCE_MESSAGE');
    if (raw.has(key)) fail('DUPLICATE_SOURCE_MESSAGE');
    raw.set(key, row);
  }
  return raw;
}

/**
 * Reclassifies the supplied source and compares it with the report rows that are
 * available. The legacy report carries no content digest, so approval of the new
 * plan binds the complete payload instead.
 */
function verifyClassification(report, raw) {
  if (!raw.size) return;
  const rebuilt = new Map(buildReport([...raw.values()]).messages.map(row => [messageKey(row), row]));
  for (const row of report.messages) {
    const expected = rebuilt.get(messageKey(row));
    if (expected && digest(expected) !== digest(row)) fail('STALE_CLASSIFIED_REPORT');
  }
}

function cardMessages({ episode, rows, raw, config, membership, reasons }) {
  return episode.message_ids.map(id => {
    const row = rows.get(String(id));
    if (!row) fail('UNKNOWN_EPISODE_MESSAGE');
    const key = messageKey(row);
    const source = raw.get(key);
    if (!source) {
      reasons.add('missing_source_metadata');
      return {
        message_key: key, source_message_id: row.source_message_id, topic_id: row.topic_id,
        source_url: row.source_url ?? null, author_text: null, author_id: null,
        raw_sent_at: null, raw_author_header: null, sent_at: null, body_text: null, attachments: [],
      };
    }
    const norm = normalizeMessageContent(source);
    const localDate = norm.normalized_dates.author_date_iso;
    let sentAt = null;
    if (isTransferTimestamp(source.sent_at)) sentAt = new Date(source.sent_at).toISOString();
    else if (localDate && config.source_utc_offset) sentAt = new Date(`${localDate}${config.source_utc_offset}`).toISOString();
    if (!sentAt) reasons.add(localDate ? 'missing_source_timezone' : 'missing_author_date');
    else if (Date.parse(sentAt) < Date.parse(config.from) || Date.parse(sentAt) >= Date.parse(config.until)) {
      reasons.add('outside_period');
    }

    const authorText = typeof source.author_text === 'string' ? source.author_text : null;
    const mapped = authorText != null && Object.hasOwn(config.authors ?? {}, authorText) ? config.authors[authorText] : null;
    const authorId = text(mapped) ? mapped : null;
    if (!authorId) reasons.add('unmapped_author');

    const sourceUrl = transferUrl(source.source_url ?? row.source_url);
    if (!sourceUrl) reasons.add('unsafe_source_link');

    if (source.content_status !== 'complete' || source.identity_method !== 'source_id') {
      reasons.add('incomplete_or_unstable_source');
    }
    if (source.attachments_status !== 'complete' || !Array.isArray(source.attachments)) {
      reasons.add('unverified_attachments');
    }

    // A reply without its own operational anchor is attached by the legacy extractor
    // to the previous episode; keep the suggestion, but never approve it silently.
    const standalone = processThreadEpisodes([source]).episodes;
    if (episode.message_ids.length > 1
      && (!standalone.length || standalone.every(item => item.review_required || item.boundary_status !== 'confirmed'))) {
      reasons.add('ambiguous_continuation');
    }

    if ((membership.get(String(id)) ?? 0) > 1) reasons.add('message_spans_multiple_episodes');

    const attachments = (Array.isArray(source.attachments) ? source.attachments : []).map((item, index) => {
      const visibility = item?.visibility ?? null;
      const review = config.attachment_reviews?.[key]?.[index];
      const verified = review?.verified === true && ['ordinary', 'internal'].includes(visibility)
        && review.visibility === visibility;
      if (!verified) reasons.add('attachment_access_review');
      const url = transferUrl(item?.url);
      if (!url) reasons.add('unsafe_attachment_link');
      return {
        name: typeof item?.name === 'string' ? item.name : null,
        source_url: url, visibility, access_verified: verified,
        download_policy: 'server_authorization_required', content_copied: false,
      };
    });

    return {
      message_key: key, source_message_id: row.source_message_id, topic_id: row.topic_id,
      source_url: sourceUrl, author_text: authorText, author_id: authorId,
      raw_sent_at: source.sent_at ?? null, raw_author_header: source.source_header_dates?.author_header ?? null,
      sent_at: sentAt, body_text: typeof source.body_text === 'string' ? source.body_text : '', attachments,
    };
  }).sort((a, b) => order(a.message_key, b.message_key));
}

/**
 * Builds a side-effect-free preview: topic/message -> process -> proposed card, with
 * authors, dates, attachments and source links. No mail, network or database access.
 */
export function buildTransferPlan({ report, messages = [], episodes, config }) {
  validateScope(config);
  const reportIdentities = validateReport(report, config.source_instance);
  const raw = validateSources(messages, config.source_instance, reportIdentities);
  verifyClassification(report, raw);

  const extracted = processThreadEpisodes(messages);
  if (episodes !== undefined) {
    if (!isPlainObject(episodes) || !Array.isArray(episodes.episodes)
      || digest(episodes.episodes) !== digest(extracted.episodes)) fail('STALE_EPISODES');
  }
  const allEpisodes = episodes?.episodes ?? extracted.episodes;
  const known = new Set(allEpisodes.map(episode => episode.episode_id));
  if (config.selected_episode_ids.some(id => !known.has(id))) fail('UNKNOWN_SELECTED_EPISODE');

  const membership = new Map();
  for (const episode of allEpisodes) {
    for (const id of episode.message_ids) membership.set(String(id), (membership.get(String(id)) ?? 0) + 1);
  }

  const classified = new Map(report.messages.map(row => [messageKey(row), row]));
  const duplicates = new Set(extracted.duplicates.flatMap(item => [item.original_episode_id, item.duplicate_episode_id]));
  const selectedIds = new Set(config.selected_episode_ids);
  const cards = allEpisodes.map(episode => {
    const reasons = new Set();
    if (episode.review_required || episode.boundary_status !== 'confirmed') reasons.add('ambiguous_episode');
    if (episode.is_possible_duplicate || duplicates.has(episode.episode_id)) reasons.add('possible_duplicate_episode');
    // These extractor boundaries need an owner to split them by request/shift first.
    if (['shift_handover', 'receipt_request'].includes(episode.episode_type)) reasons.add('manual_split_required');

    const rows = new Map();
    for (const id of episode.message_ids) {
      const row = classified.get(digest([config.source_instance, String(id)]));
      if (!row) fail('UNKNOWN_EPISODE_MESSAGE');
      rows.set(String(id), row);
    }
    const processes = unique([...rows.values()].map(row => row.primary_category));
    const process = processes.length === 1 ? processes[0] : null;
    if (!process || process === 'unmatched' || [...rows.values()].some(row => row.review_required)) {
      reasons.add('classification_review');
    }
    const target = process ? config.process_map?.[process] : null;
    if (!isPlainObject(target) || !text(target.board_id) || target.owner_approved !== true) {
      reasons.add('process_not_approved');
    }
    const messagesForCard = cardMessages({ episode, rows, raw, config, membership, reasons });
    const selected = selectedIds.has(episode.episode_id);
    return {
      card_key: digest([config.source_instance, episode.thread_id, episode.episode_id]),
      episode_id: episode.episode_id, thread_id: episode.thread_id, topic_id: episode.topic_id,
      episode_type: episode.episode_type, identifier_value: episode.identifier_value ?? null,
      title: [...rows.values()][0]?.title ?? '', process,
      board_id: target?.board_id ?? null, selected,
      status: reasons.size ? 'manual_review' : selected ? 'ready' : 'not_selected',
      reasons: [...reasons].sort(order), messages: messagesForCard,
    };
  }).sort((a, b) => order(a.card_key, b.card_key));

  if (config.scope_confirmed !== true) {
    for (const card of cards) {
      if (!card.reasons.includes('scope_not_confirmed')) card.reasons.push('scope_not_confirmed');
      card.reasons.sort(order);
      card.status = 'manual_review';
    }
  }

  const assigned = new Set(cards.flatMap(card => card.messages.map(message => message.message_key)));
  const manualReview = report.messages.filter(row => !assigned.has(messageKey(row))).map(row => ({
    message_key: messageKey(row), topic_id: row.topic_id, source_message_id: row.source_message_id,
    process: row.primary_category, reason: raw.has(messageKey(row)) ? 'no_confirmed_episode' : 'missing_source_metadata',
  }));

  const resultJournal = [
    ...cards.map(card => ({
      card_key: card.card_key, message_keys: card.messages.map(message => message.message_key),
      action: card.status === 'ready' ? 'would_create' : card.status === 'not_selected' ? 'skip' : 'manual_review',
      reasons: card.status === 'not_selected' ? ['not_selected'] : [...card.reasons],
    })),
    ...manualReview.map(row => ({ message_keys: [row.message_key], action: 'skip', reasons: [row.reason] })),
  ];

  const plan = {
    schema_version: TRANSFER_PLAN_SCHEMA, mode: 'dry-run', database_import_enabled: false,
    scope: {
      source_instance: config.source_instance, export_method: config.export_method,
      from: config.from, until: config.until, source_utc_offset: config.source_utc_offset ?? null,
      period: '[from, until)', confirmed: config.scope_confirmed === true,
      automatic_mail_api_access: 'unconfirmed',
    },
    source_report_sha256: digest(report), coverage_status: report.coverage?.coverage_status ?? 'unverified',
    cards, manual_review: manualReview, result_journal: resultJournal,
    rollback: {
      ownership_field: 'batch_id', import_key_field: 'card_key',
      candidate_card_keys: cards.filter(card => card.status === 'ready').map(card => card.card_key),
      policy: 'delete_only_created_unchanged_and_unreferenced',
      target_ids: 'recorded_in_transaction_ledger_after_creation', source_mail_changed: false,
    },
    counts: {
      cards: cards.length, selected: cards.filter(card => card.selected).length,
      ready: cards.filter(card => card.status === 'ready').length,
      not_selected: cards.filter(card => card.status === 'not_selected').length,
      manual_review: cards.filter(card => card.status === 'manual_review').length + manualReview.length,
    },
  };
  return { ...plan, plan_sha256: digest(plan) };
}

/** The approved preview is immutable: any changed byte requires a new preview and approval. */
export function verifyPlan(plan, approval) {
  if (!isPlainObject(plan)) fail('PREVIEW_APPROVAL_REQUIRED');
  const { plan_sha256: hash, ...payload } = plan;
  if (plan.schema_version !== TRANSFER_PLAN_SCHEMA || plan.mode !== 'dry-run'
    || plan.database_import_enabled !== false || hash !== digest(payload) || approval !== hash) {
    fail('PREVIEW_APPROVAL_REQUIRED');
  }
  if (plan.scope?.confirmed !== true) fail('SCOPE_NOT_CONFIRMED');
}

export const emptyTransferState = () => ({
  schema_version: TRANSFER_LEDGER_SCHEMA, cards: {}, batches: {}, journal: [],
});

const has = (object, key) => Object.hasOwn(object, key);

function verifyPreviousBatch(state, batchId, batch, plan) {
  if (batch.plan_sha256 !== plan.plan_sha256 || batch.status !== 'applied') fail('BATCH_CONFLICT');
  for (const key of [...batch.created, ...batch.reused]) {
    const stored = state.cards[key];
    const expected = plan.cards.find(card => card.card_key === key && card.selected);
    if (!stored || !expected || stored.fingerprint !== digest(expected)
      || digest(stored.payload) !== stored.fingerprint
      || (batch.created.includes(key) && stored.batch_id !== batchId)) {
      fail('IMPORTED_CARD_CONFLICT');
    }
  }
}

/**
 * Pure, atomic ledger transition. The CLI persists cards and journal together under
 * an exclusive lock; nothing here touches a database or the source mail.
 */
export function simulateTransfer(plan, state, { batch_id: batchId, approval } = {}) {
  verifyPlan(plan, approval);
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(batchId ?? '')) fail('INVALID_BATCH_ID');
  if (state?.schema_version !== TRANSFER_LEDGER_SCHEMA) fail('INVALID_SIMULATION_STATE');
  const next = structuredClone(state);
  if (has(next.batches, batchId)) {
    verifyPreviousBatch(next, batchId, next.batches[batchId], plan);
    return { state: next, result: { batch_id: batchId, status: 'already_applied', created: 0 } };
  }
  const candidates = plan.cards.filter(card => card.selected);
  if (!candidates.length) fail('NO_SELECTED_CARDS');
  if (candidates.some(card => card.status !== 'ready')) fail('SELECTED_CARDS_REQUIRE_REVIEW');
  const created = [], reused = [];
  for (const card of candidates) {
    const fingerprint = digest(card);
    if (has(next.cards, card.card_key)) {
      const existing = next.cards[card.card_key];
      if (existing.fingerprint !== fingerprint || digest(existing.payload) !== existing.fingerprint) {
        fail('IMPORTED_CARD_CONFLICT');
      }
      reused.push(card.card_key);
      continue;
    }
    // Do not silently duplicate a source message when episode boundaries change.
    const keys = new Set(card.messages.map(message => message.message_key));
    if (Object.values(next.cards).some(item => item.payload.messages.some(message => keys.has(message.message_key)))) {
      fail('IMPORTED_MESSAGE_CONFLICT');
    }
    next.cards[card.card_key] = { batch_id: batchId, fingerprint, payload: structuredClone(card) };
    created.push(card.card_key);
  }
  next.batches[batchId] = { plan_sha256: plan.plan_sha256, status: 'applied', created, reused };
  const result = { batch_id: batchId, status: 'applied', created: created.length, reused: reused.length };
  next.journal.push({
    operation: 'simulate', batch_id: batchId, status: 'applied',
    created: result.created, reused: result.reused, plan_sha256: plan.plan_sha256,
    occurred_at: new Date().toISOString(),
  });
  return { state: next, result };
}

/** Removes only cards created by this batch, unchanged and not reused by another batch. */
export function rollbackTransfer(state, batchId) {
  if (state?.schema_version !== TRANSFER_LEDGER_SCHEMA) fail('INVALID_SIMULATION_STATE');
  const next = structuredClone(state);
  if (!has(next.batches, batchId)) fail('UNKNOWN_BATCH');
  const batch = next.batches[batchId];
  if (batch.status === 'rolled_back') {
    return { state: next, result: { batch_id: batchId, status: 'already_rolled_back', removed: 0 } };
  }
  for (const key of batch.created) {
    const card = next.cards[key];
    if (!card || card.batch_id !== batchId || digest(card.payload) !== card.fingerprint) fail('ROLLBACK_CONFLICT');
    if (Object.entries(next.batches).some(([id, other]) => id !== batchId
      && other.status === 'applied' && other.reused.includes(key))) fail('BATCH_IN_USE');
  }
  for (const key of batch.created) delete next.cards[key];
  batch.status = 'rolled_back';
  const result = { batch_id: batchId, status: 'rolled_back', removed: batch.created.length };
  next.journal.push({
    operation: 'rollback', batch_id: batchId, status: 'rolled_back',
    removed: result.removed, plan_sha256: batch.plan_sha256, occurred_at: new Date().toISOString(),
  });
  return { state: next, result };
}
