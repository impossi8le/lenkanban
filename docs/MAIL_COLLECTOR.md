# Basemail collector

Local, read-only navigation collector for the **All** topic list. It never sends, deletes, moves or deliberately marks mail read. Opening a topic may itself mark it read in Basemail; the live runner requires `--ack-read-state` to acknowledge this known uncertainty. It does not download attachment bytes.

## Run

Live collection now defaults to **all topics**, activating the real `#basemail_showall` control with Enter when its label is `Показать все темы`. The floating right sidebar can overlap mouse clicks. The collector waits for `Скрыть все темы` **and updated topic IDs or pagination** before extracting the list. An already active `Скрыть все темы` control is never toggled off. Each list navigation verifies this state again. An absent control or unobserved update fails conservatively and leaves the page unfinished. `--visible-topics` explicitly requests the filtered visible list instead.

Use a **new output directory** such as `.mail-work/full-mail-2026-10-20` for this full scope. The previous two-topic run used a filtered list; it does not show an account permission restriction. Checkpoints now include `list_filter`; full-scope resume refuses older or differently filtered checkpoints. Offline imports retain `observed` scope and do not claim to have activated the live control.

Install the standalone tools from the project root (Node.js 24):

```powershell
npm ci --prefix scripts/mail
npm exec --prefix scripts/mail -- playwright install chromium
node scripts/mail/collect-basemail.mjs --help
node --test tests/mail/*.test.mjs
node scripts/mail/collect-basemail.mjs --url "https://mail.example.invalid/" --output .mail-work/run --profile .mail-work/browser-profile --login --headed --ack-read-state --max-pages 1 --max-topics 2
```

The first live invocation opens a **dedicated persistent browser profile**. Sign in directly in its browser window and press Enter in the terminal once the All list is visible. Do not paste credentials into the terminal. The collector does not extract credentials or cookies from another browser. Playwright Chromium must already be available. Close other processes using this dedicated profile before starting. Keep `.mail-work/` private and outside version control, including the authenticated profile and all raw content.

After inspecting a small sample and its manifest, repeat with the same output and profile and omit the two limits to continue. The initial list scope must remain identical. Existing completed topic records are not refreshed: use a new output directory for a new snapshot. A source mailbox can change during a long crawl, so reconciliation against an authoritative server total remains necessary.

The example URL is synthetic. Supply the authorized deployment URL locally; do not commit working mail URLs.

## Inspect the real layout without starting bulk collection

```powershell
node scripts/mail/collect-basemail.mjs --url "https://mail.example.invalid/" --output .mail-work/inspection --profile .mail-work/browser-profile --login --inspect
```

Sign in directly in the dedicated browser, make the All list visible, then press Enter in the terminal. The script saves `inspect-list.json` locally. It then pauses while **you choose and open one sample topic in the same browser tab**. Opening that sample may mark it read; the prompt explains this before you act. Press Enter to save `inspect-topic.json`, or Ctrl+C to stop before opening a sample. No automatic topic navigation or bulk collection occurs in inspection mode, so `--ack-read-state` is not required.

The files contain the rendered DOM structure with tag names, classes, IDs, selected message/post/comment ID attributes and visible direct text. Form controls, hidden DOM, scripts, cookies, browser storage and session internals are excluded. The files can contain private mail text: keep them local in `.mail-work/`, and use them to identify real message/body/author/date/attachment selectors before supplying the adapter. Inspection never uploads these files.

## DOM adapter and current verification limit

List extraction uses observed Basemail topic links ending in `#add_post_form_link` with `topicid`, excluding `Читать далее` excerpt links, plus observed `page` links. It reads the displayed `Сообщений: N` from the topic link's surrounding `tbody` as a message-count hint. It follows only same-origin, same-path URLs in `folder=all`, with the allowlisted read-page parameters `folder`, `folderid`, `topicid`, and `page`. It never invents private API endpoints or numbered page URLs.

The bundled [basemail-adapter.json](../scripts/mail/basemail-adapter.json) loads by default. Its selectors were checked against two accessible topics containing two messages; see [live validation](MAIL_LIVE_VALIDATION.md). This does not validate the historic archive or pagination. After manual sign-in, the independent Playwright network run collected two accessible topics and two messages without errors or fallback IDs; full-archive coverage remains unverified. `--channel chrome` or `--channel msedge` selects an already installed browser instead of the bundled Chromium. To support a different confirmed layout, pass `--adapter` with a local JSON selector file:

