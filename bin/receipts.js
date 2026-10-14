#!/usr/bin/env node
// show-me-the-receipts: your agent says it's done. Show me the receipts.
// Exit codes: 0 every checkable claim proven · 1 a claim is FALSE · 2 none false, some STALE or NO RECEIPT · 3 broke.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readHookInput, runStopHook } from '../src/hook.js';
import { exitCodeFor, grade, jsonlBus, latestTranscript, render, setEventBus, toHanumanG } from '../src/index.js';
import { install } from '../src/install.js';
import { initConfig } from '../src/rerun.js';

const HELP = `show-me-the-receipts: check what your coding agent says it did.

Usage:
  receipts last                 grade the newest Claude Code session for this directory
  receipts <transcript.jsonl>   grade one session transcript
  receipts init                 write receipts.config.json: the commands to re-run (read it after)
  receipts install [--user]     add the Stop hook to .claude/settings.json (or ~/.claude with --user)
  receipts hook [--strict]      run as a Claude Code Stop hook (reads the hook's JSON on stdin)

Options:
  --repo <dir>   repository to search (default: the session's working directory)
  --json         print the result as JSON
  --save         also write .receipts/<session-id>.json in the repository
  --verbose      show the command behind each piece of evidence
  --no-rerun     do not re-run the commands in receipts.config.json
  --hanumang     print the @xshieldai/hanumang-mandate axis fields this check measured, as JSON
  --acc-log <f>  append every graded claim to <f> as Agentic Control Center receipts (JSON lines);
                 the RECEIPTS_ACC_LOG environment variable does the same, also for the hook
  --strict       a hedged claim ("should pass") or a bare "done" counts as NO RECEIPT

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
  const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--repo' && args[i - 1] !== '--acc-log');
  const accLog = value('--acc-log') ?? process.env.RECEIPTS_ACC_LOG;
  if (accLog) setEventBus(jsonlBus(accLog));

  if (positional[0] === 'hook') {
    const { stdout, code } = runStopHook(readHookInput(), { strict: flag('--strict') });
    if (stdout) process.stdout.write(stdout + '\n');
    return code;
  }
  if (positional[0] === 'init') {
    console.log(initConfig(process.cwd()));
    return 0;
  }
  if (positional[0] === 'install') {
    console.log(install({ user: flag('--user'), strict: flag('--strict') }));
    return 0;
  }

  let path = positional[0];
  if (path === 'last') {
    path = latestTranscript();
    if (!path) {
      console.error(`No Claude Code sessions found for ${process.cwd()}.`);
      return 3;
    }
  }

  const report = grade(path, { repo: value('--repo'), rerun: flag('--no-rerun') ? false : undefined, strict: flag('--strict') });
  const code = exitCodeFor(report.results);

  if (flag('--save') && report.repo) {
    const dir = join(report.repo, '.receipts');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${report.sessionId ?? 'session'}.json`);
    writeFileSync(file, JSON.stringify({ tool: 'show-me-the-receipts', checkedAt: new Date().toISOString(), transcript: path, exitCode: code, results: report.results, ungraded: report.ungraded }, null, 2) + '\n');
  }

  if (flag('--hanumang')) {
    console.log(JSON.stringify(toHanumanG(report), null, 2));
    return code;
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
