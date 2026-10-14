// Adds the Stop hook to Claude Code settings. Keeps a backup; never removes anything already there.

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const HOOK_COMMAND = 'npx -y show-me-the-receipts hook';

export function install({ user = false, strict = false, dir = process.cwd() } = {}) {
  const file = user ? join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'settings.json') : join(dir, '.claude', 'settings.json');
  const command = HOOK_COMMAND + (strict ? ' --strict' : '');
  let settings = {};
  if (existsSync(file)) {
    const text = readFileSync(file, 'utf8');
    try {
      settings = JSON.parse(text || '{}');
    } catch {
      throw new Error(`${file} is not valid JSON; fix it first, nothing was changed`);
    }
    const already = JSON.stringify(settings.hooks?.Stop ?? []).includes('show-me-the-receipts hook');
    if (already) return `Already installed in ${file}. Nothing changed.`;
    copyFileSync(file, file + '.before-receipts');
  }
  settings.hooks ??= {};
  settings.hooks.Stop ??= [];
  settings.hooks.Stop.push({ hooks: [{ type: 'command', command, timeout: 600 }] });
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  return `Installed the Stop hook in ${file}${existsSync(file + '.before-receipts') ? ` (backup: ${file}.before-receipts)` : ''}.\nFrom now on the agent cannot finish with a FALSE or STALE claim without being sent back once to prove or correct it.`;
}
