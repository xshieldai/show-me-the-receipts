// PR mode: grade the claims in a pull request's description against the pull request itself.
//   "Updated `x.ts`"      -> the PR's own diff
//   "`fn()` is wired in"  -> a search of the PR's code
//   tests / build / lint  -> re-run now, with the commands in the BASE branch's receipts.config.json
// The description is data. Nothing in it is ever run.

import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';
import { FALSE, NO_RECEIPT, PROVEN, checkWired, samePath } from './check.js';
import { extractClaims } from './claims.js';
import { CONFIG, rerunClaims } from './rerun.js';
import { emitReport } from './suite.js';

export const MARKER = '<!-- show-me-the-receipts -->';

export function gradePullRequest({ body, repo, base, head = 'HEAD', runCommand }) {
  const { claims, ungraded, hedged, bareDone, sentenceCount } = extractClaims(body ?? '');
  const changed = changedFiles(repo, base, head);
  let results = claims.map((claim) => {
    if (claim.type === 'file-changed') return { ...claim, ...checkChanged(claim, changed) };
    if (claim.type === 'wired') return { ...claim, ...checkWired(claim, repo) };
    return { ...claim, verdict: NO_RECEIPT, why: `no command configured: add "${claim.type === 'tests-pass' ? 'test' : claim.kind}" to ${CONFIG} on the base branch` };
  });
  const cfg = baseConfig(repo, base);
  const reran = Boolean(cfg && cfg.rerun && Object.keys(cfg.commands).length);
  if (reran) results = rerunClaims(results, repo, cfg, runCommand);
  const report = { results, ungraded, hedged, bareDone, sentenceCount, reran, changedCount: changed?.length ?? null };
  emitReport(report, { source: 'pull_request' });
  return report;
}

function checkChanged(claim, changed) {
  if (changed === null) return { verdict: NO_RECEIPT, why: 'the pull request diff could not be read (check out with fetch-depth: 0)' };
  const hit = changed.find((p) => samePath(p, claim.file) || (!claim.file.includes('/') && basename(p) === claim.file));
  if (hit) return { verdict: PROVEN, why: `changed in this pull request: ${hit}` };
  return { verdict: FALSE, why: `${claim.file} is not changed in this pull request` };
}

function git(repo, args) {
  try {
    return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null;
  }
}

export function changedFiles(repo, base, head = 'HEAD') {
  if (!base) return null;
  const out = git(repo, ['diff', '--name-only', `${base}...${head}`]);
  return out === null ? null : out.split('\n').filter(Boolean);
}

// The commands come from the base branch, so a pull request cannot change what is run to judge it.
export function baseConfig(repo, base) {
  if (!base) return null;
  const text = git(repo, ['show', `${base}:${CONFIG}`]);
  if (text === null) return null;
  let cfg;
  try { cfg = JSON.parse(text); } catch { return null; }
  const commands = {};
  for (const k of ['test', 'build', 'lint', 'typecheck']) if (typeof cfg.commands?.[k] === 'string' && cfg.commands[k].trim()) commands[k] = cfg.commands[k];
  return { commands, timeoutSec: Number(cfg.timeoutSec) > 0 ? Number(cfg.timeoutSec) : 300, rerun: cfg.rerun !== false };
}

const ICON = { PROVEN: '✅', FALSE: '❌', STALE: '🔁', 'NO RECEIPT': '❔' };

export function renderMarkdown(report, { runUrl } = {}) {
  const { results, ungraded, hedged = [], bareDone, sentenceCount, reran } = report;
  const lines = [MARKER, '### 🧾 show me the receipts', ''];
  if (!results.length) {
    lines.push(`No checkable claims in the pull request description (${sentenceCount} sentence(s) read). Nothing claimed is nothing proven: this is not a pass.`);
  } else {
    lines.push('| | claim | receipt |', '|---|---|---|');
    for (const r of results) lines.push(`| ${ICON[r.verdict]} **${r.verdict}** | ${cell(r.text)} | ${cell(r.why)} |`);
    const n = (v) => results.filter((r) => r.verdict === v).length;
    lines.push('', `${results.length} claim(s) checked from ${sentenceCount} sentence(s): ${n(PROVEN)} proven · ${n(FALSE)} false · ${n(NO_RECEIPT)} no receipt.`);
  }
  if (hedged.length) lines.push('', `Hedged, not checked and not believed: ${hedged.map((h) => `“${cell(h)}”`).join(' · ')}`);
  if (bareDone && !results.length) lines.push('', `It says it is done (“${cell(bareDone)}”) but names nothing that can be checked.`);
  lines.push('', `<sub>${reran ? 'Tests, build, lint and typecheck claims were settled by running the base branch’s configured commands on this pull request.' : `Add a \`${CONFIG}\` to the base branch to have test and build claims settled by running them.`} ${ungraded.length} sentence(s) were not checkable claims. ${runUrl ? `[Run](${runUrl}) · ` : ''}[show-me-the-receipts](https://github.com/xshieldai/show-me-the-receipts)</sub>`);
  return lines.join('\n');
}

function cell(s) {
  const t = String(s).replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
  return t.length > 160 ? t.slice(0, 157) + '…' : t;
}

export function shouldFail(results, failOn = 'false') {
  if (failOn === 'never') return false;
  if (failOn === 'no-receipt') return results.some((r) => r.verdict !== PROVEN);
  return results.some((r) => r.verdict === FALSE);
}
