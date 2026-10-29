---
name: deckent-lean-change
description: Writing or changing code or tests in Deckent Next - the smallest complete change that fully solves the decided scope, with the fewest tests that prove it.
---

# Deckent lean change

Apply `deckent-next-refactor`. This skill shapes how a change is written; it grants no authority and decides no
scope. Adapted from dietrichgebert/ponytail `skills/ponytail` (MIT, see [LICENSE-ponytail.md](LICENSE-ponytail.md)).
Solve the whole decided problem with the least new code.

## Before you write

Read the code the change touches. List every place it must reach: callers, tests, fixtures, config, exports,
i18n catalogs, registries, migrations. Check what it could break: data it would destroy or expose, callers or
contracts that stop working. That is scope; extras nobody decided are not.

## The smallest complete change

Take the first rung that fully works:

1. Does it need to exist? Decided scope counts as asked for and is built complete (north star: no MVP ceiling).
   The smallest-version rule applies only to extras nobody decided: skip them and name them in one line.
2. Already in Deckent (a port, registry, helper, renderer, pattern)? Use it the way the surrounding code does.
3. Node standard library or a platform feature? Use it, unless Deckent has its own.
4. An installed dependency? Use it. Never add a dependency for a few lines.
5. One line a reader gets at a glance? One line.
6. Otherwise: the minimum code that works.

- Be lean about the solution, never about the change: finish every caller, test and fixture the change breaks.
- No abstraction, wrapper, option, config or "for later" code nobody decided. Deletion beats addition. Keep the
  existing layers, ports and conventions. The shortest working diff wins once you know everything it touches;
  a one-liner that needs decoding is not short.
- Bug fix: grep every caller of the function first, then fix the root cause once in the shared code.
- Moved or merged code keeps its error handling and validation.
- Between options of equal size, take the one correct on edge cases. Comment only the why, in one line.

## What complete means in Deckent

Smallest never drops a law: mutable policy and model or provider identities as registry data, not literals;
user-facing strings in matching EN and TR catalogs through the shared renderer; one typed application contract;
versioned ledger, protocol and migrations; principal, scope, policy and audit carried through
([internal-contract.md](../deckent-next-refactor/internal-contract.md)).

## Tests

- New non-trivial logic (a branch, loop, parser, money, security or authority decision) gets ONE focused test or
  an assert-based self-check. Trivial changes need none.
- Extend an existing test file before adding one.
- No `it.each` fan-out unless each row is a distinct real risk; one negative per real risk.
- Test counts are never progress; the proved behavior is. Source: owner decision 2026-10-24 ([test discipline](../../../.deckent/docs/decisions/owner-decisions.md#test-disiplini-2026-10-24)).
- Tests guard regressions; they do not accept a surface. Acceptance is the BeUser walk of the journey on the
  assembled release (`deckent-beuser`). Run targeted tests per law 7, never bulk loads in place of that walk.

## Never cut

Validation at trust boundaries, error handling that prevents data loss, security and authority checks,
cancellation and recovery paths, accessibility, anything in the decided scope.

Done when the decided scope works end to end, every broken caller, test and fixture is fixed, no undecided extra
was added, and the report names the skipped extras and what was not checked.
