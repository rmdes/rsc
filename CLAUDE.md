# Textcaster — project conventions

## Ponytail workflow

Ponytail mode (lazy/minimal, plugin `ponytail`) is auto-active every session;
the ladder (YAGNI → reuse → stdlib → native → one line → minimum) governs all
code written here. Use the sub-skills systematically:

- `/ponytail-review` — run on the diff after finishing any task that changed
  code, before committing. A Stop hook nudges this automatically when the
  working tree changed since the last review; act on the nudge, don't dismiss it.
- `/ponytail-debt` — run before planning a debt batch; it harvests every
  `ponytail:` shortcut comment into a ledger. Mark every deliberate
  simplification with a `ponytail:` comment so this stays accurate.
- `/ponytail-audit` — whole-repo over-engineering audit; run before large
  refactors or when the codebase feels heavy, not routinely.
- `/ponytail-gain`, `/ponytail-help` — informational, on demand.

Written reports from audit/debt/review runs follow the documentation layout
below: `docs/superpowers/reviews/YYYY-MM-DD-<topic>.md`.

## Documentation layout

All generated markdown lives under `docs/superpowers/`, by kind:

- `specs/` — design documents
- `plans/` — implementation plans
- `reviews/` — code-review findings, improvement suggestions, audits
- `documentation/` — operator/user docs (RUNNING.md, …)

Dated documents are named `YYYY-MM-DD-<topic>.md`. Don't create markdown at
the repo root or directly in `docs/` — `README.md` is the only exception.
Executed plans/specs are historical records: don't rewrite paths inside them
when files move; update live references (README, newer specs) instead.
