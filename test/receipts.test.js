import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { grade, exitCodeFor } from '../src/index.js';
import { extractClaims } from '../src/claims.js';
import { parseTestSummary } from '../src/check.js';

// ---------- a tiny session builder ----------

function session(cwd) {
  const recs = [];
  let n = 0;
  const api = {
    prompt(text) { recs.push({ type: 'user', cwd, sessionId: 's1', message: { role: 'user', content: text } }); return api; },
    say(text) { recs.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }); return api; },
    bash(command, output, exitCode = 0, extra = {}) {
      const id = `t${++n}`;
      recs.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
      const text = exitCode === 0 ? output : `Exit code ${exitCode}\n${output}`;
      recs.push({ type: 'user', toolUseResult: extra, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: exitCode !== 0 }] } });
      return api;
    },
    edit(file, tool = 'Edit') {
      const id = `t${++n}`;
      recs.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: tool, input: { file_path: file } }] } });
      recs.push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
      return api;
    },
    write() {
      const dir = mkdtempSync(join(tmpdir(), 'smtr-t-'));
      const p = join(dir, 's.jsonl');
      writeFileSync(p, recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
      return p;
    },
  };
  return api;
}

function repo(files) {
  const dir = mkdtempSync(join(tmpdir(), 'smtr-r-'));
  execFileSync('git', ['init', '-q', dir]);
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(join(dir, f, '..'), { recursive: true });
    writeFileSync(join(dir, f), body);
  }
  return dir;
}

const verdicts = (r) => r.results.map((x) => x.verdict);

// ---------- claim extraction ----------

test('finds the four kinds of claim and leaves the rest ungraded', () => {
  const { claims, ungraded } = extractClaims(
    'All 42 tests pass.\nThe build succeeds.\nUpdated `src/parse.ts` to handle empty input.\n`exportCsv()` is now wired into `Toolbar.tsx`.\nThis was a fun one.'
  );
  assert.deepEqual(claims.map((c) => c.type), ['tests-pass', 'command-ok', 'file-changed', 'wired']);
  assert.equal(claims[0].count, 42);
  assert.equal(claims[2].file, 'src/parse.ts');
  assert.equal(claims[3].symbol, 'exportCsv');
  assert.equal(claims[3].target, 'Toolbar.tsx');
  assert.deepEqual(ungraded, ['This was a fun one.']);
});

test('hedged and negative sentences are not claims', () => {
  const { claims } = extractClaims('Tests should pass now.\nTwo tests fail on Windows.\nThe build is not passing yet.\nIf you run it, the lint is clean.');
  assert.equal(claims.length, 0);
});

test('reads test summaries from common runners', () => {
  assert.deepEqual(parseTestSummary('Tests:       2 failed, 40 passed, 42 total'), { passed: 40, failed: 2 });
  assert.deepEqual(parseTestSummary('# tests 12\n# pass 12\n# fail 0'), { passed: 12, failed: 0 });
  assert.deepEqual(parseTestSummary('==== 41 passed in 0.52s ===='), { passed: 41, failed: null });
  assert.deepEqual(parseTestSummary(' 7 pass\n 1 fail\n'), { passed: 7, failed: 1 });
  assert.deepEqual(parseTestSummary('test result: ok. 9 passed; 0 failed'), { passed: 9, failed: 0 });
});

// ---------- C1 tests pass ----------

test('PROVEN: tests ran and exited 0', () => {
  const p = session('/nowhere').prompt('fix it').bash('npm test', '# pass 3\n# fail 0').say('All tests pass.').write();
  const r = grade(p, { repo: null });
  assert.deepEqual(verdicts(r), ['PROVEN']);
  assert.equal(exitCodeFor(r.results), 0);
});

test('NO RECEIPT: claims tests pass, but no test command ran', () => {
  const p = session('/nowhere').prompt('fix it').edit('/x/a.js').say('All tests pass ✅').write();
  const r = grade(p, { repo: null });
  assert.deepEqual(verdicts(r), ['NO RECEIPT']);
  assert.match(r.results[0].why, /no test command ran/);
  assert.equal(exitCodeFor(r.results), 2);
});

