import { FALSE, NO_RECEIPT, PROVEN, STALE } from './check.js';

const COLOR = { [PROVEN]: '\x1b[32m', [FALSE]: '\x1b[31m', [STALE]: '\x1b[33m', [NO_RECEIPT]: '\x1b[35m' };
const MARK = { [PROVEN]: '✔', [FALSE]: '✘', [STALE]: '⟳', [NO_RECEIPT]: '?' };
const RESET = '\x1b[0m';
const DIM = '\x1b[2m';

export function exitCodeFor(results) {
  if (results.some((r) => r.verdict === FALSE)) return 1;
  if (results.some((r) => r.verdict === STALE || r.verdict === NO_RECEIPT)) return 2;
  return 0;
}

export function render({ results, ungraded, sentenceCount, source }, { color = false, verbose = false } = {}) {
  const c = (code, s) => (color ? code + s + RESET : s);
  const out = [];
  out.push(c('\x1b[1m', '🧾 show me the receipts') + c(DIM, `  ${source}`));
  out.push('');
  if (!results.length) {
    out.push(`No checkable claims in the agent's last message (${sentenceCount} sentence(s) read).`);
    out.push(c(DIM, 'Nothing claimed is nothing proven: this is not a pass.'));
    return out.join('\n');
  }
  for (const r of results) {
    out.push(`${c(COLOR[r.verdict], `${MARK[r.verdict]} ${r.verdict.padEnd(10)}`)} ${quote(r.text)}`);
    out.push(`  ${c(DIM, '└')} ${r.why}${r.evidence?.line ? c(DIM, `  [transcript line ${r.evidence.line}]`) : ''}`);
    if (verbose && r.evidence?.command) out.push(c(DIM, `    $ ${oneLine(r.evidence.command)}`));
  }
  out.push('');
  const tally = [PROVEN, FALSE, STALE, NO_RECEIPT].map((v) => `${results.filter((r) => r.verdict === v).length} ${v.toLowerCase()}`).join(' · ');
  out.push(`${results.length} claim(s) checked from ${sentenceCount} sentence(s): ${tally}`);
  if (ungraded.length) out.push(c(DIM, `${ungraded.length} sentence(s) were not checkable claims and were not graded.`));
  return out.join('\n');
}

function quote(s) {
  const t = oneLine(s);
  return `"${t.length > 110 ? t.slice(0, 107) + '…' : t}"`;
}

function oneLine(s) {
  return String(s).replace(/\s+/g, ' ').trim();
}
