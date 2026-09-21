# Current Deckent Owner Design Decisions

Authority: Alperen live design direction, 2026-08-25.

Read this file before proposing or revising Deckent product, Desktop workspace or visual-language
direction. These are active decision constraints, not inspiration. Do not repackage a rejected
direction under a new name.

## Accepted product direction

- Desktop is a full management, intervention, approval, integration and enterprise-system control
  plane. It is not an observability-only dashboard.
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
- Basic and Advanced are Desktop-only disclosure modes over one object, state, permission and
  command model. They are not separate shells, runtimes, editions or products.
- Terminal has one stable operator surface. Do not add Basic/Advanced, density variants or a
  second product shell to Terminal. Contextual disclosure may reveal more detail within that same
  surface; Ask/Run/Control, where present, describe authority posture rather than UI density.
- Terminal design inherits the user's configured monospace font, background/theme and host
  capabilities. It may not require Geist Mono, a dark background, pointer/hover, floating browser
  geometry or Unicode box drawing. Rich composition is capability-admitted; limited terminals get
  the same semantics through an honest line-oriented/ASCII fallback.
- Basic defaults to one calm operational home. It answers what is happening, what changed, what
  needs attention and what can safely be done.
- Selecting a work item or process from the operational home opens a contextual detail surface
  that supports both inspection and bounded changes. Deep or sustained work may promote the same
  selected object into a full route without losing context.
- Advanced exposes causality, topology, lifecycle, freshness, authority, evidence, principal,
  policy, cost/capacity and audit detail while preserving the business outcome.
- High-value micro-elements such as counts, progress, freshness, approvals and connection
  health must be deliberately legible. Small does not mean faint, ornamental or ambiguous.
- Screen complexity must be reduced through progressive disclosure and contextual detail, not by
  hiding risk, authority, consequence, evidence or unknown state.
- Theme count and palette variants are configurable projections. Screen hierarchy and state meaning
  remain stable across themes.
- Hanken Grotesk is replaced. Bricolage Grotesque is the continuing interface baseline: readable
  in long sessions, enterprise-suitable and slightly sharp rather than soft.
- The Graphite Operations shell, Bricolage Grotesque plus Geist Mono hierarchy and current
  Basic/Advanced operating model are the continuing **Desktop** baseline. Terminal shares semantic
  roles and restrained tone, not Desktop typography, background or pixel composition. Acceptance
  is directional and does not freeze ongoing screen-level craft.
- The simplified Basic state presentation is accepted as the continuing baseline. It preserves the
  earlier portfolio/progress tracking structure; its visible order is progress, current phase and
  last material change. Detailed state axes belong in the contextual drawer unless an approval,
  recovery or unknown-state condition needs attention.
- Basic must feel effective and simple. Do not create several visible state grammars, motifs or
  explanatory layers merely to make the state treatment distinctive.

## Contextual detail surface contract

- Use a non-destructive context drawer or anchored detail surface for quick inspection and bounded
  management from the main operational screen.
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
- A dense topology, forensic inspector and event ledger all permanently open in Basic mode.
- Separate Classic/NOVA products or separate Basic/Advanced product semantics.
- Hanken Grotesk as the primary interface typeface.
- Generic interchangeable card walls, AI gradients, glow, glass, sci-fi HUD or fake telemetry.
- Colored rounded status pills and generic “On track”, “Running” or “Complete” labels as the primary
  Basic state language.
- A generic AI/admin-dashboard status strip or metric-card grammar that collapses lifecycle,
  freshness, authority, evidence and outcome into one optimistic summary.
- The Operational Index, Transition Trace and Exception Field Basic state-language exploration;
  it is too complex and pattern-heavy for quick tracking.
- Rendering lifecycle, freshness, authority, evidence and outcome as five simultaneous Basic-screen
  motifs. Preserve the truth model, then disclose detail contextually.
- Basic/Advanced Terminal modes or any attempt to map Desktop disclosure modes onto Terminal
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
