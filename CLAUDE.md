# Deckent — product development contract

## Purpose and authority
- Build the customer-installed Agent OS for human, AI and tool-driven work, from solo to enterprise.
- Read `.deckent/docs/core-memory/project_product_north_star.md` for the shared product quality bar.
- Enterprise-grade is the target of every slice; small slices never reduce the product ambition.
- Live owner instructions take precedence, then `ARCHITECTURE.md` and `PLAN.md`.
- Read `.deckent/docs/core-memory/MEMORY.md` in this repo; HOME/legacy copies are not authority.
- Preserve accepted decisions; reopen them only for owner direction or material new evidence.

## Engineering contract
- Reuse one typed application contract across human and AI surfaces; one owner per state transition.
- Keep domain pure, adapters behind ports and composition explicit; version contracts and migrations.
- Carry principal, scope, resource and policy through every operation. Persona never grants authority.
- Target scope is installation > company > optional site/unit > project > session; company policy is Core, customer IdP/SIEM are adapters.
- `do` proposes and admits Runs independently of Mission; business processes reuse the operation catalog and existing execution authority.
- Keep secure Core standalone and proprietary Enterprise outside public artifacts and history.
- Enterprise is the commercial target (owner 2026-09-23): every Core contract must let Enterprise and ERP adapters
  (IFS, SAP, Oracle, Microsoft, Uyumsoft, Logo) layer on via registry without editing Core; no new module-specific effect flow.
- Enforce filesystem/process/network/secret boundaries; workspace separation alone is not isolation.
- Preserve bounded resources, cancellation, recovery and uncertain-effect handling.
- Mutable policy and user strings belong in registries/catalogs; invariants remain versioned code.
- Preserve legacy successes; pair relevant failure causes with corrections and negative proof.
- Optimize measured end-to-end behavior, resource cost and human effort; do not claim unmeasured scale.
- Keep modules compact by responsibility, not by dropping capabilities or duplicating mechanisms.

## Working method
- At every task start, read `ARCHITECTURE.md`, `PLAN.md`, your process-board row (`node .agents/refactor/board.mjs show`) and relevant local core-memory; reconcile affected claims with code and evidence.
- Before any design, code or advice touching an API, SDK, library, protocol, standard or vendor, verify the current state with WebSearch/WebFetch (official docs, specs, changelogs) and context7/package registries; record established practice vs current state with date and source (owner 2026-09-28).
- Update affected core documents at task start when stale claims are verified, whenever accepted decisions or scope change, and before delivery or handoff; this is mandatory.
- Keep remaining scope in `PLAN.md` (completed work moves to `COMPLETED-PLAN.md`, read only when needed), contracts in `ARCHITECTURE.md`, lasting decisions in core-memory, who-holds-what/next step on the host process board, proof in the external proof folder; `current-flow.md` is a pointer only (owner 2026-10-03).
- Before reporting completion, document implemented behavior, verification, open limits and the concrete next step; documentation reconciliation is part of delivery.
- Preserve concurrent edits and accepted authority; never promote analysis into a decision or historical proof into a fresh result. Leave unaffected documents unchanged.
- Preserve other contributors' WIP; work in bounded, complete, reviewable slices.
- Explain progress and results in plain Turkish, with observable behavior and evidence.
- Continue authorized work without repeated permission; new scope/authority boundaries need a checkpoint.
- Use logged Jev preparation often (options, boundaries, checks, evidence fit), carrying the north star and current process.
- Include real gains/losses, contrary evidence and both abstention choices; advice is not acceptance.
- Verify actual producer-to-surface behavior and relevant failure paths; test green alone is not closure.
- Targeted checks per slice (typecheck, eslint on changed files, lint-arch, the touched test files); full `npm run verify` only for batches that add broad features, and only when the owner asks (owner 2026-10-03: repeated full verifies cost time, tokens and machine); no build during an active test suite.
- Local tests stay within 16 GB: full verify uses 4 workers (default), targeted/lane runs `VITEST_MAX_FORKS=2`; not a product limit.
- Commit only with owner authorization; publish/push needs its own authorization.
- Refresh the memory manifest after authorized edits: `node scripts/lint-core-memory.mjs --write`.
- Keep both `AGENTS.md` and `CLAUDE.md` at or below 70 lines.

## Current development phase
- Next owns product development and all operator/execution work; use this repository as cwd.
- For Next cards read `.agents/skills/deckent-next-refactor/SKILL.md`; reuse unchanged session reads.
- `deckent-dev` is the frozen pre-refactor reference: read only, never run its runtime or workers.
- External refactor documents/proof: `/home/alperen/deckent-refactor-work`, outside Git/npm.
- `PLAN.md` holds durable workstreams; the host process board (`.deckent/host/process-board.json`, outside Git, own row only, main reconciles, workers as main sub-list) holds who holds what and what is next.
- Main notifies the owner only when the owner must act (decision with Jev scores, owner-only command, landing/live done, blocker), at most two lines; no interim or worker notifications (owner 2026-10-03).
- Current machine gates remain enforced; host-kit Markdown is an owner-authorized exception.
- DOGFOOD stays OFF until explicitly admitted; historical receipts do not prove Next completion.
- Review channel (owner 2026-09-23): Opus implements, Astra reviews via `.agents/refactor/channel.mjs`; recipients consume handled entries.
- Owner 2026-10-05: CI green first in one lane, then frozen current-closure landing; no new preparation/analysis lanes until both land.
- Review once per batch before landing; do not review preparation, plans or documents separately. At most one correction round, then logged Jev selection >=0.90 decides; below that ask owner.
- Current-closure changes reopen only for real P0/P1. After these land, use 4–6 parallel product-author lanes, with no more review lanes than author lanes.
- Owner 2026-10-05: Qwen development-host tool uses separate source/docs commits and a PR; Astra review is exempt for this host-tool delivery only. Model-quality/HF publication acceptance stays separate.
- Never fabricate independent review or treat Jev/self-review as independent PASS.
