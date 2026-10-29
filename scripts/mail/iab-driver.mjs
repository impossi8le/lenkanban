import { safePageUrl } from './collector-core.mjs';

/** Read-only DOM extraction; intentionally self-contained for Cua evaluate. */
export function readListDom() {
  const text = n => n?.innerText?.trim() || '';
  const url = document.location.href;
  const button = text(document.querySelector('#basemail_showall'));
  const headerDate = value => /\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2}(?::\d{2})?/u.exec(value)?.[0] || null;
  // Sort flags are observed from checked inputs, matched by id, name or label text; unobserved stays false.
  const sortChecked = pattern => [...document.querySelectorAll('input[type="checkbox"],input[type="radio"]')]
    .some(input => input.checked && pattern.test(`${input.id || ''} ${input.name || ''} ${text(input.labels?.[0])}`));
  const topics = [...document.querySelectorAll('a[id^="topictitle_"]')].flatMap(a => {
    const id = /^topictitle_(\d+)$/.exec(a.id)?.[1];
    const table = a.closest('table[id^="topic_"]');
    if (!id || !table) return [];
    const count = /Сообщений\s*:\s*(\d+)/iu.exec(text(table));
    // Row 2 ems: creation (author header) and observed activity date; author text is never duplicated.
    const activityRow = table.querySelector?.(':scope > tbody > tr:nth-child(2)');
    const authorHeader = text(activityRow?.querySelector('td:first-child em'));
    const secondaryHeader = text(activityRow?.querySelector('td:nth-child(2) em'));
    return [{ topic_id: id, title: text(a), title_status: text(a) ? 'present' : 'missing', source_url: a.href, message_count_hint: count ? Number(count[1]) : null,
      initial_excerpt: text(document.querySelector(`#topictext_${id}`)),
      list_header_dates: { author_header: headerDate(authorHeader), secondary_header: headerDate(secondaryHeader) } }];
  });
  const pageLinks = [...document.querySelectorAll('ul li a[href]')].filter(a => {
    if (a.closest('table[id^="topic_"],table[id^="post_"]') || !/^(?:\d+|[«»‹›←→]|Следующая|Предыдущая)$/iu.test(text(a))) return false;
    try { const u = new URL(a.href), here = new URL(url); return u.origin === here.origin && u.pathname === here.pathname && u.searchParams.has('page') && !u.searchParams.has('topicid') && [...u.searchParams.keys()].every(k => ['folder', 'folderid', 'page'].includes(k)); } catch { return false; }
  }).map(a => a.href);
  const activeLink = document.querySelector('li.active a[href]');
  const activePage = activeLink ? Number(new URL(activeLink.href, url).searchParams.get('page') || 1) : null;
  const counterMatch = /Вся почта\s*\(([\d\s\u00a0]+)\)/u.exec(text(document.querySelector('#mail_int_left')));
  const counterValue = counterMatch ? Number(counterMatch[1].replace(/\s/gu, '')) : null;
  return { url, active_page: activePage, topics, page_links: [...new Set(pageLinks)], filter_confirmed: /Скрыть\s+все\s+темы/iu.test(button), button_text: button,
    list_sort: { date_checked: sortChecked(/searchsort_date|дат/iu), relevance_checked: sortChecked(/searchsort_rel|релевант/iu), semantics: 'search_controls_not_verified_list_order' },
    ...(Number.isSafeInteger(counterValue) && counterValue >= 0 ? { observed_counter: { value: counterValue, unit: 'unverified' } } : {}),
    pagination_verified: topics.length > 0, recognized: topics.length > 0 };
}

