#!/usr/bin/env node
import { readFile, writeFile, appendFile, mkdir, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { collectMailbox, extractDom, safePageUrl } from './collector-core.mjs';
import { showAllTopics } from './list-filter.mjs';

const args = process.argv.slice(2), options = {};
const flags = new Set(['headed', 'login', 'inspect', 'ack-read-state', 'visible-topics', 'shallow', 'help']);
for (let i = 0; i < args.length; i++) {
  if (!args[i].startsWith('--')) throw new Error('Expected named option');
  const key = args[i].slice(2);
  if (!['url', 'output', 'profile', 'max-pages', 'max-topics', 'delay-ms', 'adapter', 'channel', 'import', ...flags].includes(key)) throw new Error('Unknown option');
  options[key] = flags.has(key) ? true : args[++i];
}
if (options.help) {
  console.log('node scripts/mail/collect-basemail.mjs --url URL --output .mail-work/run --profile .mail-work/browser-profile [--login --headed] [--channel chrome|msedge] [--inspect] [--ack-read-state] [--visible-topics] [--shallow] [--max-pages N] [--max-topics N] [--adapter selectors.json] [--import snapshots.json]. Live collection defaults to verified Show all topics.');
  process.exit(0);
}
const url = options.url || 'https://basa.lenremont.com/modules/basemail/basemail.php?folder=all';
if (options.channel && !['chrome', 'msedge'].includes(options.channel)) throw new Error('INVALID_BROWSER_CHANNEL');
if (options.inspect && options.import) throw new Error('INSPECT_AND_IMPORT_ARE_EXCLUSIVE');
if (!safePageUrl(url, url)) throw new Error('INVALID_SCOPE_URL');
const output = resolve(options.output || '.mail-work/run');
const profile = resolve(options.profile || '.mail-work/browser-profile');
const number = (key, fallback) => {
  if (options[key] === undefined) return fallback;
  const result = Number(options[key]);
  if (!Number.isSafeInteger(result) || (key === 'max-topics' ? result < 0 : result < 1)) throw new Error(`Invalid --${key}`);
  return result;
};
const maxPages = number('max-pages', Infinity), maxTopics = options.shallow ? 0 : number('max-topics', Infinity), delay = number('delay-ms', 1000);
const listFilter = options.import ? 'observed' : options['visible-topics'] ? 'visible' : 'all_topics';
await mkdir(output, { recursive: true });
const atomicJson = async (file, data) => { await writeFile(`${file}.tmp`, JSON.stringify(data, null, 2)); await rename(`${file}.tmp`, file); };
let state;
try { state = JSON.parse(await readFile(join(output, 'checkpoint.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw new Error('CHECKPOINT_UNREADABLE'); }
if (state && (state.list_filter ?? 'observed') !== listFilter) throw new Error('CHECKPOINT_FILTER_MISMATCH: use a new output directory for a different list filter');
let storedMessages = [], logText = '', logExists = false;
try {
  logText = await readFile(join(output, 'messages.ndjson'), 'utf8'); logExists = true;
  // An unfinished append must never be interpreted as a committed last record.
  if (logText && !logText.endsWith('\n')) throw new Error('MESSAGE_LOG_UNREADABLE');
  storedMessages = logText.split('\n').filter(Boolean).map(line => JSON.parse(line));
} catch (error) { if (error.code !== 'ENOENT') throw new Error('MESSAGE_LOG_UNREADABLE'); }
const logHash = text => createHash('sha256').update(text).digest('hex');
if (storedMessages.length && !state) throw new Error('MESSAGE_LOG_WITHOUT_CHECKPOINT');
if (state) {
  const watermark = state.message_log;
  if (!watermark || !Number.isSafeInteger(watermark.rows) || watermark.rows < 0 || typeof watermark.sha256 !== 'string') throw new Error('CHECKPOINT_MESSAGE_WATERMARK_REQUIRED');
  if (!logExists || storedMessages.length < watermark.rows) throw new Error('MESSAGE_LOG_BEHIND_CHECKPOINT');
  const lines = logText.split('\n');
  const prefix = watermark.rows ? lines.slice(0, watermark.rows).join('\n') + '\n' : '';
  if (logHash(prefix) !== watermark.sha256) throw new Error('MESSAGE_LOG_CHECKPOINT_MISMATCH');
  // Ahead-of-checkpoint appends rehydrate state before replaying pending pages.
  state.messages = storedMessages;
}
let writtenMessages = storedMessages.length, checkpointSaves = 0, lastProgressAt = 0;
const save = async s => {
  if (Date.now() - lastProgressAt > 5000 || s.manifest) {
    await atomicJson(join(output, 'progress.json'), { updated_at: new Date().toISOString(), list_filter: listFilter,
      phase: s.list_queue.length ? 'discovering_topics' : 'collecting_messages', visited_list_pages: s.visited_list_pages.length,
      pending_list_pages: s.list_queue.length, discovered_unique_topics: s.topics.length,
      completed_topics: s.completed_topics.length, collected_unique_messages: s.messages.length,
      errors: s.errors.length, finished: Boolean(s.manifest), coverage_status: s.manifest?.coverage_status ?? 'partial' });
    lastProgressAt = Date.now();
  }
  if (s.messages.length > writtenMessages) {
    const appended = s.messages.slice(writtenMessages).map(m => JSON.stringify(m)).join('\n') + '\n';
    await appendFile(join(output, 'messages.ndjson'), appended);
    logText += appended;
    writtenMessages = s.messages.length;
  } else if (!writtenMessages) await appendFile(join(output, 'messages.ndjson'), '');
  // Bound write amplification on large mailboxes. On interruption at most 99
  // progress updates replay; source identities in the append log prevent duplicates.
  if (checkpointSaves++ % 100 === 0 || s.manifest) {
    s.message_log = { rows: writtenMessages, sha256: logHash(logText) };
    const { messages, ...progress } = s;
    await atomicJson(join(output, 'checkpoint.json'), progress);
    await writeFile(join(output, 'topics.ndjson'), s.topics.map(t => JSON.stringify(t)).join('\n') + (s.topics.length ? '\n' : ''));
  }
  if (s.manifest) await atomicJson(join(output, 'manifest.json'), s.manifest);
};
let context, stage = 'IMPORT';
try {
  let load;
  if (options.import) {
    const snapshots = JSON.parse(await readFile(resolve(options.import), 'utf8'));
    load = async (pageUrl, kind) => { const item = snapshots.pages?.find(p => p.url === pageUrl && p.kind === kind); if (!item) throw new Error('MISSING_IMPORT_PAGE'); return item.data; };
  } else {
    stage = 'ACKNOWLEDGEMENT';
    if (!options.inspect && !options.shallow && maxTopics !== 0 && !options['ack-read-state']) throw new Error('READ_STATE_ACK_REQUIRED: opening topics may mark them read; rerun with --ack-read-state after accepting this effect.');
    stage = 'DEPENDENCY';
    const { chromium } = await import('playwright');
    // Isolated profile: no access to existing browser credentials or session internals.
    stage = 'LAUNCH';
    context = await chromium.launchPersistentContext(profile, { headless: !(options.headed || options.login || options.inspect), acceptDownloads: false, ...(options.channel ? { channel: options.channel } : {}) });
    const page = context.pages()[0] || await context.newPage();
    if (options.login || options.inspect) {
      stage = 'NAVIGATE';
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      stage = 'LOGIN';
      const terminal = createInterface({ input: process.stdin, output: process.stdout });
      await terminal.question('Complete sign-in in the dedicated browser. Do not paste credentials here. Press Enter when the All mail list is visible. ');
      terminal.close();
    }
    if (options.inspect) {
      stage = 'EXTRACT';
      // Read only rendered DOM structure, never form values, hidden inputs,
      // script contents, cookies, local storage, headers or session internals.
      const capture = async kind => {
        const current = safePageUrl(page.url(), url, kind === 'topic' ? new URL(page.url()).searchParams.get('topicid') : null);
        if (!current || (kind === 'topic' && !new URL(current).searchParams.get('topicid'))) throw new Error('INSPECTION_PAGE_OUTSIDE_SCOPE');
        if (kind === 'list' && !(await page.evaluate(extractDom, { kind: 'list' })).recognized) throw new Error('INSPECTION_LIST_NOT_RECOGNIZED');
        const structure = await page.evaluate(() => {
          const collect = element => {
            if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'INPUT', 'TEXTAREA', 'SELECT', 'OPTION'].includes(element.tagName)) return null;
            if (!element.getClientRects().length) return null;
            const attributes = {};
            for (const name of ['id', 'class', 'role']) if (element.hasAttribute(name)) attributes[name] = element.getAttribute(name);
            for (const attribute of element.attributes) if (/^data-(?:message|post|comment)(?:-id)?$/i.test(attribute.name)) attributes[attribute.name] = attribute.value;
            const children = [...element.children].map(collect).filter(Boolean);
            const directText = [...element.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent.trim()).filter(Boolean).join(' ');
            return { tag: element.tagName.toLowerCase(), attributes, ...(directText ? { text: directText } : {}), ...(children.length ? { children } : {}) };
          };
          return collect(document.body);
        });
        await atomicJson(join(output, `inspect-${kind}.json`), { source_url: current, captured_at: new Date().toISOString(), structure });
      };
      await capture('list');
      const terminal = createInterface({ input: process.stdin, output: process.stdout });
      await terminal.question('List structure saved locally. Opening a topic may mark it read. To capture one sample, open your chosen topic in this same browser tab, then press Enter. To stop without opening a topic, press Ctrl+C. ');
      terminal.close();
      await capture('topic');
      console.log(JSON.stringify({ output, inspection_only: true, files: ['inspect-list.json', 'inspect-topic.json'], bulk_started: false }));
      await context.close();
      context = undefined;
      process.exit(0);
    }
    stage = 'ADAPTER';
    const adapter = JSON.parse(await readFile(options.adapter ? resolve(options.adapter) : new URL('./basemail-adapter.json', import.meta.url), 'utf8'));
    load = async (pageUrl, kind) => {
      for (let attempt = 0; attempt < 3; attempt++) {
        let loadStep = 'navigate';
        try {
          await new Promise(r => setTimeout(r, delay * (attempt + 1)));
          const response = await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
          if (response && !response.ok()) throw new Error('HTTP_ERROR');
          loadStep = 'scope';
          const verified = safePageUrl(page.url(), url, kind === 'topic' ? new URL(pageUrl).searchParams.get('topicid') : null);
          if (!verified) throw new Error('REDIRECTED_OUTSIDE_SCOPE');
          loadStep = 'ready';
          if (kind === 'list') {
            await page.waitForSelector('a[href*="topicid="]', { timeout: 15000 });
            if (listFilter === 'all_topics') {
              loadStep = 'filter';
              const evidence = await showAllTopics(page);
              if (!evidence.confirmed) throw new Error('ALL_TOPICS_FILTER_NOT_CONFIRMED');
              const data = await page.evaluate(extractDom, { kind, adapter });
              return { ...data, filter_evidence: evidence };
            }
          }
          if (kind === 'topic') await page.waitForSelector(adapter.message, { timeout: 15000 });
          loadStep = 'extract';
          return await page.evaluate(extractDom, { kind, adapter });
        } catch (error) {
          const fixedReasons = ['HTTP_ERROR', 'LOGIN_REQUIRED', 'LOGIN_OR_REDIRECT', 'ALL_TOPICS_FILTER_NOT_CONFIRMED', 'ALL_TOPICS_FILTER_UPDATE_NOT_OBSERVED'];
          const networkCode = /net::(ERR_[A-Z_]{1,80})\b/.exec(String(error.message || ''))?.[1];
          const reason = networkCode || (fixedReasons.includes(error.code || error.message) ? error.code || error.message : error.name === 'TimeoutError' ? 'TIMEOUT' : 'FAILED');
          console.error(JSON.stringify({ event: 'page_retry', kind, attempt: attempt + 1, stage: loadStep, reason, error_type: ['Error','TimeoutError','TypeError','ReferenceError'].includes(error.name) ? error.name : 'Other' }));
          if (attempt === 2) throw (String(error.code || '').startsWith('ALL_TOPICS_FILTER_') ? error : new Error('PAGE_LOAD_FAILED'));
        }
      }
    };
  }
  stage = 'COLLECT';
  const result = await collectMailbox({ url, load, state, save, maxPages, maxTopics, listFilter, shallow: Boolean(options.shallow || maxTopics === 0) });
  console.log(JSON.stringify({ output, ...result.manifest }));
  process.exitCode = result.manifest.coverage_status === 'partial' ? 2 : 0;
} catch (error) {
  // Only fixed stage names and allowlisted failure classes reach stderr. Never
  // print browser exceptions: they can contain URLs, headers and profile paths.
  const network = ['ERR_NAME_NOT_RESOLVED', 'ERR_CONNECTION_TIMED_OUT', 'ERR_CONNECTION_REFUSED', 'ERR_CONNECTION_RESET', 'ERR_INTERNET_DISCONNECTED', 'ERR_CERT_AUTHORITY_INVALID', 'ERR_CERT_DATE_INVALID', 'ERR_SSL_PROTOCOL_ERROR', 'ERR_PROXY_CONNECTION_FAILED', 'ERR_TUNNEL_CONNECTION_FAILED', 'ERR_ABORTED'];
  const matched = network.find(code => String(error?.message || '').includes(`net::${code}`));
  const reason = matched || (error?.name === 'TimeoutError' ? 'TIMEOUT' : 'FAILED');
  console.error(JSON.stringify({ error_code: `STARTUP_${stage}_${reason}` }));
  if (stage === 'ACKNOWLEDGEMENT') console.error('Opening topics may mark them read. Accept this effect explicitly with --ack-read-state.');
  process.exitCode = 1;
} finally { await context?.close(); }
