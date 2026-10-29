import test from 'node:test';
import assert from 'node:assert/strict';
import { MAIL_OVERVIEW_WINDOW, MAIL_WINDOW_STATEMENT, parseMailTimestamp, validateMailDateWindow, classifyTopicActivity, summarizeMailWindow } from '../../scripts/mail/mail-date-window.mjs';

const window = { from: '2025-01-01', to: '2026-10-20' };
const topic = (secondary, author = '01.01.2020 00:00', id = '8') => ({ topic_id: id, list_header_dates: { author_header: author, secondary_header: secondary } });

test('strict timestamp parsing yields sortable local ISO keys with no host timezone input', () => {
  assert.equal(parseMailTimestamp('20.10.2026 18:30'), '2026-10-20T18:30:00');
  assert.equal(parseMailTimestamp('01.02.2025 09:05:07'), '2025-02-01T09:05:07');
  assert.ok(parseMailTimestamp('31.12.2024 23:59') < parseMailTimestamp('01.01.2025 00:00'));
  assert.ok(parseMailTimestamp('01.01.2025 10:00:30') > parseMailTimestamp('01.01.2025 10:00'));
});

test('leap day handling follows the Gregorian 4/100/400 rules', () => {
  assert.equal(parseMailTimestamp('29.02.2024 12:00'), '2024-02-29T12:00:00');
  assert.equal(parseMailTimestamp('29.02.2000 12:00'), '2000-02-29T12:00:00');
  assert.equal(parseMailTimestamp('29.02.2023 12:00'), null);
  assert.equal(parseMailTimestamp('29.02.1900 12:00'), null);
  assert.deepEqual(validateMailDateWindow({ from: '2024-02-29', to: '2024-02-29' }), { from: '2024-02-29', to: '2024-02-29' });
  assert.equal(validateMailDateWindow({ from: '2023-02-29', to: '2023-03-01' }), null);
});

test('invalid dates and malformed formats are rejected instead of guessed', () => {
  assert.equal(parseMailTimestamp('31.04.2025 10:00'), null);
  assert.equal(parseMailTimestamp('01.13.2025 10:00'), null);
  assert.equal(parseMailTimestamp('00.03.2025 10:00'), null);
  assert.equal(parseMailTimestamp('25.12.2025 24:00'), null);
  assert.equal(parseMailTimestamp('25.12.2025 10:60'), null);
  assert.equal(parseMailTimestamp('25.12.2025 10:00:60'), null);
  assert.equal(parseMailTimestamp('2025-12-25 10:00'), null);
  assert.equal(parseMailTimestamp(' 25.12.2025 10:00'), null);
  assert.equal(parseMailTimestamp('25.12.2025  10:00'), null);
  assert.equal(parseMailTimestamp('25.12.2025 10:00 extra'), null);
  assert.equal(parseMailTimestamp(''), null);
  assert.equal(parseMailTimestamp(null), null);
});

test('window validation requires strict YYYY-MM-DD endpoints with from <= to', () => {
  assert.deepEqual(validateMailDateWindow(window), { from: '2025-01-01', to: '2026-10-20' });
  assert.deepEqual(validateMailDateWindow({ from: '2025-01-01', to: '2025-01-01' }), { from: '2025-01-01', to: '2025-01-01' });
  assert.equal(validateMailDateWindow({ from: '2026-10-21', to: '2026-10-20' }), null);
  assert.equal(validateMailDateWindow({ from: '2025-1-1', to: '2026-10-20' }), null);
  assert.equal(validateMailDateWindow({ from: '2025-13-01', to: '2026-10-20' }), null);
  assert.equal(validateMailDateWindow({ from: '2025-01-01' }), null);
  assert.equal(validateMailDateWindow(null), null);
});

test('classification reads only the secondary activity header and keeps full-day endpoints inclusive', () => {
  assert.equal(classifyTopicActivity(topic('05.03.2025 22:05'), window), 'in_window');
  assert.equal(classifyTopicActivity(topic('01.01.2025 00:00'), window), 'in_window');
  assert.equal(classifyTopicActivity(topic('20.10.2026 23:59:59'), window), 'in_window');
  assert.equal(classifyTopicActivity(topic('31.12.2024 23:59'), window), 'before_window');
  assert.equal(classifyTopicActivity(topic('21.10.2026 00:00'), window), 'after_window');
});

test('missing or invalid activity values stay unknown and creation dates are never substituted', () => {
  assert.equal(classifyTopicActivity(topic('01.05.2025 12:00', '15.03.2019 09:00'), window), 'in_window');
  assert.equal(classifyTopicActivity(topic(null, '01.05.2025 12:00'), window), 'unknown');
  assert.equal(classifyTopicActivity(topic(null, '20.10.2026 10:00'), window), 'unknown');
  assert.equal(classifyTopicActivity(topic('31.02.2025 10:00', '01.05.2025 12:00'), window), 'unknown');
  assert.equal(classifyTopicActivity({ topic_id: '8' }, window), 'unknown');
  assert.equal(classifyTopicActivity(null, window), 'unknown');
});

test('an invalid window is a caller error rather than a silent unknown', () => {
  assert.throws(() => classifyTopicActivity(topic('05.03.2025 22:05'), { from: '2025-01-01', to: '2024-01-01' }), /INVALID_MAIL_DATE_WINDOW/);
  assert.throws(() => summarizeMailWindow([], { from: 'x', to: 'y' }), /INVALID_MAIL_DATE_WINDOW/);
});

test('summary aggregates distinct topics, known extremes and in-window months only', () => {
  const topics = [
    topic('05.03.2025 22:05', '01.01.2019 00:00', '1'),
    topic('15.03.2025 08:00', '02.01.2019 00:00', '2'),
    topic('10.01.2026 12:00', '03.01.2019 00:00', '3'),
    topic('31.12.2024 23:59', '04.01.2019 00:00', '4'),
    topic('21.10.2026 00:00', '05.01.2019 00:00', '5'),
    topic(null, '06.01.2019 00:00', '6'),
    topic('99.99.2025 10:00', '07.01.2019 00:00', '7'),
    topic('01.05.2025 12:00', '08.01.2019 00:00', '1'),
  ];
  const summary = summarizeMailWindow(topics, window);
  assert.deepEqual(summary.window, window);
  assert.deepEqual(summary.topic_counts, { in_window: 3, before_window: 1, after_window: 1, unknown: 2 });
  assert.equal(summary.distinct_topics, 7);
  assert.deepEqual(summary.in_window_month_counts, { '2025-03': 2, '2026-01': 1 });
  assert.deepEqual(summary.oldest_known, { topic_id: '4', secondary_header: '31.12.2024 23:59', timestamp: '2024-12-31T23:59:00' });
  assert.deepEqual(summary.latest_known, { topic_id: '5', secondary_header: '21.10.2026 00:00', timestamp: '2026-10-21T00:00:00' });
  assert.equal(summary.statement, MAIL_WINDOW_STATEMENT);
});

test('an empty overview yields zeroed buckets, null extremes and the observation statement', () => {
  const summary = summarizeMailWindow([], MAIL_OVERVIEW_WINDOW);
  assert.deepEqual(summary.topic_counts, { in_window: 0, before_window: 0, after_window: 0, unknown: 0 });
  assert.equal(summary.distinct_topics, 0);
  assert.equal(summary.oldest_known, null);
  assert.equal(summary.latest_known, null);
  assert.deepEqual(summary.in_window_month_counts, {});
  assert.equal(MAIL_OVERVIEW_WINDOW.from, '2025-01-01');
  assert.equal(MAIL_OVERVIEW_WINDOW.to, '2026-10-20');
});