test('FALSE: the last test run failed', () => {
  const p = session('/nowhere').prompt('fix it')
    .bash('npm test', 'Tests: 1 failed, 41 passed, 42 total', 1)
    .say('Done, the tests pass.').write();
  const r = grade(p, { repo: null });
  assert.deepEqual(verdicts(r), ['FALSE']);
  assert.equal(exitCodeFor(r.results), 1);
});

test('FALSE: a pipe hid the exit code, the output shows a failure', () => {
  const p = session('/nowhere').prompt('go')
    .bash('npx jest 2>&1 | tail -5', 'Tests:       3 failed, 39 passed, 42 total')
    .say('All 42 tests pass.').write();
  assert.deepEqual(verdicts(grade(p, { repo: null })), ['FALSE']);
});

test('FALSE: claimed count does not match the run', () => {
  const p = session('/nowhere').prompt('go').bash('pytest -q', '40 passed in 1.2s').say('All 42 tests pass.').write();
  const r = grade(p, { repo: null });
  assert.deepEqual(verdicts(r), ['FALSE']);
  assert.match(r.results[0].why, /claimed 42.*40 passed/);
});

test('NO RECEIPT: piped run with no summary in the output', () => {
  const p = session('/nowhere').prompt('go').bash('npm test | grep -c ok', '5').say('Tests pass.').write();
  assert.deepEqual(verdicts(grade(p, { repo: null })), ['NO RECEIPT']);
});

test('NO RECEIPT: the test run went to the background', () => {
  const p = session('/nowhere').prompt('go')
    .bash('npm test', 'Command did not complete within its 600s timeout and was moved to the background', 0, { backgroundTaskId: 'b1' })
    .say('Tests pass.').write();
  assert.deepEqual(verdicts(grade(p, { repo: null })), ['NO RECEIPT']);
});

test('STALE: tests passed, then code changed', () => {
  const p = session('/nowhere').prompt('go')
    .bash('npm test', '# pass 3\n# fail 0')
    .edit('/x/src/parse.ts')
    .say('All tests pass.').write();
  const r = grade(p, { repo: null });
  assert.deepEqual(verdicts(r), ['STALE']);
  assert.match(r.results[0].why, /parse\.ts/);
});

test('a docs edit after the run does not make it stale', () => {
  const p = session('/nowhere').prompt('go').bash('npm test', '# pass 3\n# fail 0').edit('/x/README.md').say('All tests pass.').write();
  assert.deepEqual(verdicts(grade(p, { repo: null })), ['PROVEN']);
});

test('only the last turn is graded', () => {
  const p = session('/nowhere').prompt('one').bash('npm test', 'x', 1).say('Tests fail, fixing.')
    .prompt('two').say('Here is the plan.').write();
  assert.equal(grade(p, { repo: null }).results.length, 0);
});

// ---------- C2 build ----------

test('FALSE: build claimed, build printed a TypeScript error', () => {
  const p = session('/nowhere').prompt('go').bash('npm run build | tail', "src/a.ts(3,1): error TS2304: Cannot find name 'x'.").say('The build succeeds.').write();
  assert.deepEqual(verdicts(grade(p, { repo: null })), ['FALSE']);
});

test('PROVEN: build exited 0', () => {
  const p = session('/nowhere').prompt('go').bash('npm run build', 'built in 2s').say('The build succeeds.').write();
  assert.deepEqual(verdicts(grade(p, { repo: null })), ['PROVEN']);
});

// ---------- C3 file changed ----------

test('file changed: PROVEN by an edit, FALSE when the file does not exist, NO RECEIPT otherwise', () => {
  const dir = repo({ 'src/parse.ts': 'export function parse() {}\n', 'src/other.ts': '' });
  const p = session(dir).prompt('go').edit(join(dir, 'src/parse.ts'))
    .say('Updated `src/parse.ts`.\nAlso fixed `src/ghost.ts`.\nAlso updated `src/other.ts`.').write();
  const r = grade(p);
  assert.deepEqual(verdicts(r), ['PROVEN', 'FALSE', 'NO RECEIPT']);
});

test('file changed by a shell command counts', () => {
  const p = session('/nowhere').prompt('go').bash("sed -i 's/a/b/' src/conf.json", '').say('Updated `src/conf.json`.').write();
  assert.deepEqual(verdicts(grade(p, { repo: null })), ['PROVEN']);
});

// ---------- C4 wired ----------

