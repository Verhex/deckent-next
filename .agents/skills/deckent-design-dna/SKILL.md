---
name: deckent-design-dna
description: Use first for Deckent product, Desktop, Terminal, Dashboard observability, interaction, visual-language, or design-system work. Routes the task to the smallest Deckent design skill set and enforces current product authority; do not use for unrelated generic marketing design.
---

## Next refactor scope — 2026-09-17

For current Deckent Next work, first apply `deckent-next-refactor` from the host skill directory.
Product writes target `/home/alperen/deckent-next`; legacy `/home/alperen/deckent-dev` is a read-only
reference except the owner-authorized host tooling/channel setup. Next ARCHITECTURE.md and PLAN.md
carry accepted refactor decisions. Relative legacy `docs/`, `.deckent/workspace/`, `src/` and
`scripts/` references below resolve in the legacy repository for reading only; inspect target
implementation separately. Do not run legacy generation, recovery, MCP or dogfood commands for Next.


# Deckent Design DNA

## Purpose

This is Deckent's design entry point and routing contract. It prevents a polished but semantically
false interface from becoming product authority.

## Load current authority

Before making a durable recommendation or editing a surface, read only the relevant sections of:

1. .deckent/workspace/IDENTITY.md
2. docs/design/DECKENT-DESKTOP-TERMINAL-NORTH-STAR.md
3. docs/design/DECKENT-DESKTOP-TERMINAL-RECONCILIATION.md
4. The real implementation, protocol and user-visible states in scope

The reconciliation document supersedes stale visual direction. Repository truth supersedes a
mockup. A live owner decision supersedes all persisted design guidance.

For Deckent product, Desktop workspace or visual-language work, also read
[references/current-owner-decisions.md](references/current-owner-decisions.md). Treat its accepted
and rejected directions as a decision ratchet: do not re-propose settled or rejected context unless
the reference's reopening rule is satisfied.

## Route by problem

Use the smallest sufficient set:

| Problem | Skill |
|---|---|
| Product model, journey, IA, progressive complexity | deckent-product-design |
| Runs, agents, approvals, autonomy, recovery, evidence | deckent-agentic-ux |
| Art direction, hierarchy, typography, color, motion | deckent-visual-language |
| Components, variants, tokens, governance | deckent-design-system |
| Token source, generation or drift | design-tokens-pipeline |
| Desktop shell, panes, docking, focus, layouts | deckent-workspace-design |
| CLI/TUI, streams, keyboard, ANSI degradation | deckent-terminal-design |
| Tenants, RBAC, policy, audit, secrets, cost | deckent-enterprise-ux |
| Independent review or release verdict | deckent-design-critic |

Do not load every skill by default.

## Non-negotiable product contract

- Desktop and Terminal are primary control/operator surfaces.
- Dashboard is an observability projection, never a second execution authority.
- The same application-service truth feeds every surface; semantic parity does not require pixel
  parity.
- Design for novice solo users, expert operators and the largest multi-tenant enterprises.
- Design the macOS, Linux, Windows-native and WSL behavior matrix up front.
- User-visible strings use the existing i18n systems. Mechanism modules remain string-free.
- Every async or agentic action exposes state, ownership, evidence, recovery and the next safe
  action.
- Accessibility is structural: keyboard, focus, screen reader, zoom, reduced motion, forced
  colors and non-color state carriers are designed with the interaction.
- No mock, screenshot or test-only state can claim production completion without real wiring.

## Default design direction

Precision Instrument is the current default: calm, formal, precise, long-session readable and
dense when the operator task requires it. Hierarchy comes from execution semantics. Color and
motion communicate status or causality.

Reject as defaults:

- generic AI gradients, decorative glow and glass;
- sci-fi HUD theater or fake telemetry;
- default component-library styling presented as identity;
- landing-page structure transplanted into an operator product;
- decorative metrics, fake activity and invented backend capability;
- novelty that reduces scanability, trust or recovery clarity.

NOVA is not the default identity. It may be evaluated only as an explicitly selected operator
visualization preset.

## Interactive design loop

1. State the surface, users, job, data authority, critical states and constraints.
2. Map the Golden Workflow plus failure, permission, stale, empty, offline and recovery paths.
3. For a durable identity or interaction-direction decision, present materially distinct
   directions against the same workflow. Explain trade-offs and failure risks.
4. Wait for owner selection before treating a durable direction as accepted authority.
5. Derive repeated patterns, then components, then tokens.
6. Implement inside current ownership boundaries.
7. Capture real rendered and interaction evidence.
8. Run deckent-design-critic as a separate pass.

Do not create approval theater for a small implementation detail already covered by an accepted
contract.

## Required handoff

Report:

- authority and repository evidence used;
- selected domain skills;
- states and platform modes covered;
- decisions still requiring owner selection;
- implementation and real-surface proof;
- critic verdict and unresolved findings.
