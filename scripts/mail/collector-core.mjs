import { createHash } from 'node:crypto';

export const SCHEMA_VERSION = '1.0';

// Never follow arbitrary links from mail bodies or state-changing UI controls.
export function safePageUrl(value, base, topicId = null) {
  try {
    const url = new URL(value, base), root = new URL(base);
    if (url.origin !== root.origin || url.pathname !== root.pathname || url.username || url.password) return null;
    if ([...url.searchParams.keys()].some(key => !['folder', 'folderid', 'topicid', 'page'].includes(key))) return null;
    // PHP and URLSearchParams disagree on duplicate-key precedence.
    if (new Set(url.searchParams.keys()).size !== [...url.searchParams.keys()].length) return null;
    if (url.searchParams.get('folder') !== 'all') return null;
    const topic = url.searchParams.get('topicid');
    if (topicId === null ? topic !== null : topic !== String(topicId)) return null;
    if (url.searchParams.has('page') && !/^\d+$/.test(url.searchParams.get('page'))) return null;
    if (url.searchParams.has('folderid') && !/^\d+$/.test(url.searchParams.get('folderid'))) return null;
    if (topic && !/^\d+$/.test(topic)) return null;
    url.hash = '';
    return url.href;
  } catch { return null; }
}

export function messageRecord(message, topic, pageUrl, index, sourceInstance) {
  const explicit = message.source_message_id == null ? null : String(message.source_message_id);
  // Position, never content, is used when the source exposes no stable ID.
  const fallback = `position:${topic.topic_id}:${createHash('sha256').update(pageUrl).digest('hex').slice(0, 16)}:${index}`;
  return {
    source_instance: sourceInstance, source_message_id: explicit ?? fallback,
    topic_id: String(topic.topic_id), source_url: pageUrl, title: topic.title || '',
    body_text: String(message.body_text ?? ''), sent_at: message.sent_at ?? null,
    ...(message.source_header_dates ? { source_header_dates: message.source_header_dates } : {}),
    ...(message.source_date_observation ? { source_date_observation: message.source_date_observation } : {}),
    author_text: message.author_text ?? null, attachments: message.attachments ?? [],
    attachments_status: message.attachments_status ?? 'unverified',
    content_status: message.content_status || (message.body_text ? 'complete' : 'empty'),
    identity_method: explicit === null ? 'page_position_fallback' : 'source_id',
    collected_at: new Date().toISOString(),
  };
}

// Canonical object ordering avoids false conflicts from JSON key order. Arrays
// retain their order because it can carry source meaning (including attachments).
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
export function meaningfulMessageSignature(message) {
  return JSON.stringify(canonical(Object.fromEntries(
    ['topic_id', 'title', 'body_text', 'sent_at', 'author_text', 'attachments', 'attachments_status', 'content_status']
      .map(key => [key, message[key] ?? null])
  )));
}

