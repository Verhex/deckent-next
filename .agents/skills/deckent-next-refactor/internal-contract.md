# Deckent — product development contract

The complete stable contract for Next work. Dated owner rules live in the laws
(`.deckent/docs/core-memory/`) and the ARCHITECTURE decision log; this file points to them.

## Purpose and authority
- Build the customer-installed Agent Control & Execution Plane for human, AI and tool-driven work, solo to enterprise.
- The north star (`.deckent/docs/core-memory/project_product_north_star.md`) is the shared quality bar;
  Enterprise-grade is the target of every slice, and small slices never reduce the product ambition.
- Live owner instructions take precedence, then `ARCHITECTURE.md` and `PLAN.md`. Core-memory in this repo is
  authority; HOME/legacy copies are not. Reopen accepted decisions only for owner direction or material new evidence.

## Engineering contract
- Reuse one typed application contract across human and AI surfaces; one owner per state transition.
- Keep domain pure, adapters behind ports and composition explicit; version contracts and migrations.
- Carry principal, scope, resource and policy through every operation. Persona never grants authority.
- Target scope is installation > company > optional site/unit > project > session; company policy is Core, customer IdP/SIEM are adapters.
- `do` proposes and admits Runs independently of Mission; business processes reuse the operation catalog and existing execution authority.
- Keep secure Core standalone and proprietary Enterprise outside public artifacts and history.
- Every Core contract lets Enterprise and ERP adapters (IFS, SAP, Oracle, Microsoft, Uyumsoft, Logo) layer on via
  registry without editing Core; no new module-specific effect flow (law 10, `law_enterprise_layering.md`).
- Enforce filesystem/process/network/secret boundaries; workspace separation alone is not isolation.
- Preserve bounded resources, cancellation, recovery and uncertain-effect handling.
- Mutable policy and user strings belong in registries/catalogs; invariants remain versioned code.
- Preserve legacy successes; pair relevant failure causes with corrections and negative proof.
- Optimize measured end-to-end behavior, resource cost and human effort; do not claim unmeasured scale.
- Keep modules compact by responsibility, not by dropping capabilities or duplicating mechanisms. Read the current
  machine gates (`arch.json`, `scripts/lint-arch.mjs`) for language, package, file-size, version and migration limits.

## Working rules
- Verify the current state of any API, SDK, library, protocol, standard or vendor from official sources and
  context7/registries before design, code or advice; record date, source, established practice and current state.
- Reconcile affected documents at task start, when accepted scope changes and before delivery (law 4).
- Preserve concurrent edits, other contributors' WIP and accepted authority; never promote analysis into a decision
  or historical proof into a fresh result. Work in bounded, complete, reviewable slices.
- Explain progress and results in plain Turkish with observable behavior and evidence (law 3).
- Continue authorized work without repeated permission; new scope or authority boundaries need a checkpoint.
- Use logged Jev for material judgments (law 8); advice is not acceptance.
- Verify actual producer-to-surface behavior and relevant failure paths; test green alone is not closure (law 1).
- Test through public seams agreed for the slice, one red → green slice at a time. Expected values come from an
  independent source (spec, worked example, known-good literal); an assertion that recomputes the code's own
  formula is tautological and proves nothing.
- Verification cadence, the 16 GB limit, `VITEST_MAX_FORKS=2` and "no build during a suite" follow law 7.
- Commit inside the assigned scope without asking; workers never push. Release, landing, live/N1 switch and
  dogfood are lead-only with owner approval per merge and per switch and green hosted PR CI before merge.
- Refresh the memory manifest after authorized core-memory edits: `node scripts/lint-core-memory.mjs --write`.
- `AGENTS.md` is the single contributor instruction file, at or below 70 lines; `CLAUDE.md` only imports it with `@AGENTS.md`.

## Current development phase
- Next owns product development and all operator/execution work; use this repository as cwd.
- `deckent-dev` is the frozen pre-refactor reference: read only, never run its runtime or workers.
- External refactor documents and proof live in `<refactor-work>/`, outside Git/npm.
- DOGFOOD is ON (owner 2026-10-09 approval, on since 2026-10-10; ARCHITECTURE decision log); operating it is lead-only.
- Review channel, thresholds and independent review: law 8 (`law_second_opinion_jev.md`); one review per batch
  before merge; never fabricate independent review or treat Jev/self-review as independent PASS.
- Host lane count comes from the outcome DAG, disjoint write ownership and measured capacity (law 5), not a fixed
  number; review lanes never exceed author lanes. Current machine gates remain enforced.
