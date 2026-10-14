// Claude Code Stop hook: the agent may not finish while a claim in its last message is FALSE or STALE.
// It gets one chance to prove or correct the claim; then it is let go, and the verdict is shown to the person.

import { readFileSync } from 'node:fs';
import { FALSE, NO_RECEIPT, STALE } from './check.js';
import { grade } from './index.js';

export function readHookInput() {
  // fd 0, not /dev/stdin: the harness may hand hooks a socket, and /dev/stdin throws ENXIO on one.
  try {
    return JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    return {};
  }
}

// Returns { stdout, code }. Never throws: a broken checker must not trap the agent.
export function runStopHook(input, { strict = false } = {}) {
  try {
    if (!input.transcript_path) return { stdout: '', code: 0 };
    const report = grade(input.transcript_path, {
      strict,
      finalText: typeof input.last_assistant_message === 'string' ? input.last_assistant_message : undefined,
    });
    const blocking = report.results.filter((r) => r.verdict === FALSE || r.verdict === STALE || (strict && r.verdict === NO_RECEIPT));
    if (!blocking.length) return { stdout: '', code: 0 };

    const lines = blocking.map((r) => `- ${r.verdict}: "${oneLine(r.text)}" (${r.why})`);

    if (input.stop_hook_active) {
      // Already sent back once. Let it stop, and tell the person what still does not hold.
      return { stdout: JSON.stringify({ systemMessage: `🧾 show-me-the-receipts: still unproven after one retry:\n${lines.join('\n')}` }), code: 0 };
    }

    const reason = [
      '🧾 show-me-the-receipts: your last message makes claims this session does not support.',
      ...lines,
      '',
      'Before you finish, for each one: either prove it (run the check now and let the output show it), or correct your message to say what is actually true.',
      'Do not repeat a claim the session record does not prove.',
    ].join('\n');
    return { stdout: JSON.stringify({ decision: 'block', reason }), code: 0 };
  } catch {
    return { stdout: '', code: 0 };
  }
}

function oneLine(s) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > 140 ? t.slice(0, 137) + '…' : t;
}
