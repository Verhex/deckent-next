# Current Deckent Owner Design Decisions

This file is the single home of the Deckent design direction; other design skills point here.

Authority, newest first (Alperen live design direction):
- 2026-10-18: follow proven Claude Code / Codex app UX instead of reinventing interaction; Basic/Advanced
  Desktop modes are removed in favour of one chat-first main view.
- 2026-10-16: no Desktop decision surface before beta; approvals stay in the Terminal.
- 2026-10-09: chat-first main view with detail panels; "Kâğıt ve Mürekkep" light theme primary, "Gece Gölü"
  dark theme; Atkinson Hyperlegible type system; Stitch's first Desktop/Dashboard designs rejected.
- 2026-08-25: the remaining accepted product, Terminal and detail-surface decisions below.

These are product/design targets subject to live owner instructions and current ARCHITECTURE/PLAN. They do
not prove a shipped Desktop, Terminal behavior or runtime health; verify actual wiring and platform evidence.
Read this file before proposing or revising Deckent product, Desktop workspace or visual-language direction.
These are active decision constraints, not inspiration. Do not repackage a rejected direction under a new name.

## Desktop direction (2026-10-09, 2026-10-16, 2026-10-18)

- **Main view.** One calm, chat-first main view with the same function and flow as the Terminal (reference:
  the Claude and Codex apps). It shows only light information, such as how many workers run and that
  background work proceeds. Never put everything on one screen.
- **Detail panels.** Selecting an item opens a detail or control panel for agents, runs, workers, approvals,
  protocols, settings, notifications, reminders, integrations and connections. Through progressive
  disclosure the user reaches complete mastery of every surface; each panel stays calm and functional.
- **Proven UX.** For every interaction, name the Claude Code / Codex reference behaviour being copied
  (for example a fixed input bar that never moves, inline cards in the conversation).
- **Before beta.** Desktop carries no decision surface; approvals stay in the Terminal. The full approval
  and intervention control plane below remains the post-beta target.
- **Themes.** "Kâğıt ve Mürekkep" (light, primary): canvas `#F6F2EA`, text `#24211C`, accent `#2E4A68`.
  "Gece Gölü" (dark): canvas `#191B1A`, text `#E7E3D9`, accent `#A9BFD6`. Full role values live in the
  separate `deckent-desktop` repository, `ui/src/styles.css` (see `design-tokens-pipeline`).
- **Type.** Atkinson Hyperlegible Next for the interface and Atkinson Hyperlegible Mono for code, with
  Literata only for long prose. All OFL and self-hosted. Text must be fluid and easy to read.
- **Carrier.** Electron + React in the separate `deckent-desktop` repository (`contract/`, `shell/`, `ui/`);
  Next holds the typed bridge contract.

## Accepted product direction

- Desktop is a full management, intervention, approval, integration and enterprise-system control
  plane (post-beta target for decisions). It is not an observability-only dashboard.
- Terminal carries the same product jobs and canonical authority for developer and expert teams.
  **Causal Workline with contextual Work Ledger** is the accepted single-surface design baseline:
  Workline is the default causal shell; `/runs --follow` opens Ledger as a temporary lens in the
  same bounded dynamic region. It remains subject to real-terminal feasibility and platform proof.
- Software delivery is one domain profile. Orders, production, ERP and other governed business
  processes use the same execution, permission, intervention, evidence and audit semantics.
- Execution mediation is a cross-cutting capability of the one Deckent kernel, not a fourth product
  face or an isolation-only product identity. The same product may execute directly in a canonical
  workspace or mediate AI through staged, isolated, brokered or remote realms according to
  installation topology, effective policy, task risk and platform capability evidence.
- Named execution profiles are user-facing presets only. Durable authority records the exact
  resolved realm, workspace projection, effects, filesystem/network/secrets capabilities and
  landing policy; an unavailable stronger realm never silently downgrades to direct host effects.
- Docker, Firecracker or another container/microVM/runtime is an execution-realm adapter, never a
  separate Deckent edition, kernel or product identity.
- Desktop and Terminal share one object, state, permission and command model; disclosure never
  creates separate shells, runtimes, editions or products.
- Terminal has one stable operator surface. Do not add disclosure modes, density variants or a
  second product shell to Terminal. Contextual disclosure may reveal more detail within that same
  surface; Ask/Run/Control, where present, describe authority posture rather than UI density.
- Terminal design inherits the user's configured monospace font, background/theme and host
  capabilities. It may not require Geist Mono, a dark background, pointer/hover, floating browser
  geometry or Unicode box drawing. Rich composition is capability-admitted; limited terminals get
  the same semantics through an honest line-oriented/ASCII fallback.
