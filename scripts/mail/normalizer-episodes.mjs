import { createHash } from 'node:crypto';
import { parseMailTimestamp } from './mail-date-window.mjs';

export const NORMALIZER_VERSION = '1.1.0';
export const EPISODE_EXTRACTOR_VERSION = '1.1.0';

function mailHeader(message, name) {
  const entry = Object.entries(message.headers || {}).find(([key]) => key.toLowerCase() === name);
  return entry ? String(entry[1]) : '';
}

function decodeBytes(bytes, charset) {
  return new TextDecoder(charset || 'utf-8', { fatal: true }).decode(bytes);
}

function transferBytes(text, encoding) {
  if (encoding === 'base64') {
    const compact = text.replace(/[\t\r\n ]/g, '');
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==?|[A-Za-z0-9+/]{3}=?)?$/.test(compact)) {
      throw new Error('INVALID_MAIL_BASE64');
    }
    return Buffer.from(compact, 'base64');
  }
  const unfolded = text.replace(/=\r?\n/g, '');
  const bytes = [];
  for (let i = 0; i < unfolded.length; i++) {
    if (unfolded[i] === '=') {
      const hex = unfolded.slice(i + 1, i + 3);
      if (!/^[0-9a-f]{2}$/i.test(hex)) throw new Error('INVALID_MAIL_QUOTED_PRINTABLE');
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else {
      const code = unfolded.charCodeAt(i);
      if (code > 255) throw new Error('INVALID_MAIL_BYTE');
      bytes.push(code);
    }
  }
  return Uint8Array.from(bytes);
}