/** Read only observed message tables, never execute mail links or scripts. */
export function readTopicDom({ offset = 0, limit = 500 } = {}) {
  const text = n => n?.innerText?.trim() || '';
  const url = document.location.href;
  const topicId = new URL(url).searchParams.get('topicid');
  const title = text(document.querySelector(`#topictitle_${topicId}`)) || text(document.querySelector('h1'));
  const rows = [...document.querySelectorAll('table.basemail_topic[id^="post_"]')].filter(n => /^post_\d+$/.test(n.id));
  const messages = rows.slice(offset, offset + limit).map(row => {
    const body = row.querySelector('td[id^="posttext_"]');
    const header = row.querySelector(':scope > tbody > tr:first-child');
    const authorHeader = text(header?.querySelector('td:first-child em'));
    const date = text(header?.querySelector('td:nth-child(2) em'));
    const authorDate = /\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2}(?::\d{2})?/.exec(authorHeader)?.[0] || null;
    const attachments = [...row.querySelectorAll('a[href*="/modules/attachment/"]')].map(a => ({ name: text(a), url: a.href, availability: 'linked_not_downloaded' }));
    for (const img of body?.querySelectorAll('img[src]') ?? []) attachments.push({ name: img.alt || '', url: img.src, availability: 'inline_link_not_downloaded' });
    return { source_message_id: row.id, body_text: text(body), author_text: /^<([^>]+)>/.exec(authorHeader)?.[1] ?? authorHeader,
      sent_at: authorDate,
      source_header_dates: { author_header: authorDate, secondary_header: date || null },
      source_date_observation: { primary_field: 'author_header', secondary_semantics: 'unverified', parser_version: 'basemail-author-date-v2' },
      attachments, attachments_status: 'unverified', content_status: body ? 'complete' : 'missing_body' };
  });
  const pageLinks = [...document.querySelectorAll('ul li a[href]')].filter(a => {
    if (a.closest('table[id^="post_"],td[id^="posttext_"]') || !/^(?:\d+|[«»‹›←→]|Следующая|Предыдущая)$/iu.test(text(a))) return false;
    try { const u = new URL(a.href), here = new URL(url); return u.origin === here.origin && u.pathname === here.pathname && u.searchParams.get('topicid') === topicId && u.searchParams.has('page') && [...u.searchParams.keys()].every(k => ['folder', 'folderid', 'topicid', 'page'].includes(k)); } catch { return false; }
  }).map(a => a.href);
  return { url, topic_id: topicId, title, messages, total_dom_messages: rows.length, message_offset: offset, page_links: [...new Set(pageLinks)], recognized: messages.length > 0,
    pagination_verified: messages.length > 0, content_verified: messages.length > 0 && messages.every(m => m.content_status !== 'missing_body') };
}

function samePage(actual, expected, topicId) {
  const a = safePageUrl(actual, expected, topicId), b = safePageUrl(expected, expected, topicId);
  if (!a || !b) return false;
  const normalize = value => { const u = new URL(value); if (u.searchParams.get('page') === '1') u.searchParams.delete('page'); u.searchParams.sort(); return u.href; };
  return normalize(a) === normalize(b);
}

