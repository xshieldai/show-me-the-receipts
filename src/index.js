import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { checkClaims, repoRoot } from './check.js';
import { extractClaims } from './claims.js';
import { finalMessage, parseTranscript } from './transcript.js';

export { exitCodeFor, render } from './report.js';

export function grade(transcriptPath, opts = {}) {
  const { events, cwd, sessionId } = parseTranscript(transcriptPath);
  const final = finalMessage(events);
  const { claims, ungraded, sentenceCount } = extractClaims(final.text);
  const repo = opts.repo ?? repoRoot(cwd);
  const results = checkClaims(claims, events, final.index, { repo });
  return { results, ungraded, sentenceCount, sessionId, repo, source: transcriptPath, finalMessage: final.text };
}

// Claude Code keeps a project's sessions under ~/.claude/projects/<cwd with every non-alphanumeric as '->.
export function latestTranscript(dir = process.cwd()) {
  const slug = dir.replace(/[^a-zA-Z0-9]/g, '-');
  const base = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects', slug);
  if (!existsSync(base)) return null;
  const files = readdirSync(base)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => ({ f: join(base, f), t: statSync(join(base, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return files[0]?.f ?? null;
}
