/** Only rendered list identities and pagination are inspected; no session internals. */
export function listState() {
  const links = [...document.querySelectorAll('a[href]')];
  const topicIds = [...new Set(links.filter(a => /(?:\?|&)topicid=\d+/.test(a.href) && a.hash === '#add_post_form_link').map(a => new URL(a.href).searchParams.get('topicid')))];
  const pagination = [...new Set(links.filter(a => /(?:\?|&)page=\d+/.test(a.href)).map(a => a.href))];
  const button = document.querySelector('#basemail_showall');
  return { topic_ids: topicIds, pagination, button_text: button?.innerText?.trim() || null,
    button_visible: Boolean(button?.getClientRects().length), signature: JSON.stringify([topicIds, pagination]) };
}

export function fullListReady({ signature }) {
  const button = document.querySelector('#basemail_showall');
  if (!/Скрыть\s+все\s+темы/iu.test(button?.innerText || '')) return false;
  const links = [...document.querySelectorAll('a[href]')];
  const ids = [...new Set(links.filter(a => /(?:\?|&)topicid=\d+/.test(a.href) && a.hash === '#add_post_form_link').map(a => new URL(a.href).searchParams.get('topicid')))];
  const pages = [...new Set(links.filter(a => /(?:\?|&)page=\d+/.test(a.href)).map(a => a.href))];
  return ids.length > 0 && JSON.stringify([ids, pages]) !== signature;
}

export async function showAllTopics(page) {
  const before = await page.evaluate(listState);
  if (before.button_visible && /Скрыть\s+все\s+темы/iu.test(before.button_text || '')) {
    return { confirmed: true, action: 'already_showing_all_topics', before_topics: before.topic_ids.length, after_topics: before.topic_ids.length, pagination_links: before.pagination.length, button_text_after: before.button_text };
  }
  if (!before.button_visible || !/Показать\s+все\s+темы/iu.test(before.button_text || '')) {
    throw Object.assign(new Error('ALL_TOPICS_FILTER_NOT_CONFIRMED'), { code: 'ALL_TOPICS_FILTER_NOT_CONFIRMED' });
  }
  // Keyboard activation avoids the floating right sidebar overlapping its centre.
  await page.locator('#basemail_showall').press('Enter');
  // A click alone is insufficient: the old two-topic DOM may remain while AJAX runs.
  try { await page.waitForFunction(fullListReady, { signature: before.signature }, { timeout: 45000 }); }
  catch { throw Object.assign(new Error('ALL_TOPICS_FILTER_UPDATE_NOT_OBSERVED'), { code: 'ALL_TOPICS_FILTER_UPDATE_NOT_OBSERVED' }); }
  const after = await page.evaluate(listState);
  return { confirmed: true, action: 'activated_show_all_and_verified_hide_all_label', before_topics: before.topic_ids.length, after_topics: after.topic_ids.length, pagination_links: after.pagination.length, button_text_after: after.button_text };
}