/** Run only inside an active Cua call. Every browser operation is awaited. */
export async function collectBatch({ tab, store, kind = 'list', maxPages = 5, deadlineMs = 40000, getTopic }) {
  if (!['list', 'topic'].includes(kind) || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100 || !Number.isFinite(deadlineMs) || deadlineMs <= 0) throw new Error('INVALID_BATCH_OPTIONS');
  const started = Date.now(), results = [];
  while (results.length < maxPages && Date.now() - started < deadlineMs) {
    const next = kind === 'list' ? store.nextListPage() : store.nextTopicPage();
    if (!next) break;
    let navigationTimedOut = false;
    try {
      try { await tab.goto(next.url); } catch { navigationTimedOut = true; }
      // A navigation timeout can still leave a fully rendered correct page.
      if (kind === 'list') {
        await tab.playwright.locator('#basemail_showall').first().waitFor({ state: 'visible', timeoutMs: 15000 });
        await tab.playwright.locator('a[id^="topictitle_"]').first().waitFor({ state: 'visible', timeoutMs: 15000 });
        const requestedPage = new URL(next.url).searchParams.get('page');
        if (requestedPage && Number(requestedPage) > 1) {
          await tab.playwright.locator(`li.active a[href$="page=${Number(requestedPage)}"],li.active a[href*="page=${Number(requestedPage)}&"]`).first().waitFor({ state: 'visible', timeoutMs: 15000 });
        }
      } else await tab.playwright.locator('table.basemail_topic[id^="post_"] td[id^="posttext_"]').first().waitFor({ state: 'visible', timeoutMs: 15000 });
      // Extremely long unfolded discussions can exceed the native AX frame;
      // the following bounded read-only DOM state remains the verifier.
      try { await tab.getAXState({ emit: false }); } catch { /* Verify URL and content below. */ }
      if (kind === 'topic') {
        const reveal = tab.playwright.getByRole('link', { name: 'Сообщения скрыты Нажмите сюда чтобы показать скрытые сообщения', exact: true });
        if (await reveal.isVisible()) await reveal.click();
      }
      let data = await tab.playwright.evaluate(kind === 'list' ? readListDom : readTopicDom);
      if (!samePage(data.url, next.url, kind === 'topic' ? String(next.topic_id) : null)) throw new Error('STALE_OR_UNEXPECTED_PAGE');
      const requestedPage = Number(new URL(next.url).searchParams.get('page') || 1);
      if (kind === 'list' && requestedPage > 1 && data.active_page !== requestedPage) throw new Error('STALE_OR_UNEXPECTED_PAGE');
      if (kind === 'list' && !data.filter_confirmed && /Показать\s+все\s+темы/iu.test(data.button_text)) {
        await tab.playwright.getByRole('button', { name: /Показать\s+все\s+темы/iu }).press('Enter');
        await tab.playwright.getByRole('button', { name: /Скрыть\s+все\s+темы/iu }).waitFor({ state: 'visible', timeoutMs: 10000 });
        await tab.getAXState({ emit: false });
        data = await tab.playwright.evaluate(readListDom);
        if (!samePage(data.url, next.url, null)) throw new Error('STALE_OR_UNEXPECTED_PAGE');
      }
      if (!data.recognized) throw new Error('UNSUPPORTED_PAGE_LAYOUT');
      if (kind === 'list' && !data.filter_confirmed) throw new Error('ALL_TOPICS_FILTER_NOT_CONFIRMED');
      const metadata = kind === 'topic' && getTopic ? await getTopic(String(next.topic_id)) : null;
      if (kind === 'topic' && Number.isInteger(data.total_dom_messages)) {
        // Bounded DOM chunks avoid large browser transport payloads. Some long
        // discussions also finish rendering after their first table appears.
        if (Number.isInteger(metadata?.message_count_hint) && data.total_dom_messages < metadata.message_count_hint) {
          try { await tab.playwright.locator('table.basemail_topic[id^="post_"]').nth(metadata.message_count_hint - 1).waitFor({ state: 'attached', timeoutMs: 15000 }); } catch { /* Preserve actual available content and quarantine count mismatch. */ }
          data = await tab.playwright.evaluate(readTopicDom, { offset: 0, limit: 500 });
          if (!samePage(data.url, next.url, String(next.topic_id))) throw new Error('STALE_OR_UNEXPECTED_PAGE');
        }
        const total = data.total_dom_messages;
        while (data.messages.length < total) {
          const offset = data.messages.length;
          const chunk = await tab.playwright.evaluate(readTopicDom, { offset, limit: 500 });
          if (!samePage(chunk.url, next.url, String(next.topic_id)) || chunk.total_dom_messages !== total || chunk.message_offset !== offset || !chunk.messages.length) throw new Error('SOURCE_CHANGED_DURING_PAGE');
          data.messages.push(...chunk.messages);
          data.content_verified = data.content_verified && chunk.content_verified;
        }
        if (new Set(data.messages.map(m => m.source_message_id)).size !== data.messages.length) throw new Error('SOURCE_CHANGED_DURING_PAGE');
      }
      const quarantinedBefore = store.progress().quarantined_pages;
      if (kind === 'topic') {
        if (metadata?.title) data.title = metadata.title;
        const hint = metadata?.message_count_hint;
        // A first page without pagination must contain the observed source count.
        if (Number.isInteger(hint) && hint >= 0 && !new URL(next.url).searchParams.has('page') && data.page_links.length === 0 && data.messages.length !== hint) {
          data.pagination_verified = false;
          data.count_mismatch = { expected_hint: hint, extracted: data.messages.length, reason: data.messages.length > hint ? 'source_count_changed' : 'source_count_not_reconciled' };
        }
        store.ingestTopicPage({ ...data, topic_id: String(next.topic_id), url: next.url });
      } else store.ingestListPage({ ...data, url: next.url });
      const progress = await store.checkpoint();
      results.push({ url: next.url, status: data.content_verified === false || data.pagination_verified === false || progress.quarantined_pages > quarantinedBefore ? 'quarantined' : 'done', navigation_timed_out: navigationTimedOut,
        records: kind === 'list' ? data.topics.length : data.messages.length, ...(data.count_mismatch ? { count_mismatch: data.count_mismatch } : {}) });
      if (progress.quarantined_pages && results.at(-1).status === 'quarantined') break;
    } catch (error) {
      const code = ['STALE_OR_UNEXPECTED_PAGE', 'UNSUPPORTED_PAGE_LAYOUT', 'ALL_TOPICS_FILTER_NOT_CONFIRMED', 'SOURCE_CHANGED_DURING_PAGE'].includes(error.message) ? error.message : 'IAB_PAGE_READ_FAILED';
      store.recordFailure({ url: next.url, kind, topic_id: next.topic_id, code });
      await store.checkpoint();
      results.push({ url: next.url, status: 'failed', code });
      break;
    }
  }
  return { results, progress: store.progress(), elapsed_ms: Date.now() - started };
}
