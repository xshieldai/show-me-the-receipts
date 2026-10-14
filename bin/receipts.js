#!/usr/bin/env node
// show-me-the-receipts: your agent says it's done. Show me the receipts.
// Exit codes: 0 every checkable claim proven · 1 a claim is FALSE · 2 none false, some STALE or NO RECEIPT · 3 broke.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { exitCodeFor, grade, latestTranscript, render } from '../src/index.js';

const HELP = `show-me-the-receipts: check what your coding agent says it did.

Usage:
  receipts last                 grade the newest Claude Code session for this directory
  receipts <transcript.jsonl>   grade one session transcript

Options:
  --repo <dir>   repository to search (default: the session's working directory)
  --json         print the result as JSON
  --save         also write .receipts/<session-id>.json in the repository
  --verbose      show the command behind each piece of evidence

Verdicts:
  PROVEN      the session shows it happened (evidence attached)
  FALSE       the session or the repository contradicts it
  STALE       it was true, then code changed after the proof
  NO RECEIPT  nothing proves or disproves it, so it is flagged, not believed

Exit codes: 0 all proven · 1 a claim is false · 2 stale or unproven · 3 broke`;

function main(argv) {
  const args = argv.slice(2);
  if (!args.length || args.includes('-h') || args.includes('--help')) {
    console.log(HELP);
    return 0;
  }
  const flag = (n) => args.includes(n);
  const value = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--repo');

  let path = positional[0];
  if (path === 'last') {
    path = latestTranscript();
    if (!path) {
      console.error(`No Claude Code sessions found for ${process.cwd()}.`);
      return 3;
    }
  }

  const report = grade(path, { repo: value('--repo') });
  const code = exitCodeFor(report.results);

  if (flag('--save') && report.repo) {
    const dir = join(report.repo, '.receipts');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${report.sessionId ?? 'session'}.json`);
    writeFileSync(file, JSON.stringify({ tool: 'show-me-the-receipts', checkedAt: new Date().toISOString(), transcript: path, exitCode: code, results: report.results, ungraded: report.ungraded }, null, 2) + '\n');
  }

  if (flag('--json')) console.log(JSON.stringify({ exitCode: code, ...report }, null, 2));
  else console.log(render(report, { color: process.stdout.isTTY && !process.env.NO_COLOR, verbose: flag('--verbose') }));
  return code;
}

try {
  process.exitCode = main(process.argv);
} catch (err) {
  console.error(`show-me-the-receipts broke: ${err.message}`);
  process.exitCode = 3;
}
