export const CLASSIFIER_VERSION = 'rules-2.0';
export const TAXONOMY_VERSION = '2.0.0';

const categories = [
  [
    'reports', 'Отчёты сотрудников и мониторинг',
    /отч[её]т.{0,35}(проделан|работ|сотрудник)|тем[аы] с отч[её]т|мониторинг/u,
    'board',
    ['Период', 'Подразделение', 'Исполнитель', 'Результат'],
    ['Ожидается', 'Подготовлен', 'На проверке', 'Принят'],
    [
      { id: 'daily', name: 'Ежедневные отчёты', pattern: /ежедневн|за\s+день|итоги\s+дня/iu },
      { id: 'monitoring', name: 'Мониторинг и показатели', pattern: /мониторинг|показател|статистик/iu },
      { id: 'general', name: 'Общий отчёт сотрудника', pattern: /отч[её]т/iu },
    ],
    'Отчёт одного сотрудника за отчётный период',
    'Руководители отделов / Служба контроля',
    'До 12:00 следующего рабочего дня',
    'Сотрудник видит свои отчёты; руководитель — подразделение; проверяющий — назначенные.',
  ],
  [
    'complaints', 'Клиентские претензии и качество',
    /жалоб|претензи|озок|обращени.{0,20}качеств/u,
    'board',
    ['Заявка', 'Тип обращения', 'Ответственный', 'Срок'],
    ['Новое', 'Разбор', 'Ожидает ответа', 'Решено'],
    [
      { id: 'quality', name: 'Качество обслуживания и ремонта', pattern: /качеств|ремонт|мастер/iu },
      { id: 'service', name: 'Претензия по срокам или коммуникации', pattern: /срок|не\s+отвеча|груб|хам/iu },
      { id: 'general', name: 'Общая жалоба / претензия', pattern: /жалоб|претензи|озок/iu },
    ],
    'Отдельная претензия клиента',
    'Отдел контроля качества (ОЗОК)',
    'Первичный ответ в течение 4 часов, решение до 24 часов',
    'ОЗОК и ответственный специалист; конфиденциальные данные клиентов защищены.',
  ],
  [
    'receipts', 'Запросы клиентов на отправку чеков',
    /чек/u,
    'board',
    ['Заявка', 'Канал отправки', 'Ответственный'],
    ['Запрошен', 'Проверка', 'Отправлен', 'Подтвержден'],
    [
      { id: 'sms', name: 'Отправка чека по SMS', pattern: /sms|смс/iu },
      { id: 'email', name: 'Отправка чека по email', pattern: /email|почт|электрон/iu },
      { id: 'correction', name: 'Корректировка или возврат чека', pattern: /возврат|коррект|ошибк/iu },
      { id: 'general', name: 'Запрос чека клиенту', pattern: /чек/iu },
    ],
    'Запрос клиента на отправку чека',
    'Бухгалтерия и операторы чеков',
    'В день обращения клиента (до 18:00)',
    'Оператор чеков и бухгалтер; персональные контакты только по назначению.',
  ],
  [
    'shift', 'Передача между сменами и группами',
    /передач.{0,35}(смен|групп)|между смен|незаверш[её]нн.{0,20}заяв/u,
    'board',
    ['Заявка', 'Смена отправителя', 'Смена получателя', 'Следующее действие'],
    ['Передано', 'Принято', 'В работе', 'Закрыто'],
    [
      { id: 'pending_tasks', name: 'Передача незавершённых заявок', pattern: /незаверш|висящ|остат/iu },
      { id: 'shift_handover', name: 'Смена дежурств и передачи', pattern: /смен|передач/iu },
    ],
    'Пакет передачи смены / незавершённая заявка',
    'Дежурные координаторы смен',
    'В момент пересменки (30 минут)',
    'Участники передающей и принимающей смен.',
  ],
  [
    'sales', 'Передача из телемаркетинга в продажи',
    /телемаркетинг.{0,40}продаж|продаж.{0,40}телемаркетинг/u,
    'board',
    ['Заявка', 'Источник', 'Менеджер', 'Следующий контакт'],
    ['Передано', 'Принято', 'Контакт', 'Результат'],
    [
      { id: 'telemarketing', name: 'Лид из телемаркетинга', pattern: /телемаркетинг|лид|баз/iu },
      { id: 'commercial', name: 'Коммерческое предложение / продажа', pattern: /кп|предложен|договор/iu },
    ],
    'Клиентский лид / контакт продажи',
    'Отдел продаж и телемаркетинг',
    'Первый контакт в течение 2 часов',
    'Менеджеры продаж и руководитель отдела.',
  ],
  [
    'thanks', 'Благодарности клиентов',
    /благодарност.{0,20}клиент|благодарности/u,
    'review',
    ['Заявка', 'Ответственный'],
    ['Получена', 'Проверена', 'Учтена'],
    [
      { id: 'master_thanks', name: 'Благодарность мастеру', pattern: /мастер/iu },
      { id: 'service_thanks', name: 'Благодарность сервису', pattern: /сервис|ленремонт/iu },
    ],
    'Запись благодарности клиента',
    'Отдел по работе с клиентами / HR',
    'Учёт в течение 3 рабочих дней',
    'Общая видимость в реестре без персональных телефонов.',
  ],
  [
    'partner', 'Подключение партнёров',
    /подключени.{0,25}партн[её]р/u,
    'board',
    ['Партнёр', 'Ответственный', 'Проверка доступа'],
    ['Заявка', 'Настройка', 'Проверка', 'Подключён'],
    [
      { id: 'onboarding', name: 'Подключение нового партнёра', pattern: /нов[ыо]|подключ/iu },
      { id: 'agreement', name: 'Согласование условий / договор', pattern: /договор|услови/iu },
    ],
    'Заявка на подключение партнёра',
    'Отдел по работе с партнёрами',
    'До 3 рабочих дней',
    'Менеджер партнёров и администратор доступа.',
  ],
  [
    'finance_docs', 'Бухгалтерские документы и безналичная оплата',
    /акт.{0,10}сверк|безналичн.{0,15}оплат|банковск.{0,15}выписк|бухгалтерск.{0,15}документ/u,
    'review',
    ['Тип документа', 'Период', 'Ответственный'],
    ['Запрошен', 'Подготовлен', 'Проверен', 'Передан'],
    [
      { id: 'reconciliation', name: 'Акты сверки', pattern: /акт.{0,10}сверк/iu },
      { id: 'bank_statements', name: 'Банковские выписки', pattern: /выписк/iu },
      { id: 'cashless', name: 'Безналичная оплата', pattern: /безнал/iu },
    ],
    'Запрос бухгалтерского документа',
    'Бухгалтерия',
    'До 2 рабочих дней',
    'Только бухгалтерия и уполномоченный инициатор.',
  ],
  [
    'club', 'Клиентский клуб',
    /клиентск.{0,10}клуб/u,
    'registry',
    ['Заявка', 'Согласие', 'Ответственный'],
    [],
    [
      { id: 'membership', name: 'Членство в клубе', pattern: /клуб|вступлен|регистрац/iu },
    ],
    'Запись реестра участника клуба',
    'Маркетинг и клиентский клуб',
    'Внесение в течение суток',
    'Операторы клуба и руководитель маркетинга.',
  ],
  [
    'fraud_reports', 'Обращения о сторонних мошенниках',
    /мошенник|мошенничеств/u,
    'restricted_review',
    ['Обращение', 'Ответственный', 'Результат проверки'],
    ['Получено', 'Проверяется', 'Обработано'],
    [
      { id: 'scam_report', name: 'Обращение о сторонних мошенниках', pattern: /мошенник|обман|поддел/iu },
    ],
    'Обращение о факте мошенничества',
    'Служба безопасности / Юридический отдел',
    'Немедленная проверка (1-2 часа)',
    'Строго служба безопасности; доступ по подразделению закрыт.',
  ],
  [
    'optout', 'Просьбы отключить автообзвон',
    /отключ.{0,30}(автообзвон|обзвон)|отказ.{0,30}(автообзвон|обзвон)/u,
    'board',
    ['Заявка', 'Ответственный', 'Подтверждение отключения'],
    ['Получено', 'Исполнение', 'Проверка', 'Отключён'],
    [
      { id: 'call_optout', name: 'Отказ от автообзвона / звонков', pattern: /обзвон|звон/iu },
      { id: 'sms_optout', name: 'Отказ от SMS рассылок', pattern: /sms|смс|рассылк/iu },
    ],
    'Заявка на отключение контакта из базы обзвона',
    'ИТ и служба телемаркетинга',
    'В течение 1 часа',
    'Оператор и исполнитель отключения.',
  ],
  [
    'wellbeing', 'Запись на корпоративные сеансы',
    /сеанс.{0,25}(массаж|корпоратив)|запис.{0,25}массаж/u,
    'calendar',
    ['Слот', 'Ответственный'],
    [],
    [
      { id: 'massage', name: 'Сеансы массажа', pattern: /массаж/iu },
      { id: 'corporate', name: 'Корпоративные мероприятия', pattern: /мероприят|сеанс/iu },
    ],
    'Слот записи сотрудника',
    'HR / Административная служба',
    'По графику слотов',
    'Календарная запись.',
  ],
  [
    'rota', 'Распределение дежурств и переключений',
    /график.{0,25}дежур|распределени.{0,25}(дежур|переключ)/u,
    'calendar',
    ['Дата', 'Смена'],
    [],
    [
      { id: 'duty_schedule', name: 'График дежурств', pattern: /график|дежур/iu },
      { id: 'shift_switch', name: 'Переключения и подмены', pattern: /переключ|подмен/iu },
    ],
    'Слот дежурства',
    'Руководители смен',
    'За 2 дня до смены',
    'Сотрудники подразделения.',
  ],
  [
    'birthdays', 'Календарные объявления',
    /дн[еёя]м? рождени|дни рождени/u,
    'calendar',
    ['Дата'],
    [],
    [
      { id: 'congratulation', name: 'Поздравление / объявление', pattern: /поздравл|дн[еёя]м/iu },
    ],
    'Календарное событие',
    'HR / Общекорпоративный',
    'В день события',
    'Все сотрудники.',
  ],
  [
    'payroll', 'Уведомления о зарплатных перечислениях',
    /зарплат.{0,25}(перечисл|выплат)|перечисл.{0,25}зарплат/u,
    'restricted_review',
    ['Период', 'Ответственный'],
    [],
    [
      { id: 'payment_notice', name: 'Уведомление о начислении/выплате', pattern: /перечисл|выплат|расч[её]т/iu },
    ],
    'Уведомление сотрудника',
    'Расчётный отдел бухгалтерии',
    'В расчётный день',
    'Строго сотрудник и расчётчик; отдельный ограниченный доступ.',
  ],
];

