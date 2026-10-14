// Re-run mode: the tool runs the project's own commands itself and grades against what happens now.
// The commands come only from receipts.config.json, which the person writes. Never from the transcript.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FALSE, PROVEN, parseTestSummary } from './check.js';

export const CONFIG = 'receipts.config.json';
const KINDS = ['test', 'build', 'lint', 'typecheck'];

export function loadConfig(repo) {
  if (!repo) return null;
  const file = join(repo, CONFIG);
  if (!existsSync(file)) return null;
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`${file} is not valid JSON`);
  }
  const commands = {};
  for (const k of KINDS) if (typeof cfg.commands?.[k] === 'string' && cfg.commands[k].trim()) commands[k] = cfg.commands[k];
  return { commands, timeoutSec: Number(cfg.timeoutSec) > 0 ? Number(cfg.timeoutSec) : 300, rerun: cfg.rerun !== false };
}

// `receipts init`: propose a config from the scripts in package.json. The person reads it before it is used.
export function initConfig(repo) {
  const file = join(repo, CONFIG);
  if (existsSync(file)) return `${file} already exists. Nothing changed.`;
  const commands = {};
  const pkgFile = join(repo, 'package.json');
  if (existsSync(pkgFile)) {
    const scripts = JSON.parse(readFileSync(pkgFile, 'utf8')).scripts ?? {};
    if (scripts.test && !/no test specified/.test(scripts.test)) commands.test = 'npm test';
    if (scripts.build) commands.build = 'npm run build';
    if (scripts.lint) commands.lint = 'npm run lint';
    for (const k of ['typecheck', 'type-check', 'check-types']) if (scripts[k] && !commands.typecheck) commands.typecheck = `npm run ${k}`;
  }
  writeFileSync(file, JSON.stringify({ rerun: true, timeoutSec: 300, commands }, null, 2) + '\n');
  const listed = Object.entries(commands).map(([k, v]) => `  ${k}: ${v}`).join('\n') || '  (none found: add your own)';
  return `Wrote ${file}. These commands will be run to check your agent's claims:\n${listed}\nRead them and edit the file if they are not what you run.`;
}

// Grades the claims that a configured command can settle. Each command runs at most once.
export function rerunClaims(results, repo, cfg, run = runCommand) {
  const cache = new Map();
  return results.map((r) => {
    const kind = r.type === 'tests-pass' ? 'test' : r.type === 'command-ok' ? r.kind : null;
    const cmd = kind && cfg.commands[kind];
    if (!cmd) return r;
    if (!cache.has(kind)) cache.set(kind, run(cmd, repo, cfg.timeoutSec));
    const out = cache.get(kind);
    const how = `re-run now: \`${cmd}\` ${out.timedOut ? `timed out after ${cfg.timeoutSec}s` : `exited ${out.code}`} in ${out.seconds}s`;
    const rerun = { command: cmd, exitCode: out.code, seconds: out.seconds, timedOut: out.timedOut };
    if (out.timedOut || out.code !== 0) return { ...r, verdict: FALSE, why: `${how}; the session said: ${r.why}`, rerun };
    if (kind === 'test' && r.count !== null && r.count !== undefined) {
      const { passed } = parseTestSummary(out.output);
      if (passed !== null && passed >= 0 && passed !== r.count) return { ...r, verdict: FALSE, why: `${how}, but ${passed} passed, not ${r.count}`, rerun };
    }
    return { ...r, verdict: PROVEN, why: how, rerun };
  });
}

export function runCommand(cmd, repo, timeoutSec) {
  const t0 = Date.now();
  const res = spawnSync('sh', ['-c', cmd], {
    cwd: repo,
    encoding: 'utf8',
    timeout: timeoutSec * 1000,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CI: process.env.CI ?? '1', FORCE_COLOR: '0' },
  });
  return {
    code: res.status ?? -1,
    timedOut: res.error?.code === 'ETIMEDOUT' || res.signal === 'SIGTERM',
    seconds: ((Date.now() - t0) / 1000).toFixed(1),
    output: `${res.stdout ?? ''}\n${res.stderr ?? ''}`,
  };
}
