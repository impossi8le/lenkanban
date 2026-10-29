import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildReviewedOverview, originalReviewHash, sourceSnapshotHash } from '../../scripts/mail/review-ledger.mjs';
import { renderOverviewSummary, overviewCoverage } from '../../scripts/mail/mail-overview.mjs';

const sha = text => createHash('sha256').update(text).digest('hex');
function fixture() {
  const topics = [1, 2, 3].map(topic_id => ({ topic_id: String(topic_id), title: `Номер ${topic_id}`, initial_excerpt: 'PRIVATE_MARKER_NONPUBLIC', source_url: `https://private.example.test/?topicid=${topic_id}`, list_header_dates: { secondary_header: '20.10.2026 10:00' } }));
  topics.push({ topic_id: '4', title: 'Отчет о проделанной работе', initial_excerpt: '', list_header_dates: { secondary_header: '20.10.2026 10:00' } });
  const corpus = topics.slice(0, 3).map((row, index) => {
    const payload = { review_id: `U${String(index + 1).padStart(4, '0')}`, title: 'redacted', preview: '', activity_at: '2026-10-20T10:00:00', baseline_reason: 'no_matching_rule', needs_private_review: true, privacy_status: 'private_fixture' };
    return { ...payload, input_sha256: sha(JSON.stringify(payload)) };
  });
  const mapping = corpus.map((row, i) => ({ review_id: row.review_id, topic_id: topics[i].topic_id, original_hash: originalReviewHash(topics[i]), input_sha256: row.input_sha256 }));
  const firstReview = corpus.map((row, index) => ({ review_id: row.review_id, input_sha256: row.input_sha256, category: index === 0 ? 'marketing_campaigns' : index === 1 ? 'it_support' : 'unmatched', reason_code: index === 2 ? 'ambiguous_context' : 'explicit_request', evidence_kind: index === 2 ? 'none' : 'preview', confidence: index === 2 ? 'low' : 'medium' }));
  return { topics, corpus, mapping, baselineSnapshotSha256: sourceSnapshotHash(topics), firstReview, secondReview: structuredClone(firstReview), window: { from: '2025-01-01', to: '2026-10-20' }, coverage: overviewCoverage([{ url: 'https://private.example.test/?page=1', status: 'done' }], 1) };
}

test('all reviewed baseline identities contribute exactly once; previous groups remain unchanged', () => {
  const input = fixture(), report = buildReviewedOverview(input);
  assert.equal(report.review_audit.baseline_unmatched, 3);
  assert.equal(report.review_audit.primary_reviewed, 3);
  assert.equal(report.review_audit.independent_reviewed, 3);
  assert.equal(report.review_audit.newly_grouped, 2);
  assert.equal(report.review_audit.remaining_unmatched, 1);
  assert.equal(report.counts.indexed_topics, 4);
  assert.equal(report.counts.provisional_grouped_topics, 3);
  assert.equal(report.groups.find(g => g.id === 'reports').topics, 1);
  assert.equal(report.groups.find(g => g.id === 'marketing_campaigns').activity.year_counts['2026'], 1);
});

test('disagreement stays unresolved unless explicitly adjudicated, with no majority guess', () => {
  const input = fixture(); input.secondReview[0].category = 'procurement';
  const before = buildReviewedOverview(input);
  assert.equal(before.review_audit.disagreements, 1);
  assert.equal(before.review_audit.adjudicated, 0);
  assert.equal(before.unmatched_reasons.model_disagreement, 1);
  const after = buildReviewedOverview({ ...input, adjudications: [input.firstReview[0]] });
  assert.equal(after.review_audit.adjudicated, 1);
  assert.equal(after.review_audit.remaining_unmatched, 1);
  assert.throws(() => buildReviewedOverview({ ...fixture(), adjudications: [fixture().firstReview[0]] }), /ADJUDICATION_REQUIRES_DISAGREEMENT/);
});

