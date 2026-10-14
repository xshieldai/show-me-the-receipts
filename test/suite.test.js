import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { grade, setEventBus, isBusWired, toHanumanG } from '../src/index.js';

const BIN = fileURLToPath(new URL('../bin/receipts.js', import.meta.url));

function sessionFile(lines) {
  const dir = mkdtempSync(join(tmpdir(), 'smtr-suite-'));
  const p = join(dir, 's.jsonl');
  const recs = [{ type: 'user', cwd: '/nowhere', sessionId: 'sess-1', message: { role: 'user', content: 'go' } }];
  let n = 0;
  for (const [cmd, out, code] of lines.cmds ?? []) {
    const id = `t${++n}`;
    recs.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: cmd } }] } });
    recs.push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: code ? `Exit code ${code}\n${out}` : out, is_error: Boolean(code) }] } });
  }
  recs.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: lines.say }] } });
  writeFileSync(p, recs.map((r) => JSON.stringify(r)).join('\n'));
  return p;
}

test('no bus, no emission; with a bus, one receipt per claim and one for the report', () => {
  const p = sessionFile({ cmds: [['npm test', '# pass 2\n# fail 0']], say: 'All tests pass. The build succeeds.' });
  assert.equal(isBusWired(), false);
  grade(p, { repo: null });
  const got = [];
  setEventBus({ emit: (r) => got.push(r) });
  try {
    grade(p, { repo: null });
  } finally {
    setEventBus(null);
  }
  assert.deepEqual(got.map((r) => r.event_type), ['receipts.claim_graded', 'receipts.claim_graded', 'receipts.report_graded']);
  assert.deepEqual(got.map((r) => r.verdict), ['PROVEN', 'NO RECEIPT', 'UNPROVEN']);
  assert.ok(got.every((r) => r.primitive === 'show-me-the-receipts' && r.agent_id === 'sess-1' && r.emitted_at && r.receipt_id));
  assert.equal(new Set(got.map((r) => r.receipt_id)).size, 3);
});

test('a bus that throws does not break grading', () => {
  const p = sessionFile({ say: 'All tests pass.' });
  setEventBus({ emit: () => { throw new Error('bus down'); } });
  try {
    assert.equal(grade(p, { repo: null }).results.length, 1);
  } finally {
    setEventBus(null);
  }
});

test('HanumanG fields: only what is measured, and false when a claim fails', () => {
  const ok = toHanumanG({ sessionId: 's', results: [{ verdict: 'PROVEN' }] });
  assert.deepEqual(ok.inputs, [{ axis: 'truthful_report', errors_reported: true, task_id: 's' }, { axis: 'return_with_proof', deviations_reported: true, task_id: 's' }]);
  const stale = toHanumanG({ results: [{ verdict: 'PROVEN' }, { verdict: 'STALE' }] });
  assert.equal(stale.inputs[0].errors_reported, true);
  assert.equal(stale.inputs[1].deviations_reported, false);
  const bad = toHanumanG({ results: [{ verdict: 'FALSE' }] });
  assert.equal(bad.inputs[0].errors_reported, false);
  const none = toHanumanG({ results: [{ verdict: 'NO RECEIPT' }] });
  assert.deepEqual(none.inputs.map((i) => Object.keys(i)), [['axis'], ['axis']]);
  assert.deepEqual(none.measured, []);
  for (const r of [ok, stale, bad, none]) for (const i of r.inputs) for (const k of Object.keys(i)) assert.ok(['axis', 'task_id', 'errors_reported', 'deviations_reported'].includes(k), k);
});

test('CLI: --acc-log writes JSON lines, and the hook honours RECEIPTS_ACC_LOG', () => {
  const p = sessionFile({ cmds: [['npm test', 'x', 1]], say: 'All tests pass.' });
  const log = join(mkdtempSync(join(tmpdir(), 'smtr-acc-')), 'acc.jsonl');
  spawnSync(process.execPath, [BIN, p, '--acc-log', log], { encoding: 'utf8' });
  const first = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(first.map((r) => r.verdict), ['FALSE', 'FALSE']);
  const hook = spawnSync(process.execPath, [BIN, 'hook'], { input: JSON.stringify({ transcript_path: p, last_assistant_message: 'All tests pass.' }), encoding: 'utf8', env: { ...process.env, RECEIPTS_ACC_LOG: log } });
  assert.equal(JSON.parse(hook.stdout).decision, 'block');
  assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, 4);
});

test('CLI: --hanumang prints the measured fields', () => {
  const p = sessionFile({ cmds: [['npm test', 'x', 1]], say: 'All tests pass.' });
  const out = JSON.parse(spawnSync(process.execPath, [BIN, p, '--hanumang'], { encoding: 'utf8' }).stdout);
  assert.deepEqual(out.measured, ['truthful_report.errors_reported', 'return_with_proof.deviations_reported']);
  assert.equal(out.inputs[0].errors_reported, false);
});
