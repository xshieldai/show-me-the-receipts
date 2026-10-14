// Checks each claim against the session's record and the working tree.
// Verdicts: PROVEN · FALSE · STALE · NO RECEIPT.
// FALSE needs a contradicting line that can be shown. When in doubt: NO RECEIPT.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, isAbsolute, join, relative } from 'node:path';

export const PROVEN = 'PROVEN';
export const FALSE = 'FALSE';
export const STALE = 'STALE';
export const NO_RECEIPT = 'NO RECEIPT';

const TEST_CMD = /(?:^|[\s;&|(])(?:npm\s+(?:run\s+)?test|yarn\s+(?:run\s+)?test|pnpm\s+(?:run\s+)?test|bun\s+(?:run\s+)?test|npx\s+(?:jest|vitest|mocha|playwright\s+test)|jest|vitest(?:\s+run)?|mocha|node\s+--test|deno\s+test|(?:python3?\s+-m\s+)?pytest|go\s+test|cargo\s+test|mvn\s+(?:\S+\s+)*test|gradlew?\s+test|rspec|phpunit|tox|make\s+(?:\S+\s+)*test|ctest|dotnet\s+test|(?:node|bun|deno|tsx|ts-node)\s+(?:--\S+\s+)*\S*[\w-]\.(?:test|spec)\.[cm]?[jt]sx?|python3?\s+(?:-I\s+)?\S*test_\w+\.py|\S*\.(?:test|spec)\.sh)(?![\w.])/;

const KIND_CMD = {
  build: /(?:^|[\s;&|(])(?:(?:npm|yarn|pnpm|bun)\s+(?:run\s+)?build|tsc(?!\s+--noEmit)|vite\s+build|next\s+build|webpack|esbuild|rollup|cargo\s+build|go\s+build|mvn\s+(?:\S+\s+)*(?:package|install|compile)|gradlew?\s+build|make(?:\s|$)|dotnet\s+build)\b/,
  lint: /(?:^|[\s;&|(])(?:(?:npm|yarn|pnpm|bun)\s+(?:run\s+)?lint|eslint|biome\s+(?:lint|check)|ruff|flake8|pylint|cargo\s+clippy|golangci-lint|rubocop|stylelint)\b/,
  typecheck: /(?:^|[\s;&|(])(?:(?:npm|yarn|pnpm|bun)\s+(?:run\s+)?(?:typecheck|type-check|check-types|tsc)|tsc|mypy|pyright|vue-tsc)\b/,
};

const ERROR_MARKERS = /\berror TS\d+|\bSyntaxError\b|\bERR!|\berror\[E\d+\]|^\s*error:|Build failed|Compilation failed|\b[1-9]\d*\s+errors?\b(?!\s*,?\s*0)/im;

// Files whose change after a test run does not make the run stale.
const NOT_CODE = /\.(md|mdx|txt|rst|adoc|png|jpe?g|gif|svg|webp)$|(^|\/)(docs?|\.receipts)\//i;

export function checkClaims(claims, events, finalIndex, opts = {}) {
  const repo = opts.repo ?? null;
  const before = events.slice(0, finalIndex);
  return claims.map((claim) => {
    switch (claim.type) {
      case 'tests-pass': return { ...claim, ...checkTests(claim, before) };
      case 'command-ok': return { ...claim, ...checkCommand(claim, before) };
      case 'file-changed': return { ...claim, ...checkFile(claim, before, repo) };
      case 'wired': return { ...claim, ...checkWired(claim, repo) };
      default: return { ...claim, verdict: NO_RECEIPT, why: 'unknown claim type' };
    }
  });
}

// ---------- C1 tests pass ----------

export function parseTestSummary(text) {
  let passed = null;
  let failed = null;
  const take = (re, set) => {
    const all = [...text.matchAll(re)];
    if (all.length) set(Number(all[all.length - 1][1]));
  };
  take(/#\s*pass\s+(\d+)/gi, (n) => (passed = n));
  take(/#\s*fail\s+(\d+)/gi, (n) => (failed = n));
  if (passed === null) take(/(\d+)\s+(?:tests?\s+)?(?:passed|passing|pass)\b/gi, (n) => (passed = n));
  if (failed === null) take(/(\d+)\s+(?:tests?\s+)?(?:failed|failing|fail)\b/gi, (n) => (failed = n));
  if (failed === null && /^(?:FAIL\b|--- FAIL:|FAILED\b)/m.test(text)) failed = 1;
  if (passed === null && failed === null && /^ok\s+\S+/m.test(text) && !/^FAIL/m.test(text)) passed = -1; // go test: ok, count unknown
  return { passed, failed };
}

function checkTests(claim, before) {
  const runs = before
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => e.kind === 'command' && TEST_CMD.test(e.command));
  if (!runs.length) return { verdict: NO_RECEIPT, why: 'no test command ran in this session' };

  const graded = runs.map(({ e, i }) => ({ e, i, ...gradeRun(e) }));
  const last = graded[graded.length - 1];

  if (last.outcome === 'failed') {
    return { verdict: FALSE, why: `the last test run failed (${last.detail})`, evidence: ev(last.e) };
  }
  if (last.outcome === 'unknown') {
    return { verdict: NO_RECEIPT, why: `the last test run gave no result that can be read (${last.detail})`, evidence: ev(last.e) };
  }

  let proof = last;
  if (claim.count !== null) {
    const match = [...graded].reverse().find((r) => r.outcome === 'passed' && r.passed === claim.count);
    if (match) proof = match;
    else if (last.passed !== null && last.passed >= 0) {
      return { verdict: FALSE, why: `claimed ${claim.count} passing, the last run shows ${last.passed} passed`, evidence: ev(last.e) };
    } else {
      return { verdict: NO_RECEIPT, why: `tests passed, but the count ${claim.count} cannot be read from the output`, evidence: ev(last.e) };
    }
  }
  return staleOr(proof, before, `${proof.detail}`);
}

function gradeRun(e) {
  const r0 = e.result;
  if (!r0) return { outcome: 'unknown', detail: 'no result recorded' };
  if (r0.backgrounded) return { outcome: 'unknown', detail: 'moved to the background, result never seen' };
  const r = withEchoedExit(e, r0);
  const { passed, failed } = parseTestSummary(r.text);
  if (r.exitCode !== null && r.exitCode !== 0) return { outcome: 'failed', passed, detail: `exit code ${r.exitCode}${failed ? `, ${failed} failed` : ''}` };
  if (failed && failed > 0) return { outcome: 'failed', passed, detail: `${failed} failed in the output${piped(e.command, r.text) ? ', the pipe hid the exit code' : ''}` };
  if (r.exitCode === 0 && (r.echoed || !piped(e.command, r.text))) return { outcome: 'passed', passed, detail: `exit code 0${passed > 0 ? `, ${passed} passed` : ''}` };
  if (passed !== null && passed !== 0 && failed === 0) return { outcome: 'passed', passed, detail: `${passed >= 0 ? passed + ' passed, ' : ''}0 failed in the output` };
  if (passed !== null && passed > 0 && failed === null) return { outcome: 'passed', passed, detail: `${passed} passed in the output` };
  return { outcome: 'unknown', detail: piped(e.command, r.text) ? 'the command was piped, so exit 0 belongs to the last command in the pipe, and the output shows no summary' : 'no summary in the output' };
}

// `cmd | tail; echo EXIT=${PIPESTATUS[0]}` prints the real exit code; trust it over the pipe's.
function withEchoedExit(e, r) {
  if (!/PIPESTATUS\[0\]|\$\?/.test(e.command)) return r;
  const all = [...r.text.matchAll(/\bEXIT[=:]\s*(\d+)\b/g)];
  if (!all.length) return r;
  return { ...r, exitCode: Number(all[0][1]), echoed: true };
}

function piped(cmd, output = '') {
  if (/[^|]\|[^|]/.test(cmd) && !/pipefail/.test(cmd)) return true;
  // `npm test` whose script pipes: npm echoes the script as "> node --test | tail -n 3", and its exit code is tail's.
  return /^> .*[^|]\|[^|]/m.test(output) && !/pipefail/.test(output);
}

// ---------- C2 build / lint / typecheck ----------

function checkCommand(claim, before) {
  const re = KIND_CMD[claim.kind];
  const runs = before.map((e, i) => ({ e, i })).filter(({ e }) => e.kind === 'command' && re.test(e.command));
  if (!runs.length) return { verdict: NO_RECEIPT, why: `no ${claim.kind} command ran in this session` };
  const { e, i } = runs[runs.length - 1];
  const r = e.result;
  if (!r || r.backgrounded) return { verdict: NO_RECEIPT, why: 'the result of the last run was never seen', evidence: ev(e) };
  if (r.exitCode !== null && r.exitCode !== 0) return { verdict: FALSE, why: `the last ${claim.kind} run exited ${r.exitCode}`, evidence: ev(e) };
  const marker = ERROR_MARKERS.exec(r.text);
  if (marker && claim.scoped) {
    const edited = new Set(before.flatMap(writtenFiles));
    const bad = errorFiles(r.text);
    const ours = bad.filter((f) => [...edited].some((p) => samePath(p, f)));
    if (bad.length && !ours.length) {
      return { verdict: NO_RECEIPT, why: `errors were printed, but only in files this session did not edit (${bad.slice(0, 2).map((f) => basename(f)).join(', ')}); the run does not show the edited files alone`, evidence: ev(e) };
    }
  }
  if (marker) return { verdict: FALSE, why: `the last ${claim.kind} run printed "${marker[0].trim()}"`, evidence: ev(e) };
  if (r.exitCode === 0 && !piped(e.command, r.text)) return staleOr({ e, i }, before, 'exit code 0');
  return { verdict: NO_RECEIPT, why: 'the command was piped and its output shows no error, but its own exit code was not seen', evidence: ev(e) };
}

function errorFiles(text) {
  const out = new Set();
  for (const m of text.matchAll(/^\s*([\w./@-]+\.\w+)(?:\(\d+,\d+\)|:\d+(?::\d+)?)\s*:?\s*(?:-\s*)?error\b/gim)) out.add(m[1]);
  return [...out];
}

export function samePath(a, b) {
  if (!a || !b) return false;
  const x = a.replace(/^\.\//, '');
  const y = b.replace(/^\.\//, '');
  return x === y || x.endsWith('/' + y) || y.endsWith('/' + x);
}

function staleOr(proof, before, detail) {
  const later = [];
  for (const e of before.slice(proof.i + 1)) {
    for (const f of writtenFiles(e)) if (!NOT_CODE.test(f)) later.push(f);
  }
  const files = [...new Set(later)];
  if (files.length) {
    return { verdict: STALE, why: `passed (${detail}), then ${files.length} file(s) changed: ${files.slice(0, 3).map((f) => basename(f)).join(', ')}${files.length > 3 ? ' …' : ''}`, evidence: ev(proof.e) };
  }
  return { verdict: PROVEN, why: detail, evidence: ev(proof.e) };
}

// Files an event changed. Shell writes are recognised only in the plainest forms.
function writtenFiles(e) {
  if (e.kind === 'edit' && e.file && !(e.result && e.result.isError)) return [e.file];
  if (e.kind !== 'command') return [];
  const out = [];
  for (const m of e.command.matchAll(/(?:sed|perl)\s+-i\S*\s+(?:(?:-e\s+)?'[^']*'\s+|"[^"]*"\s+)+([^\s;&|]+)/g)) out.push(m[1]);
  for (const m of e.command.matchAll(/(?:^|[^>&2])>>?\s*([\w./@-]+\.\w+)/g)) if (!/^\/dev\//.test(m[1])) out.push(m[1]);
  for (const m of e.command.matchAll(/\btee\s+(?:-a\s+)?([\w./@-]+\.\w+)/g)) out.push(m[1]);
  return out;
}

// ---------- C3 file changed ----------

function checkFile(claim, before, repo) {
  const want = claim.file;
  const hit = (p) => samePath(p, want) || (!want.includes('/') && basename(p ?? '') === want);
  for (let i = before.length - 1; i >= 0; i--) {
    const e = before[i];
    if (writtenFiles(e).some(hit)) {
      return { verdict: PROVEN, why: e.kind === 'edit' ? `${e.tool} on ${e.file}` : 'a shell command wrote it', evidence: ev(e) };
    }
  }
  if (repo && !existsAnywhere(want, repo)) {
    return { verdict: FALSE, why: `no file named ${want} exists in ${repo}` };
  }
  return { verdict: NO_RECEIPT, why: `no edit to ${want} is in the session record` };
}

function existsAnywhere(file, repo) {
  if (existsSync(isAbsolute(file) ? file : join(repo, file))) return true;
  const files = gitFiles(repo);
  if (files === null) return true; // cannot tell, so do not call it false
  return files.some((p) => p === file || p.endsWith('/' + file) || basename(p) === basename(file));
}

// ---------- C4 wired / called ----------

function checkWired(claim, repo) {
  if (!repo) return { verdict: NO_RECEIPT, why: 'no repository to search' };
  const name = claim.symbol.split('.').pop();
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) return { verdict: NO_RECEIPT, why: 'not a plain name' };
  const lines = gitGrep(repo, name);
  if (lines === null) return { verdict: NO_RECEIPT, why: 'the repository could not be searched' };
  if (!lines.length) return { verdict: FALSE, why: `\`${name}\` appears nowhere in the repository` };

  const def = definitionPattern(name);
  const callers = lines.filter((l) => !def.test(l.text) && !/^\s*(\/\/|#|\*|\/\*)/.test(l.text) && !isTestFile(l.file));
  const defs = lines.filter((l) => def.test(l.text));
  const refs = callers.filter((l) => !defs.some((d) => d.file === l.file && d.n === l.n));

  if (claim.target) {
    const inTarget = refs.filter((l) => l.file === claim.target || l.file.endsWith('/' + claim.target) || basename(l.file) === basename(claim.target));
    if (inTarget.length) return { verdict: PROVEN, why: `used in ${inTarget[0].file}:${inTarget[0].n}`, evidence: { file: inTarget[0].file, line: inTarget[0].n } };
    return { verdict: FALSE, why: `\`${name}\` is never used in ${claim.target}` };
  }
  if (refs.length) {
    const r = refs.find((l) => !defs.some((d) => d.file === l.file)) ?? refs[0];
    return { verdict: PROVEN, why: `used in ${r.file}:${r.n}${refs.length > 1 ? ` and ${refs.length - 1} more` : ''}`, evidence: { file: r.file, line: r.n } };
  }
  return { verdict: FALSE, why: `\`${name}\` is defined but nothing outside tests uses it`, evidence: defs[0] ? { file: defs[0].file, line: defs[0].n } : undefined };
}

function definitionPattern(name) {
  const n = name.replace(/\$/g, '\\$');
  return new RegExp(
    `(?:function\\*?\\s+${n}\\b|(?:const|let|var|class|interface|type|enum|def|fn|func|struct)\\s+${n}\\b|^\\s*(?:export\\s+)?(?:async\\s+)?(?:public\\s+|private\\s+|static\\s+)*${n}\\s*\\([^)]*\\)\\s*(?::[^={]*)?\\{|^\\s*${n}\\s*[:=]\\s*(?:async\\s*)?(?:function|\\()|export\\s*\\{[^}]*\\b${n}\\b[^}]*\\}\\s*;?\\s*$)`
  );
}

function isTestFile(f) {
  return /(^|\/)(__tests__|tests?|spec)\/|\.(test|spec)\.[\w]+$|_test\.(go|py)$|^test_/.test(f);
}

// ---------- git helpers (arguments only, never a shell line) ----------

function git(repo, args) {
  try {
    return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (err) {
    if (err.status === 1 && typeof err.stdout === 'string') return err.stdout; // grep: no match
    return null;
  }
}

function gitFiles(repo) {
  const out = git(repo, ['ls-files', '--cached', '--others', '--exclude-standard']);
  return out === null ? null : out.split('\n').filter(Boolean);
}

function gitGrep(repo, name) {
  const out = git(repo, ['grep', '-n', '-w', '-I', '--untracked', '-F', '-e', name]);
  if (out === null) return null;
  return out.split('\n').filter(Boolean).map((l) => {
    const m = /^(.*?):(\d+):(.*)$/.exec(l);
    return m ? { file: m[1], n: Number(m[2]), text: m[3] } : null;
  }).filter(Boolean);
}

function ev(e) {
  return { line: e.line, command: e.command, tool: e.tool, file: e.file, exitCode: e.result?.exitCode ?? null };
}

export function repoRoot(dir) {
  if (!dir) return null;
  const out = git(dir, ['rev-parse', '--show-toplevel']);
  return out ? out.trim() : null;
}

export { relative };
