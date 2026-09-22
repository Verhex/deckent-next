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
- Enforce filesystem/process/network/secret boundaries; workspace separation alone is not isolation.
- Preserve bounded resources, cancellation, recovery and uncertain-effect handling.
- Mutable policy and user strings belong in registries/catalogs; invariants remain versioned code.
- Preserve legacy successes; pair relevant failure causes with corrections and negative proof.
- Optimize measured end-to-end behavior, resource cost and human effort; do not claim unmeasured scale.
- Keep modules compact by responsibility, not by dropping capabilities or duplicating mechanisms.

## Working method
- At every task start, read `ARCHITECTURE.md`, `PLAN.md`, `follow-up-works/current-flow.md` and relevant local core-memory; reconcile affected claims with code and evidence.
- Update affected core documents at task start when stale claims are verified, whenever accepted decisions or scope change, and before delivery or handoff; this is mandatory.
- Keep durable scope/status in `PLAN.md`, contracts in `ARCHITECTURE.md`, lasting decisions in core-memory, and current work/evidence/next step in `current-flow.md`.
- Before reporting completion, document implemented behavior, verification, open limits and the concrete next step; documentation reconciliation is part of delivery.
- Preserve concurrent edits and accepted authority; never promote analysis into a decision or historical proof into a fresh result. Leave unaffected documents unchanged.
- Preserve other contributors' WIP; work in bounded, complete, reviewable slices.
- Explain progress and results in plain Turkish, with observable behavior and evidence.
- Continue authorized work without repeated permission; new scope/authority boundaries need a checkpoint.
- Use logged Jev preparation often (options, boundaries, checks, evidence fit), carrying the north star and current process.
- Include real gains/losses, contrary evidence and both abstention choices; advice is not acceptance.
- Verify actual producer-to-surface behavior and relevant failure paths; test green alone is not closure.
- Run `npm run verify` before landing; no build during an active test suite.
- Local tests stay within 16 GB, normally `VITEST_MAX_FORKS=2`; this is not a product concurrency limit.
- Commit only with owner authorization; publish/push needs its own authorization.
- Refresh the memory manifest after authorized edits: `node scripts/lint-core-memory.mjs --write`.
- Keep both `AGENTS.md` and `CLAUDE.md` at or below 70 lines.

## Current development phase
- Next owns product development and all operator/execution work; use this repository as cwd.
- For Next cards read `.agents/skills/deckent-next-refactor/SKILL.md`; reuse unchanged session reads.
- `deckent-dev` is the frozen pre-refactor reference: read only, never run its runtime or workers.
- External refactor documents/proof: `/home/alperen/deckent-refactor-work`, outside Git/npm.
- `PLAN.md` holds durable workstreams; `follow-up-works/current-flow.md` is replaceable progress only.
- Current machine gates remain enforced; host-kit Markdown is an owner-authorized exception.
- DOGFOOD stays OFF until explicitly admitted; historical receipts do not prove Next completion.
- Review channel (owner 2026-09-23): Opus implements, Astra reviews via `.agents/refactor/channel.mjs`; recipients consume handled entries.
- Never fabricate independent review or treat Jev/self-review as independent PASS.