// Decode only declared encodings: ordinary text such as "YWJj" and "=20"
// must survive unchanged. Failed decoding preserves the original for review.
function decodeBody(message, rawBody) {
  const encoding = String(message.content_transfer_encoding || message.transfer_encoding || mailHeader(message, 'content-transfer-encoding')).trim().toLowerCase();
  const contentType = String(message.content_type || mailHeader(message, 'content-type'));
  const charset = message.charset || /charset\s*=\s*["']?([^\s;"']+)/i.exec(contentType)?.[1] || 'utf-8';
  try {
    if (encoding === 'base64' || encoding === 'quoted-printable') {
      return { text: decodeBytes(transferBytes(rawBody, encoding), charset), failed: false };
    }
    // body_text normally already contains Unicode. Byte strings are decoded
    // only when the source explicitly declares an 8bit transfer encoding.
    if (encoding === '8bit' && [...rawBody].every(char => char.charCodeAt(0) <= 255)) {
      return { text: decodeBytes(Buffer.from(rawBody, 'latin1'), charset), failed: false };
    }
    if (encoding && !['7bit', '8bit', 'binary'].includes(encoding)) throw new Error('UNKNOWN_MAIL_ENCODING');
    return { text: rawBody, failed: false };
  } catch {
    return { text: rawBody, failed: true };
  }
}

function decodeTitle(rawTitle) {
  let failed = false;
  // Whitespace between adjacent encoded-words is folding, not title content.
  const title = rawTitle.replace(/(\?=)[\t\r\n ]+(?==\?)/g, '$1')
    .replace(/=\?([^?\s]+)\?([bq])\?([^?]*)\?=/gi, (word, charset, encoding, value) => {
      try {
        return decodeBytes(transferBytes(encoding.toLowerCase() === 'q' ? value.replace(/_/g, ' ') : value,
          encoding.toLowerCase() === 'q' ? 'quoted-printable' : 'base64'), charset);
      } catch {
        failed = true;
        return word;
      }
    });
  return { title, failed };
}

/**
 * Normalizes email content while strictly preserving raw originals.
 * Separates new text, quoted sections, forwarded blocks, and signatures.
 * Instructions inside emails are treated as inert string data, not commands.
 */
export function normalizeMessageContent(message) {
  if (!message || typeof message !== 'object') {
    throw new Error('INVALID_MESSAGE_OBJECT');
  }

  const rawBody = message.body_text != null ? String(message.body_text) : '';
  const rawTitle = message.title != null ? String(message.title) : '';
  const rawSentAt = message.sent_at != null ? String(message.sent_at) : null;
  const decodedBody = decodeBody(message, rawBody);
  const decodedTitle = decodeTitle(rawTitle);
  const decodingFailed = decodedBody.failed || decodedTitle.failed;
  const contentStatus = message.content_status || (rawBody ? 'complete' : 'empty');

  // Handle empty or missing body explicitly
  if (contentStatus === 'empty' || contentStatus === 'missing_body' || !rawBody.trim()) {
    return {
      source_instance: message.source_instance ?? null,
      source_message_id: message.source_message_id != null ? String(message.source_message_id) : null,
      topic_id: message.topic_id != null ? String(message.topic_id) : null,
      source_url: message.source_url ?? null,
      raw_body_text: rawBody,
      raw_title: rawTitle,
      normalized_title: decodedTitle.title,
      decoding_failed: decodingFailed,
      raw_sent_at: rawSentAt,
      clean_text: '',
      new_text: '',
      quotes: [],
      forwarded: [],
      signatures: [],
      normalized_dates: {
        author_date_iso: parseMailTimestamp(rawSentAt || message.source_header_dates?.author_header),
        secondary_date_iso: parseMailTimestamp(message.source_header_dates?.secondary_header),
        dates_in_text: [],
      },
      content_status: contentStatus,
      normalizer_version: NORMALIZER_VERSION,
    };
  }

  // 1. HTML entity decoding and HTML tag stripping
  let text = decodedBody.text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/&#(\d+);/g, (_, code) => {
      try { return String.fromCodePoint(Number(code)); } catch { return ''; }
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      try { return String.fromCodePoint(parseInt(hex, 16)); } catch { return ''; }
    });

  // Replace line-break tags with newlines
  text = text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, '\n> $1\n')
    .replace(/\[quote\]([\s\S]*?)\[\/quote\]/gi, '\n> $1\n')
    .replace(/<[^>]+>/g, '');

  // Unicode NFKC normalization
  text = text.normalize('NFKC');

  // Strip control characters except newline and tab
  text = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  const cleanText = text.trim();

  // 2. Parse lines to separate new text, quotes, forwards, and signatures
  const lines = cleanText.split('\n');
  const newLines = [];
  const quoteBlocks = [];
  const forwardBlocks = [];
  const signatureBlocks = [];

  let currentQuote = [];
  let currentForward = [];
  let sigLines = [];

  let inForward = false;
  let inHeaderQuote = false;
  let inPrefixQuote = false;
  let signatureStarted = false;

  const quoteHeaderRegex = /^(?:-{3,}\s*(?:Original Message|Исходное сообщение)\s*-{3,}|On\s+.+wrote:|В\s+сообщении\s+от\s+.+написал:|\d{2}\.\d{2}\.\d{4}.+wrote:)/iu;
  const forwardHeaderRegex = /^(?:-{3,}\s*(?:Forwarded message|Пересылаемое сообщение)\s*-{3,}|Fwd:\s*|Пересланное сообщение:)/iu;
  const sigStartRegex = /^(?:--\s*$|__\s*$|С\s+уважением[,.]?|Best\s+regards[,.]?|С\s+наилучшими\s+пожеланиями[,.]?|Отправлено\s+из\s+|Sent\s+from\s+my\s+)/iu;

  const flushQuote = () => {
    if (currentQuote.length) {
      quoteBlocks.push(currentQuote.join('\n').trim());
      currentQuote = [];
    }
    inHeaderQuote = false;
    inPrefixQuote = false;
  };

  const flushForward = () => {
    if (currentForward.length) {
      forwardBlocks.push(currentForward.join('\n').trim());
      currentForward = [];
    }
    inForward = false;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // 1. Signature start check
    if (!signatureStarted && sigStartRegex.test(trimmed)) {
      flushQuote();
      flushForward();
      signatureStarted = true;
      sigLines.push(line);
      continue;
    }

    if (signatureStarted) {
      sigLines.push(line);
      continue;
    }

    // 2. Forward header check
    if (forwardHeaderRegex.test(trimmed)) {
      flushQuote();
      flushForward();
      inForward = true;
      currentForward.push(line);
      continue;
    }

    // 3. Quote header check
    if (quoteHeaderRegex.test(trimmed)) {
      flushForward();
      flushQuote();
      inHeaderQuote = true;
      currentQuote.push(line);
      continue;
    }

    // 4. Prefix quote (lines starting with > or &gt;)
    if (trimmed.startsWith('>') || trimmed.startsWith('&gt;')) {
      if (!inPrefixQuote && !inHeaderQuote) {
        flushForward();
        inPrefixQuote = true;
      }
      const unquoted = trimmed.replace(/^(?:>|&gt;)\s*/u, '');
      currentQuote.push(unquoted);
      continue;
    }

    // 5. Active forward block
    if (inForward) {
      currentForward.push(line);
      continue;
    }

    // 6. Active header quote (everything following -----Original Message-----)
    if (inHeaderQuote) {
      currentQuote.push(line);
      continue;
    }

    // 7. Active prefix quote ending on non-quote line
    if (inPrefixQuote) {
      if (trimmed === '') {
        currentQuote.push(line);
      } else {
        flushQuote();
        newLines.push(line);
      }
      continue;
    }

    // 8. Regular new content line
    newLines.push(line);
  }

  flushQuote();
  flushForward();
  if (sigLines.length) {
    signatureBlocks.push(sigLines.join('\n').trim());
  }

  const newText = newLines.join('\n').trim();

  // 3. Extract dates from text
  const dateRegex = /\b(\d{2}\.\d{2}\.\d{4}(?:\s+\d{2}:\d{2}(?::\d{2})?)?)\b/g;
  const datesInText = [];
  let m;
  while ((m = dateRegex.exec(cleanText)) !== null) {
    const parsed = parseMailTimestamp(m[1].includes(':') ? m[1] : `${m[1]} 00:00:00`);
    if (parsed && !datesInText.includes(parsed)) {
      datesInText.push(parsed);
    }
  }

  return {
    source_instance: message.source_instance ?? null,
    source_message_id: message.source_message_id != null ? String(message.source_message_id) : null,
    topic_id: message.topic_id != null ? String(message.topic_id) : null,
    source_url: message.source_url ?? null,
    raw_body_text: rawBody,
    raw_title: rawTitle,
    normalized_title: decodedTitle.title,
    decoding_failed: decodingFailed,
    raw_sent_at: rawSentAt,
    clean_text: cleanText,
    new_text: newText,
    quotes: quoteBlocks.filter(Boolean),
    forwarded: forwardBlocks.filter(Boolean),
    signatures: signatureBlocks.filter(Boolean),
    normalized_dates: {
      author_date_iso: parseMailTimestamp(rawSentAt || message.source_header_dates?.author_header),
      secondary_date_iso: parseMailTimestamp(message.source_header_dates?.secondary_header),
      dates_in_text: datesInText.sort(),
    },
    content_status: contentStatus,
    normalizer_version: NORMALIZER_VERSION,
  };
}

