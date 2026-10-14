# 🧾 show-me-the-receipts

**Your AI coding agent says it's done. Show me the receipts.**

![show-me-the-receipts grading a demo session: one claim proven, one false, one stale, one with no receipt](https://raw.githubusercontent.com/xshieldai/show-me-the-receipts/main/docs/demo.gif)

<sub>A demo session ([`examples/demo-session.jsonl`](examples/demo-session.jsonl)), graded by the real tool. The GIF is drawn from that run by [`scripts/make-demo-gif.py`](scripts/make-demo-gif.py), so anyone can rebuild it.</sub>

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
**NO RECEIPT**, including a hedged claim ("tests should pass now") or a bare "Done!" that names
nothing checkable. Without `--strict`, those are listed in the report, never counted as passed.

The install keeps your existing hooks, writes a backup (`settings.json.before-receipts`), and does
nothing if the hook is already there. The repository is also a Claude Code plugin (`hooks/hooks.json`).

## Re-run mode: don't trust the transcript, run it

```bash
npx show-me-the-receipts init     # writes receipts.config.json from your package.json scripts
```

```json
{ "rerun": true, "timeoutSec": 300, "commands": { "test": "npm test", "build": "npm run build" } }
```

With this file in your repository, a claim about tests, build, lint or typecheck is settled by
**running your command now**, not by what the session record says. A faked run, a run that
passed before a later edit, or a count that doesn't match all come out FALSE if your command
fails now. Each command runs at most once per check. Only the commands in this file are ever run,
never anything from the transcript. Use `--no-rerun` to skip it.

## Pull requests: the GitHub Action

Agents (and people) write claims in pull request descriptions: "All tests pass", "Updated
`src/parse.ts`", a ticked "- [x] Ran the tests". The Action checks them against the pull request
itself and posts one receipts comment, updated in place:

```yaml
# .github/workflows/receipts.yml
on:
  pull_request:
    types: [opened, edited, synchronize, reopened]
permissions:
  contents: read
  pull-requests: write
jobs:
  receipts:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: xshieldai/show-me-the-receipts@v0.4.0
```

- **"Updated `file`"** is checked against the pull request's own diff. A file it never touches is FALSE.
- **"`fn()` is wired in"** is checked by searching the pull request's code.
- **Tests, build, lint, typecheck** are settled by running the commands in `receipts.config.json`
  **from the base branch**, so a pull request cannot change what is run to judge it.
- The check fails on a FALSE claim. `fail-on: no-receipt` is stricter; `fail-on: never` only reports.
- Use the `pull_request` trigger. The Action refuses `pull_request_target`, which would run a
  fork's code with a write token and secrets. A fork's token is read-only, so for forks the
  receipts are in the job summary instead of a comment.

## Subagents

When the agent hands work to subagents, their transcripts (`<session>/subagents/agent-<id>.jsonl`)
are read too. A test run or an edit made by a subagent counts as evidence for the main agent's
claims, placed in time order, and is marked `[subagent <id>]` in the report. Work a background
subagent does after the agent's final message is not counted.

## With the xShieldAI suite

Optional, and nothing runs unless you ask for it.

- **Agentic Control Center events.** `setEventBus(bus)` takes the same bus as the `@xshieldai`
  packages: each graded claim, and one summary per check, is emitted as a receipt
  (`receipts.claim_graded`, `receipts.report_graded`). From the command line or the hook, set
  `RECEIPTS_ACC_LOG=/path/acc.jsonl` (or pass `--acc-log`) to append the same receipts as JSON lines.
- **HanumanG.** `toHanumanG(report)` (or `--hanumang`) gives the two
  `@xshieldai/hanumang-mandate` fields this tool actually measures: `truthful_report.errors_reported`
  and `return_with_proof.deviations_reported`, false when a claim is FALSE (or STALE, for
  deviations). Before/after state and receipt fields are yours to add before scoring.

```js
import { grade, setEventBus, toHanumanG } from 'show-me-the-receipts';
setEventBus({ emit: (receipt) => myBus.emit(receipt) });
const report = grade('session.jsonl');
const { inputs } = toHanumanG(report);
```

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
- **Without re-run mode, it trusts the session record.** That catches honest mistakes. An agent
  that controls the shell could fake a run, so turn on re-run mode where that matters.
- **An agent that claims nothing passes trivially**, and the tool says so: "Nothing claimed is
  nothing proven".
- **Claims are found by pattern, not by a model.** A claim phrased in an unusual way is left
  ungraded, and the count of ungraded sentences is always printed. Nothing ungraded is counted as passed.
- **It never runs anything from the transcript.** The transcript is data. It runs `git` read
  commands with fixed arguments and, in re-run mode, the commands you wrote in `receipts.config.json`.
- **Local only.** No network, no telemetry, no account.

## Roadmap

- More claim types ("no errors", counts like "fixed 12 warnings").
- Transcripts from other agents.
- Optional signed receipts, so a team can check what an agent did later.

## Licence

MIT. Made by [xShieldAI](https://xshieldai.com), part of [ANKR](https://ankr.in).