```json
{
  "message": "SELECTOR_FOR_EACH_MESSAGE_CONTAINER",
  "idAttribute": "ATTRIBUTE_CONTAINING_SOURCE_MESSAGE_ID",
  "body": "SELECTOR_FOR_BODY_WITHIN_CONTAINER",
  "author": "SELECTOR_FOR_AUTHOR_WITHIN_CONTAINER",
  "date": "SELECTOR_FOR_DATE_WITHIN_CONTAINER",
  "attachments": "SELECTOR_FOR_ATTACHMENT_ANCHORS_WITHIN_CONTAINER"
}
```

Only `message` and `body` are mandatory. Missing source IDs get an explicit page-position fallback, never a body-text hash. This fallback distinguishes identical texts but is not stable when source ordering changes, and it cannot deduplicate the same source message repeated on overlapping pages. Do not claim complete identity reconciliation when fallback identities exist. Dates remain the displayed source text; no timezone is guessed. Links are recorded as `linked_not_downloaded`, without probing external attachment hosts.

Unsupported layouts, failed pages and identity conflicts produce a `partial` manifest and exit code 2. Exhausting observed links produces `unverified`, never an unsupported assertion that all source mail was captured. Exit code 1 indicates startup/input failure. A successful traversal does not prove the meaning of a sidebar counter or the absence of hidden pagination. The adapter and all-topic traversal must be validated on real samples before the bulk run.

## Local outputs and resume

- `messages.ndjson`: source instance, exact source ID, topic ID, source URL, title, body, displayed date/author, attachment links, content status, identity method and collection timestamp.
- `topics.ndjson`: discovered unique topic IDs, titles, URLs, nullable message-count hint, traversal progress.
- `checkpoint.json`: atomic progress snapshot, including pending list/topic pages, a message-log row count and SHA-256 prefix watermark, and locally preserved identity-conflict variants; raw primary messages live in the append log.
- `manifest.json`: scope, snapshot time, separate topic/message counts, errors, failures, unfinished pages/topics and conservative coverage status.
- `progress.json`: count-only progress saved on traversal updates, at most once per five seconds plus finalization (not a heartbeat during a stalled navigation), including discovery/collection phase, visited/pending list pages, topics, messages, error count and termination flag. No message text or credentials are included.

The checkpoint and manifest also retain per-list `filter_observations`: action, before/after topic counts, pagination link count and confirmed scope. Sidebar counts are source hints, not an independent proof that every message was collected.

Messages append after each page; progress snapshots save every 100 updates and at normal termination. This bounds disk writes for a large mailbox. An interrupted run may replay up to 99 progress updates; existing message IDs loaded from the append log prevent duplicate output. Each checkpoint records the durable append-log row count and SHA-256 of that prefix. Resume refuses a missing log, fewer rows than the checkpoint, an unfinished last line, or an altered checkpoint prefix before writing progress. Legacy checkpoints without a watermark are refused; retain them for inspection and start a fresh output directory rather than guessing their integrity. Valid rows appended after the last checkpoint are rehydrated before pending pages replay. These checks detect local loss or alteration relative to the checkpoint; they do not prove source-mail completeness. Failed list pages remain pending; failed topics are retried. Source IDs are deduplicated by `(source_instance, source_message_id)`, retaining exact ID strings. Different source IDs with identical bodies remain separate messages. Duplicate IDs are compared across topic ID, title, body, displayed date, author, attachments and content status with canonical object-key order; source URL and collection time are excluded. Any meaningful mismatch produces `SOURCE_ID_CONTENT_CONFLICT` and `partial` coverage. The original primary row remains in `messages.ndjson`; distinct alternatives are retained in `checkpoint.json.message_conflicts` with both original and variant. Manifest `identity_conflict_variants` counts these alternatives separately, without inflating `collected_unique_messages`. Progress snapshots preserve conflicts at the same checkpoint cadence as traversal progress.

## Offline import

For captured DOM extraction results, use `--import .mail-work/snapshots.json`; no browser starts and no read-state acknowledgement is necessary. The JSON format is:

```json
{
  "pages": [
    {"url":"https://mail.example.test/basemail.php?folder=all","kind":"list","data":{"recognized":true,"topics":[{"topic_id":"1","title":"Synthetic","source_url":"https://mail.example.test/basemail.php?folder=all&topicid=1"}],"page_links":[]}},
    {"url":"https://mail.example.test/basemail.php?folder=all&topicid=1","kind":"topic","data":{"recognized":true,"messages":[{"source_message_id":"100","body_text":"Synthetic body"}],"page_links":[]}}
  ]
}
```

Pass the matching `--url`, and use a fresh output directory. Import accepts structured DOM results, not arbitrary HTML or email archives. It makes traversal and downstream processing reproducible without network access. Only synthetic fixtures belong in the repository.
