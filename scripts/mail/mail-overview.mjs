#!/usr/bin/env node
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { openSync, writeSync, closeSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { classifyIab, aggregateIab } from './iab-report.mjs';
import { classifyTopicActivity, parseMailTimestamp, validateMailDateWindow } from './mail-date-window.mjs';

const previewOf = row => String(row.initial_excerpt ?? row.excerpt ?? '').trim();
const plain = value => String(value ?? '').replace(/[\r\n|]/gu, ' ').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');

/** Every assignment is provisional: a list preview is never a full discussion. */
export function classifyPreview(row) {
  const title = classifyIab(row, true);
  if (title.primary_category !== 'unmatched') return {
    category: title.primary_category,
    basis: title.confidence === 'provisional_title_and_excerpt' ? 'title_and_preview' : 'title',
    review_required: true, candidates: title.candidates,
  };
  if (title.candidates.length > 1) return { category: 'unmatched', basis: 'title', reason: 'conflicting_title_rules', review_required: true, candidates: title.candidates };
  const preview = previewOf(row);
  if (!preview) return { category: 'unmatched', basis: 'none', reason: String(row.title ?? '').trim() ? 'no_visible_preview_or_title_rule' : 'missing_title_and_preview', review_required: true, candidates: [] };
  const result = classifyIab({ ...row, body_text: preview, content_status: 'preview' }, false);
  const candidates = result.candidates ?? [];
  if (candidates.length === 1) return { category: candidates[0], basis: 'preview', review_required: true, candidates };
  return { category: 'unmatched', basis: 'preview', reason: candidates.length > 1 ? 'conflicting_preview_rules' : 'no_matching_rule', review_required: true, candidates };
}

/** Page coverage is independent from deliberately unfinished deep-read queues. */
export function overviewCoverage(pages, expectedPages) {
  if (!Number.isSafeInteger(expectedPages) || expectedPages < 1) throw Error('INVALID_EXPECTED_PAGES');
  const done = new Set(), seen = new Set();
  let failed = 0, quarantined = 0;
  for (const page of pages) {
    const u = new URL(page.url), n = Number(u.searchParams.get('page') || 1);
    if (!Number.isSafeInteger(n) || n < 1) throw Error('INVALID_PAGE_NUMBER');
    seen.add(n);
    if (page.status === 'done') done.add(n);
    if (page.status === 'failed') failed++;
    if (page.status === 'quarantined') quarantined++;
  }
  const upper = Math.max(expectedPages, ...seen);
  const missing = [];
  for (let n = 1; n <= upper; n++) if (!done.has(n)) missing.push(n);
  return { status: !missing.length && !failed && !quarantined ? 'observed_range_complete' : 'partial',
    observed_last_page: upper, completed_unique_list_pages: done.size,
    missing_list_pages: missing, failed_list_pages: failed, quarantined_list_pages: quarantined,
    content_scope: 'topic_titles_and_visible_opening_previews', snapshot_consistency: 'live_non_atomic',
    full_discussions_collected: false, attachment_contents_reviewed: false };
}

export function aggregateOverview({ topics, coverage, onTopic, window, classifier = classifyPreview, extraGroupTemplates = [] }) {
  if (window && !validateMailDateWindow(window)) throw Error('INVALID_MAIL_DATE_WINDOW');
  const groups = new Map([...aggregateIab({ topics: [], messages: [] }).groups, ...extraGroupTemplates].map(g => [g.id, {
    id: g.id, name: g.name, proposal_type: g.proposal_type ?? 'board', fields: g.fields,
    statuses: g.statuses, participant_roles: g.participant_roles, access: g.access,
    topics: 0, evidence: { title: 0, title_and_preview: 0, preview: 0 },
  }]));
  const counts = { indexed_topics: 0, provisional_grouped_topics: 0, unmatched_topics: 0, missing_title_topics: 0, topics_with_visible_preview: 0 };
  const reasons = {};
  const temporal = window ? { window, basis: 'list_header_dates.secondary_header', semantics: 'observed_topic_activity_not_individual_message_dates', buckets: { in_window: 0, before_window: 0, after_window: 0, unknown: 0 } } : null;
  for (const row of topics) {
    const activity = window ? classifyTopicActivity(row, window) : null;
    if (temporal) {
      temporal.buckets[activity]++;
      if (activity !== 'in_window') {
        onTopic?.({ topic_id: String(row.topic_id), title: String(row.title ?? ''), source_url: row.source_url, temporal_status: activity, category: 'outside_analysis', review_required: activity === 'unknown' });
        continue;
      }
    }
    const classification = classifier(row);
    counts.indexed_topics++;
    if (!String(row.title ?? '').trim()) counts.missing_title_topics++;
    if (previewOf(row)) counts.topics_with_visible_preview++;
    if (classification.category === 'unmatched') {
      counts.unmatched_topics++;
      reasons[classification.reason] = (reasons[classification.reason] ?? 0) + 1;
    } else {
      counts.provisional_grouped_topics++;
      const group = groups.get(classification.category);
      if (!group) throw Error('UNKNOWN_CATEGORY');
      group.topics++;
      group.evidence[classification.basis]++;
      if (window) {
        const date = parseMailTimestamp(row.list_header_dates.secondary_header);
        group.activity ??= { latest: null, year_counts: {}, month_counts: {}, recommendation: 'candidate_requires_process_owner_validation' };
        if (!group.activity.latest || date > group.activity.latest) group.activity.latest = date;
        for (const [field, key] of [['year_counts', date.slice(0, 4)], ['month_counts', date.slice(0, 7)]]) group.activity[field][key] = (group.activity[field][key] ?? 0) + 1;
      }
    }
    onTopic?.({ topic_id: String(row.topic_id), title: String(row.title ?? ''), source_url: row.source_url, ...(window ? { temporal_status: activity, activity_at: parseMailTimestamp(row.list_header_dates.secondary_header) } : {}), ...classification });
  }
  if (window) for (const group of groups.values()) {
    if (group.activity && !group.activity.year_counts[window.to.slice(0, 4)]) group.activity.recommendation = 'insufficient_recent_evidence';
  }
  return { schema_version: '1.0', classifier_version: 'preview-rules-1', generated_at: new Date().toISOString(),
    coverage, ...(temporal ? { temporal } : {}), counts, groups: [...groups.values()].filter(g => g.topics).sort((a, b) => (b.activity?.latest ?? '').localeCompare(a.activity?.latest ?? '') || b.topics - a.topics || a.id.localeCompare(b.id)),
    unmatched_reasons: reasons,
    interpretation: 'Группы предварительные по заголовкам и видимым вступлениям. Сообщения, темы и карточки — разные единицы. Частота исторических тем не доказывает текущую нагрузку.' };
}

/** Safe to publish: no source titles, previews, IDs, contacts or author names. */
export function renderOverviewSummary(report) {
  const c = report.counts, v = report.coverage;
  const lines = [report.temporal ? '# Поверхностный обзор почты за 2025–2026 годы' : '# Поверхностный обзор почтового архива', '', `Срез: ${report.generated_at}.`, '',
    `Охват списка: **${v.status}**. Проверено ${v.completed_unique_list_pages} из ${v.observed_last_page} страниц проверяемого диапазона.`,
    `Тем: **${c.indexed_topics}**; предварительно сгруппированы: **${c.provisional_grouped_topics}**; неразобранные: **${c.unmatched_topics}**.`,
    `Тем без заголовка: ${c.missing_title_topics}; с видимым вступлением: ${c.topics_with_visible_preview}.`, '',
    'Это поверхностный обзор заголовков и видимых вступлений по уточнённому запросу пользователя. Полные обсуждения и содержимое вложений не считаются прочитанными. Архив меняется во время обхода; согласованный снимок не подтверждён.', '',
    'Все назначения предварительные. Количество тем не равно количеству будущих карточек. Историческая частота не задаёт текущий приоритет.', '',
    '| Процесс | Тем | Предлагаемый инструмент |', '|---|---:|---|'];
  const types = { board: 'Kanban-доска', registry: 'Реестр', calendar: 'Календарь', review: 'Реестр; уточнить процесс', restricted_review: 'Ограниченный реестр; уточнить процесс' };
  if (report.temporal) {
    const t = report.temporal;
    lines.splice(4, 0, `Период: **${t.window.from} — ${t.window.to} включительно**. Отбор по второй видимой дате строки темы; это не даты всех отдельных сообщений.`,
      `По времени: в периоде — ${t.buckets.in_window}; до периода — ${t.buckets.before_window}; после — ${t.buckets.after_window}; дата неизвестна — ${t.buckets.unknown}.`, '',
      'Охват относится к явно выбранному диапазону страниц; полнота всего периода за его пределами независимо не подтверждена. Перед миграцией требуется сверка с источником.', '',
      'Предложения — кандидаты для обсуждения с владельцами процессов. Последняя активность и число тем за год не доказывают повторяемость рабочих случаев или необходимость отдельной доски.', '');
  }
  if (report.review_audit) {
    const a = report.review_audit;
    lines.splice(2, 0, `Дополнительный разбор: ${a.baseline_unmatched} исходно неразобранных тем; первый просмотр — ${a.primary_reviewed}, независимый второй — ${a.independent_reviewed}.`,
      `Совпадений назначений — ${a.agreement}; расхождений — ${a.disagreements}, из них локально проверено — ${a.adjudicated}; совместно нераспознанных случаев проверено — ${a.manual_refinements ?? 0}. Добавлено в группы — ${a.newly_grouped}; осталось неразобранным — ${a.remaining_unmatched}.`,
      'Совпадение моделей не является доказательством точности. Исходные ранее сгруппированные темы этим разбором не перепроверялись. Все назначения требуют подтверждения владельцем процесса.',
      ...(a.opencode_go?.status === 'usage_limit' ? ['OpenCode Go вернул лимит использования за 5 часов до чтения корпуса: обработано им 0 тем. Разбор выполнен субагентами Codex, без переключения провайдера или включения платного превышения.'] : []), '');
  }
  for (const g of report.groups) lines.push(`| ${plain(g.name)} | ${g.topics} | ${types[g.proposal_type] ?? plain(g.proposal_type)} |`);
  for (const g of report.groups) lines.push('', `## ${plain(g.name)}`, '',
    ...(g.activity ? [`Последняя наблюдённая активность: ${g.activity.latest}. Тем с последней активностью в 2025: ${g.activity.year_counts['2025'] ?? 0}; в 2026: ${g.activity.year_counts['2026'] ?? 0}. Это не число сообщений или повторных рабочих случаев.`,
      `Активность по месяцам (тем): ${Object.entries(g.activity.month_counts).sort().map(([month, n]) => `${month}: ${n}`).join('; ')}.`,
      `${g.activity.year_counts['2026'] ? 'Есть признаки использования в 2026 году; актуальность и стадии нужно подтвердить с участниками.' : 'Свежих подтверждений за 2026 год нет; отдельную доску пока не рекомендовать.'}`] : []),
    `Основание: заголовок — ${g.evidence.title}, заголовок со вступлением — ${g.evidence.title_and_preview}, только вступление — ${g.evidence.preview}.`,
    `Поля: ${(g.fields ?? []).map(plain).join('; ')}.`, `Стадии: ${(g.statuses ?? []).map(plain).join(' → ') || 'определяются форматом календаря/реестра'}.`,
    `Участники: ${(g.participant_roles ?? []).map(plain).join(', ')}.`, `Видимость: ${plain(g.access)}.`);
  lines.push('', '## Что осталось неразобранным', '', '| Причина | Тем |', '|---|---:|');
  const labels = { conflicting_title_rules: 'Несколько процессов в заголовке', conflicting_preview_rules: 'Несколько процессов во вступлении', no_visible_preview_or_title_rule: 'Неоднозначный заголовок, вступление не видно', missing_title_and_preview: 'Не видны ни заголовок, ни вступление', no_matching_rule: 'Нет подходящего правила', model_disagreement: 'Расхождение моделей, нужна проверка', number_only: 'Номер без понятного действия', no_preview: 'Нет видимого вступления', mixed_signals: 'Несколько процессов без ясного основного', ambiguous_context: 'Недостаточно контекста', redacted_context: 'Ключевой контекст скрыт редакцией', new_family_needed: 'Нужен отдельный разбор процесса' };
  for (const [reason, n] of Object.entries(report.unmatched_reasons)) lines.push(`| ${labels[reason] ?? plain(reason)} | ${n} |`);
  lines.push('', `Непросмотренные страницы не считаются неразобранными темами. Полный перечень неразобранных исходных тем хранится локально в \`${report.review_audit ? 'reviewed-unmatched.ndjson' : 'unmatched-overview.ndjson'}\`; исходные тексты и контакты в эту публикацию не включены.`, '',
    `Ошибок страниц списка: ${v.failed_list_pages}; страниц на проверке: ${v.quarantined_list_pages}; непроверенных номеров страниц: ${v.missing_list_pages.length}.`, '');
  return lines.join('\n');
}

async function main() {
  const args = process.argv.slice(2), opts = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help') { console.log('node scripts/mail/mail-overview.mjs --input DIR --expected-list-pages N [--from YYYY-MM-DD --to YYYY-MM-DD] [--output DIR]'); return; }
    if (!['--input', '--expected-list-pages', '--output', '--from', '--to'].includes(args[i]) || !args[i + 1]) throw Error('INVALID_ARGUMENTS');
    opts[args[i].slice(2)] = args[++i];
  }
  const input = resolve(opts.input ?? '.mail-work/iab-full-2026-10-20');
  const expected = Number(opts['expected-list-pages']);
  const window = opts.from || opts.to ? validateMailDateWindow({ from: opts.from, to: opts.to }) : undefined;
  if (window === null) throw Error('INVALID_MAIL_DATE_WINDOW');
  const db = new DatabaseSync(join(input, 'mail.sqlite'), { readOnly: true });
  db.exec('PRAGMA busy_timeout=5000; BEGIN');
  const output = resolve(opts.output ?? join(input, 'overview'));
  const suffix = `.${randomUUID()}.tmp`, all = join(output, 'topics-overview.ndjson'), unmatched = join(output, 'unmatched-overview.ndjson');
  const handles = [];
  const temporaryFiles = [all + suffix, unmatched + suffix, join(output, 'overview.json') + suffix, join(output, 'overview.md') + suffix];
  let report;
  try {
    try {
      await mkdir(output, { recursive: true });
      handles.push(openSync(all + suffix, 'w', 0o600));
      handles.push(openSync(unmatched + suffix, 'w', 0o600));
      const pages = db.prepare("SELECT url,status FROM pages WHERE kind='list'").all();
      function* topics() { for (const row of db.prepare('SELECT record_json FROM topics ORDER BY topic_id').iterate()) yield JSON.parse(row.record_json); }
      const selectedPages = window ? pages.filter(page => page.status !== 'pending' || Number(new URL(page.url).searchParams.get('page') || 1) <= expected) : pages;
      const coverage = overviewCoverage(selectedPages, expected);
      if (window) Object.assign(coverage, { scope: 'selected_list_page_range', period_completeness: 'not_independently_verified_beyond_selected_pages' });
      report = aggregateOverview({ topics: topics(), coverage, window, onTopic: row => {
        const line = JSON.stringify(row) + '\n'; writeSync(handles[0], line);
        if (row.category === 'unmatched') writeSync(handles[1], line);
      } });
    } finally { handles.forEach(closeSync); db.exec('ROLLBACK'); db.close(); }
    await rename(all + suffix, all); await rename(unmatched + suffix, unmatched);
    for (const [name, content] of [['overview.json', JSON.stringify(report, null, 2) + '\n'], ['overview.md', renderOverviewSummary(report)]]) {
      await writeFile(join(output, name) + suffix, content, { mode: 0o600 }); await rename(join(output, name) + suffix, join(output, name));
    }
    console.log(JSON.stringify({ coverage: report.coverage.status, counts: report.counts }));
    process.exitCode = report.coverage.status === 'observed_range_complete' ? 0 : 2;
  } finally { await Promise.allSettled(temporaryFiles.map(file => unlink(file))); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(() => { console.error('MAIL_OVERVIEW_FAILED: проверьте параметры и локальное хранилище; содержание почты не выводится.'); process.exitCode = 1; });
