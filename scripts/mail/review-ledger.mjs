import { createHash } from 'node:crypto';
import { classifyPreview, aggregateOverview } from './mail-overview.mjs';
import { classifyTopicActivity, parseMailTimestamp } from './mail-date-window.mjs';
import { IAB_TAXONOMY } from './iab-report.mjs';
import { REVIEWED_TAXONOMY } from './reviewed-taxonomy.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw Error(code); };
const reasons = new Set(['explicit_request', 'explicit_process_title', 'reference_only', 'number_only', 'no_preview', 'mixed_signals', 'ambiguous_context', 'redacted_context', 'new_family_needed']);
const kinds = new Set(['title', 'preview', 'title_and_preview', 'none']);
const confidence = new Set(['high', 'medium', 'low']);
const categories = new Set([...IAB_TAXONOMY, ...REVIEWED_TAXONOMY].map(g => g.id).concat('unmatched'));
const keys = ['review_id', 'input_sha256', 'category', 'reason_code', 'evidence_kind', 'confidence'].sort();

export function originalReviewHash(row) {
  return hash(JSON.stringify({ title: row.title ?? '', preview: String(row.initial_excerpt ?? row.excerpt ?? ''), activity_at: parseMailTimestamp(row.list_header_dates?.secondary_header) }));
}

export function sourceSnapshotHash(topics) {
  return hash(JSON.stringify(topics.map(row => [String(row.topic_id), originalReviewHash(row)]).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));
}

function decisionMap(rows, expected, requireAll) {
  if (!Array.isArray(rows)) fail('INVALID_REVIEW_ARRAY');
  const indexed = new Map();
  for (const row of rows) {
    if (!row || Object.keys(row).sort().join('|') !== keys.join('|')) fail('INVALID_REVIEW_FIELDS');
    const source = expected.get(row.review_id);
    if (!source || indexed.has(row.review_id)) fail('UNKNOWN_OR_DUPLICATE_REVIEW_ID');
    if (row.input_sha256 !== source.input_sha256) fail('STALE_REVIEW_HASH');
    if (!categories.has(row.category) || !reasons.has(row.reason_code) || !kinds.has(row.evidence_kind) || !confidence.has(row.confidence)) fail('INVALID_REVIEW_CODE');
    if (row.category !== 'unmatched' && (row.confidence === 'low' || row.evidence_kind === 'none')) fail('UNSUPPORTED_ASSIGNMENT');
    indexed.set(row.review_id, row);
  }
  if (requireAll && indexed.size !== expected.size) fail('INCOMPLETE_REVIEW_COVERAGE');
  return indexed;
}

/** Refuse missing/duplicate/stale inputs before changing any report. No source text in errors. */
export function buildReviewedOverview({ topics, coverage, window, mapping, corpus, baselineSnapshotSha256, firstReview, secondReview, adjudications = [], onTopic }) {
  if (!Array.isArray(topics) || !Array.isArray(mapping) || !Array.isArray(corpus)) fail('INVALID_REVIEW_INPUT');
  const ids = new Set();
  for (const row of topics) { if (ids.has(String(row.topic_id))) fail('DUPLICATE_TOPIC_ID'); ids.add(String(row.topic_id)); }
  if (!/^[a-f0-9]{64}$/.test(baselineSnapshotSha256 ?? '') || sourceSnapshotHash(topics) !== baselineSnapshotSha256) fail('STALE_SOURCE_SNAPSHOT');
  const baseline = new Map(topics.filter(row => classifyTopicActivity(row, window) === 'in_window' && classifyPreview(row).category === 'unmatched').map(row => [String(row.topic_id), row]));
  const expected = new Map(), byTopic = new Map(), safe = new Map();
  for (const row of corpus) {
    if (!row || safe.has(row.review_id)) fail('DUPLICATE_CORPUS_ID');
    const { input_sha256, ...payload } = row;
    if (!/^[a-f0-9]{64}$/.test(input_sha256 ?? '') || hash(JSON.stringify(payload)) !== input_sha256) fail('CORRUPTED_CORPUS_HASH');
    safe.set(row.review_id, row);
  }
  for (const row of mapping) {
    const topic = baseline.get(String(row.topic_id)), sanitized = safe.get(row.review_id);
    if (!/^U\d{4}$/.test(row.review_id) || !topic || !sanitized || expected.has(row.review_id) || byTopic.has(String(row.topic_id))) fail('INVALID_BASELINE_MAPPING');
    if (row.original_hash !== originalReviewHash(topic) || row.input_sha256 !== sanitized.input_sha256) fail('STALE_BASELINE_HASH');
    expected.set(row.review_id, row); byTopic.set(String(row.topic_id), row);
  }
  if (expected.size !== baseline.size || safe.size !== expected.size) fail('INCOMPLETE_BASELINE_MAPPING');
  const first = decisionMap(firstReview, expected, true), second = decisionMap(secondReview, expected, true), third = decisionMap(adjudications, expected, false);
  const resolutions = new Map();
  const audit = { baseline_unmatched: baseline.size, primary_reviewed: first.size, independent_reviewed: second.size, source_snapshot_verified: true, agreement: 0, disagreements: 0, adjudicated: 0, manual_refinements: 0, newly_grouped: 0, remaining_unmatched: 0, reason_counts: {}, added_by_category: {} };
  for (const [reviewId, source] of expected) {
    const a = first.get(reviewId), b = second.get(reviewId), agrees = a.category === b.category;
    let result;
    if (agrees) {
      audit.agreement++;
      if (third.has(reviewId)) {
        if (a.category !== 'unmatched' || ![a.reason_code, b.reason_code].includes('new_family_needed')) fail('ADJUDICATION_REQUIRES_DISAGREEMENT');
        audit.manual_refinements++;
        result = { ...third.get(reviewId), decision_source: 'locally_reviewed_new_family' };
      } else result = { ...b, decision_source: 'independent_model_agreement' };
    } else {
      audit.disagreements++;
      if (third.has(reviewId)) { audit.adjudicated++; result = { ...third.get(reviewId), decision_source: 'local_adjudication' }; }
      else result = { ...b, category: 'unmatched', reason_code: 'model_disagreement', decision_source: 'unresolved_disagreement' };
    }
    if (result.category === 'unmatched') {
      audit.remaining_unmatched++;
      audit.reason_counts[result.reason_code] = (audit.reason_counts[result.reason_code] ?? 0) + 1;
    } else {
      audit.newly_grouped++;
      audit.added_by_category[result.category] = (audit.added_by_category[result.category] ?? 0) + 1;
    }
    resolutions.set(String(source.topic_id), result);
  }
  const report = aggregateOverview({ topics, coverage, window, extraGroupTemplates: REVIEWED_TAXONOMY, onTopic,
    classifier: row => {
      const item = resolutions.get(String(row.topic_id));
      if (!item) return classifyPreview(row);
      return { category: item.category, basis: item.evidence_kind, review_required: true, candidates: item.category === 'unmatched' ? [] : [item.category],
        ...(item.category === 'unmatched' ? { reason: item.reason_code } : {}), decision_source: item.decision_source };
    },
  });
  report.classifier_version = 'preview-rules-1+review-ledger-1';
  report.review_audit = audit;
  report.review_audit.limitations = ['titles_and_opening_previews_only', 'model_agreement_is_not_ground_truth', 'topic_activity_does_not_prove_recurrence', 'boards_require_process_owner_validation'];
  if (audit.baseline_unmatched !== audit.newly_grouped + audit.remaining_unmatched || report.counts.unmatched_topics !== audit.remaining_unmatched) fail('REVIEW_BALANCE_MISMATCH');
  return report;
}