/**
 * Reconstructs conversation threads strictly by confirmed identifiers (topic_id / thread_id).
 * Similar or identical titles ALONE DO NOT merge threads.
 */
export function reconstructThreads(messages) {
  if (!Array.isArray(messages)) {
    throw new Error('INVALID_MESSAGES_ARRAY');
  }

  const threads = new Map();

  for (const raw of messages) {
    const norm = normalizeMessageContent(raw);
    const threadId = norm.topic_id != null ? String(norm.topic_id) : `unknown_thread_${createHash('sha256').update(norm.source_message_id || '').digest('hex').slice(0, 12)}`;

    if (!threads.has(threadId)) {
      threads.set(threadId, {
        thread_id: threadId,
        topic_id: norm.topic_id,
        title: norm.normalized_title,
        source_url: norm.source_url,
        messages: [],
      });
    }

    const thread = threads.get(threadId);
    thread.messages.push(norm);
  }

  // Sort messages in each thread chronologically by author date if available
  for (const thread of threads.values()) {
    thread.messages.sort((a, b) => {
      const dateA = a.normalized_dates?.author_date_iso || '';
      const dateB = b.normalized_dates?.author_date_iso || '';
      if (dateA && dateB && dateA !== dateB) {
        return dateA < dateB ? -1 : 1;
      }
      return String(a.source_message_id || '').localeCompare(String(b.source_message_id || ''));
    });
  }

  return threads;
}

/**
 * Extracts work episodes (cards/cases) from normalized messages within a thread.
 * Identifies tickets, report periods, customer receipt requests, shift handovers, IT requests.
 * One message with multiple requests splits into multiple episode IDs.
 * Ambiguous boundaries are flagged for manual review.
 */