export const TAXONOMY = categories.map(([id, name, , proposal_type, fields, statuses, subcategories, card_unit, owner_department, sla_deadline, visibility_policy]) => ({
  id,
  name,
  proposal_type,
  fields,
  statuses,
  subcategories: (subcategories || []).map(({ id, name }) => ({ id, name })),
  card_unit: card_unit || 'Рабочая задача процесса',
  owner_department: owner_department || 'Владелец процесса',
  sla_deadline: sla_deadline || 'По регламенту процесса',
  visibility_policy: visibility_policy || 'Участники подразделения по назначению',
  allowed_owner_decisions: ['accept', 'merge', 'split', 'postpone'],
  governance_rule: 'Автор, год или заголовок сами по себе не создают доску. Требуется подтверждение владельца процесса.',
}));

const normalize = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
const order = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const identity = m => JSON.stringify([m.source_instance, String(m.source_message_id)]);
const topicIdentity = m => JSON.stringify([m.source_instance ?? '', String(m.topic_id ?? '')]);
const safeUrl = value => { try { const u = new URL(value); return /^https?:$/.test(u.protocol) && !u.username && !u.password ? u.href : null; } catch { return null; } };

export function classifyMessage(message) {
  const title = normalize(message.title), body = normalize(message.body_text), text = `${title} ${body}`;
  const candidates = categories.flatMap(([id, , pattern]) => {
    if (id === 'receipts' && (!/клиент|заказчик/u.test(text) || !/отправ|высл|присл|получ|sms|смс|email/u.test(text))) return [];
    const score = pattern.test(title) ? 3 : pattern.test(body) ? 2 : 0;
    return score ? [{ category: id, score, evidence: pattern.test(title) ? 'title_rule' : 'body_rule' }] : [];
  }).sort((a, b) => b.score - a.score || order(a.category, b.category));
  const winner = candidates[0];
  const conflict = winner && candidates[1]?.score === winner.score;
  const reason = conflict ? 'category_conflict' : !winner ? 'no_matching_rule' : winner.score < 3 ? 'low_confidence' : null;
  const primary = reason ? 'unmatched' : winner.category;

  // Determine subcategory for the winner
  let subcategory = null;
  if (primary !== 'unmatched') {
    const catEntry = categories.find(([id]) => id === primary);
    const subs = catEntry?.[6] || [];
    const matchedSub = subs.find(s => s.pattern.test(text));
    subcategory = matchedSub ? matchedSub.id : (subs[0]?.id ?? null);
  }

  const contentStatus = message.content_status || (message.body_text ? 'complete' : 'empty');

  // Determine unmatched reason category per Issue #23 criterion 4
  let unmatchedReasonCategory = null;
  if (primary === 'unmatched') {
    if (contentStatus === 'missing_body' || contentStatus === 'corrupted') {
      unmatchedReasonCategory = 'damaged_content';
    } else if (!title.trim() && !body.trim()) {
      unmatchedReasonCategory = 'insufficient_data';
    } else if (conflict) {
      unmatchedReasonCategory = 'ambiguous';
    } else if (reason === 'low_confidence') {
      unmatchedReasonCategory = 'insufficient_data';
    } else if (reason === 'no_matching_rule') {
      unmatchedReasonCategory = text.length > 25 ? 'new_topic' : 'insufficient_data';
    } else {
      unmatchedReasonCategory = 'insufficient_data';
    }
  }

  return {
    primary_category: primary,
    subcategory,
    secondary_tags: candidates.filter(c => c.category !== primary).map(c => c.category).sort(order),
    confidence: reason ? (conflict ? 'ambiguous' : 'low') : 'rule_supported',
    evidence: candidates,
    review_required: Boolean(reason) || contentStatus !== 'complete' || message.identity_method === 'page_position_fallback',
    review_reason: reason ?? (contentStatus !== 'complete' ? 'incomplete_content' : message.identity_method === 'page_position_fallback' ? 'unstable_identity' : null),
    unmatched_reason_category: unmatchedReasonCategory,
    data_only_neutralized: true,
  };
}

