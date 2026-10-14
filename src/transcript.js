// Reads a Claude Code session transcript (JSONL) into an ordered list of events.
// The transcript is data. Nothing in it is ever executed.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function readRecords(path) {
  const records = [];
  readFileSync(path, 'utf8').split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    try {
      records.push({ line: i + 1, rec: JSON.parse(line) });
    } catch {
      // a torn last line is normal while a session is still writing
    }
  });
  return records;
}

// Subagents write their own transcripts beside the session: <session>/subagents/agent-<id>.jsonl.
// Their commands and edits are evidence for the main agent's claims, merged in by timestamp.
export function parseTranscript(path, { subagents = true } = {}) {
  const main = buildEvents(readRecords(path));
  if (!subagents) return main;
  const dir = join(path.replace(/\.jsonl$/, ''), 'subagents');
  if (!existsSync(dir)) return { ...main, subagentCount: 0 };
  const files = readdirSync(dir).filter((f) => /^agent-.*\.jsonl$/.test(f));
  const extra = files.flatMap((f) => buildEvents(readRecords(join(dir, f)), { agent: f.replace(/^agent-|\.jsonl$/g, '') }).events);
  return { ...main, events: mergeByTime(main.events, extra), subagentCount: files.length };
}

// Keeps the main session's order; places each subagent event before the first main event that is later.
// A subagent event with no timestamp cannot be placed, so it is left out rather than guessed.
export function mergeByTime(main, extra) {
  const sub = extra.filter((e) => Number.isFinite(e.ts)).sort((a, b) => a.ts - b.ts);
  const out = [];
  let j = 0;
  let last = -Infinity;
  for (const e of main) {
    const t = Number.isFinite(e.ts) ? e.ts : last;
    while (j < sub.length && sub[j].ts < t) out.push(sub[j++]);
    out.push(e);
    last = t;
  }
  while (j < sub.length) out.push(sub[j++]);
  return out;
}

export function buildEvents(records, { agent = null } = {}) {
  const events = [];
  const pending = new Map(); // tool_use_id -> event
  let cwd = null;
  let sessionId = null;
  const sidechain = agent !== null;

  for (const { line, rec } of records) {
    if (rec.isSidechain && !sidechain) continue;
    const ts = Date.parse(rec.timestamp);
    if (rec.cwd) cwd = rec.cwd;
    if (rec.sessionId) sessionId = rec.sessionId;
    const msg = rec.message;
    if (!msg) continue;
    const content = msg.content;

    if (rec.type === 'user') {
      if (rec.isMeta) continue;
      if (typeof content === 'string') {
        if (!sidechain) events.push({ kind: 'prompt', line, ts, text: content });
        continue;
      }
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block.type === 'tool_result') {
          const ev = pending.get(block.tool_use_id);
          if (!ev) continue;
          ev.result = resultOf(block, rec.toolUseResult);
          ev.resultLine = line;
        } else if (block.type === 'text' && !content.some((b) => b.type === 'tool_result') && !sidechain) {
          events.push({ kind: 'prompt', line, ts, text: block.text });
        }
      }
      continue;
    }

    if (rec.type === 'assistant' && Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text' && block.text.trim()) {
          if (!sidechain) events.push({ kind: 'text', line, ts, text: block.text });
        } else if (block.type === 'tool_use') {
          const ev = { ...toolEvent(block, line), ts, ...(agent ? { agent } : {}) };
          events.push(ev);
          pending.set(block.id, ev);
        }
      }
    }
  }
  return { events, cwd, sessionId };
}

function toolEvent(block, line) {
  const input = block.input || {};
  if (block.name === 'Bash') {
    return { kind: 'command', line, id: block.id, command: String(input.command ?? ''), result: null };
  }
  if (EDIT_TOOLS.has(block.name)) {
    const file = input.file_path ?? input.notebook_path ?? '';
    return { kind: 'edit', line, id: block.id, tool: block.name, file: String(file), result: null };
  }
  return { kind: 'tool', line, id: block.id, tool: block.name, result: null };
}

function resultOf(block, tur) {
  const text = flatten(block.content);
  let exitCode = null;
  const m = /^(?:Error: )?Exit code (\d+)/.exec(text);
  if (m) exitCode = Number(m[1]);
  else if (block.is_error === false) exitCode = 0;
  const backgrounded =
    /moved to the background|Running in the background/i.test(text) ||
    Boolean(tur && typeof tur === 'object' && tur.backgroundTaskId);
  if (backgrounded) exitCode = null;
  return { text, isError: block.is_error === true, exitCode, backgrounded };
}

function flatten(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c === 'string' ? c : c.text ?? '')).join('\n');
  return '';
}

// The agent's final message: the text it wrote after its last tool call in the last turn.
export function finalMessage(events) {
  let start = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].kind === 'prompt') { start = i + 1; break; }
  }
  const turn = events.slice(start);
  let lastTool = -1;
  turn.forEach((e, i) => { if (e.kind !== 'text' && !e.agent) lastTool = i; }); // a background subagent may still be working
  const texts = turn.slice(lastTool + 1).filter((e) => e.kind === 'text');
  // Evidence is everything before the final message, including subagent work merged in before it.
  const index = texts.length ? events.indexOf(texts[0]) : start + lastTool + 1;
  return { text: texts.map((t) => t.text).join('\n\n'), line: texts[0]?.line ?? null, index };
}
