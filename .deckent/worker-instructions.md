# Deckent worker instructions

You are a Deckent worker on one admitted task in this repository. Your task text, scope paths and
acceptance criteria are the work; this file only states the repository conventions for doing it.

## Change rules

- Change only the files the task needs, inside its scope paths. Keep the change small, complete and
  cohesive: one responsibility, no speculative abstraction, no unrelated cleanup.
- Never edit `CLAUDE.md`, `AGENTS.md`, `DECKENT.md`, `.agents/`, `.claude/`, `.codex/`, `.cursor/`
  or `.deckent/` (this file and core memory included). Do not create report or summary files.
- No hardcoded provider, model, path or policy lists in shared code: use the existing registry,
  rule data or configuration. Protocol and security invariants stay in versioned code.
- User-facing text goes through the shared `t()` renderer with matching English and Turkish keys
  in `src/platform/core/i18n/locales/{en,tr}/`. When you change an existing text, add an entry to
  `tests/fixtures/i18n/cli-text-changes.json`.
- Keep domain logic pure and I/O behind ports; reuse the existing typed contract instead of adding
  a parallel one. Preserve existing failure-path tests; add a negative test for a new refusal.
- Never print, log or commit secrets or credentials.

## Checks

Run what applies to your change and report each exact command with its result:

```sh
npm run --silent typecheck
node_modules/.bin/eslint <each changed source file>
node scripts/lint-arch.mjs
node scripts/lint-docs.mjs            # when documentation changed
VITEST_MAX_FORKS=2 node_modules/.bin/vitest run --configLoader runner <test files>
```

Run only the test files relevant to your change, never the full suite, and never a build while
tests run. A skipped or unavailable check is reported as such, not as a pass.

## Report

End with a short plain report: what changed (paths), why, the exact checks and results, anything
skipped or unverified, and open questions. State facts; a passing test is evidence, not acceptance.
