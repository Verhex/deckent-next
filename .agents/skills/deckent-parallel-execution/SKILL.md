---
name: deckent-parallel-execution
description: Coordinate explicitly authorized independent Deckent Next implementation or execution lanes with disjoint ownership, exact evidence custody and fan-in.
---

# Deckent Next Parallel Execution

This skill keeps only Deckent constraints. For dispatch and worktree mechanics use
`superpowers:dispatching-parallel-agents` and `superpowers:using-git-worktrees`. Do not use the superpowers
per-task reviewer subagent (not independent; review is one Astra pass per batch, law 8) or its
finishing/merge steps (merge is lead-only with owner approval and green hosted PR CI).

## Preconditions

Apply `deckent-next-refactor`. Require explicit authorization for delegation/parallel agent work,
an admitted result and a bounded dependency/ownership plan (`deckent-outcome-plan` when needed).
Skill invocation alone is not delegation permission. For a small or coupled slice use one writer.
Refresh affected bootstrap facts if revision, ownership, policy or relevant runtime changes.
Distinguish host development lanes from product workers; they have different execution authority.
Lane count follows the DAG, disjoint write ownership and measured capacity (law 5), not a fixed number.

## Lane brief

One common brief for the package plus a per-slice `HANDOFF` file. Each brief carries the exact input
revision/diff, task, role, read/write/negative scopes, sole writer, output artifacts, proof, time/resource
bounds and stop conditions, and the law check and two perspectives (full template:
`<refactor-work>/proof/LAW-GATE/CARD-TEMPLATE.md`):

    ## Kanun kontrolü (zorunlu)
    1. Kanıt ve kapanış — uyumlu / ilgisiz / çatışma: <neden>
    2. Yetki sınırı — uyumlu / ilgisiz / çatışma: <neden>
    3. Owner iletişimi — uyumlu / ilgisiz / çatışma: <neden>
    4. Doküman haritası — uyumlu / ilgisiz / çatışma: <neden>
    5. İş bölme ve kök neden — uyumlu / ilgisiz / çatışma: <neden>
    6. Model/provider tek kaynak — uyumlu / ilgisiz / çatışma: <neden>
    7. Yerel doğrulama — uyumlu / ilgisiz / çatışma: <neden>
    8. İkinci görüş — uyumlu / ilgisiz / çatışma: <neden>
    9. Alp Discipline — uyumlu / ilgisiz / çatışma: <neden>
    10. Enterprise katmanı — uyumlu / ilgisiz / çatışma: <neden>
    North star (güvenlik, determinizm, sınırlı kaynak, iptal/kurtarma, ölçülmüş performans) — <neden>
    ## İki bakış
    - Dogfood: Deckent kendini geliştirirken bu ne katar?
    - Hedef ürün: müşteri bir ERP/CRM sürecini yürütürken aynı mekanizma nasıl çalışır?
      Kod/test'e özgü bir öğe kalıyorsa git adapter'ında mı?

## Lane rules

- Split only independent responsibilities with a real dependency join and useful parallel gain.
- One writer per worktree: before dispatch check that no other session or process writes there.
  Worktrees are a collaboration boundary, not process, filesystem, network or secret isolation.
- Builds and test suites run under `flock /tmp/claude-1000/deckent-heavy.lock`; targeted Vitest uses
  `VITEST_MAX_FORKS=2` (law 7). Never build while a Vitest suite runs.
- Seed a new worktree's `node_modules` with `cp -al` from a worktree with the same lockfile.
- Codex lanes take code-only work: their sandbox cannot run PTY, socket or loopback tests, so the lane
  writes `OWNER-VERIFY.md` and the lead runs the targeted host tests right after the lane; a read-only Git
  directory gets `OWNER-COMMIT.md` for the lead. Test-heavy lanes go to Claude subagents.
- A lane report without host test evidence is not verification; feed real failures back as a new card.
- Resolve product providers, models, realms, capability and concurrency from admitted current
  config/policy/capacity. Host instructions do not force a runtime provider or extra workers.
- For product execution retain task/attempt/operation/invocation/effect identities and immutable
  inputs, attempt-private results, partial outputs, timeout evidence and logs. For host lanes retain the
  lane revision, owned diff and check artifacts; never fabricate receipts or independent acceptance.

## Supervision and fan-in

Inspect each lane's artifacts and diff, not just its self-report; observe admitted live work with
`deckent-observe`. Fan in on one branch in DAG order. Shared hot files — i18n catalogs under
`src/platform/core/i18n/locales/`, the error registry `src/platform/core/errors/internal/registry.ts` and
`src/platform/core/config-fields/` — are resolved as the union of both sides, never by taking one side.
At each join recheck base/head, write collisions, custody and dependency results; reject sibling, prior,
replayed, unattributed or ambiguous results. Keep implementation checks, independent review and owner
acceptance separate; the implementer cannot PASS its own lane. Bound retries; an unchanged failure or
unknown side effect cannot justify another automatic attempt.

## Stop and delivery

Pause the affected lane on missing authority, conflict, unsafe custody or exhausted budget; continue
unrelated admitted work. Do not clean runtime data, force-settle, change auth or restart services under a
coordination instruction. Deliver lane inputs/outputs, the exact integrated diff, join evidence, checks and
failures, open limits, document reconciliation and the next action. Verification cadence follows law 7;
the batch merges only after Astra PASS and green hosted PR CI on the exact head, by the lead with owner approval.