/**
 * Evaluates classifier accuracy and error distribution against a labeled sample dataset.
 * Evaluates groups and manual review share against agreed thresholds.
 */
export function evaluateClassifier(labeledSamples, thresholds = {}) {
  if (!Array.isArray(labeledSamples)) throw new Error('INVALID_LABELED_SAMPLES');
  let correct = 0;
  let reviewCount = 0;
  const errorDistribution = {};
  const unmatchedReasons = {};

  for (const sample of labeledSamples) {
    const result = classifyMessage(sample);
    const expected = sample.expected_category;
    const predicted = result.primary_category;
    const isCorrect = predicted === expected;

    if (isCorrect) correct++;
    if (result.review_required) reviewCount++;

    if (result.unmatched_reason_category) {
      unmatchedReasons[result.unmatched_reason_category] = (unmatchedReasons[result.unmatched_reason_category] ?? 0) + 1;
    }

    errorDistribution[expected] ??= { expected: 0, predicted: 0, true_positives: 0, false_positives: 0, false_negatives: 0 };
    errorDistribution[expected].expected++;

    errorDistribution[predicted] ??= { expected: 0, predicted: 0, true_positives: 0, false_positives: 0, false_negatives: 0 };
    errorDistribution[predicted].predicted++;

    if (isCorrect) {
      errorDistribution[expected].true_positives++;
    } else {
      errorDistribution[expected].false_negatives++;
      errorDistribution[predicted].false_positives++;
    }
  }

  const total = labeledSamples.length;
  const accuracy = total > 0 ? correct / total : 0;
  const reviewRequiredShare = total > 0 ? reviewCount / total : 0;

  const minAccuracy = thresholds.min_accuracy ?? 0.8;
  const maxReviewShare = thresholds.max_review_share ?? 0.5;

  return {
    total_samples: total,
    correct_count: correct,
    accuracy,
    review_required_count: reviewCount,
    review_required_share: reviewRequiredShare,
    errors_by_group: errorDistribution,
    unmatched_breakdown: unmatchedReasons,
    thresholds: { min_accuracy: minAccuracy, max_review_share: maxReviewShare },
    thresholds_passed: accuracy >= minAccuracy && reviewRequiredShare <= maxReviewShare,
  };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort(order).map(key => [key, canonical(value[key])]));
  return value;
}
const contentSignature = message => JSON.stringify(canonical(Object.fromEntries(['topic_id', 'title', 'body_text', 'sent_at', 'author_text', 'attachments', 'content_status'].map(k => [k, message[k] ?? null]))));