export function extractEpisodes({ thread_id, topic_id, title = '', messages = [] }) {
  const episodes = [];
  const episodeMap = new Map(); // key -> episode

  // Regex patterns for episode signals
  // NFKC turns the numero sign (U+2116) into the letters "No", so the normalized
  // text can contain "Заявка No1234" even though the raw message used "№1234".
  const ticketRegex = /(?:[#№]|заявк[аеиу]|заказ[аеу]?|обращени[еяю]|договор[аеу]?)\s*[:#№]?(?:No|Nº|N°)?\s*(\d{4,10})/giu;
  const bareTicketRegex = /\b(?:[#№])(\d{4,10})\b/gu;
  const reportPeriodRegex = /отч[её]т.{0,30}?(?:за\s+)?((?:январ[ья]|феврал[ья]|март[а]?|апрел[ья]|ма[йя]|июн[ья]|июл[ья]|август[а]?|сентябр[ья]|октябр[ья]|ноябр[ья]|декабр[ья]|[1-4]\s+кв(?:артал)?)(?:\s+(?:за\s+)?\d{4}(?:\s*г(?:ода|од|\.)?)?)?|\d{2}\.\d{4}|\d{4}\s*г)/iu;
  const receiptRegex = /чек.{0,30}(?:по\s+заявке|клиент|заказ)\s*[:#№]?\s*(\d{4,10})?/iu;
  const shiftHandoverRegex = /передач[аеи].{0,25}(?:смен[ые]|групп[ые])/iu;
  const itRequestRegex = /(?:доступ|установк[аеи]|парол[ьяе]|бп\s+в\s+пк|vpn)\s*[:—\-]?\s*([^\n.;]{3,50})/iu;

  for (const msg of messages) {
    // If message body is empty or damaged, it produces no confirmed episode directly
    if (msg.content_status === 'empty' || msg.content_status === 'missing_body' || !msg.clean_text) {
      continue;
    }

    const textToScan = msg.decoding_failed ? '' : `${msg.new_text ?? msg.clean_text}`;
    // A topic's inherited subject does not confirm a later reply's boundary.
    const messageTitle = msg.normalized_title ?? title;
    const titleToScan = !msg.decoding_failed && episodes.length === 0
      && !/^\s*(?:re|fw|fwd|ответ|пересл)\s*:/iu.test(messageTitle) ? messageTitle : '';
    const foundTickets = new Set();

    let match;
    while ((match = ticketRegex.exec(textToScan)) !== null) {
      foundTickets.add(match[1]);
    }
    while ((match = bareTicketRegex.exec(textToScan)) !== null) {
      foundTickets.add(match[1]);
    }

    const assignedEpisodeIds = [];

    // Case 1: Explicit Ticket Numbers (one or multiple)
    if (foundTickets.size > 0) {
      for (const ticket of [...foundTickets].sort()) {
        const episodeKey = `ticket_${ticket}`;
        let ep = episodeMap.get(episodeKey);
        if (!ep) {
          ep = {
            episode_id: `ep_${thread_id}_${ticket}`,
            thread_id: String(thread_id),
            topic_id: topic_id ? String(topic_id) : null,
            episode_type: 'ticket',
            identifier_value: ticket,
            message_ids: [msg.source_message_id],
            boundary_status: 'confirmed',
            review_required: false,
            review_reason: null,
            first_seen_at: msg.normalized_dates?.author_date_iso || null,
          };
          episodeMap.set(episodeKey, ep);
          episodes.push(ep);
        } else {
          if (!ep.message_ids.includes(msg.source_message_id)) {
            ep.message_ids.push(msg.source_message_id);
          }
        }
        assignedEpisodeIds.push(ep.episode_id);
      }
    }

    // Case 2: Report Period
    const reportMatch = reportPeriodRegex.exec(textToScan) || reportPeriodRegex.exec(titleToScan);
    if (reportMatch && !foundTickets.size) {
      const period = reportMatch[1].trim();
      const hasYear = /\d{4}/.test(period);
      const episodeKey = `report_${period.toLowerCase()}${hasYear ? '' : `_${msg.source_message_id}`}`;
      let ep = episodeMap.get(episodeKey);
      if (!ep) {
        ep = {
          episode_id: `ep_${thread_id}_report_${createHash('sha256').update(episodeKey).digest('hex').slice(0, 8)}`,
          thread_id: String(thread_id),
          topic_id: topic_id ? String(topic_id) : null,
          episode_type: 'report_period',
          identifier_value: period,
          message_ids: [msg.source_message_id],
          boundary_status: hasYear ? 'confirmed' : 'ambiguous',
          review_required: !hasYear,
          review_reason: hasYear ? null : 'ambiguous_report_year',
          first_seen_at: msg.normalized_dates?.author_date_iso || null,
        };
        episodeMap.set(episodeKey, ep);
        episodes.push(ep);
      } else {
        if (!ep.message_ids.includes(msg.source_message_id)) {
          ep.message_ids.push(msg.source_message_id);
        }
      }
      assignedEpisodeIds.push(ep.episode_id);
    }

    // Case 3: Customer Receipt Request
    const receiptMatch = receiptRegex.exec(textToScan);
    if (receiptMatch && !foundTickets.size && !reportMatch) {
      const receiptRef = receiptMatch[1] ? receiptMatch[1] : 'unspecified';
      const episodeKey = `receipt_${receiptRef}_${msg.source_message_id}`;
      const ep = {
        episode_id: `ep_${thread_id}_receipt_${createHash('sha256').update(episodeKey).digest('hex').slice(0, 8)}`,
        thread_id: String(thread_id),
        topic_id: topic_id ? String(topic_id) : null,
        episode_type: 'receipt_request',
        identifier_value: receiptRef !== 'unspecified' ? receiptRef : null,
        message_ids: [msg.source_message_id],
        boundary_status: receiptRef !== 'unspecified' ? 'confirmed' : 'ambiguous',
        review_required: receiptRef === 'unspecified',
        review_reason: receiptRef === 'unspecified' ? 'ambiguous_receipt_target' : null,
        first_seen_at: msg.normalized_dates?.author_date_iso || null,
      };
      episodes.push(ep);
      assignedEpisodeIds.push(ep.episode_id);
    }

    // Case 4: Shift handover
    const shiftMatch = shiftHandoverRegex.exec(textToScan) || shiftHandoverRegex.exec(titleToScan);
    if (shiftMatch && !foundTickets.size && !reportMatch && !receiptMatch) {
      const episodeKey = `shift_${thread_id}`;
      let ep = episodeMap.get(episodeKey);
      if (!ep) {
        ep = {
          episode_id: `ep_${thread_id}_shift`,
          thread_id: String(thread_id),
          topic_id: topic_id ? String(topic_id) : null,
          episode_type: 'shift_handover',
          identifier_value: null,
          message_ids: [msg.source_message_id],
          boundary_status: 'confirmed',
          review_required: false,
          review_reason: null,
          first_seen_at: msg.normalized_dates?.author_date_iso || null,
        };
        episodeMap.set(episodeKey, ep);
        episodes.push(ep);
      } else {
        if (!ep.message_ids.includes(msg.source_message_id)) {
          ep.message_ids.push(msg.source_message_id);
        }
      }
      assignedEpisodeIds.push(ep.episode_id);
    }

    // Case 5: IT / Access Request
    const itMatch = itRequestRegex.exec(textToScan);
    if (itMatch && !foundTickets.size && !reportMatch && !receiptMatch && !shiftMatch) {
      const target = itMatch[1].trim();
      const episodeKey = `it_${createHash('sha256').update(target).digest('hex').slice(0, 8)}`;
      let ep = episodeMap.get(episodeKey);
      if (!ep) {
        ep = {
          episode_id: `ep_${thread_id}_it_${createHash('sha256').update(target).digest('hex').slice(0, 8)}`,
          thread_id: String(thread_id),
          topic_id: topic_id ? String(topic_id) : null,
          episode_type: 'it_request',
          identifier_value: target,
          message_ids: [msg.source_message_id],
          boundary_status: 'confirmed',
          review_required: false,
          review_reason: null,
          first_seen_at: msg.normalized_dates?.author_date_iso || null,
        };
        episodeMap.set(episodeKey, ep);
        episodes.push(ep);
      } else {
        if (!ep.message_ids.includes(msg.source_message_id)) {
          ep.message_ids.push(msg.source_message_id);
        }
      }
      assignedEpisodeIds.push(ep.episode_id);
    }

    // Case 6: Fallback for ambiguous or ongoing discussion with no explicit operational anchor
    if (!assignedEpisodeIds.length) {
      // An unanchored continuation is a separate review item. Thread order
      // cannot confirm which of its operational episodes it belongs to.
      const ep = {
        episode_id: `ep_${thread_id}_discussion_${msg.source_message_id}`,
        thread_id: String(thread_id),
        topic_id: topic_id ? String(topic_id) : null,
        episode_type: 'discussion',
        identifier_value: null,
        message_ids: [msg.source_message_id],
        boundary_status: 'ambiguous',
        review_required: true,
        review_reason: msg.decoding_failed ? 'decoding_failed' : 'ambiguous_boundary',
        first_seen_at: msg.normalized_dates?.author_date_iso || null,
      };
      episodes.push(ep);
    }
  }

  return episodes;
}

/**
 * Builds the comprehensive mapping table:
 * message_id -> thread_id -> episode_ids
 * Every collected message ID is preserved, including empty or corrupted records.
 */
export function buildEpisodeIndex(messages, threads, allEpisodes) {
  if (!Array.isArray(messages)) {
    throw new Error('INVALID_MESSAGES_ARRAY');
  }

  // Create message to episodes lookup
  const msgToEpisodes = new Map();
  const msgReviewReasons = new Map();
  for (const ep of allEpisodes) {
    for (const msgId of ep.message_ids) {
      if (!msgToEpisodes.has(msgId)) {
        msgToEpisodes.set(msgId, []);
      }
      msgToEpisodes.get(msgId).push(ep.episode_id);
      if (ep.review_required) msgReviewReasons.set(msgId, ep.review_reason || 'ambiguous_boundary');
    }
  }

  // Find thread for each message
  const msgToThread = new Map();
  const decodingFailures = new Set();
  for (const thread of threads.values()) {
    for (const msg of thread.messages) {
      msgToThread.set(String(msg.source_message_id), thread.thread_id);
      if (msg.decoding_failed) decodingFailures.add(String(msg.source_message_id));
    }
  }

  const index = new Map();

  for (const raw of messages) {
    const id = raw.source_message_id != null ? String(raw.source_message_id) : null;
    if (!id) {
      continue;
    }

    const threadId = msgToThread.get(id) || (raw.topic_id != null ? String(raw.topic_id) : null);
    const episodeIds = msgToEpisodes.get(id) || [];
    const contentStatus = raw.content_status || (raw.body_text ? 'complete' : 'empty');
    const isCorrupted = contentStatus === 'missing_body' || contentStatus === 'corrupted';
    const isEmpty = contentStatus === 'empty' || !raw.body_text;
    const reviewReason = isCorrupted ? 'corrupted_content' : isEmpty ? 'empty_content'
      : decodingFailures.has(id) ? 'decoding_failed' : msgReviewReasons.get(id)
        || (episodeIds.length === 0 ? 'no_episode_assigned' : null);

    index.set(id, {
      message_id: id,
      thread_id: threadId,
      episode_ids: [...new Set(episodeIds)].sort(),
      content_status: contentStatus,
      review_required: reviewReason !== null,
      review_reason: reviewReason,
    });
  }

  return index;
}

/**
 * Flags possible duplicates across different topics/threads without deleting originals.
 * (e.g. multiple distinct topics referencing the same customer ticket on the front pages).
 */
export function detectDuplicateEpisodes(episodes) {
  if (!Array.isArray(episodes)) {
    throw new Error('INVALID_EPISODES_ARRAY');
  }

  const seenTickets = new Map(); // ticket -> first episode
  const duplicates = [];

  for (const ep of episodes) {
    if (ep.episode_type === 'ticket' && ep.identifier_value) {
      const ticket = ep.identifier_value;
      if (!seenTickets.has(ticket)) {
        seenTickets.set(ticket, ep);
        ep.is_possible_duplicate = false;
        ep.duplicate_of_episode_id = null;
      } else {
        const first = seenTickets.get(ticket);
        if (first.thread_id !== ep.thread_id) {
          ep.is_possible_duplicate = true;
          ep.duplicate_of_episode_id = first.episode_id;
          ep.duplicate_of_thread_id = first.thread_id;
          ep.duplicate_reason = 'same_ticket_across_threads';
          duplicates.push({
            duplicate_episode_id: ep.episode_id,
            original_episode_id: first.episode_id,
            ticket: ticket,
            threads: [first.thread_id, ep.thread_id],
          });
        }
      }
    }
  }

  return duplicates;
}

/**
 * High-level orchestration for normalizing messages and extracting episodes.
 */
export function processThreadEpisodes(rawMessages) {
  const threads = reconstructThreads(rawMessages);
  const allEpisodes = [];

  for (const thread of threads.values()) {
    const eps = extractEpisodes(thread);
    allEpisodes.push(...eps);
  }

  const duplicates = detectDuplicateEpisodes(allEpisodes);
  const index = buildEpisodeIndex(rawMessages, threads, allEpisodes);

  const reviewRequiredCount = [...index.values()].filter(i => i.review_required).length;

  return {
    normalizer_version: NORMALIZER_VERSION,
    episode_extractor_version: EPISODE_EXTRACTOR_VERSION,
    threads_count: threads.size,
    episodes_count: allEpisodes.length,
    duplicates_count: duplicates.length,
    review_required_count: reviewRequiredCount,
    threads: [...threads.values()],
    episodes: allEpisodes,
    duplicates,
    index: Object.fromEntries(index.entries()),
  };
}
