---
name: deckent-workspace-design
description: deckent Desktop workspace architecture - docking, tabs, split panes, resizing, sidebars, inspectors, command palette, focus restoration, saved layouts, multi-window, multi-monitor and scale-factor behaviour.
---


# deckent Workspace Design

## Objective

Design a professional operator workspace that remains understandable from one active run to
large-scale multi-project supervision. Load deckent-design-dna plus the relevant product and
agentic skills.

## Runtime truth

Accepted Desktop carrier: Tauri 2 + React (owner 2026-11-08, confirmed 2026-11-10); Desktop is a
simple chat app (owner 2026-11-10). See the design-dna reference and
[architecture decision log](../../../.deckent/docs/architecture/decisions.md); D2–D7 remain unchanged.
The earlier Electron + React carrier is historical. Runtime authority remains in the separate service.
Next's inspected bridge source is `src/surfaces/core/desktop/internal/bridge-contract.ts`; it does not
prove the state of the external `deckent-desktop` UI or a completed migration. Inspect PLAN and actual
wiring before claiming a capability is shipped. Keep one shell and one authority rather than
separate Classic/NOVA products. Before implementation, verify current official Tauri 2 security,
sidecar, per-OS webview, packaging and signing guidance; renderer integration cannot become a second
execution or secret authority.

## Workspace model

Apply the direction in the design-dna reference (`current-owner-decisions.md`): one chat-first main
view plus governed detail panels opened by progressive disclosure; reserve durable routes and panes for
deep or sustained work. Copy proven Claude/Codex app layout behaviour rather than inventing it.

Define:

- global navigation and project/workspace scope;
- primary work area and current task context;
- inspectors and evidence views;
- terminal/log/artifact panes;
- transient overlays versus durable panes;
- commands, shortcuts and discoverability;
- layout persistence, versioning and recovery.

The default layout must support the Golden Workflow. Specialized layouts may optimize research,
development, operations or enterprise review without changing product semantics.

## Interaction requirements

- Every operation is reachable by keyboard and visible interaction.
- Focus order follows causal work, not DOM accident.
- Closing, moving or restoring a pane has predictable focus behavior.
- Splitters provide keyboard operation, minimum sizes and announced values.
- Tabs expose dirty, live, stale, failed and attention states without color alone.
- Command palette results show scope, consequence and shortcut.
- Destructive layout reset is distinguishable from clearing product data.
- Background work remains discoverable after navigation.
- Reconnect restores truthful state, not a stale optimistic snapshot.

## Platform and scale matrix

Resolve from the start:

- macOS, Linux, Windows native and WSL conventions;
- Cmd versus Ctrl shortcut presentation;
- high DPI, fractional scaling, zoom and text resizing;
- small laptop through large and multi-monitor workspaces;
- window movement across different scale factors;
- input by keyboard, pointer and assistive technology;
- reduced motion, forced colors and system contrast;
- very long labels, Turkish text and future locale expansion;
- large trees, logs and run histories without blocking interaction.

Do not make platform behavior identical when conventions differ; preserve equivalent capability
and meaning.

## Saved layouts

Treat a layout as versioned user data. Specify schema evolution, invalid pane recovery, missing
provider/capability behavior, safe defaults, company/project scoping and reset semantics. Never
silently discard a user's layout.

## Required evidence

Provide layout/state maps, keyboard routes, focus restoration cases, responsive and scale-factor
captures, persistence/migration tests and real Desktop interaction proof. Use
deckent-design-critic for the independent verdict.
