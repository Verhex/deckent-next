---
name: deckent-readonly-audit
description: Audit Deckent repository, runtime, wiring, or incidents with complete read-only evidence coverage. Do not use it to edit code, create runs, or clean state.
---

## Next refactor scope — 2026-09-17

For current Deckent Next work, first apply `deckent-next-refactor` from the host skill directory.
Product writes target `/home/alperen/deckent-next`; legacy `/home/alperen/deckent-dev` is a read-only
reference except the owner-authorized host tooling/channel setup. Next ARCHITECTURE.md and PLAN.md
carry accepted refactor decisions. Relative legacy `docs/`, `.deckent/workspace/`, `src/` and
`scripts/` references below resolve in the legacy repository for reading only; inspect target
implementation separately. Do not run legacy generation, recovery, MCP or dogfood commands for Next.

For refactor planning/execution/review, use the per-card loop and proof requirements in
`deckent-next-refactor`, then stop here. The historical runtime protocol below applies only
when the user explicitly requests that legacy runtime operation; it is not a Next admission gate.

## Historical legacy runtime procedure


# Deckent Read-only Audit

## Preconditions

Use a fresh `$deckent-authority-bootstrap` snapshot. State the audit question and boundaries. An
audit finding does not admit an outcome or authorize implementation.

## Evidence method

- Inventory files relevant to the stated audit boundaries and follow their producer/consumer
  dependencies. Inventory every tracked file only for a repository-wide audit. Classify relevant
  untracked, runtime, generated, large, and binary artifacts separately; state coverage limits.
- Trace claims through producer → durable state → consumer → entrypoint/ingress → effective
  policy/config. Distinguish production wiring from tests, mocks, fixtures, and documentation.
- Read source and tests as evidence, but do not run tests, builds, Deckent flows, cleanup, recovery,
  or commands with unproven side effects.
- Use effective config, registry, capability, auth/reachability metadata, and capacity evidence;
  never route by model-name prose or inspect credentials.
- Recheck important claims through an independent source, agent, or main-session disk inspection.
- Treat generated files and `.brain/exports` as projections. Do not read or mutate raw
  `.brain/memory.db`, and never manually delete `.tasks` content.

## Truth labels

Describe capabilities as `çalışıyor`, `kısmen çalışıyor`, `yalnız görünüşte var`, `çalışmıyor`, or
`kanıtlanamadı`. Label every finding exactly one of `BLOCKS_CURRENT_DONE`,
`RELATED_BUT_NONBLOCKING`, or `UNRELATED`; none of these labels creates work authority.

For conflicts, name each source, identify the higher-authority source, explain why it wins, and use
typed `HOLD` when the conflict cannot be resolved. Never convert absence of evidence into success
or failure.

## Required output

Lead with the conclusion, then provide concise file-and-line evidence, coverage counts by domain,
skipped artifacts with reasons, confidence per major section, contradictions, and explicit HOLDs.
Keep raw logs and large code dumps out of the report.
