// Reads a Claude Code session transcript (JSONL) into an ordered list of events.
// The transcript is data. Nothing in it is ever executed.

import { readFileSync } from 'node:fs';

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

export function parseTranscript(path) {
  const lines = readFileSync(path, 'utf8').split('\n');
  const records = [];
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    try {
      records.push({ line: i + 1, rec: JSON.parse(line) });
    } catch {
      // a torn last line is normal while a session is still writing
    }
  });
  return buildEvents(records);
}

export function buildEvents(records) {
  const events = [];
  const pending = new Map(); // tool_use_id -> event
  let cwd = null;
  let sessionId = null;

  for (const { line, rec } of records) {
    if (rec.isSidechain) continue;
    if (rec.cwd) cwd = rec.cwd;
    if (rec.sessionId) sessionId = rec.sessionId;
    const msg = rec.message;
    if (!msg) continue;
    const content = msg.content;

    if (rec.type === 'user') {
      if (rec.isMeta) continue;
      if (typeof content === 'string') {
        events.push({ kind: 'prompt', line, text: content });
        continue;
      }
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block.type === 'tool_result') {
          const ev = pending.get(block.tool_use_id);
          if (!ev) continue;
          ev.result = resultOf(block, rec.toolUseResult);
          ev.resultLine = line;
        } else if (block.type === 'text' && !content.some((b) => b.type === 'tool_result')) {
          events.push({ kind: 'prompt', line, text: block.text });
        }
      }
      continue;
    }

    if (rec.type === 'assistant' && Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text' && block.text.trim()) {
          events.push({ kind: 'text', line, text: block.text });
        } else if (block.type === 'tool_use') {
          const ev = toolEvent(block, line);
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
  turn.forEach((e, i) => { if (e.kind !== 'text') lastTool = i; });
  const texts = turn.slice(lastTool + 1).filter((e) => e.kind === 'text');
  return { text: texts.map((t) => t.text).join('\n\n'), line: texts[0]?.line ?? null, index: start + lastTool + 1 };
}
