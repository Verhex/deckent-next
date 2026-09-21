---
name: deckent-visual-language
description: Use for Deckent art direction, typography, color roles, density, spacing rhythm, hierarchy, motion, iconography, branding, or visual state language. Do not use to choose a random style before product states and interaction needs are known.
---

## Next refactor scope — 2026-09-17

For current Deckent Next work, first apply `deckent-next-refactor` from the host skill directory.
Product writes target `/home/alperen/deckent-next`; legacy `/home/alperen/deckent-dev` is a read-only
reference except the owner-authorized host tooling/channel setup. Next ARCHITECTURE.md and PLAN.md
carry accepted refactor decisions. Relative legacy `docs/`, `.deckent/workspace/`, `src/` and
`scripts/` references below resolve in the legacy repository for reading only; inspect target
implementation separately. Do not run legacy generation, recovery, MCP or dogfood commands for Next.


# Deckent Visual Language

## Objective

Express Deckent as a precise operator instrument without generic AI-product theater. Load
deckent-design-dna first and obtain the workflow/state contract from the relevant domain skill.

## Current direction

Apply the current owner decision ratchet loaded by deckent-design-dna before presenting a type,
tone or composition candidate. A rejected family or visual grammar is not a fresh direction when
only its name, accent or spacing changes.

Precision Instrument is the default:

- calm and formal rather than theatrical;
- precise, inspectable and long-session readable;
- dense when the work is dense, with disciplined hierarchy;
- clear about live, stale, historical and proposed information;
- restrained in color and motion;
- distinctive through composition, typography and semantic details, not decoration.

NOVA is not a default shell or identity. It may be explored only as an explicitly selected
operator visualization preset.

## Direction exploration

When the task changes durable identity or a major interaction grammar:

1. Hold the workflow, information and critical states constant.
2. Produce at least three materially different directions.
3. For each, specify spatial grammar, typography roles, density, semantic color behavior,
   iconography, motion, accessibility risks and long-session failure modes.
4. Show representative success, failure, approval, stale and high-density states.
5. Present a recommendation with reasons, then wait for owner selection.

Changing only accent color, radius or background does not create a distinct direction.

## Craft rules

- Typography creates role and cadence. Validate Turkish glyphs, numeric alignment, code/log
  legibility and platform fallback.
- Color names product meaning. It is not a substitute for labels, shape, position or status text.
- Spacing creates groups and reading order; avoid uniform card grids when relationships differ.
- Borders, elevation and surfaces communicate containment and focus, not generic decoration.
- Motion explains continuity, causality or state transition. Respect reduced motion and never
  animate fake activity.
- Icons use one coherent family, accessible labels and stable meaning. Emoji are not interface
  icons.
- Data density supports scanning, comparison and drill-down. Do not inflate whitespace to look
  premium.
- Every focus, hover, pressed, selected, disabled, loading, stale, warning, error and success state
  is designed deliberately.

## Reject

- purple/blue AI gradients, glass cards and glow as default identity;
- sci-fi HUD, CRT, matrix or fake telemetry motifs;
- default shadcn or framework styling presented as finished work;
- a dashboard made of interchangeable cards without causal hierarchy;
- marketing slogans inside an operator workflow;
- hidden controls revealed only by hover;
- low-contrast muted text used for essential information;
- decorative motion, particle fields or pulsing status without real state.

## Verification

Inspect real renders at representative sizes and platform scale factors. Review keyboard focus,
zoom, forced colors, reduced motion, color-vision ambiguity, localization expansion and dense
data. Compare the accepted direction with implementation screenshots rather than relying on code
intent.

Hand off the accepted visual rules to deckent-design-system and run deckent-design-critic after
implementation.
