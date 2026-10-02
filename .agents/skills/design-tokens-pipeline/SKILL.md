---
name: design-tokens-pipeline
description: Maintain Deckent semantic token sources and actual Next Terminal palette generation; inspect current consumers before claiming cross-surface outputs or drift checks.
---

# Deckent Next Design Tokens Pipeline

## Actual repository contract

Load `deckent-design-dna` and relevant `deckent-design-system` contracts. Inspect current paths
and consumers before changing sources; accepted cross-surface semantics do not imply a generator
for an absent surface. At the 2026-10-02 inventory:

- Terminal role map: `design/tokens/terminal.map.json`.
- Builder: `scripts/build-terminal-palette.mjs`; primitive values also live in its `PRIMITIVES`.
- Generated output: `src/surfaces/core/terminal-kit/internal/generated/palette.ts`.
- The current token directory contains the Terminal map; broader primitive/semantic documents
  and cross-surface outputs must be verified before claiming they exist or are consumed.
- Former Dashboard/Desktop generators and `scripts/build-design-tokens.mjs` are absent in Next.

The builder always writes and has no `--check` mode. Do not run a write command during a read-only
audit or call it a safe drift check. Generation requires owned source/output paths and authorized
edits. Read-only inspection compares existing source, builder and consumers without generating.

## Semantic layering

Use primitive → semantic → justified component roles as the target architecture. Reuse current
roles and their actual source; current primitive-in-builder structure is evidence, not a reason
to introduce a second token store. Components consume semantic/component roles, preserving state
meaning across themes and Terminal color tiers. Identify existing raw-value escapes as findings.
DTCG 2025.10 is a community specification, not a W3C Recommendation. Verify the current official
format before interoperability changes; `$type`/`$value`/aliases must match actual supported code.
Do not claim DTCG conformance from filenames or replace working infrastructure to match a draft.

## Authorized change procedure

1. Name the semantic problem, states, current source and every real consumer.
2. Reuse a fitting role; add one only when existing meaning is inadequate.
3. Pin source, builder, output ownership and the generated contract before editing.
4. Change the actual source, including builder primitives only when that is the current source.
5. Generate in the owned change with `node scripts/build-terminal-palette.mjs`.
6. Inspect the generated diff and relevant contract checks. If checking determinism, regenerate
   in an isolated disposable copy and compare bytes; do not add a fake `--check` argument.
7. Check color-independent carriers, contrast/forced colors where applicable, reduced motion,
   terminal truecolor/256/16/no-color degradation and inherited light/dark backgrounds.
8. Capture real consumer evidence for claimed behavior; use the assigned design review role.

Do not hand-edit generated output or create competing per-surface semantics. If needed output
is outside lane ownership or a consumer is absent, report the dependency and coordinate.

## Evidence and compatibility

Report intent, source/aliases, builder version/revision, generated consumers and diff, checks,
measurements, preference/migration impact and actual captures. Distinguish present Terminal
generation from proposed Desktop/Dashboard integration. Unavailable surface proof remains open.
Reject color-only meaning, unjustified roles, silent tier drift or discarded user preferences.
