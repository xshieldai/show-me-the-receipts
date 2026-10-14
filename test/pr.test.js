import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gradePullRequest, renderMarkdown, shouldFail, MARKER } from '../src/pr.js';

const ACTION = fileURLToPath(new URL('../action/pr-action.js', import.meta.url));
const g = (dir, ...a) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' }).trim();

// base: export.ts + Menu.tsx, and (optionally) a receipts config. head: the PR's change.
function prRepo({ config, testScript = 'node -e "process.exit(0)"', head = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'smtr-pr-'));
  g(dir, 'init', '-q', '-b', 'main');
  const files = {
    'package.json': JSON.stringify({ name: 'p', scripts: { test: testScript } }),
    'src/export.ts': 'export function exportCsv(rows) {\n  return rows;\n}\n',
    'src/Menu.tsx': 'export const Menu = () => null;\n',
    ...(config ? { 'receipts.config.json': JSON.stringify(config) } : {}),
  };
  const write = (f, body) => { mkdirSync(join(dir, f, '..'), { recursive: true }); writeFileSync(join(dir, f), body); };
  for (const [f, b] of Object.entries(files)) write(f, b);
  g(dir, 'add', '-A'); g(dir, 'commit', '-q', '-m', 'base');
  const base = g(dir, 'rev-parse', 'HEAD');
  g(dir, 'checkout', '-q', '-b', 'pr');
  for (const [f, b] of Object.entries(head)) write(f, b);
  g(dir, 'add', '-A'); g(dir, 'commit', '-q', '-m', 'pr', '--allow-empty');
  return { dir, base };
}

const v = (r) => r.results.map((x) => x.verdict);

test('PR: file claims are checked against the diff, wired claims against the code', () => {
  const { dir, base } = prRepo({ head: { 'src/Menu.tsx': "import { exportCsv } from './export';\nexport const Menu = () => exportCsv([]);\n" } });
  const body = '## Summary\n- Updated `src/Menu.tsx` to add the export button.\n- Also updated `src/routes.ts` to register it.\n- `exportCsv()` is now called from the menu.';
  const r = gradePullRequest({ body, repo: dir, base });
  assert.deepEqual(v(r), ['PROVEN', 'FALSE', 'PROVEN']);
  assert.match(r.results[1].why, /not changed in this pull request/);
});

test('PR: ticked boxes are claims, unticked boxes and template comments are not', () => {
  const { dir, base } = prRepo({ config: { commands: { test: 'npm test --silent' } } });
  const body = '<!-- Tests pass: describe how you tested -->\n- [x] All tests pass\n- [ ] The build succeeds';
  const r = gradePullRequest({ body, repo: dir, base });
  assert.deepEqual(r.results.map((x) => x.type), ['tests-pass']);
  assert.deepEqual(v(r), ['PROVEN']);
});

test('PR: test claims are re-run with the BASE branch config; a PR cannot change what is run', () => {
  const { dir, base } = prRepo({
    config: { commands: { test: 'npm test --silent' } },
    testScript: 'node -e "process.exit(1)"',
    head: { 'receipts.config.json': JSON.stringify({ commands: { test: 'true' } }) },
  });
  const r = gradePullRequest({ body: 'All tests pass.', repo: dir, base });
  assert.equal(r.reran, true);
  assert.deepEqual(v(r), ['FALSE']);
  assert.match(r.results[0].why, /`npm test --silent` exited 1/);
});

test('PR: with no base config, a test claim is NO RECEIPT and says how to fix that', () => {
  const { dir, base } = prRepo();
  const r = gradePullRequest({ body: 'All tests pass.', repo: dir, base });
  assert.deepEqual(v(r), ['NO RECEIPT']);
  assert.match(r.results[0].why, /receipts\.config\.json on the base branch/);
});

test('PR: markdown carries the marker, escapes pipes, and fail-on works', () => {
  const md = renderMarkdown({ results: [{ verdict: 'FALSE', text: 'a | b', why: 'x' }], ungraded: [], sentenceCount: 1 });
  assert.ok(md.startsWith(MARKER));
  assert.match(md, /a \\\| b/);
  const res = [{ verdict: 'NO RECEIPT' }];
  assert.equal(shouldFail(res), false);
  assert.equal(shouldFail(res, 'no-receipt'), true);
  assert.equal(shouldFail([{ verdict: 'FALSE' }], 'never'), false);
});

// ---------- the Action entry, end to end ----------

function runAction(env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [ACTION], { env: { PATH: process.env.PATH, ...env } });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => resolve({ code, out, err }));
  });
}

function eventFile(dir, body, base, number = 7) {
  const f = join(dir, '..', `event-${Date.now()}-${Math.random()}.json`);
  writeFileSync(f, JSON.stringify({ pull_request: { number, body, base: { sha: base } } }));
  return f;
}

test('Action: refuses pull_request_target', async () => {
  const r = await runAction({ GITHUB_EVENT_NAME: 'pull_request_target', GITHUB_EVENT_PATH: '/nonexistent' });
  assert.equal(r.code, 1);
  assert.match(r.err, /refuses to run on pull_request_target/);
});

test('Action: writes the summary, fails on FALSE, posts one comment and then updates it', async () => {
  const { dir, base } = prRepo({ head: { 'src/Menu.tsx': 'export const Menu = () => 1;\n' } });
  const calls = [];
  let stored = [];
  const server = createServer((req, res) => {
    let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => {
      calls.push(`${req.method} ${req.url}`);
      if (req.method === 'GET') { res.end(JSON.stringify(stored)); return; }
      if (req.method === 'POST') stored = [{ id: 99, body: JSON.parse(b).body }];
      res.end('{}');
    });
  });
  await new Promise((r) => server.listen(0, r));
  const api = `http://127.0.0.1:${server.address().port}`;
  const summary = join(dir, '..', `summary-${Date.now()}.md`);
  const env = {
    GITHUB_EVENT_NAME: 'pull_request', GITHUB_WORKSPACE: dir, GITHUB_STEP_SUMMARY: summary,
    GITHUB_REPOSITORY: 'o/r', GITHUB_API_URL: api, INPUT_TOKEN: 't', INPUT_COMMENT: 'true',
    GITHUB_EVENT_PATH: eventFile(dir, 'Updated `src/Menu.tsx`.\nAlso updated `src/routes.ts`.', base),
  };
  const first = await runAction(env);
  const second = await runAction(env);
  server.close();
  assert.equal(first.code, 1);
  assert.match(readFileSync(summary, 'utf8'), /FALSE\*\* \| Also updated `src\/routes\.ts`/);
  assert.deepEqual(calls, ['GET /repos/o/r/issues/7/comments?per_page=100', 'POST /repos/o/r/issues/7/comments', 'GET /repos/o/r/issues/7/comments?per_page=100', 'PATCH /repos/o/r/issues/comments/99']);
  assert.match(second.out, /updated in the pull request/);
});
