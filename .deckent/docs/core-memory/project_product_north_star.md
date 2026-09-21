# Deckent product north star

Owner direction, 2026-09-21. This is the shared product and development decision context.
It describes the target and evaluation criteria, not proof that all capabilities exist.

Deckent is a customer-installed Agent OS that turns human or AI intent into authorized,
coordinated, verifiable work and durable business processes. Humans, AI agents and tools
use one typed application contract across SDK, MCP, CLI and other product surfaces.
A single person must be able to manage substantial work; teams and 10,000-person enterprises
must have the same quality foundations. Millions of users are design context, not measured capacity.
OpenAI, Anthropic, IBM, Michael Page, Google, Tesla and SpaceX illustrate the intended quality bar;
these names imply neither customers, endorsements nor proven suitability.

## Product criteria

- Enterprise-grade security, reliability, ergonomics and performance from each delivered slice.
  No MVP ceiling, reduced product ambition or permission shortcuts for solo users.
- Solo, team, on-prem, customer cloud and air-gapped deployment. Secure Core stands alone;
  proprietary Enterprise stays separately distributed. Organization policy can narrow authority.
- Human and direct-AI operation share identity, scope, policy, approval, error and result semantics.
  Persona, model advice, UI convenience and timeouts never grant authority.
- Deterministic validated transitions, scheduling and effects have one owner and durable evidence.
  AI can propose intent and plans; it cannot bypass authorization or choose internal SQL.
  External model responses are probabilistic: do not claim deterministic outputs from them.
- Isolate filesystem, process, network and secrets; bound concurrency, queues, retries and resources.
  Cancellation, uncertain effects, crash recovery and safe delivery belong to the initial contract.
- Compact, modular implementation with explicit ports, dependency direction and version boundaries.
  Compactness removes duplication, not business capabilities. Entity counts are not quality metrics.
  Mutable business policy comes from registries/config; security and protocol invariants are versioned code.
- Optimize measured end-to-end latency, tail latency, throughput, cost and operator effort together.
  Record workload, environment and version; local test limits are not global product ceilings.
- Learning requires scoped evidence, evaluation and rollback; no silent cross-customer learning.
  Installed mechanisms, product wiring, verified behavior and accepted outcomes are separate claims.

## Development process and decision criteria

Preserve successful responsibilities and explain causes of failures from roughly 700 legacy iterations.
For each relevant lesson record source, failure cause, correction and a regression/negative proof.
Legacy is read-only evidence, not execution authority or an obligation to copy its structure.
Proceed through bounded, complete, reviewable responsibilities under ARCHITECTURE.md and PLAN.md.
Small implementation slices do not mean a small product. Avoid perpetual analysis and redesign.
Reopen accepted decisions only with explicit owner direction or new evidence of a material conflict;
explain what changed, the gain/loss and the smallest justified amendment before changing the boundary.
The full business ontology remains open for owner review: neither Run/Task/Attempt alone nor the old
mandatory seven-level hierarchy is automatically accepted as the final Agent OS model.

Every Jev decision consultation carries this exact shared context plus authored current stage,
accepted decisions, evidence, unknowns, next step and option tradeoffs. Compare options against
security, determinism, human/AI usability, scale, speed, modularity and migration cost; disclose gaps.
Do not equate enterprise quality with maximal machinery or prefer a rewrite without evidence.
Retain none_of_the_above and insufficient_information; advice is not proof or owner permission.
Only this curated public-policy context is automatically included, never arbitrary memory or source.
