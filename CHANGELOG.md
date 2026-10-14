# Changelog

## 0.4.1
- A claim inside quotation marks is quoted, not made. Found live on pull request #1, where the
  corrected description quoted the removed false claim and the Action graded the quote.

## 0.4.0
- GitHub Action: grades the claims in a pull request's description against the pull request
  itself (its diff, its code, and the base branch's configured commands, re-run).
- Ticked checkboxes count as claims; unticked boxes and template comments do not.

## 0.3.0
- Re-run mode: with `receipts.config.json`, claims about tests, build, lint and typecheck are
  settled by running the project's own command now. `receipts init` proposes the file.
- Hedged claims ("should pass now") and a bare "Done!" are listed; `--strict` makes them NO RECEIPT.
- A test runner counts only where a command starts, so a receipt the agent prints itself
  (`echo "# pass 42"`) is not a receipt.

## 0.2.x
- 0.2.2: README with the demo GIF on npm.
- 0.2.1: a pipe inside the npm script counts as a pipe.
- 0.2.0: Claude Code Stop hook; `receipts install`; plugin hooks.

## 0.1.0
- First release: grades an agent's final message against its Claude Code session.