/** Injectable page loader makes traversal testable without a browser or credentials. */
export async function collectMailbox({ url, load, state, save = async () => {}, maxPages = Infinity, maxTopics = Infinity, listFilter = 'observed', shallow = false }) {
  const isShallow = Boolean(shallow || maxTopics === 0);
  const base = safePageUrl(url, url);
  if (!base) throw new Error('INVALID_SCOPE_URL');
  const s = state ?? { schema_version: SCHEMA_VERSION, scope: base, list_filter: listFilter, filter_observations: [], snapshot_at: new Date().toISOString(),
    list_queue: [base], visited_list_pages: [], topics: [], completed_topics: [], messages: [], errors: [], failed_topics: [] };
  if (s.scope !== base || s.schema_version !== SCHEMA_VERSION) throw new Error('CHECKPOINT_SCOPE_MISMATCH');
  if ((s.list_filter ?? 'observed') !== listFilter) throw new Error('CHECKPOINT_FILTER_MISMATCH');
  s.filter_observations ??= [];
  delete s.manifest;
  s.integrity_errors ??= [];
  s.message_conflicts ??= [];
  s.errors = [...s.integrity_errors]; s.failed_topics = [];
  const topicIds = new Set(s.topics.map(t => t.topic_id));
  const messageIndex = new Map(s.messages.map(m => [JSON.stringify([m.source_instance, m.source_message_id]), m]));
  let pageBudget = 0, topicBudget = 0;
  const enqueue = (queue, visited, links, topicId = null) => {
    for (const link of links ?? []) {
      const next = safePageUrl(link, base, topicId);
      if (next && !queue.includes(next) && !visited.includes(next)) queue.push(next);
    }
  };
  while (s.list_queue.length && pageBudget < maxPages) {
    const current = s.list_queue[0];
    try {
      const data = await load(current, 'list'); pageBudget++;
      if (listFilter === 'all_topics' && data.filter_evidence?.confirmed !== true) throw new Error('UNSUPPORTED_ALL_TOPICS_FILTER');
      if (data.filter_evidence) s.filter_observations.push({ source_url: current, ...data.filter_evidence });
      if (!data.recognized || !Array.isArray(data.topics)) throw new Error('UNSUPPORTED_LIST_LAYOUT');
      for (const topic of data.topics) {
        const target = safePageUrl(topic.source_url, base, topic.topic_id);
        if (target && !topicIds.has(String(topic.topic_id))) {
          s.topics.push({ ...topic, topic_id: String(topic.topic_id), source_url: target });
          topicIds.add(String(topic.topic_id));
        }
      }
      enqueue(s.list_queue, s.visited_list_pages, data.page_links);
      s.visited_list_pages.push(current); s.list_queue.shift();
      await save(s);
    } catch (error) { s.errors.push({ stage: 'list', source_url: current, code: error.code || (error.message.startsWith('UNSUPPORTED') ? error.message : 'PAGE_LOAD_FAILED') }); break; }
  }
  let consecutiveFailures = 0;
  if (!isShallow && maxTopics > 0) {
    for (const topic of s.topics) {
      if (s.completed_topics.includes(topic.topic_id)) continue;
      if (topicBudget++ >= maxTopics) break;
      topic.pending_pages ??= [topic.source_url]; topic.visited_pages ??= [];
      let failed = false;
      while (topic.pending_pages.length) {
        const current = topic.pending_pages[0];
        try {
          const data = await load(current, 'topic');
          if (!data.recognized || !Array.isArray(data.messages) || !data.messages.length) throw new Error('UNSUPPORTED_TOPIC_LAYOUT');
          if (data.messages.some(m => m.content_status && !['complete', 'empty'].includes(m.content_status))) throw new Error('UNSUPPORTED_MESSAGE_CONTENT');
          data.messages.forEach((message, index) => {
            const record = messageRecord(message, topic, current, index, new URL(base).origin);
            const identity = JSON.stringify([record.source_instance, record.source_message_id]);
            const old = messageIndex.get(identity);
            if (!old) { s.messages.push(record); messageIndex.set(identity, record); }
            else if (meaningfulMessageSignature(old) !== meaningfulMessageSignature(record)) {
              const conflict = { stage: 'identity', topic_id: topic.topic_id, code: 'SOURCE_ID_CONTENT_CONFLICT' };
              const signature = meaningfulMessageSignature(record);
              if (!s.message_conflicts.some(item => item.source_instance === record.source_instance && item.source_message_id === record.source_message_id && meaningfulMessageSignature(item.variant) === signature)) {
                // Keep the alternative locally without inflating unique-message counts.
                s.message_conflicts.push({ source_instance: record.source_instance, source_message_id: record.source_message_id, original: old, variant: record });
              }
              if (!s.integrity_errors.some(e => e.topic_id === topic.topic_id && e.code === conflict.code)) s.integrity_errors.push(conflict);
              s.errors.push(conflict);
            }
          });
          enqueue(topic.pending_pages, topic.visited_pages, data.page_links, topic.topic_id);
          topic.visited_pages.push(current); topic.pending_pages.shift();
          await save(s);
        } catch (error) {
          s.errors.push({ stage: 'topic', topic_id: topic.topic_id, source_url: current, code: error.message.startsWith('UNSUPPORTED') ? error.message : 'PAGE_LOAD_FAILED' });
          s.failed_topics.push(topic.topic_id); failed = true; break;
        }
      }
      if (!failed) { s.completed_topics.push(topic.topic_id); consecutiveFailures = 0; }
      else consecutiveFailures++;
      await save(s);
      if (consecutiveFailures >= 3 || (failed && s.errors.at(-1)?.code.startsWith('UNSUPPORTED'))) break;
    }
  }
  s.manifest = {
    schema_version: SCHEMA_VERSION, scope: base, snapshot_at: s.snapshot_at, updated_at: new Date().toISOString(),
    list_filter: listFilter, filter_observations: s.filter_observations,
    shallow_mode: isShallow,
    // Exhausting observed links proves only this traversal, never an unknown server total.
    coverage_status: s.errors.length || s.list_queue.length || (!isShallow && s.completed_topics.length < s.topics.length) ? 'partial' : 'unverified',
    coverage_reason: isShallow
      ? 'Shallow topic overview only: topic headers, excerpts and dates collected; individual thread messages and attachment files are not downloaded.'
      : 'Observed DOM links only; server totals and historical snapshot consistency are not independently verified.',
    discovered_unique_topics: s.topics.length, collected_unique_messages: s.messages.length,
    completed_topics: s.completed_topics.length, failed_topics: s.failed_topics,
    identity_conflict_variants: s.message_conflicts.length,
    unfinished_pages: [...s.list_queue, ...s.topics.flatMap(t => t.pending_pages ?? [])],
    unfinished_topics: isShallow ? [] : s.topics.filter(t => !s.completed_topics.includes(t.topic_id)).map(t => t.topic_id),
    visited_list_pages: s.visited_list_pages.length, errors: s.errors,
    identity_fallback_messages: s.messages.filter(m => m.identity_method === 'page_position_fallback').length,
    read_state_side_effect: isShallow ? 'none; shallow list mode does not open topics' : 'unknown; opening a topic may mark it read',
  };
  await save(s);
  return s;
}

