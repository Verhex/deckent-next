---
name: deckent-design-system
description: Use for Deckent component contracts, primitives, variants, design tokens, accessibility behavior, component governance, or Desktop/Terminal/Dashboard semantic parity. Do not use for a one-off mockup with no reusable system decision.
---

## Next refactor scope — 2026-09-17

For current Deckent Next work, first apply `deckent-next-refactor` from the host skill directory.
Product writes target `/home/alperen/deckent-next`; legacy `/home/alperen/deckent-dev` is a read-only
reference except the owner-authorized host tooling/channel setup. Next ARCHITECTURE.md and PLAN.md
carry accepted refactor decisions. Relative legacy `docs/`, `.deckent/workspace/`, `src/` and
`scripts/` references below resolve in the legacy repository for reading only; inspect target
implementation separately. Do not run legacy generation, recovery, MCP or dogfood commands for Next.


# Deckent Design System

## Objective

Turn proven Golden Workflow patterns into a governed cross-surface system. Load
deckent-design-dna, the relevant interaction skill and deckent-visual-language.

Do not begin with an abstract component inventory. The sequence is workflow, repeated pattern,
component contract, then tokens.

## Component model

Deckent's differentiating components represent agentic semantics, for example:

- run, flow and work-item summaries;
- agent and worker nodes;
- tool and MCP operations;
- approval and policy decisions;
- verification and evidence;
- cost, usage and context;
- execution timelines and checkpoints;
- provider, connector and skill health;
- terminal, artifact, log and evidence panes.

Names are illustrative until verified against the current product model.

## Required component contract

Every shared component specifies:

1. Purpose and authoritative data source
2. Anatomy and content hierarchy
3. Variants and density modes
4. Lifecycle, freshness, permission and evidence states
5. Keyboard and pointer behavior
6. Focus management and accessible name/description
7. Live-region behavior where updates occur
8. Loading, empty, stale, partial, error and recovery behavior
9. i18n and content expansion
10. Desktop, Terminal and Dashboard adaptations
11. Token dependencies
12. Performance and large-data behavior
13. Test and rendered-evidence requirements

A component is not complete when only its happy state exists.

## Token architecture

Use primitive → semantic → component layers. Invoke design-tokens-pipeline for source or generated
output changes.

- Primitive tokens hold raw values and do not leak to consumers.
- Semantic tokens encode product meaning independent of a component.
- Component tokens exist only for a stable component-specific contract.
- State semantics remain stable across themes and surfaces.
- Theme or density preferences are versioned, migratable and runtime-safe.

## Cross-surface parity

Share semantics and causal structure, not pixels:

- Desktop may use panes, direct manipulation and richer spatial context.
- Terminal uses text hierarchy, keyboard flow and honest capability degradation.
- Dashboard presents read-only observability and links to control surfaces.

One surface may omit an interaction only when its capability boundary is explicit and a valid
alternative exists.

## Governance

- Define ownership and change impact for each public component/token.
- Prefer extension over parallel copies.
- Deprecate with migration, usage evidence and a removal gate.
- Prevent undocumented local variants and raw-value escapes.
- Keep examples real enough to expose long strings, large counts and adverse states.
- Validate WCAG 2.2 behavior and applicable ARIA APG patterns without cargo-culting roles.

## Acceptance

Require contract tests, accessibility checks, token drift checks, representative rendered states,
real-surface proof and deckent-design-critic. A Storybook-like gallery or static specimen alone is
not production wiring evidence.
