import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { grade } from '../src/index.js';
import { mergeByTime } from '../src/transcript.js';

// Records with real timestamps, the way Claude Code writes them. t is seconds from a fixed start.
const T0 = Date.parse('2026-10-14T10:00:00Z');
const at = (t) => new Date(T0 + t * 1000).toISOString();
let n = 0;
const prompt = (t, text, extra = {}) => ({ type: 'user', timestamp: at(t), cwd: '/nowhere', sessionId: 's1', message: { role: 'user', content: text }, ...extra });
const say = (t, text, extra = {}) => ({ type: 'assistant', timestamp: at(t), message: { role: 'assistant', content: [{ type: 'text', text }] }, ...extra });
function bash(t, command, output, code = 0, extra = {}) {
  const id = `t${++n}`;
  return [
    { type: 'assistant', timestamp: at(t), message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] }, ...extra },
    { type: 'user', timestamp: at(t + 1), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: code ? `Exit code ${code}\n${output}` : output, is_error: code !== 0 }] }, ...extra },
  ];
}
function edit(t, file, extra = {}) {
  const id = `t${++n}`;
  return [
    { type: 'assistant', timestamp: at(t), message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Edit', input: { file_path: file } }] }, ...extra },
    { type: 'user', timestamp: at(t + 1), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] }, ...extra },
  ];
}
function agentTool(t) {
  const id = `t${++n}`;
  return [
    { type: 'assistant', timestamp: at(t), message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Agent', input: { prompt: 'run the tests' } }] } },
  ];
}

function write(main, subagents = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'smtr-sub-'));
  const p = join(dir, 's1.jsonl');
  writeFileSync(p, main.flat().map((r) => JSON.stringify(r)).join('\n') + '\n');
  mkdirSync(join(dir, 's1', 'subagents'), { recursive: true });
  for (const [id, recs] of Object.entries(subagents)) {
    const side = recs.flat().map((r) => ({ ...r, isSidechain: true, agentId: id, sessionId: 's1' }));
    writeFileSync(join(dir, 's1', 'subagents', `agent-${id}.jsonl`), side.map((r) => JSON.stringify(r)).join('\n') + '\n');
  }
  return p;
}

const v = (r) => r.results.map((x) => x.verdict);

test('a test run made by a subagent proves the main agent\'s claim', () => {
  const p = write(
    [prompt(0, 'add the feature'), agentTool(5), say(100, 'All 12 tests pass.')],
    { abc12345: [prompt(6, 'run the tests'), bash(10, 'npm test', '# pass 12\n# fail 0'), say(20, 'Tests pass.')] },
  );
  const r = grade(p, { repo: null });
  assert.deepEqual(v(r), ['PROVEN']);
  assert.equal(r.results[0].evidence.agent, 'abc12345');
});

test('a subagent edit after the test run makes the claim STALE', () => {
  const p = write(
    [prompt(0, 'go'), bash(5, 'npm test', '# pass 3\n# fail 0'), agentTool(10), say(100, 'All tests pass.')],
    { def67890: [prompt(11, 'tidy'), edit(20, '/x/src/parse.ts')] },
  );
  const r = grade(p, { repo: null });
  assert.deepEqual(v(r), ['STALE']);
  assert.match(r.results[0].why, /parse\.ts/);
});

test('a failed run in a subagent makes the claim FALSE', () => {
  const p = write(
    [prompt(0, 'go'), agentTool(5), say(100, 'Tests pass.')],
    { aaa: [prompt(6, 'test'), bash(10, 'npx jest', 'Tests: 2 failed, 8 passed, 10 total', 1)] },
  );
  assert.deepEqual(v(grade(p, { repo: null })), ['FALSE']);
});

test('a background subagent still working after the final message neither hides it nor counts as evidence', () => {
  const p = write(
    [prompt(0, 'go'), agentTool(5), say(50, 'All tests pass.')],
    { bg: [prompt(6, 'later'), bash(80, 'npm test', '# pass 9\n# fail 0')] },
  );
  const r = grade(p, { repo: null });
  assert.deepEqual(v(r), ['NO RECEIPT']);
});

test('the main session without its subagents still grades as before', () => {
  const p = write([prompt(0, 'go'), bash(5, 'npm test', '# pass 1\n# fail 0'), say(10, 'All tests pass.')]);
  assert.deepEqual(v(grade(p, { repo: null })), ['PROVEN']);
});

test('merge keeps the main order and drops a subagent event it cannot place', () => {
  const main = [{ k: 'a', ts: 1 }, { k: 'b' }, { k: 'c', ts: 5 }];
  const out = mergeByTime(main, [{ k: 'x', ts: 3 }, { k: 'y' }, { k: 'z', ts: 9 }]);
  assert.deepEqual(out.map((e) => e.k), ['a', 'b', 'x', 'c', 'z']);
});
