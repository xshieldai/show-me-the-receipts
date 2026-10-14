# 🧾 show-me-the-receipts

**Your AI coding agent says it's done. Show me the receipts.**

Agents end their turn with claims: *"All 42 tests pass"*, *"The build succeeds"*,
*"`exportCsv()` is wired into the toolbar"*. This tool reads the agent's last message, finds the
claims it can check, and checks each one against what actually happened in the session and in
your repository.

```
$ npx show-me-the-receipts last

🧾 show me the receipts

✔ PROVEN     "Added `exportCsv()` in `src/export.ts`."
  └ Edit on /app/src/export.ts  [transcript line 6]
✘ FALSE      "All 42 tests pass."
  └ the last test run failed (2 failed in the output, the pipe hid the exit code)  [transcript line 4]
⟳ STALE      "The build succeeds."
  └ passed (exit code 0), then 1 file(s) changed: report-page.tsx  [transcript line 8]
✔ PROVEN     "Updated `src/report-page.tsx` with the new button."
  └ Edit on /app/src/report-page.tsx  [transcript line 10]
? NO RECEIPT "Also updated `src/routes.ts` to register the page."
  └ no edit to src/routes.ts is in the session record

5 claim(s) checked from 7 sentence(s): 2 proven · 1 false · 1 stale · 1 no receipt
2 sentence(s) were not checkable claims and were not graded.
```

That output is real: it is this tool run on [`examples/demo-session.jsonl`](examples/demo-session.jsonl).

## The four verdicts

| verdict | meaning |
|---|---|
| ✔ **PROVEN** | the session shows it happened, and the evidence is attached |
| ✘ **FALSE** | the session or the repository contradicts it, and the contradicting line is shown |
| ⟳ **STALE** | it was true, then code changed after the proof |
| ? **NO RECEIPT** | nothing proves or disproves it, so it is flagged, not believed |

When unsure, it says NO RECEIPT, never FALSE. A claim is called false only when there is a line
that contradicts it.

## Make the agent prove it: the Stop hook

```bash
npx show-me-the-receipts install          # this project (.claude/settings.json)
npx show-me-the-receipts install --user   # every project (~/.claude/settings.json)
```

Now, when Claude Code tries to finish with a **FALSE** or **STALE** claim, it is sent back once
with the verdict and told to prove the claim or correct it. If the claim still doesn't hold after
that one retry, the agent is allowed to stop and you see the verdict. It never loops, and if the
checker itself breaks, it gets out of the way. Add `--strict` to also send the agent back on
**NO RECEIPT**.

The install keeps your existing hooks, writes a backup (`settings.json.before-receipts`), and does
nothing if the hook is already there. The repository is also a Claude Code plugin (`hooks/hooks.json`).

## What it checks

| claim | example | evidence |
|---|---|---|
| tests pass | "All 42 tests pass" | the last test run: its exit code, its pass/fail summary, the count |
| build / lint / typecheck | "The build succeeds" | the last such command: its exit code and any error lines |
| file changed | "Updated `src/parse.ts`" | an edit to that file in the session; FALSE if no such file exists |
| wired in | "`exportCsv()` is now called from the menu" | a real caller in the repository, outside tests and outside its own definition |

It catches the classic tricks: `npm test | tail` hiding a failing exit code, tests that passed
before the last edit, a count that doesn't match the run, a function that is defined but never
called, and test runs that were moved to the background and never finished.

## Install and use

```bash
npx show-me-the-receipts last                # newest Claude Code session in this directory
npx show-me-the-receipts path/to/session.jsonl
```

Options: `--json` · `--save` (writes `.receipts/<session>.json`) · `--repo <dir>` · `--verbose`

Exit codes: `0` every checkable claim proven · `1` a claim is false · `2` stale or unproven ·
`3` the tool broke. So it fits in a script or a CI step.

Requires Node 18 or later. No dependencies. Works with Claude Code transcripts today.

## What it does not do

- **It doesn't judge your code.** PROVEN means "the tests ran and passed", not "the tests are good".
- **It sees only the session record and the working tree.** An agent that claims nothing passes
  trivially, and the tool says so: "Nothing claimed is nothing proven".
- **Claims are found by pattern, not by a model.** A claim phrased in an unusual way is left
  ungraded, and the count of ungraded sentences is always printed. Nothing ungraded is counted as passed.
- **It never runs anything from the transcript.** The transcript is data. The only commands it
  runs are `git` read commands on your repository, with fixed arguments.
- **Local only.** No network, no telemetry, no account.

## Roadmap

- More claim types ("no errors", counts like "fixed 12 warnings").
- Transcripts from other agents.
- Optional signed receipts, so a team can check what an agent did later.

## Licence

MIT. Made by [ANKR](https://ankr.in).
