---
name: deckent-versioned-handoff
description: Transfer exact Deckent session authority through the canonical prepared, verified, and committed receipt protocol. Do not use transcripts or premature handoff as authority.
---

## Next refactor scope — 2026-09-17

For current Deckent Next work, first apply `deckent-next-refactor` from the host skill directory.
Product writes target `/home/alperen/deckent-next`; legacy `/home/alperen/deckent-dev` is a read-only
reference except the owner-authorized host tooling/channel setup. Next ARCHITECTURE.md and PLAN.md
carry accepted refactor decisions. Relative legacy `docs/`, `.deckent/workspace/`, `src/` and
`scripts/` references below resolve in the legacy repository for reading only; inspect target
implementation separately. Do not run legacy generation, recovery, MCP or dogfood commands for Next.

For refactor planning/execution/review, use the per-card loop and proof requirements in
`deckent-next-refactor`, then stop here. The historical runtime protocol below applies only
when the user explicitly requests that legacy runtime operation; it is not a Next admission gate.

## Historical legacy runtime procedure


# Deckent Versioned Handoff

## Admission gate

Start only when all three are true: the owner accepted the comprehensive analysis, the interactive
outcome order is final, and the receiving main session's exact authority and first authorized task
are defined. Otherwise do not create a handoff receipt.

Read `$deckent-authority-bootstrap` and the versioned handoff schema in
`docs/governance/deckent-dev-operating-policy.md` from the current HEAD. A transcript, summary,
generated export, or prior handoff cannot substitute for fresh measurement.

## Fresh transfer snapshot

Re-measure branch, base/head SHA, upstream relation, worktree diff and ownership, active runtime,
bot, sprint/Flow/Run/workers/containers, locks, `.tasks`, MASTER validator and exact outcome state,
Closure OS head, receipts, policy and scope digests, open HOLDs, and owner-only pending gates. Do not
read secrets, raw `.brain/memory.db`, or mutate runtime while measuring.

Separate delegated decisions and permissions from findings that remain non-authoritative. State the
receiving session's exact first authorized action, negative scope, stop conditions, and which
actions still need owner approval.

## Protocol

Use the canonical receipt fields: `schemaVersion`, `outcomeId`, `role`, `baseSha`, `headSha`,
`branch`, `policyDigest`, `scopeDigest`, `filesChanged`, `verification`, `findings`, `openActions`,
`recommendedNextAction`, and `receiptDigest`.

Advance only:

1. `prepared` — producer writes the fresh, digest-bound candidate;
2. `verified` — an independent consumer remeasures and verifies it;
3. `committed` — authority transfers only after verified evidence and canonical receipt checks.

Use the repository's documented handoff tooling for verification. No placeholder evidence,
self-verified receipt, transcript relay, or silent field repair is allowed. Commit/push remain
separate owner gates. Any drift between phases invalidates the candidate and requires a fresh
prepared receipt.