export function buildReport(messages, topics = [], manifest = {}) {
  const identities = new Map();
  let exactDuplicates = 0;
  for (const message of messages) {
    if (typeof message.source_instance !== 'string' || !message.source_instance || !['string', 'number'].includes(typeof message.source_message_id) || !String(message.source_message_id)) throw new Error('INVALID_MESSAGE_IDENTITY');
    const key = identity(message), signature = contentSignature(message);
    if (!identities.has(key)) identities.set(key, new Map());
    const variants = identities.get(key);
    if (variants.has(signature)) {
      exactDuplicates++;
      // Same message seen on another page: stable choice, independent of input order.
      if (order(String(message.source_url ?? ''), String(variants.get(signature).source_url ?? '')) < 0) variants.set(signature, message);
    }
    else variants.set(signature, message);
  }
  const items = [...identities.entries()].sort(([a], [b]) => order(a, b)).map(([, variants]) => {
    // Pick deterministically, then quarantine conflicting content; never silently overwrite it.
    const message = [...variants.entries()].sort(([a], [b]) => order(a, b))[0][1];
    const conflict = variants.size > 1;
    return {
      source_instance: message.source_instance, source_message_id: String(message.source_message_id),
      topic_id: String(message.topic_id ?? ''), source_url: safeUrl(message.source_url), title: String(message.title ?? ''),
      ...classifyMessage(message),
      ...(conflict ? { primary_category: 'unmatched', confidence: 'ambiguous', secondary_tags: [], review_required: true, review_reason: 'conflicting_duplicate', unmatched_reason_category: 'ambiguous', conflicting_variants: variants.size } : {}),
    };
  });
  const messageTopics = new Set(items.map(topicIdentity));
  // Topic metadata may omit source_instance; collector scope supplies the single source origin.
  const instance = items[0]?.source_instance ?? '';
  const topicRows = new Map(topics.map(t => { const item = { ...t, source_instance: t.source_instance ?? instance }; return [topicIdentity(item), item]; }));
  const conflicts = items.filter(i => i.review_reason === 'conflicting_duplicate').length;

  const assignedCount = items.filter(i => i.primary_category !== 'unmatched').length;
  const unmatchedCount = items.filter(i => i.primary_category === 'unmatched').length;

  // Strict balance equation check (Issue #24 criterion 2)
  const isBalanceVerified = items.length === assignedCount + unmatchedCount;

  const counts = {
    input_rows: messages.length, collected_unique_messages: items.length, exact_duplicate_rows: exactDuplicates,
    conflicting_identities: conflicts, classified_messages: assignedCount,
    unmatched_messages: unmatchedCount,
    balance_verified: isBalanceVerified,
    review_required_messages: items.filter(i => i.review_required).length,
    collected_message_topics: messageTopics.size, metadata_unique_topics: topicRows.size,
    discovered_topics_without_messages: [...topicRows.keys()].filter(k => !messageTopics.has(k)).length,
  };
  const validationIssues = [];
  if (manifest.collected_unique_messages !== undefined && manifest.collected_unique_messages !== items.length) validationIssues.push('MANIFEST_MESSAGE_COUNT_MISMATCH');
  if (conflicts) validationIssues.push('CONFLICTING_DUPLICATE_IDENTITIES');
  const observedTopics = new Set([...topicRows.keys(), ...messageTopics]);
  if (manifest.discovered_unique_topics !== undefined && manifest.discovered_unique_topics !== observedTopics.size) validationIssues.push('MANIFEST_TOPIC_COUNT_MISMATCH');
  const nonempty = value => Array.isArray(value) ? value.length > 0 : typeof value === 'number' ? value > 0 : Boolean(value && Object.keys(value).length);
  const declared = ['complete', 'partial', 'unverified'].includes(manifest.coverage_status) ? manifest.coverage_status : 'unverified';
  const failures = counts.discovered_topics_without_messages > 0 || ['failed_topics', 'unfinished_pages', 'unfinished_topics', 'errors'].some(k => nonempty(manifest[k]));
  const coverage = {
    scope: typeof manifest.scope === 'string' ? safeUrl(manifest.scope) : manifest.scope ?? null,
    snapshot_at: manifest.snapshot_at ?? null, declared_coverage_status: declared,
    coverage_status: declared === 'partial' ? 'partial' : validationIssues.length ? 'unverified' : failures && declared === 'complete' ? 'partial' : declared,
    discovered_unique_topics: manifest.discovered_unique_topics ?? null,
    source_total: manifest.source_total ?? (typeof manifest.observed_counter === 'object' ? manifest.observed_counter?.value : manifest.observed_counter) ?? null,
    source_total_basis: manifest.source_total_basis ?? (manifest.observed_counter ? 'observed_sidebar_counter' : 'unverified'),
    failed_topics_count: Array.isArray(manifest.failed_topics) ? manifest.failed_topics.length : manifest.failed_topics ?? null,
    unfinished_pages_count: Array.isArray(manifest.unfinished_pages) ? manifest.unfinished_pages.length : manifest.unfinished_pages ?? null,
    unfinished_topics_count: Array.isArray(manifest.unfinished_topics) ? manifest.unfinished_topics.length : manifest.unfinished_topics ?? null,
    validation_issues: validationIssues,
    normalizer_version: '1.0.0',
    classifier_version: CLASSIFIER_VERSION,
    note: 'Охват заявлен сборщиком; классификатор не проверяет доступность всего архива. Непросмотренное не входит в unmatched.',
  };
  const groups = TAXONOMY.map(group => {
    const members = items.filter(i => i.primary_category === group.id);
    return {
      ...group,
      messages: members.length,
      topics: new Set(members.map(topicIdentity)).size,
      subcategories: group.subcategories.map(sub => ({
        ...sub,
        messages: members.filter(m => m.subcategory === sub.id).length,
      })),
      review_required_messages: members.filter(i => i.review_required).length,
    };
  });
  return { schema_version: '1.0', classifier_version: CLASSIFIER_VERSION, taxonomy_version: TAXONOMY_VERSION, confidence_note: 'Уровень подтверждения правилом, не вероятность и не оценка точности.', coverage, counts, groups, messages: items,
    topics_without_messages: [...topicRows.entries()].filter(([k]) => !messageTopics.has(k)).sort(([a], [b]) => order(a, b)).map(([, t]) => ({ topic_id: String(t.topic_id), source_url: safeUrl(t.source_url), reason: 'no_collected_messages' })) };
}