- The chat-first main view answers what is happening, what changed, what needs attention and what
  can safely be done.
- Selecting a work item or process from the main view opens a contextual detail surface
  that supports both inspection and bounded changes. Deep or sustained work may promote the same
  selected object into a full route without losing context.
- Detail panels expose causality, topology, lifecycle, freshness, authority, evidence, principal,
  policy, cost/capacity and audit detail while preserving the business outcome.
- High-value micro-elements such as counts, progress, freshness, approvals and connection
  health must be deliberately legible. Small does not mean faint, ornamental or ambiguous.
- Screen complexity must be reduced through progressive disclosure and contextual detail, not by
  hiding risk, authority, consequence, evidence or unknown state.
- Theme count and palette variants are configurable projections. Screen hierarchy and state meaning
  remain stable across themes.
- Terminal shares semantic roles and restrained tone with Desktop, not Desktop typography,
  background or pixel composition. Acceptance is directional and does not freeze screen-level craft.
- The main view's state presentation stays simple: progress, current phase and last material
  change. Detailed state axes belong in the detail panel unless an approval, recovery or
  unknown-state condition needs attention.
- The main view must feel effective and simple. Do not create several visible state grammars,
  motifs or explanatory layers merely to make the state treatment distinctive.

## Contextual detail surface contract

- Use a non-destructive context drawer or anchored detail surface for quick inspection and bounded
  management from the main view.
- Preserve the selected canonical object, background context and return focus.
- Show identity, current state and age, business impact, responsible principal, evidence summary,
  available intervention and next safe action before secondary telemetry.
- Separate inspection from mutation. A dangerous or elevated action opens a focused confirmation
  step showing scope, authority, consequence, expiry and rollback/reconciliation limits.
- The drawer must be keyboard reachable, Escape dismissible when safe, focus-contained while modal,
  screen-reader named and responsive to a full-width sheet at narrow sizes.
- A popup is not a substitute for a durable full route, stable deep link, large table, log stream,
  policy editor or multi-step administration flow.

## Rejected directions — do not re-propose

- ui-ux-pro-max or generic database-generated UI direction.
- Desktop framed primarily as a run viewer or passive monitoring dashboard.
- The initial Golden Workflow A/B/C shell explorations as product-level IA; they are retained only
  as rejected design history.
- Stitch's first Desktop and Dashboard designs (2026-10-09), and AI-tool default looks: Inter/Material,
  neon dark dashboards, generic SaaS styling.
- The Graphite Operations shell and the Bricolage Grotesque + Geist Mono hierarchy (superseded
  2026-10-09); Hanken Grotesk as the primary interface typeface.
- Basic/Advanced Desktop disclosure modes (superseded 2026-10-18 by the single chat-first main view).
- A dense topology, forensic inspector and event ledger all permanently open in the main view.
- Separate Classic/NOVA products.
- Generic interchangeable card walls, AI gradients, glow, glass, sci-fi HUD or fake telemetry.
- Colored rounded status pills and generic “On track”, “Running” or “Complete” labels as the primary
  main-view state language.
- A generic AI/admin-dashboard status strip or metric-card grammar that collapses lifecycle,
  freshness, authority, evidence and outcome into one optimistic summary.
- The Operational Index, Transition Trace and Exception Field state-language exploration; it is
  too complex and pattern-heavy for quick tracking.
- Rendering lifecycle, freshness, authority, evidence and outcome as five simultaneous main-view
  motifs. Preserve the truth model, then disclose detail contextually.
- Terminal disclosure or density modes, or any attempt to map Desktop disclosure onto Terminal
  authority posture.
- A+C rendered as permanent split panes, simultaneously competing input regions, or a second
  Terminal dashboard shell. Work Ledger is contextual disclosure inside Causal Workline.
- Terminal designs that depend on a shipped font, forced dark background, CSS-style overlay,
  clickable button, pointer/hover, clipboard, alternate screen or one Unix-only signal path.
- Decorative popups, hover-only controls, confirmation theater or optimistic terminal success.
- A language/theme control that visually promises a complete variant without real parity.

## Reopening rule

Reopen a rejected direction only when:

1. Alperen explicitly asks to revisit it; or
2. new repository/runtime/accessibility evidence makes an accepted decision impossible.

In the second case, present the exact evidence and the smallest necessary reconsideration. Do not
restart broad direction exploration or spend owner time re-arguing settled context.
