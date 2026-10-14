// Pulls checkable claims out of an agent's final message, by pattern. No model.
// A sentence that matches no pattern is not graded; it is never counted as passed.

const HEDGE = /\b(should|would|might|may|could|probably|likely|if|once|unless|try|let me|i'll|i will|next|todo|to do)\b/i;
const NEGATION = /(?:\bnot\b|n't\b|\bno longer\b|\bnever\b|\bfail(?:s|ed|ing)?\b|\bbroken\b|\bred\b)/i;

const FILE_TOKEN = /`?(\/?(?:[\w.@-]+\/)*[\w@-][\w.@-]*\.(?:[cm]?[jt]sx?|py|go|rs|rb|java|kt|swift|c|cc|cpp|h|hpp|cs|php|vue|svelte|json|ya?ml|toml|sql|sh|css|scss|html|prisma|graphql|md))(?![\w-])`?/g;
const SYMBOL = /`([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)(?:\(\))?`/g;

export function splitSentences(text) {
  const out = [];
  const withoutCode = text.replace(/```[\s\S]*?```/g, ' ');
  for (const raw of withoutCode.split(/\n+/)) {
    const line = raw.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').replace(/^#+\s*/, '').trim();
    if (!line) continue;
    for (const s of line.split(/(?<=[.!?])\s+(?=[A-Z`*✅])/)) {
      const t = s.trim();
      if (t) out.push(t);
    }
  }
  return out;
}

export function extractClaims(text) {
  const sentences = splitSentences(text);
  const claims = [];
  const ungraded = [];
  for (const sentence of sentences) {
    const found = claimsIn(sentence);
    if (found.length) claims.push(...found);
    else ungraded.push(sentence);
  }
  return { claims, ungraded, sentenceCount: sentences.length };
}

function claimsIn(sentence) {
  const s = sentence.replace(/\*\*/g, '');
  const plain = s.replace(/`/g, ''); // "`npm test` passes" is a test claim too
  if (HEDGE.test(s)) return [];
  const out = [];

  // C1 tests pass
  const tests =
    /\b(?:all\s+)?(?:(\d[\d,]*)\s+)?(?:of\s+(?:the\s+)?\d[\d,]*\s+)?(?:unit\s+|integration\s+|e2e\s+|the\s+)?tests?\s+(?:now\s+|still\s+)?(?:pass(?:es|ed|ing)?|are\s+(?:passing|green)|(?:is|are)\s+green|succeed(?:s|ed)?|green)\b/i.exec(plain) ||
    /\btest\s+suite\s+(?:now\s+)?(?:pass(?:es|ed)?|is\s+green)\b/i.exec(plain) ||
    /\b(\d[\d,]*)\s*\/\s*\d[\d,]*\s+tests?\s+pass/i.exec(plain) ||
    /\b(\d[\d,]*)\s+pass(?:ed|ing)?,\s*0\s+fail/i.exec(plain);
  if (tests && !NEGATION.test(s.replace(/0\s+fail\w*/gi, ''))) {
    const n = tests[1] ? Number(tests[1].replace(/,/g, '')) : null;
    out.push({ type: 'tests-pass', text: sentence, count: n });
  }

  // C2 build / lint / typecheck succeeded
  if (!NEGATION.test(s)) {
    const kinds = [
      ['build', /\b(?:the\s+)?build\s+(?:now\s+)?(?:succeeds|succeeded|passes|passed|is\s+(?:clean|green|passing)|works)\b|\bbuilds\s+(?:cleanly|successfully|fine)\b|\bcompiles\s+(?:cleanly|successfully|fine|without)\b/i],
      ['lint', /(?<!\b(?:\d+|one|two|three|four|several|many|both)\s)\blint(?:er|ing)?\s+(?:now\s+)?(?:is\s+clean|passes|passed|is\s+green)|\blint[- ]clean\b/i],
      ['typecheck', /\b(?:type[- ]?check(?:ing|s)?|tsc|types?)\s+(?:now\s+)?(?:passes|passed|is\s+clean|are\s+clean|clean)\b/i],
    ];
    for (const [kind, re] of kinds) {
      if (re.test(s)) out.push({ type: 'command-ok', kind, text: sentence, scoped: SCOPED.test(s) });
    }
  }

  // C4 wired / called
  const wired = /\b(?:wired\s+(?:it\s+)?(?:in|into|up)|hooked\s+(?:it\s+)?(?:up|into)|(?:is\s+)?(?:now\s+)?(?:called|used|invoked|imported|rendered|mounted)\s+(?:from|in|by)|registered\s+(?:in|with)|plugged\s+into|connected\s+to)\b/i;
  if (wired.test(s) && !NEGATION.test(s)) {
    const symbols = [...s.matchAll(SYMBOL)].map((m) => m[1]).filter((x) => !FILE_TOKEN_SINGLE.test(x));
    const files = [...s.matchAll(FILE_TOKEN)].map((m) => m[1]);
    if (symbols.length) out.push({ type: 'wired', text: sentence, symbol: symbols[0], target: files[0] ?? null });
  }

  // C3 file changed (skipped when the sentence was already a wiring claim)
  if (!out.some((c) => c.type === 'wired')) {
    const verb = /\b(updated|added|modified|changed|edited|created|wrote|written|fixed|refactored|rewrote|patched|moved|renamed|implemented|extended)\b/i;
    if (verb.test(s) && !NEGATION.test(s)) {
      const files = [...new Set([...s.matchAll(FILE_TOKEN)].map((m) => m[1]))];
      for (const f of files) out.push({ type: 'file-changed', text: sentence, file: f });
    }
  }
  return out;
}

// "touched files typecheck clean" speaks only for the files the session changed.
const SCOPED = /\b(?:touched|changed|modified|edited|new|my|our)\s+(?:files?|code|changes|modules?)\b/i;

const FILE_TOKEN_SINGLE = /\.(?:[cm]?[jt]sx?|py|go|rs|rb|java|json|ya?ml|md|sh|css|html|sql|toml)$/;
