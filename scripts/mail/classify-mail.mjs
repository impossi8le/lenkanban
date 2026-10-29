#!/usr/bin/env node
import { createReadStream } from 'node:fs';
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { resolve, join } from 'node:path';
import { buildReport, renderMarkdown, renderCsv, evaluateClassifier } from './classifier-core.mjs';

async function readNdjson(path, optional = false) {
  const rows = [];
  const input = createReadStream(path, { encoding: 'utf8' });
  const reader = createInterface({ input, crlfDelay: Infinity });
  let line = 0;
  try {
    for await (const value of reader) {
      line++;
      const text = value.replace(/^\uFEFF/, '').trim();
      if (!text) continue;
      let item;
      try { item = JSON.parse(text); } catch { throw new Error(`INVALID_NDJSON line ${line}`); }
      if (!item || Array.isArray(item) || typeof item !== 'object') throw new Error(`INVALID_RECORD line ${line}`);
      rows.push(item);
    }
  } catch (error) { if (!(optional && error.code === 'ENOENT')) throw error; }
  return rows;
}

try {
  const args = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help') { options.help = true; continue; }
    if (!['--input', '--output', '--evaluate'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('INVALID_ARGUMENTS');
    options[args[i].slice(2)] = args[++i];
  }
  if (options.help) {
    console.log('node scripts/mail/classify-mail.mjs [--input .mail-work/run] [--output .mail-work/run/report] [--evaluate labeled-samples.json]');
  } else if (options.evaluate) {
    const samples = JSON.parse(await readFile(resolve(options.evaluate), 'utf8'));
    const evaluation = evaluateClassifier(samples);
    console.log(JSON.stringify(evaluation, null, 2));
    process.exitCode = evaluation.thresholds_passed ? 0 : 2;
  } else {
    const input = resolve(options.input || '.mail-work/run'), output = resolve(options.output || join(input, 'report'));
    let manifest;
    try { manifest = JSON.parse((await readFile(join(input, 'manifest.json'), 'utf8')).replace(/^\uFEFF/, '')); }
    catch (error) { if (error.code === 'ENOENT') manifest = {}; else throw new Error('INVALID_MANIFEST'); }
    if (!manifest || Array.isArray(manifest) || typeof manifest !== 'object') throw new Error('INVALID_MANIFEST');
    const [messages, topics] = await Promise.all([readNdjson(join(input, 'messages.ndjson')), readNdjson(join(input, 'topics.ndjson'), true)]);
    const report = buildReport(messages, topics, manifest);
    await mkdir(output, { recursive: true });
    for (const [name, content] of [
      ['report.json', JSON.stringify(report, null, 2) + '\n'],
      ['report.md', renderMarkdown(report)],
      ['report.csv', renderCsv(report)],
    ]) {
      await writeFile(join(output, `${name}.tmp`), content, { encoding: 'utf8', mode: 0o600 });
      await rename(join(output, `${name}.tmp`), join(output, name));
    }
    console.log(JSON.stringify({ output, coverage_status: report.coverage.coverage_status, counts: report.counts }));
    // Incomplete archive is an expected result, but must remain detectable by automation.
    process.exitCode = report.coverage.coverage_status === 'complete' ? 0 : 2;
  }
} catch (error) {
  const code = /^(INVALID_[A-Z_]+)(?: line (\d+))?$/.exec(error.message);
  console.error(code ? code[0] : 'CLASSIFICATION_FAILED: check local input paths and file permissions; message content is not logged.');
  process.exitCode = 1;
}