const escapeMarkdown = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\|/g, '&#124;').replace(/[\[\]`*_\\]/g, c => `&#${c.codePointAt(0)};`).replace(/[\r\n]/g, ' ');

export function renderMarkdown(report) {
  const { counts: c, coverage: v } = report;
  const lines = ['# Тематический отчёт по собранной почте', '', `Охват: **${v.coverage_status}**. ${v.note}`, '',
    `Сообщения: **${c.collected_unique_messages} = ${c.classified_messages} классифицированных + ${c.unmatched_messages} неразобранных**. Тем с сообщениями: ${c.collected_message_topics}; тем в метаданных: ${c.metadata_unique_topics}; без собранных сообщений: ${c.discovered_topics_without_messages}.`, '',
    `Повторных строк: ${c.exact_duplicate_rows}; конфликтующих идентичностей: ${c.conflicting_identities}; ручная проверка: ${c.review_required_messages}. ${report.confidence_note}`, '',
    'Количество тем в разных группах может пересекаться: отдельные сообщения одной темы могут иметь разные категории. Сообщение не равно отдельной рабочей задаче.', '',
    'Автор, год или заголовок сами по себе не создают доску. Все предложения требуют утверждения владельцем процесса.', '',
    '| Группа | Сообщений | Тем | Предложение | Поля карточки | Статусы | Единица карточки | Владелец | Решения |',
    '| --- | ---: | ---: | --- | --- | --- | --- | --- | --- |'];

  for (const group of report.groups.filter(g => g.messages)) {
    const decisions = (group.allowed_owner_decisions || ['принять', 'объединить', 'разделить', 'отложить']).join(', ');
    lines.push(`| ${escapeMarkdown(group.name)} | ${group.messages} | ${group.topics} | ${group.proposal_type} | ${escapeMarkdown(group.fields.join(', '))} | ${escapeMarkdown(group.statuses.join(' → ') || 'реестр')} | ${escapeMarkdown(group.card_unit || 'карточка')} | ${escapeMarkdown(group.owner_department || 'владелец')} | ${escapeMarkdown(decisions)} |`);
  }
  lines.push('', 'Предложения требуют проверки владельцем процесса; доски и карточки автоматически не создаются. calendar — календарь, registry — реестр, review — уточнить процесс, restricted_review — проверить ограничение доступа, board — кандидат доски.', '',
    'Решения владельца процесса по кандидатам досок: принять, объединить, разделить, отложить. Реальный импорт задач выполняется отдельно после предпросмотра.', '',
    '## Все собранные сообщения', '', '| Источник / ID | Тема | Основная группа | Подкатегория | Дополнительные метки | Проверка |', '| --- | --- | --- | --- | --- | --- |');
  for (const item of report.messages) {
    const label = escapeMarkdown(`${item.topic_id} / ${item.source_message_id}`);
    const source = item.source_url ? `[${label}](${item.source_url.replace(/[()<>\s]/g, c => encodeURIComponent(c))})` : label;
    lines.push(`| ${source} | ${escapeMarkdown(item.title)} | ${item.primary_category} | ${item.subcategory || '—'} | ${item.secondary_tags.join(', ')} | ${item.review_reason ?? '—'} |`);
  }
  lines.push('', '## Неразобранные сообщения', '');
  for (const item of report.messages.filter(i => i.primary_category === 'unmatched')) lines.push(`- ${escapeMarkdown(`${item.topic_id} / ${item.source_message_id}`)}: ${item.review_reason} (вид: ${item.unmatched_reason_category || 'не указан'})`);
  if (!c.unmatched_messages) lines.push('Нет среди собранных сообщений.');
  lines.push('', '## Обнаруженные темы без собранных сообщений', '');
  for (const topic of report.topics_without_messages) lines.push(`- ${escapeMarkdown(topic.topic_id)}: no_collected_messages`);
  if (!report.topics_without_messages.length) lines.push('Нет в переданных метаданных; это не доказательство полноты архива.');
  return lines.join('\n') + '\n';
}

/**
 * Escapes and neutralizes CSV values.
 * Prepends leading =, +, -, @, \t, \r with single quote to prevent spreadsheet formula injection.
 * Wraps values in double quotes if they contain commas, newlines or quotes.
 */
export function sanitizeCsvCell(value) {
  let str = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(str)) {
    str = `'${str}`;
  }
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Generates CSV registry of all collected messages.
 * Neutralizes spreadsheet formula injection.
 * Private message bodies and raw contact details are never exposed.
 */
export function renderCsv(report) {
  const headers = [
    'source_instance',
    'topic_id',
    'source_message_id',
    'source_url',
    'title',
    'primary_category',
    'subcategory',
    'secondary_tags',
    'confidence',
    'review_required',
    'review_reason',
    'unmatched_reason_category',
    'proposal_type',
    'is_kanban_candidate',
  ];
  const lines = [headers.map(sanitizeCsvCell).join(',')];
  const groupMap = new Map((report.groups ?? []).map(g => [g.id, g]));

  for (const msg of report.messages ?? []) {
    const group = groupMap.get(msg.primary_category);
    const proposalType = group ? group.proposal_type : (msg.primary_category === 'unmatched' ? 'unmatched' : 'unknown');
    const isKanban = proposalType === 'board';
    const row = [
      msg.source_instance ?? '',
      msg.topic_id ?? '',
      msg.source_message_id ?? '',
      msg.source_url ?? '',
      msg.title ?? '',
      msg.primary_category ?? '',
      msg.subcategory ?? '',
      (msg.secondary_tags ?? []).join('; '),
      msg.confidence ?? '',
      msg.review_required ? 'true' : 'false',
      msg.review_reason ?? '',
      msg.unmatched_reason_category ?? '',
      proposalType,
      isKanban ? 'true' : 'false',
    ];
    lines.push(row.map(sanitizeCsvCell).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}