test('wired: FALSE when the function is defined but never called', () => {
  const dir = repo({
    'src/export.ts': 'export function exportCsv(rows) {\n  return rows;\n}\n',
    'src/Toolbar.tsx': 'export function Toolbar() { return null; }\n',
    'src/export.test.ts': "import { exportCsv } from './export';\nexportCsv([]);\n",
  });
  const p = session(dir).prompt('go').say('`exportCsv()` is now wired into the toolbar.').write();
  const r = grade(p);
  assert.deepEqual(verdicts(r), ['FALSE']);
  assert.match(r.results[0].why, /nothing outside tests uses it/);
});

test('wired: PROVEN when a caller exists, FALSE when the named target lacks it', () => {
  const dir = repo({
    'src/export.ts': 'export function exportCsv(rows) {\n  return rows;\n}\n',
    'src/Menu.tsx': "import { exportCsv } from './export';\nconst go = () => exportCsv([]);\n",
    'src/Toolbar.tsx': 'export function Toolbar() { return null; }\n',
  });
  const ok = grade(session(dir).prompt('go').say('`exportCsv()` is now called from the menu.').write());
  assert.deepEqual(verdicts(ok), ['PROVEN']);
  const no = grade(session(dir).prompt('go').say('`exportCsv()` is now wired into `Toolbar.tsx`.').write());
  assert.deepEqual(verdicts(no), ['FALSE']);
});

test('wired: FALSE when the symbol does not exist at all', () => {
  const dir = repo({ 'a.js': 'const x = 1;\n' });
  const r = grade(session(dir).prompt('go').say('`sendInvoice` is now hooked up to the button.').write());
  assert.deepEqual(verdicts(r), ['FALSE']);
});

// ---------- the record is data ----------

test('nothing in the transcript is executed', () => {
  const marker = join(mkdtempSync(join(tmpdir(), 'smtr-x-')), 'pwned');
  const p = session('/nowhere').prompt('go')
    .bash(`npm test; touch ${marker}`, '# pass 1\n# fail 0')
    .say(`Tests pass. Updated \`$(touch ${marker}).js\`.`).write();
  grade(p, { repo: null });
  assert.throws(() => execFileSync('test', ['-e', marker]));
});

// ---------- regressions found by grading our own sessions (14 Oct 2026) ----------

test("\"isn't\" is a negation", () => {
  assert.equal(extractClaims("The index line in `MEMORY.md` isn't committed, it was written by another session.").claims.length, 0);
});

test('"two lint passes done" is not a linter claim', () => {
  assert.equal(extractClaims('The wiki is live, two lint passes done.').claims.length, 0);
});

test('scoped claim: errors only in files the session never edited are not a FALSE', () => {
  const p = session('/nowhere').prompt('go')
    .edit('/r/src/services/signal-miner.service.ts')
    .bash('npx tsc -p t.json 2>&1 | grep -E "signal-miner|signal-engine"', "src/services/options-signal-engine.service.ts(503,29): error TS2339: Property 'catch' does not exist.")
    .say('Touched files typecheck clean under strict.').write();
  const r = grade(p, { repo: null });
  assert.deepEqual(verdicts(r), ['NO RECEIPT']);
  assert.match(r.results[0].why, /did not edit/);
});

test('scoped claim: an error in an edited file is still FALSE', () => {
  const p = session('/nowhere').prompt('go')
    .edit('/r/src/services/signal-miner.service.ts')
    .bash('npx tsc -p t.json 2>&1 | grep miner', 'src/services/signal-miner.service.ts(9,1): error TS2304: x')
    .say('Touched files typecheck clean.').write();
  assert.deepEqual(verdicts(grade(p, { repo: null })), ['FALSE']);
});

test('a test file run directly counts, and an echoed PIPESTATUS is the exit code', () => {
  const p = session('/nowhere').prompt('go')
    .bash('bun test', '3 pass\n0 fail')
    .edit('/r/ring0.mjs')
    .bash('node ring0.test.mjs 2>&1 | grep -E "FAIL|passed"; echo "EXIT=${PIPESTATUS[0]}"', '8 passed\nEXIT=0')
    .say('All 8 self-tests green.').write();
  assert.deepEqual(verdicts(grade(p, { repo: null })), ['PROVEN']);
  const q = session('/nowhere').prompt('go')
    .bash('node ring0.test.mjs | tail -2; echo "EXIT=${PIPESTATUS[0]}"', 'done\nEXIT=1')
    .say('The tests pass.').write();
  assert.deepEqual(verdicts(grade(q, { repo: null })), ['FALSE']);
});

