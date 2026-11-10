---
name: deckent-untangle
description: Untangle an owner-admitted package or area so a typical change lands in one place - list hidden links, needless links, surplus and special cases, redesign once, fix in bounded cards.
disable-model-invocation: true
argument-hint: "[package or area, e.g. alpha.64 KG2]"
---

# Deckent untangle

Apply `deckent-next-refactor` and, for each change, `deckent-lean-change`. This skill shapes the analysis and the
redesign; it grants no authority and opens no work: the owner admits the package and its scope (law 2), and the
analysis is read-only until then. Adapted from caldoai/skills `untangle-codebase` (MIT, see
[LICENSE-caldoai.md](LICENSE-caldoai.md); upstream 442c299, 2026-11-05).

## 1. Scope

Name the admitted package or area and its write scope. Reuse an existing analysis as input (for alpha.64:
`<refactor-work>/proof/ALPHA64-KOD-IYILESTIRME/BORC-ENVANTERI.md`) instead of starting over. Ask the owner, with
the exact descriptions, whether to include the two additions; do only the chosen ones:

| Addition | What it does |
| --- | --- |
| **Comments** | Remove comments that only restate the code. |
| **Tests** | Remove tests that would not catch a real bug, and fix the ones that fail without one. |

Done when the scope, its write paths and the chosen additions are written at the top of the decision log
(`<refactor-work>/proof/<PACKAGE>/UNTANGLE.md`).

## 2. List every problem (change nothing)

Ask one question of the code: **should these pieces change together?** Write every wrong answer with `file:line`:

- **Hidden links** (must change together, nothing shows it): copies of logic or values (a table copied into four
  sites, a port copied field by field); a module reading a global or file another module sets; one feature split
  across layers or folders; a call order or convention callers just have to know.
- **Needless links** (tied, but change for different reasons): callers on internals; stable code importing
  something more volatile; a general function with a parameter only one workflow understands; a shallow module.
- **Surplus** (no reason of its own to change): pass-through wrappers; extension points and config for things that
  never vary (registries and ports Enterprise plugs into are not surplus, law 10); dead code (an export reachable
  from the public barrel is checked against Enterprise use before it counts as dead).
- **Special cases**: an `if` for one value (a provider or model id is also a law 6 finding), a parameter for one
  caller, a swallowed exception, a retry or sleep, a disabled test. Count them; the count is the progress measure.

Mark each item `[floor]` when it touches a security, authority, custody or audit boundary. Done when every item
has `file:line`, a kind and a floor mark where it applies.

## 3. Redesign once

Work out the fixes as if today's requirements had been known from the start; look for the one fix behind several
problems, which often looks nothing like them. Every fix must leave pieces that change together together, untie
pieces that do not, and make everything depend on what changes less. A `[floor]` fix never loosens a boundary;
when it would, it becomes an owner question. Write each fix above the problems it solves, as in the example.

Done when every listed problem sits under a fix or is marked "kept: <reason>"; send the decision log through the
clean-context law auditor (`deckent-outcome-plan`) before the owner sees it.

## 4. Fix in bounded cards

Turn the fixes into cards with `deckent-outcome-plan` (one sole writer per hot file; a wide change goes expand →
migrate → contract). Remove the special cases the redesign makes unnecessary, keep the ones the system still needs.

- **Comments** (if chosen): remove comments that restate the implementation; keep comments about something outside
  the code and every owner decision, law, Astra or incident reference; a workaround's comment goes with its workaround.
- **Tests** (if chosen; last, they are the safety net): remove tests that repeat the implementation or cannot fail,
  rewrite tests tied to internals to behavior. A test pinning a `[floor]` rule is never removed without the law
  audit; follow the owner's test discipline record. Each removal names the regression a remaining test still catches.

Done when every card is landed or deferred with its reason, and the decision log records both.

## 5. Check

Re-run the search (subagents may summarize parts; a skeleton without function bodies and the import graph from
`node scripts/lint-arch.mjs` and the A3 scripts help). Behavior stays the same apart from bugs the redesign fixed:
targeted tests per card, the full suite once per release candidate (law 7), and the journey walk on the assembled
release (`deckent-beuser`). Done when the special-case count is reported before/after, a typical change in the
package lands in one place, nothing imports something more volatile, and the remaining items are written down
as kept or as the next package's candidates (never silently dropped, law 2).

## Decision log example

```md
- Pass the whole host `/model` source through the workline; only the session-bound members stay its own.
  - `surfaces/core/terminal/internal/workline-settings.tsx:57` copies the port field by field; `setBrain` was lost (owner F2-1).
  - same file, 2026-10-09: `budget` and `resolveShadow` were lost the same way.
- One Docker client environment table in docker-supervisor; every caller reads it. [floor]
  - `docker-supervisor/internal/command.ts:32` passes the whole service environment (A6-3).
  - `worker-image/internal/{build,state,choices}.ts`, `toolchains/internal/builder.ts:33` each keep a copy of the list.
```
