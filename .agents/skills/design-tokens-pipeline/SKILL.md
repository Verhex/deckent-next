---
name: design-tokens-pipeline
description: Use when changing Deckent color, typography, spacing, radius, motion, density, or component tokens, or when validating generated Dashboard, Desktop, and Terminal token outputs. Do not use for visual ideation that does not change token contracts.
---

## Next refactor scope — 2026-09-17

For current Deckent Next work, first apply `deckent-next-refactor` from the host skill directory.
Product writes target `/home/alperen/deckent-next`; legacy `/home/alperen/deckent-dev` is a read-only
reference except the owner-authorized host tooling/channel setup. Next ARCHITECTURE.md and PLAN.md
carry accepted refactor decisions. Relative legacy `docs/`, `.deckent/workspace/`, `src/` and
`scripts/` references below resolve in the legacy repository for reading only; inspect target
implementation separately. Do not run legacy generation, recovery, MCP or dogfood commands for Next.


# Deckent Design Tokens Pipeline

## Current repository contract

The repository implementation is the authority:

- Source: design/tokens/*.tokens.json plus watch-map.json and terminal.map.json
- Builder: scripts/build-design-tokens.mjs
- Dashboard output: src/dashboard/src/generated/theme.css
- Desktop output: src/desktop/src/shared/generated/theme-tokens.gen.ts
- Terminal output: src/cli/helpers/generated/palette.ts

The source follows the DTCG value/type and alias model where the current implementation supports
it. Do not rewrite working token infrastructure merely to resemble a newer draft.

## Layering

Use three layers:

1. Primitive tokens hold raw values.
2. Semantic tokens describe product meaning such as surface, text, focus, approval, warning and
   failure.
3. Component tokens encode a justified local contract.

Components consume semantic or component roles. A primitive value must not leak into product CSS
or rendering code.

The same semantic state must survive all outputs, but surface rendering may differ. Terminal color
tiers, CSS variables and Desktop runtime themes are adapters, not competing token authorities.

## Change procedure

1. Load deckent-design-dna and deckent-design-system.
2. Identify the semantic problem and every consumer before proposing a value.
3. Search current sources and generated consumers; extend existing roles when they fit.
4. Add a new role only when an existing role would misrepresent meaning.
5. Update the canonical source first.
6. Generate all affected outputs in the same authorized change.
7. Run the check mode and affected tests.
8. Verify contrast, forced colors, reduced motion and terminal degradation as applicable.
9. Capture real-surface evidence and run deckent-design-critic.

## Commands

Safe drift check:

    node scripts/build-design-tokens.mjs --check

Write mode updates all configured outputs:

    node scripts/build-design-tokens.mjs

Before write mode, inspect current file ownership. If an output is outside the active lane,
especially src/cli, stop and coordinate instead of crossing the boundary.

## Token acceptance evidence

For each change report:

- semantic intent and affected states;
- source tokens and aliases;
- every generated consumer;
- contrast or motion measurements;
- migration and preference compatibility;
- check/test results;
- screenshots or terminal captures from real surfaces.

Reject a change when it:

- uses a visual value without semantic need;
- creates a surface-specific competing source;
- changes a generated file by hand;
- breaks saved preference migration;
- relies on color alone;
- leaves one surface or degradation tier silently stale.
