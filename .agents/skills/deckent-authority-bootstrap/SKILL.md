---
name: deckent-authority-bootstrap
description: Establish a read-only Deckent Next snapshot of owner authority, repository scope, work ownership and evidence freshness at session start or after relevant context changes. Inspect runtime only when the task needs it; this skill does not admit or execute work.
---

# Deckent Next authority bootstrap

## Role and boundaries

Use `deckent-next-refactor` for the shared development method. This skill establishes the
current authority and working context before the assigned task; it does not repeat the
implementation, verification, review or documentation workflow.

Produce a read-only snapshot. Loading this skill, reading a document, receiving a channel
message or obtaining a snapshot grants no new work, runtime, recovery, delegation or release
authority. Preserve existing owner authorization; do not request it again for routine steps.
The frozen `/home/alperen/deckent-dev` repository supplies read-only historical evidence;
never run its runtime, workers, entry points, generation or recovery commands.

## When to refresh

Establish the snapshot at session start and refresh affected fields when the owner instruction,
scope, repository revision, worktree, ownership or relevant runtime/configuration changes.
Reuse unchanged session reads with their source paths and content identities. Do not reload
all sources before every small step. A prior transcript, handoff summary or historical receipt
does not replace current authority and relevant verification.

## Establish authority and repository context

- Work from `/home/alperen/deckent-next`; identify the actual checkout/worktree and Next HEAD.
  Record branch, relevant upstream relation and staged, unstaged and untracked changes.
  Check overlapping worktrees and assigned paths. Do not infer dirty-state ownership from a
  filename or branch; mark unknown ownership and preserve those edits.
- Resolve live owner instructions and repository `AGENTS.md` / `CLAUDE.md`, then the relevant
  `ARCHITECTURE.md`, `PLAN.md` and `follow-up-works/current-flow.md` content. Read local
  `.deckent/docs/core-memory/MEMORY.md` and its relevant laws; use the product north star
  already required by the shared entry guide. Refresh changed sources before relying on them.
- Identify the exact admitted objective, session role, read/write paths, authorized actions
  and remaining owner checkpoints. Distinguish a proposal or finding from an accepted task.
  Current-flow progress, channel data and legacy MASTER/DIRECTIVES are not new work authority.
- Keep owner instruction, accepted contract, implemented mechanism, historical proof and fresh
  observation separate. Use the repository precedence chain; an observation may reveal a
  conflict but does not silently amend an accepted decision.
- Missing legacy documents or MASTER/Closure OS heads are not Next prerequisites. Do not
  recreate them, invoke legacy validators or treat legacy protocols as implemented Next gates.

## Inspect runtime only when relevant

For development-only edits, report runtime as not inspected when it is outside the task.
For operator work or runtime claims, identify the actual installation, project, effective
configuration/data roots, principal/scope/policy and relevant Run/Task/Attempt when applicable.
Inspect the process, container, lock, heartbeat, execution custody and durable receipts needed
for the claim, without admitting a run or changing state.

Separate checkout HEAD from the code revision actually used by a live process. The Next host
entry `.agents/refactor/next-entry.mjs` can select a staged installation version; inspect current
entry/configuration and build/receipt evidence rather than assuming checkout code is running.
Repository source, durable product state, runtime projection and generated evidence are
different sources. A process listing or optimistic status alone does not prove execution or settlement.

Use only queries or projections whose implementation and side effects have been checked for
the relevant revision. A command named `status`, `help` or `list` is not automatically read-only.
Do not start services, build, migrate, create runs, recover, clean state or consume channel entries
as part of this snapshot. If safe inspection is unavailable, report the gap instead of guessing.
Use sanitized projections; do not read raw product databases, credentials, tokens, private keys
or secret-bearing files. Do not include secrets in commands, output or the snapshot.

## Resolve uncertainty without changing state

Record conflicting sources, their revision/time and why the applicable authority or canonical
persisted state/producer receipt governs the claim. When authority, freshness or attribution
remains unresolved, report a scoped `HOLD` for the dependent action and its missing evidence.
This is a report label, not a product-state transition. Continue unrelated authorized work
when the conflict does not affect it. Distinguish not inspected, unavailable, unknown and verified;
absence of evidence is neither success nor failure. A permitted omission is not itself a HOLD.

## Required output

Return a concise, timestamped snapshot in plain Turkish:

- Sources and content/revision identities, checkout/worktree and relevant dirty-state ownership.
- Owner-admitted objective, role, allowed actions/paths and pending owner checkpoints.
- Verified context and relevant runtime evidence; explicitly uninspected, unavailable or unknown fields.
- Contradictions and scoped HOLDs with the evidence or owner decision needed to resolve them.
- The exact next authorized action and its applicable specialist workflow.

Do not manufacture timestamps, actors, receipts, independent PASS or terminal product truth.
Snapshot completion does not satisfy the next action's own authority, proof or admission requirements.