test('missing, duplicate, unknown and stale decisions fail rather than manufacture full coverage', () => {
  assert.throws(() => buildReviewedOverview({ ...fixture(), firstReview: [] }), /INCOMPLETE_REVIEW_COVERAGE/);
  const duplicate = fixture(); duplicate.secondReview[2] = duplicate.secondReview[0];
  assert.throws(() => buildReviewedOverview(duplicate), /UNKNOWN_OR_DUPLICATE_REVIEW_ID/);
  const unknown = fixture(); unknown.firstReview[0].review_id = 'U9999';
  assert.throws(() => buildReviewedOverview(unknown), /UNKNOWN_OR_DUPLICATE_REVIEW_ID/);
  const stale = fixture(); stale.secondReview[0].input_sha256 = '0'.repeat(64);
  assert.throws(() => buildReviewedOverview(stale), /STALE_REVIEW_HASH/);
});

test('source edits, mapping holes and corrupt sanitized payloads invalidate prior decisions', () => {
  const source = fixture(); source.topics[0].initial_excerpt += ' changed';
  assert.throws(() => buildReviewedOverview(source), /STALE_SOURCE_SNAPSHOT/);
  const assigned = fixture(); assigned.topics[3].title = 'Счета';
  assert.throws(() => buildReviewedOverview(assigned), /STALE_SOURCE_SNAPSHOT/);
  const safe = fixture(); safe.corpus[0].preview = 'tampered';
  assert.throws(() => buildReviewedOverview(safe), /CORRUPTED_CORPUS_HASH/);
  const missing = fixture(); missing.mapping.pop();
  assert.throws(() => buildReviewedOverview(missing), /INCOMPLETE_BASELINE_MAPPING/);
});

test('a mapping cannot override an existing classification or import an out-of-period topic', () => {
  const existing = fixture(); existing.mapping[0].topic_id = '4';
  assert.throws(() => buildReviewedOverview(existing), /INVALID_BASELINE_MAPPING/);
  const outside = fixture(); outside.topics[0].list_header_dates.secondary_header = '31.12.2024 23:59';
  assert.throws(() => buildReviewedOverview(outside), /STALE_SOURCE_SNAPSHOT/);
});

test('unlisted codes, arbitrary extra text and unsupported assignments are rejected', () => {
  for (const [field, value, pattern] of [['category', 'made_up_board', /INVALID_REVIEW_CODE/], ['reason_code', 'raw source text', /INVALID_REVIEW_CODE/], ['confidence', 'low', /UNSUPPORTED_ASSIGNMENT/], ['evidence_kind', 'none', /UNSUPPORTED_ASSIGNMENT/]]) {
    const input = fixture(); input.firstReview[0][field] = value;
    assert.throws(() => buildReviewedOverview(input), pattern);
  }
  const extra = fixture(); extra.firstReview[0].source_quote = 'PRIVATE_MARKER';
  assert.throws(() => buildReviewedOverview(extra), /INVALID_REVIEW_FIELDS/);
});

test('public report and Markdown contain audit counts and fixed templates, no source content', () => {
  const report = buildReviewedOverview(fixture()), markdown = renderOverviewSummary(report);
  for (const text of [JSON.stringify(report), markdown]) {
    assert.equal(text.includes('PRIVATE_MARKER'), false);
    assert.equal(text.includes('private.example.test'), false);
    assert.equal(text.includes('Номер 1'), false);
    assert.equal(text.includes('U0001'), false);
  }
  assert.match(markdown, /Совпадение моделей не является доказательством точности/);
  assert.match(markdown, /первый просмотр — 3, независимый второй — 3/);
  assert.match(markdown, /reviewed-unmatched\.ndjson/);
});

test('a new process needs explicit local refinement when both reviewers leave it outside the fixed catalogue', () => {
  const input = fixture();
  for (const rows of [input.firstReview, input.secondReview]) rows[2].reason_code = 'new_family_needed';
  const adjudication = { ...input.firstReview[2], category: 'legal_requests', reason_code: 'explicit_request', evidence_kind: 'preview', confidence: 'high' };
  const report = buildReviewedOverview({ ...input, adjudications: [adjudication] });
  assert.equal(report.review_audit.manual_refinements, 1);
  assert.equal(report.review_audit.disagreements, 0);
  assert.equal(report.review_audit.remaining_unmatched, 0);
  assert.equal(report.groups.find(g => g.id === 'legal_requests').proposal_type, 'restricted_review');
});