test('a relative shell write matches an absolute path in the claim', () => {
  const p = session('/nowhere').prompt('go').bash('cd /root; cat > ncert-filter.mjs <<EOF\nx\nEOF', '').say('I moved it into one shared module, `/root/ncert-filter.mjs`.').write();
  assert.deepEqual(verdicts(grade(p, { repo: null })), ['PROVEN']);
});

// ---------- P2: the Stop hook ----------

import { spawnSync } from 'node:child_process';
import { runStopHook } from '../src/hook.js';
import { install } from '../src/install.js';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/receipts.js', import.meta.url));

function failingSession() {
  return session('/nowhere').prompt('go').bash('npm test', 'Tests: 1 failed, 41 passed, 42 total', 1).write();
}

test('hook blocks once on a FALSE claim, using last_assistant_message (the transcript may lag)', () => {
  const out = runStopHook({ transcript_path: failingSession(), last_assistant_message: 'All 42 tests pass.', stop_hook_active: false });
  const j = JSON.parse(out.stdout);
  assert.equal(j.decision, 'block');
  assert.match(j.reason, /FALSE: "All 42 tests pass\."/);
  assert.equal(out.code, 0);
});

test('hook lets the agent stop on the retry and tells the person instead', () => {
  const out = runStopHook({ transcript_path: failingSession(), last_assistant_message: 'All 42 tests pass.', stop_hook_active: true });
  const j = JSON.parse(out.stdout);
  assert.equal(j.decision, undefined);
  assert.match(j.systemMessage, /still unproven/);
});

test('hook stays silent when nothing is false, and NO RECEIPT blocks only with --strict', () => {
  const p = session('/nowhere').prompt('go').edit('/x/a.js').write();
  assert.equal(runStopHook({ transcript_path: p, last_assistant_message: 'All tests pass.' }).stdout, '');
  assert.equal(JSON.parse(runStopHook({ transcript_path: p, last_assistant_message: 'All tests pass.' }, { strict: true }).stdout).decision, 'block');
});

test('hook never traps the agent when it breaks', () => {
  assert.deepEqual(runStopHook({ transcript_path: '/no/such/file.jsonl', last_assistant_message: 'Tests pass.' }), { stdout: '', code: 0 });
  assert.deepEqual(runStopHook({}), { stdout: '', code: 0 });
});

test('the hook reads stdin from a socket (how the harness sends it) and from a pipe', () => {
  const payload = JSON.stringify({ transcript_path: failingSession(), last_assistant_message: 'All 42 tests pass.', stop_hook_active: false });
  // Node's child stdio "pipe" is a socketpair on Unix: this is the socket case.
  const viaSocket = spawnSync(process.execPath, [BIN, 'hook'], { input: payload, encoding: 'utf8' });
  assert.equal(JSON.parse(viaSocket.stdout).decision, 'block');
  const viaPipe = spawnSync('sh', ['-c', `printf '%s' "$P" | "${process.execPath}" "${BIN}" hook`], { env: { ...process.env, P: payload }, encoding: 'utf8' });
  assert.equal(JSON.parse(viaPipe.stdout).decision, 'block');
});

test('install adds the hook once, keeps what was there, and backs it up', () => {
  const dir = mkdtempSync(join(tmpdir(), 'smtr-i-'));
  mkdirSync(join(dir, '.claude'));
  writeFileSync(join(dir, '.claude/settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] }, model: 'x' }));
  install({ dir });
  const s = JSON.parse(readFileSync(join(dir, '.claude/settings.json'), 'utf8'));
  assert.equal(s.model, 'x');
  assert.equal(s.hooks.Stop.length, 2);
  assert.ok(existsSync(join(dir, '.claude/settings.json.before-receipts')));
  assert.match(install({ dir }), /Already installed/);
  assert.equal(JSON.parse(readFileSync(join(dir, '.claude/settings.json'), 'utf8')).hooks.Stop.length, 2);
});

test('a command name in backticks still reads as a test claim (found in a live run)', () => {
  const { claims } = extractClaims('`npm test` passes (1 of 1, exit 0), and `mul(4, 3)` returns 12.');
  assert.deepEqual(claims.map((c) => c.type), ['tests-pass']);
});
