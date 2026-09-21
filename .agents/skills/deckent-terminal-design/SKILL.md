---
name: deckent-terminal-design
description: Use for Deckent CLI/TUI ergonomics, information hierarchy, keyboard interaction, command palette, logs, worker trees, run inspection, ANSI color tiers, TTY behavior, piping, or Terminal/Desktop semantic parity. Do not use for generic CLI backend implementation.
---

## Next refactor scope — 2026-09-17

For current Deckent Next work, first apply `deckent-next-refactor` from the host skill directory.
Product writes target `/home/alperen/deckent-next`; legacy `/home/alperen/deckent-dev` is a read-only
reference except the owner-authorized host tooling/channel setup. Next ARCHITECTURE.md and PLAN.md
carry accepted refactor decisions. Relative legacy `docs/`, `.deckent/workspace/`, `src/` and
`scripts/` references below resolve in the legacy repository for reading only; inspect target
implementation separately. Do not run legacy generation, recovery, MCP or dogfood commands for Next.


# Deckent Terminal Design

## Objective

Make Terminal a first-class control and operator surface, not a reduced Desktop. Load
deckent-design-dna and the relevant product or agentic skill.

Terminal is one stable product surface. Basic/Advanced are Desktop-only disclosure modes; never
project them onto Terminal, create parallel density shells or rename them as Terminal modes.
Contextual disclosure, focus and drill-down reveal detail without changing surfaces. Ask/Run/Control,
where present, are authority postures and must not be treated as visual-density modes.

The accepted composition is **Causal Workline with contextual Work Ledger**. Workline is the
default causal shell. `/runs --follow` may replace its bounded dynamic region with a live ledger;
selection returns to Workline on the same canonical identity. Never render A+C as permanent split
panes, simultaneous input owners or a second Terminal dashboard shell.

## Feasibility gate

A Terminal composition is invalid until every region and interaction maps to a real terminal
primitive available through the current Node/Ink architecture or to an explicitly named foundation
dependency. A browser mockup is evidence of hierarchy only.

- Never require or claim control of the user's terminal font, font weight rendering, background
  color, window chrome, pointer, hover, clipboard or notification system.
- Inherit the user's monospace font and light/dark background. Prefer the terminal's default
  background; resolve foreground color through the existing ANSI tier and suppression authority.
- Compose with sequential Ink layout, conditional region replacement and native scrollback. CSS
  overlays, absolute positioning, floating windows and browser-style clickable buttons are not
  production interactions.
- Keyboard and slash-command paths are primary. Mouse support may be additive only after an exact
  capability probe and may never be the only path.
- Admit the rich surface only for an interactive TTY whose required raw-input and rendering
  capabilities are available. Otherwise degrade honestly to a line-oriented or non-interactive
  surface; `isTTY` alone is not proof of every capability.
- Measure widths in terminal display cells and account for rows as well as columns. Provide ASCII
  markers when Unicode/box-drawing width or encoding is not trustworthy.
- Preserve main-screen native scrollback by default. Alternate-screen behavior is opt-in and can
  never be required for the primary workflow.
- Model platform signals explicitly: POSIX SIGINT/SIGTERM and Windows SIGINT/SIGBREAK are different
  adapters. Escape closes focus; it never promises process cancellation without a real abort seam.

Respect current workspace ownership. If implementation output such as src/cli is outside the
active lane, produce the exact design/interaction contract and coordinate before editing it.

## Environment modes

These are runtime/terminal capability conditions for the same product surface, not selectable UI
modes or alternate information architectures.

Design and test each applicable mode:

| Mode | Contract |
|---|---|
| Interactive TTY | Rich hierarchy, keyboard control and live updates |
| Non-interactive TTY | Stable progress and final result without required input |
| Pipe or redirect | Deterministic machine-safe output; no cursor control |
| NO_COLOR or dumb terminal | Meaning preserved without color or animation |
| Truecolor, 256, 16 color | Honest semantic degradation |
| Unknown or light background | Default background retained; foreground roles remain legible |
| Legacy/limited Windows console | Capability-gated line UI or explicit unsupported result |
| Narrow or resized viewport | Reflow/truncation with access to full values |
| Lost connection | Last-known state, freshness and recovery are explicit |

Machine-readable output is a separate contract; never decorate it.

## Interaction rules

- Use stable text hierarchy, alignment and whitespace before color.
- Emoji are not interface icons.
- Every status has a textual carrier.
- Keyboard help is discoverable and scoped to the current context and available authority.
- Focus and selection remain visible after streaming updates.
- Pause, cancel, retry and approval shortcuts state their exact target.
- Logs preserve raw content, timestamps and attribution while offering structured navigation.
- Truncation never hides an identifier without a way to reveal or copy it.
- Long operations provide state, elapsed time, freshness and the next safe action.
- Screen updates avoid flicker, scroll theft and inaccessible animation.

## Cross-platform behavior

Account for POSIX shells, PowerShell, Windows Terminal, cmd where supported, WSL, SSH and common
CI environments. Resolve Unicode width, wrapping, alternate-screen behavior, signal handling,
clipboard assumptions and keybinding collisions honestly. Unsupported capability fails explicitly.

Maintain a platform-capability matrix for macOS, Linux, Windows native, WSL, SSH/multiplexers and
CI/pipe use. Shell name is not a rendering capability. Each rich behavior needs real-binary proof
on the platform or a typed unverified/unsupported classification; one xterm PTY simulation cannot
stand in for the whole matrix.

## Accessibility and i18n

- Preserve reading order in the output stream.
- Avoid rapid live-region-like churn and decorative spinners.
- Respect reduced animation behavior and color suppression.
- Use the existing message system for all user-visible text.
- Test Turkish glyphs, long translations, RTL-sensitive composition assumptions and narrow widths.
- Never rely on case, punctuation shape or color alone for state.

## Parity contract

Terminal and Desktop share authoritative nouns, lifecycle, permissions, evidence and action
consequences. Terminal keeps one surface while Desktop may use Basic/Advanced disclosure; their
navigation and presentation may differ without changing semantic truth. Dashboard remains
observability only.

## Verification

Capture representative real-binary sessions on macOS, Linux, Windows native and WSL for supported
color tiers, light/dark user themes, Unicode/ASCII markers, pipe output, resize, keyboard paths,
failure/recovery, localization and Workline → Ledger → selected Workline focus preservation. Token
changes use design-tokens-pipeline. Finish with deckent-design-critic.