/** Runs inside the browser. Selectors must come from an inspected layout. */
export function extractDom({ kind, adapter }) {
  const text = element => element?.innerText?.trim() || '';
  const links = [...document.querySelectorAll('a[href]')];
  const pageLinks = links.filter(a => /(?:\?|&)page=\d+/.test(a.href)).map(a => a.href);
  if (kind === 'list') {
    const headerDate = value => /\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2}(?::\d{2})?/u.exec(value)?.[0] || null;
    const topics = links.filter(a => /(?:\?|&)topicid=\d+/.test(a.href) && a.hash === '#add_post_form_link' && !/^Читать\s+далее\s*[.…]*$/iu.test(text(a))).map(a => {
      const topicId = new URL(a.href).searchParams.get('topicid');
      const table = a.closest('table[id^="topic_"]') || a.closest('tbody');
      const countMatch = text(table).match(/Сообщений\s*:\s*(\d+)/iu);
      const activityRow = table?.querySelector?.(':scope > tbody > tr:nth-child(2)');
      const authorHeader = text(activityRow?.querySelector?.('td:first-child em'));
      const secondaryHeader = text(activityRow?.querySelector?.('td:nth-child(2) em'));
      const excerptElem = document.querySelector ? document.querySelector(`#topictext_${topicId}`) : null;
      return {
        topic_id: topicId,
        title: text(a),
        title_status: text(a) ? 'present' : 'missing',
        source_url: a.href,
        message_count_hint: countMatch ? Number(countMatch[1]) : null,
        initial_excerpt: excerptElem ? text(excerptElem) : '',
        list_header_dates: {
          author_header: headerDate(authorHeader),
          secondary_header: headerDate(secondaryHeader),
        },
      };
    });
    return { recognized: topics.length > 0, topics, page_links: pageLinks };
  }
  if (!adapter?.message || !adapter?.body) return { recognized: false, messages: [], page_links: [] };
  const rows = [...document.querySelectorAll(adapter.message)];
  return { recognized: rows.length > 0, page_links: pageLinks, messages: rows.map(row => ({
    source_message_id: adapter.idAttribute ? row.getAttribute(adapter.idAttribute) : null,
    body_text: text(row.querySelector(adapter.body)),
    author_text: adapter.author ? (() => { const header = text(row.querySelector(adapter.author)); return adapter.authorPattern ? (new RegExp(adapter.authorPattern).exec(header)?.[1] ?? header) : header; })() : null,
    sent_at: adapter.author ? /\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2}(?::\d{2})?/.exec(text(row.querySelector(adapter.author)))?.[0] ?? null : null,
    source_header_dates: { author_header: adapter.author ? /\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2}(?::\d{2})?/.exec(text(row.querySelector(adapter.author)))?.[0] ?? null : null, secondary_header: adapter.date ? text(row.querySelector(adapter.date)) || null : null },
    source_date_observation: { primary_field: 'author_header', secondary_semantics: 'unverified', parser_version: 'basemail-author-date-v2' },
    attachments: adapter.attachments ? [...row.querySelectorAll(adapter.attachments)].map(a => ({ name: text(a), url: a.href, availability: 'linked_not_downloaded' })) : [],
    attachments_status: adapter.attachmentsStatus || 'unverified',
    content_status: row.querySelector(adapter.body) ? 'complete' : 'missing_body',
  })) };
}
