#!/usr/bin/env node
import { classifyMessage, TAXONOMY } from './classifier-core.mjs';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { openSync, writeSync, closeSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const extras = [
  { id: 'callbacks', name: 'Повторные контакты по заявкам', proposal_type: 'board', fields: ['Исходная заявка', 'Причина контакта', 'Ответственный', 'Следующий контакт', 'Результат звонка', 'Ограничения связи'], statuses: ['К контакту', 'Назначен', 'Связались', 'Повторный контакт', 'Завершён'], pattern: /(?:^|[\s_])(?:про|пере)звонить(?:$|[\s_:,;.!?—-])|повторн.{0,12}(звон|контакт)/u },
  { id: 'timesheets', name: 'Табели и учёт выполненных работ', proposal_type: 'registry', fields: ['Период', 'Сотрудник', 'Подразделение', 'Основание: часы / выполненные работы (уточнить)', 'Подтверждающий документ', 'Согласующий'], statuses: ['Получен', 'Проверка', 'Возврат на уточнение', 'Согласован', 'Передан в расчёт'], pattern: /(?:^|[\s_])табел(?:ь|и|я|ей)(?:$|[\s_\-])/u },
  { id: 'business_cooperation', name: 'Предложения сотрудничества и договоры', proposal_type: 'board', fields: ['Организация', 'Предложение', 'Ответственный', 'Следующий контакт', 'Результат переговоров', 'Договор'], statuses: ['Получено', 'Проверка', 'Контакт', 'Переговоры', 'Договор', 'Отказ'], pattern: /сотрудничеств/u },
  { id: 'leave_planning', name: 'Планирование отпусков', proposal_type: 'calendar', fields: ['Сотрудник', 'Подразделение', 'Период', 'Согласующий', 'Замещение'], statuses: ['Запрошен', 'На согласовании', 'Запланирован', 'Завершён'], pattern: /(?:^|[\s_])отпуск(?:а|ов)?(?:$|[\s_])/u },
  { id: 'breaks', name: 'Расписание перерывов', proposal_type: 'calendar', fields: ['Дата', 'Смена', 'Сотрудник', 'Временной слот', 'Замещение'], statuses: [], pattern: /(?:^|[\s_])перерыв(?:ы|ов)?(?:$|[\s_])/u },
  { id: 'invoices', name: 'Счета и контроль оплаты', proposal_type: 'board', fields: ['Номер счёта', 'Контрагент', 'Сумма и валюта', 'Ответственный', 'Срок оплаты', 'Подтверждение оплаты'], statuses: ['Получен', 'Проверка', 'Согласование', 'Ожидает оплаты', 'Оплачен'], pattern: /(?:^|[\s_])сч[её]т(?:а|ов|ы)(?:$|[\s_])/u },
  { id: 'procurement', name: 'Закупки и расходные материалы', proposal_type: 'board', fields: ['Предмет закупки', 'Количество', 'Подразделение', 'Согласующий', 'Срок'], statuses: ['Запрошено', 'Согласование', 'Заказано', 'Получено'], pattern: /картридж|канцеляр|закупк|расходн.{0,15}материал|удлинител|сетев.{0,10}фильтр|заказ.{0,20}гарнитур/u },
  { id: 'it_support', name: 'Заявки на ИТ и доступы', proposal_type: 'board', fields: ['Сервис', 'Описание проблемы', 'Тип действия: предоставить / изменить / отозвать', 'Согласующий', 'Подразделение', 'Исполнитель', 'Срок'], statuses: ['Новая', 'Диагностика', 'В работе', 'Проверка', 'Решена'], pattern: /установ.{0,20}(программ|приложен)|доступ.{0,20}(программ|систем|баз|почт)|добавить.{0,15}тем.{0,15}сотрудник|закрыть базу|замена бп в пк|не работа.{0,20}(компьютер|принтер)|техническ.{0,15}поддержк/u },
];
const additionalTitleRules = [{ id: 'finance_docs', pattern: /(?:^|[\s_])выписк[аи].{0,30}безнал/u }, { id: 'club', pattern: /закрыт.{0,10}клуб друзей ленремонта/u }, { id: 'partner', pattern: /(?:^|[\s_])новый партн[её]р/u }];
const unmatchedFamilies = [
  { id: 'number_only', name: 'Только номер заявки', pattern: /^\s*(?:[#№]?\s*[A-Za-zА-Яа-я]?\d[\d\s/\-]*)\s*$/u, reason: 'Номер не объясняет требуемое действие: претензия, ремонт, передача или документ.', next_action: 'Прочитать первое сообщение и определить следующее действие по исходной заявке.' },
  { id: 'generic_reports', name: 'Общие отчёты и статистика', pattern: /отч[её]т|статистик/iu, reason: 'Неясно, отчёт сотрудника это, финансовый документ или статистическая выгрузка; часто содержание во вложении.', next_action: 'Уточнить объект отчёта, период и получателя; отдельно проверить вложение.' },
  { id: 'access_ambiguous', name: 'Доступ без подтверждённого сервиса', pattern: /доступ/iu, reason: 'Не хватает подтверждающего текста о сервисе, виде доступа и согласующем.', next_action: 'Прочитать запрос, определить сервис и действие предоставления, изменения или отзыва.' },
  { id: 'masters', name: 'Вопросы по мастерам', pattern: /мастер/iu, reason: 'Встречаются разные процессы: настройка списков, проблема на объекте, претензия и передача работы.', next_action: 'Разделить по требуемому действию; упоминание мастера само по себе не создаёт единую доску.' },
  { id: 'single_call', name: 'Просьбы о звонке', pattern: /позвонить|звонок|позвонит/iu, reason: 'Не всегда понятны адресат, причина и принадлежность к клиентскому контакту, партнёру или внутреннему вопросу.', next_action: 'Уточнить адресата, основание и ограничения связи до выбора процесса.' },
  { id: 'repair_ambiguous', name: 'Ремонт без следующего действия', pattern: /ремонт/iu, reason: 'Специальность или объект ремонта не определяют текущую стадию и задачу.', next_action: 'Проверить заявку и определить ответственное действие.' },
];
export const IAB_TAXONOMY = [...TAXONOMY.map(g => g.id === 'receipts' ? { ...g, name: 'Клиентские чеки: формирование и отправка', fields: ['Заявка', 'Тип действия', 'Нужна ли отправка', 'Канал и получатель', 'Ответственный', 'Подтверждение результата'], statuses: ['Запрошен', 'Проверка', 'Сформирован', 'Отправлен (если требуется)', 'Завершён'] } : g), ...extras.map(({ pattern, ...g }) => g)];
const clean = v => String(v ?? '').normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
const safeUrl = value => { try { const u = new URL(value); return /^https?:$/.test(u.protocol) && !u.username && !u.password ? u.href : null; } catch { return null; } };
const publicRef = row => ({ topic_id: String(row.topic_id ?? ''), source_message_id: row.source_message_id === undefined ? undefined : String(row.source_message_id), title: String(row.title ?? ''), source_url: safeUrl(row.source_url) });

export function verifyReceiptContext(opening) {
  const body = clean(opening.body_text);
  if (opening.identity_conflict || opening.content_status !== 'complete' || !/^post_\d+$/.test(String(opening.source_message_id)) || !/чек/u.test(clean(opening.title)) || !/клиент/u.test(body) || !/просят|просит|звонят/u.test(body) || !/отправ.{0,30}чек|чек.{0,30}отправ|сформир.{0,30}чек/u.test(body) || !/сюда|специальн.{0,30}групп|в этой теме/u.test(body)) return null;
  return { topic_id: String(opening.topic_id), category: 'receipts', scope: 'thread_process_only', rule: 'customer_receipts_opening_v1', evidence_source_message_id: String(opening.source_message_id), evidence_source_url: safeUrl(opening.source_url) };
}

export function receiptContextForMessage(row, classification, context) {
  if (!context) return { status: 'unverified', context: null };
  const incompatible = /авансов.{0,12}отч[её]т|командировочн|расход.{0,15}сотрудник|подотч[её]т|возме(?:щ|ст).{0,20}расход/u.test(clean(row.body_text));
  const competing = classification.primary_category !== 'unmatched' && classification.primary_category !== 'receipts';
  if (row.identity_conflict || row.content_status !== 'complete' || incompatible || competing || classification.review_reason === 'category_conflict') return { status: 'excluded', reason: row.identity_conflict ? 'conflicting_duplicate' : row.content_status !== 'complete' ? 'incomplete_content' : incompatible ? 'employee_expenses' : 'competing_message_process', context };
  return { status: 'supported', basis: classification.primary_category === 'receipts' ? 'own_message_and_opening' : 'inherited_opening_only', context };
}

export function classifyIab(row, titleOnly = false) {
  if (row.identity_conflict) return { primary_category: 'unmatched', confidence: 'ambiguous', review_required: true, review_reason: 'conflicting_duplicate', candidates: [] };
  const input = titleOnly ? { ...row, body_text: '', content_status: 'title_only' } : row;
  const base = classifyMessage(input), text = clean(`${input.title ?? ''} ${titleOnly ? '' : input.body_text ?? ''}`);
  const candidates = new Set(base.evidence.map(e => e.category));
  for (const extra of extras) if (extra.pattern.test(text)) candidates.add(extra.id);
  for (const rule of additionalTitleRules) if (rule.pattern.test(clean(input.title))) candidates.add(rule.id);
  const accessExcerpt = titleOnly && /^доступ$/u.test(clean(row.title)) && /бм\s*\/\s*бл|vpn|внп|внутренн.{0,10}номер/u.test(clean(row.initial_excerpt));
  if (accessExcerpt) candidates.add('it_support');
  // Titles such as ЧЕКИ 2026 identify a candidate process only; they do not prove
  // customer receipt delivery rather than employee expenses.
  if (titleOnly && /чек/u.test(clean(row.title))) candidates.add('receipts');
  const strong = new Set(base.evidence.filter(e => e.evidence === 'title_rule').map(e => e.category));
  for (const extra of extras) if (extra.pattern.test(clean(input.title))) strong.add(extra.id);
  for (const rule of additionalTitleRules) if (rule.pattern.test(clean(input.title))) strong.add(rule.id);
  if (titleOnly && candidates.size === 1) return { primary_category: [...candidates][0], confidence: accessExcerpt ? 'provisional_title_and_excerpt' : 'provisional_title_only', review_required: true, review_reason: accessExcerpt ? 'title_and_excerpt' : 'title_only', candidates: [...candidates].sort() };
  // A work report routinely mentions complaints, receipts or purchases. Those
  // are secondary subjects, not competing evidence for its explicit process.
  // Two competing title rules still require manual review.
  if (strong.size === 1) {
    const primary = [...strong][0];
    return { ...base, primary_category: primary, secondary_tags: [...candidates].filter(id => id !== primary).sort(), confidence: 'rule_supported', review_required: row.content_status !== 'complete' || row.identity_method === 'page_position_fallback', review_reason: row.content_status !== 'complete' ? 'incomplete_content' : row.identity_method === 'page_position_fallback' ? 'unstable_identity' : null, candidates: [...candidates].sort() };
  }
  return { ...base, primary_category: 'unmatched', confidence: candidates.size > 1 ? 'ambiguous' : 'low', review_required: true, review_reason: candidates.size > 1 ? 'category_conflict' : candidates.size ? 'body_only_evidence' : 'no_matching_rule', candidates: [...candidates].sort() };
}

const accessFor = id => ['payroll', 'fraud_reports', 'invoices', 'finance_docs'].includes(id) ? 'Только уполномоченные специалисты и руководитель; доступ по подразделению сам по себе недостаточен.' : id === 'timesheets' ? 'Сотрудник видит свой табель; назначенный согласующий и уполномоченные специалисты по учёту видят необходимые записи. Доступ ко всему подразделению не выдаётся автоматически.' : id === 'callbacks' ? 'Назначенный ответственный и руководитель видят карточку и необходимые контакты. Остальным контакты клиентов не раскрываются; ограничения связи проверяются до контакта.' : id === 'club' ? 'Доступ к контактам клиентов только у назначенных операторов и владельца реестра. Согласие на рассылку не предполагается по факту внесения клиента в тему.' : id === 'leave_planning' ? 'Сотрудник видит свою заявку, согласующий — назначенные заявки. Команда видит только согласованные периоды отсутствия и замещение; причины отсутствия не публикуются.' : id === 'reports' ? 'Сотрудник видит свои карточки; руководитель — отчёты своего подразделения; проверяющий — назначенные отчёты.' : 'Участники назначенного подразделения и ответственный; межотдельская передача через явное предоставление доступа. Администратор настраивает роли и аудит.';
const rolesFor = id => ({ callbacks: ['Ответственный за контакт', 'Координатор', 'Руководитель'], timesheets: ['Сотрудник', 'Согласующий', 'Специалист по учёту'], reports: ['Сотрудник', 'Руководитель', 'Проверяющий'], receipts: ['Оператор', 'Бухгалтерия', 'Ответственный за отправку'], sales: ['Телемаркетинг', 'Менеджер продаж', 'Руководитель'], invoices: ['Инициатор счёта', 'Согласующий', 'Бухгалтерия'], procurement: ['Заявитель', 'Согласующий', 'Закупщик'], it_support: ['Заявитель', 'ИТ-исполнитель', 'Руководитель'] }[id] ?? ['Заявитель', 'Ответственный', 'Владелец процесса']);

// The source must provide unique identities (SQLite PRIMARY KEY). Memory is
// bounded by groups plus five examples, never by raw message bodies.
export function aggregateIab({ topics, messages, manifest = {}, topicContexts = new Map(), onTopic, onMessage }) {
  const groups = new Map(IAB_TAXONOMY.map(g => [g.id, { ...g, provisional_topics: 0, messages: 0, complete_content_messages: 0, examples: [], access: accessFor(g.id), participant_roles: rolesFor(g.id) }]));
  const counts = { discovered_unique_topics: 0, provisional_assigned_topics: 0, unmatched_topics: 0, collected_unique_messages: 0, classified_messages: 0, unmatched_messages: 0, complete_content_messages: 0, review_required_messages: 0 };
  const unmatched = { topics: {}, messages: {} }, unmatchedExamples = { topics: [], messages: [] };
  const familyCounts = unmatchedFamilies.map(({ pattern, ...family }) => ({ ...family, topics: 0 }));
  const topicContextCounts = { verified_topics: topicContexts.size, supported_messages: 0, inherited_only_messages: 0, own_and_context_messages: 0, excluded_messages: 0, unverified_messages: 0 };
  for (const [kind, rows] of [['topics', topics], ['messages', messages]]) for (const row of rows) {
    const topicOnly = kind === 'topics', classification = classifyIab(row, topicOnly), ref = publicRef(row), result = { ...ref, ...classification };
    if (!topicOnly) {
      const inherited = receiptContextForMessage(row, classification, topicContexts.get(String(row.topic_id)));
      result.topic_process_context = inherited;
      topicContextCounts[`${inherited.status}_messages`]++;
      if (inherited.status === 'supported') topicContextCounts[inherited.basis === 'inherited_opening_only' ? 'inherited_only_messages' : 'own_and_context_messages']++;
    }
    counts[topicOnly ? 'discovered_unique_topics' : 'collected_unique_messages']++;
    if (!topicOnly && row.content_status === 'complete') counts.complete_content_messages++;
    if (!topicOnly && classification.review_required) counts.review_required_messages++;
    if (classification.primary_category === 'unmatched') {
      if (topicOnly) for (let i = 0; i < unmatchedFamilies.length; i++) if (unmatchedFamilies[i].pattern.test(String(row.title ?? ''))) familyCounts[i].topics++;
      counts[topicOnly ? 'unmatched_topics' : 'unmatched_messages']++;
      unmatched[kind][classification.review_reason] = (unmatched[kind][classification.review_reason] ?? 0) + 1;
      if (unmatchedExamples[kind].length < 10) unmatchedExamples[kind].push(result);
    } else {
      counts[topicOnly ? 'provisional_assigned_topics' : 'classified_messages']++;
      const group = groups.get(classification.primary_category);
      group[topicOnly ? 'provisional_topics' : 'messages']++;
      if (!topicOnly && row.content_status === 'complete') group.complete_content_messages++;
      if (group.examples.length < 5) group.examples.push({ ...ref, basis: topicOnly ? 'title_only' : row.content_status });
    }
    (topicOnly ? onTopic : onMessage)?.(result);
  }
  const issues = [];
  if (manifest.discovered_unique_topics !== undefined && manifest.discovered_unique_topics !== counts.discovered_unique_topics) issues.push('MANIFEST_TOPIC_COUNT_MISMATCH');
  if (manifest.collected_unique_messages !== undefined && manifest.collected_unique_messages !== counts.collected_unique_messages) issues.push('MANIFEST_MESSAGE_COUNT_MISMATCH');
  const unfinished = counts.complete_content_messages !== counts.collected_unique_messages || ['failed_topics', 'failed_pages', 'unfinished_pages', 'unfinished_topics', 'quarantined_pages', 'conflict_versions', 'errors'].some(k => Array.isArray(manifest[k]) ? manifest[k].length > 0 : Number(manifest[k] ?? 0) > 0);
  const complete = manifest.coverage_status === 'complete' && !unfinished && !issues.length && counts.discovered_unique_topics > 0 && counts.collected_unique_messages > 0 && counts.complete_content_messages === counts.collected_unique_messages;
  const observedCounter = manifest.observed_counter ?? manifest.source_counter ?? manifest.sidebar_count;
  const counterValue = observedCounter && typeof observedCounter === 'object' ? observedCounter.value : observedCounter;
  const sourceCounter = Number.isSafeInteger(counterValue) && counterValue >= 0 ? counterValue : null;
  const counterUnit = manifest.source_counter_unit ?? (observedCounter && typeof observedCounter === 'object' ? observedCounter.unit : null) ?? 'unverified';
  return { schema_version: '1.0', classifier_version: 'iab-rules-2', generated_at: new Date().toISOString(), coverage: { status: complete ? 'complete' : unfinished || issues.length || manifest.coverage_status === 'partial' ? 'partial' : 'unverified', declared_status: manifest.coverage_status ?? 'unverified', scope: manifest.scope ?? null, date_audit: manifest.date_audit ?? { status: 'pending_replay', parser_version: 'basemail-author-date-v2', observed_messages: null, legacy_messages: null }, expected_pages: manifest.expected_pages ?? manifest.last_page_visible ?? null, collected_pages: manifest.completed_list_pages ?? manifest.collected_pages ?? null, completed_topic_pages: manifest.completed_topic_pages ?? null, unfinished_pages: manifest.unfinished_pages ?? null, failed_pages: manifest.failed_pages ?? null, quarantined_pages: manifest.quarantined_pages ?? null, conflict_versions: manifest.conflict_versions ?? null, resolved_rendering_variants: manifest.resolved_rendering_variants ?? null, fallback_identity_messages: manifest.fallback_identity_messages ?? null, source_counter: sourceCounter, source_counter_unit: counterUnit, issues, note: 'Заголовки дают предварительную группировку. Непросмотренные страницы и сообщения не считаются неразобранными. Число в интерфейсе не считается числом тем или сообщений без проверки.' }, counts, topic_process_context: { counts: topicContextCounts, contexts: [...topicContexts.values()] }, groups: [...groups.values()], unmatched_families: familyCounts.filter(f => f.topics).sort((a, b) => b.topics - a.topics || a.id.localeCompare(b.id)), unmatched_reasons: unmatched, unmatched_examples: unmatchedExamples };
}

const md = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\|/g, '&#124;').replace(/[\[\]`*_\\]/g, c => `&#${c.codePointAt(0)};`).replace(/[\r\n]/g, ' ');
export function renderIabMarkdown(report) {
  const c = report.counts, lines = ['# Результаты сбора и предложения kanban-досок', '', `Охват: **${report.coverage.status}**. ${report.coverage.note}`, '', `Тем обнаружено: **${c.discovered_unique_topics} = ${c.provisional_assigned_topics} предварительно сгруппированных + ${c.unmatched_topics} для ручного разбора**.`, `Сообщений собрано: **${c.collected_unique_messages} = ${c.classified_messages} сгруппированных + ${c.unmatched_messages} неразобранных**. Полный текст: ${c.complete_content_messages}. Требуют проверки: ${c.review_required_messages}.`, '', 'Одна тема может содержать много рабочих эпизодов. Совпадение заголовков не объединяет исходные темы и не создаёт карточки автоматически.', '', '| Тематика | Тем предварительно (заголовки / фрагменты) | Сообщений | Сообщений с полным текстом | Предложение |', '| --- | ---: | ---: | ---: | --- |'];
  lines.splice(4, 0, `Страниц списка пройдено: ${report.coverage.collected_pages ?? 'не подтверждено'}; страниц тем: ${report.coverage.completed_topic_pages ?? 'не подтверждено'}. Счётчик интерфейса: ${report.coverage.source_counter ?? 'не подтверждён'}; единица: ${md(report.coverage.source_counter_unit)}. Карантин страниц: ${report.coverage.quarantined_pages ?? 0}. Нерешённых конфликтных версий: ${report.coverage.conflict_versions ?? 0}; проверенных вариантов отображения: ${report.coverage.resolved_rendering_variants ?? 0}.`, '');
  for (const g of report.groups.filter(g => g.provisional_topics || g.messages)) lines.push(`| ${md(g.name)} | ${g.provisional_topics} | ${g.messages} | ${g.complete_content_messages} | ${g.proposal_type} |`);
  for (const g of report.groups.filter(g => g.provisional_topics || g.messages)) {
    lines.push('', `## ${md(g.name)}`, '', `Формат: ${g.proposal_type}. Участники: ${md(g.participant_roles.join(', '))}.`, `Поля: ${md(g.fields.join(', '))}.`, `Статусы: ${md(g.statuses.length ? g.statuses.join(' → ') : 'уточнить; возможно нужен календарь или реестр')}.`, `Видимость: ${md(g.access)}`, '', 'Примеры источников (локальный отчёт):');
    for (const ref of g.examples) lines.push(`- ${ref.source_url ? `[Тема ${md(ref.topic_id)}](${ref.source_url.replace(/[()< >]/g, encodeURIComponent)})` : `Тема ${md(ref.topic_id)}`}: ${md(ref.title)}; основание: ${md(ref.basis)}.`);
  }
  lines.splice(4, 0, 'Выборка смещена: сбор идёт с обоих концов архива и включает старые темы. Исторические семейства, в том числе 2019 года, не доказывают текущую нагрузку или приоритет будущих досок. До завершения аудита дат временная статистика не строится.', '');
  for (const family of (report.unmatched_families ?? []).slice(0, 5)) lines.push('', `### Неразобранное семейство: ${md(family.name)} (${family.topics} тем)`, '', `${md(family.reason)} Следующее действие: ${md(family.next_action)}`);
  if (report.unmatched_families?.length) lines.push('', 'Эти диагностические семейства могут пересекаться, не являются основными категориями и не суммируются. Баланс неразобранного от этого не меняется.');
  const dateAudit = report.coverage.date_audit;
  lines.splice(6, 0, `Аудит дат: **${md(dateAudit?.status ?? 'pending_replay')}**. Прочитано авторским парсером: ${dateAudit?.observed_messages ?? 'не подтверждено'}; старых записей: ${dateAudit?.legacy_messages ?? 'не подтверждено'}. Корректность дат и готовность к миграции требуют проверки; тематическая группировка датами не пользуется.`, '');
  const contextCounts = report.topic_process_context?.counts;
  if (contextCounts) lines.push('', '## Проверенный процесс чековой темы', '', `Тем с проверенным вступлением и совпадающим количеством сообщений: ${contextCounts.verified_topics}. Контекст поддерживает ${contextCounts.supported_messages} сообщений: ${contextCounts.own_and_context_messages} также имеют собственное правило и ${contextCounts.inherited_only_messages} наследуют только процесс темы. Исключено из наследования: ${contextCounts.excluded_messages}.`, '', 'Это отдельное пересекающееся измерение, его нельзя складывать с основной классификацией. Короткий ответ может относиться к процессу формирования или отправки клиентского чека, но не доказывает отправку. Сообщение и процесс темы не равны отдельной заявке или карточке. Provenance вступления сохранён в report.json и messages-classified.ndjson.');
  lines.push('', '## Неразобранное', '', `Причины по темам: ${md(JSON.stringify(report.unmatched_reasons.topics))}.`, `Причины по сообщениям: ${md(JSON.stringify(report.unmatched_reasons.messages))}.`, '', 'Все результаты по исходным ID: topics-classified.ndjson и messages-classified.ndjson. Неразобранное сохранено отдельно в unmatched-topics.ndjson и unmatched-messages.ndjson. Ни исходные тексты, ни контакты не включены в эти отчёты; заголовки и ссылки остаются только локально.', '', 'board — кандидат отдельной доски; review — требуется уточнение процесса; restricted_review — требуется отдельный доступ; calendar — календарь; registry — реестр. Предложения требуют согласования с владельцами процессов.');
  return lines.join('\n') + '\n';
}

export async function writeIabReport({ topics, messages, manifest, topicContexts, output }) {
  await mkdir(output, { recursive: true });
  const names = ['topics-classified.ndjson', 'messages-classified.ndjson', 'unmatched-topics.ndjson', 'unmatched-messages.ndjson'];
  const handles = names.map(n => openSync(join(output, `${n}.tmp`), 'w', 0o600));
  let report;
  try { report = aggregateIab({ topics, messages, manifest, topicContexts, onTopic: row => { const text = JSON.stringify(row) + '\n'; writeSync(handles[0], text); if (row.primary_category === 'unmatched') writeSync(handles[2], text); }, onMessage: row => { const text = JSON.stringify(row) + '\n'; writeSync(handles[1], text); if (row.primary_category === 'unmatched') writeSync(handles[3], text); } }); }
  finally { handles.forEach(closeSync); }
  for (const name of names) await rename(join(output, `${name}.tmp`), join(output, name));
  for (const [name, content] of [['report.json', JSON.stringify(report, null, 2) + '\n'], ['report.md', renderIabMarkdown(report)]]) { await writeFile(join(output, `${name}.tmp`), content, { mode: 0o600 }); await rename(join(output, `${name}.tmp`), join(output, name)); }
  return report;
}

// A resolution applies to one audited variant signature, never to an entire
// identity. A later different variant must therefore return to manual review.
export function* readIabMessages(db) {
  const hasResolutions = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='conflict_resolutions'").get());
  const unresolved = hasResolutions ? 'AND NOT EXISTS(SELECT 1 FROM conflict_resolutions r WHERE r.identity=c.identity AND r.signature=c.signature)' : '';
  for (const row of db.prepare(`SELECT m.record_json, EXISTS(SELECT 1 FROM conflicts c WHERE c.identity=m.identity ${unresolved}) identity_conflict FROM messages m ORDER BY m.topic_id,m.identity`).iterate()) yield { ...JSON.parse(row.record_json), identity_conflict: Boolean(row.identity_conflict) };
}

export function readIabTopicContexts(db) {
  const hasResolutions = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='conflict_resolutions'").get());
  const unresolved = hasResolutions ? 'AND NOT EXISTS(SELECT 1 FROM conflict_resolutions r WHERE r.identity=c.identity AND r.signature=c.signature)' : '';
  const rows = db.prepare(`WITH ranked AS (
    SELECT m.*, ROW_NUMBER() OVER(PARTITION BY topic_id ORDER BY CAST(substr(json_extract(record_json,'$.source_message_id'),6) AS INTEGER)) position,
    COUNT(*) OVER(PARTITION BY topic_id) collected_count FROM messages m
  ) SELECT m.record_json, t.record_json topic_json,m.collected_count,
    EXISTS(SELECT 1 FROM conflicts c WHERE c.identity=m.identity ${unresolved}) identity_conflict
    FROM ranked m JOIN topics t ON t.topic_id=m.topic_id WHERE m.position=1`).iterate();
  const contexts = new Map();
  for (const row of rows) {
    const metadata = JSON.parse(row.topic_json);
    // Only a fully observed count-matched thread may supply its opening.
    if (!Number.isInteger(metadata.message_count_hint) || metadata.message_count_hint !== row.collected_count) continue;
    const context = verifyReceiptContext({ ...JSON.parse(row.record_json), identity_conflict: Boolean(row.identity_conflict) });
    if (context) contexts.set(context.topic_id, { ...context, observed_message_count: row.collected_count });
  }
  return contexts;
}

async function main() {
  const args = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i++) { if (args[i] === '--help') { console.log('node scripts/mail/iab-report.mjs --input .mail-work/iab-full-2026-10-20 [--output PATH]'); return; } if (!['--input', '--output'].includes(args[i]) || !args[i + 1]) throw new Error('INVALID_ARGUMENTS'); options[args[i].slice(2)] = args[++i]; }
  const input = resolve(options.input ?? '.mail-work/iab-full-2026-10-20');
  const manifest = JSON.parse(await readFile(join(input, 'manifest.json'), 'utf8'));
  const db = new DatabaseSync(join(input, 'mail.sqlite'), { readOnly: true });
  db.exec('PRAGMA busy_timeout=5000; BEGIN');
  function* topics() { for (const row of db.prepare('SELECT record_json FROM topics ORDER BY topic_id').iterate()) yield JSON.parse(row.record_json); }
  const messages = readIabMessages(db);
  try { const report = await writeIabReport({ topics: topics(), messages, manifest, topicContexts: readIabTopicContexts(db), output: resolve(options.output ?? join(input, 'report')) }); console.log(JSON.stringify({ coverage: report.coverage.status, counts: report.counts })); process.exitCode = report.coverage.status === 'complete' ? 0 : 2; }
  finally { db.exec('ROLLBACK'); db.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error.message === 'INVALID_ARGUMENTS' ? error.message : 'IAB_REPORT_FAILED: проверьте локальное хранилище; содержание писем не записывается в журнал.'); process.exitCode = 1; });
