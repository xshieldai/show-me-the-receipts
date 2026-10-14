// Bridge to the xShieldAI suite. Optional: nothing here runs unless a bus is set or a mapping is asked for.
//   setEventBus(bus)   the same opt-in event bus as the @xshieldai packages (aegis-suite's wireAllToBus shape)
//   toHanumanG(report) the two @xshieldai/hanumang-mandate axis fields this tool can actually measure

import { appendFileSync } from 'node:fs';

const PRIMITIVE = 'show-me-the-receipts';
let bus = null;

export function setEventBus(next) {
  bus = next ?? null;
}

export function isBusWired() {
  return bus !== null;
}

// An append-only JSON-lines bus, for the CLI and the hook, which run as their own processes.
export function jsonlBus(path) {
  return { emit: (receipt) => appendFileSync(path, JSON.stringify(receipt) + '\n') };
}

// One receipt per graded claim and one for the report. Never throws: a broken bus must not break grading.
export function emitReport(report, { source = 'session' } = {}) {
  if (!bus) return;
  const at = new Date().toISOString();
  const id = `${PRIMITIVE}-${report.sessionId ?? source}-${Date.now()}`;
  const send = (r) => {
    try {
      bus.emit({ primitive: PRIMITIVE, emitted_at: at, ...r });
    } catch {
      // the bus handles its own delivery failures
    }
  };
  report.results.forEach((c, i) =>
    send({
      receipt_id: `${id}-${i}`,
      event_type: 'receipts.claim_graded',
      agent_id: report.sessionId ?? undefined,
      verdict: c.verdict,
      summary: `${c.verdict}: ${oneLine(c.text)}`,
      payload: { claim_type: c.type, why: c.why, evidence: c.evidence ?? null, rerun: c.rerun ?? null, source },
    })
  );
  const count = (v) => report.results.filter((c) => c.verdict === v).length;
  send({
    receipt_id: `${id}-report`,
    event_type: 'receipts.report_graded',
    agent_id: report.sessionId ?? undefined,
    verdict: count('FALSE') ? 'FALSE' : count('STALE') || count('NO RECEIPT') ? 'UNPROVEN' : report.results.length ? 'PROVEN' : 'NO CLAIMS',
    summary: `${report.results.length} claim(s): ${count('PROVEN')} proven, ${count('FALSE')} false, ${count('STALE')} stale, ${count('NO RECEIPT')} no receipt`,
    payload: { proven: count('PROVEN'), false: count('FALSE'), stale: count('STALE'), no_receipt: count('NO RECEIPT'), hedged: report.hedged?.length ?? 0, bare_done: Boolean(report.bareDone), reran: Boolean(report.reran), source },
  });
}

// HanumanG scores seven axes. This tool measures two fields of two axes, and only those are filled:
//   truthful_report.errors_reported         false when a claim is FALSE (the agent reported success the record contradicts)
//   return_with_proof.deviations_reported   false when a claim is FALSE or STALE (a change after the proof went unmentioned)
// Each is true only when at least one claim is PROVEN and none fails; with nothing proven it is left out.
// before_state_present, after_state_present, receipt_signed and the rest are the caller's to supply.
export function toHanumanG(report, { taskId } = {}) {
  const has = (v) => report.results.some((c) => c.verdict === v);
  const proven = has('PROVEN');
  const errors_reported = has('FALSE') ? false : proven ? true : undefined;
  const deviations_reported = has('FALSE') || has('STALE') ? false : proven ? true : undefined;
  const task = taskId ?? report.sessionId ?? undefined;
  return {
    inputs: [
      { axis: 'truthful_report', ...(errors_reported === undefined ? {} : { errors_reported }), ...(task ? { task_id: task } : {}) },
      { axis: 'return_with_proof', ...(deviations_reported === undefined ? {} : { deviations_reported }), ...(task ? { task_id: task } : {}) },
    ],
    measured: ['truthful_report.errors_reported', 'return_with_proof.deviations_reported'].filter((f) => (f.endsWith('errors_reported') ? errors_reported : deviations_reported) !== undefined),
    note: 'Only the fields this tool measures are set. Merge your own before/after state and receipt fields before scoring.',
  };
}

function oneLine(s) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > 200 ? t.slice(0, 197) + '…' : t;
}
