---
name: deckent-beuser
description: Journey spec before building a person- or company-facing surface, and the BeUser walk on the assembled release - AI agents act as the persona on a real install, walk every branch and give the surface's acceptance verdict.
---

# Deckent BeUser

Apply `deckent-next-refactor`. This is a development method: it grants no authority, admits no work and changes
no product state. A surface is accepted when the person's or company's whole journey works on the assembled
release, not when its cards pass their own tests and review. Owning records: law 1
([evidence and closure](../../../.deckent/docs/core-memory/law_evidence_and_closure.md)) and the
[owner decision of 2026-10-27](../../../.deckent/docs/decisions/owner-decisions.md#beuser-2026-10-27);
verification cadence stays law 7.

## 1. Journey spec, before building

Part of the plan (`deckent-outcome-plan`) for every surface the outcome claims, written before code:

- Personas: solo, from a non-developer who only follows prompts ("babaanne") to a developer, and enterprise
  (admin, member under policy). Each with goals, skill level and tastes (wording, density, order, EN/TR).
- Starting states, each a branch: fresh host, existing install, earlier partial or failed attempt, running
  service, older version, missing permission, offline.
- Per step: what the person sees, each menu choice and its CLI flag twin (the same steps interactive and
  headless, e.g. an `uninstall` menu choice ↔ `uninstall --all --force`), the outcome, and every refusal with
  its cause and exact next step.
- Shape copied from proven tools doing the same job (Claude Code, Codex, popular CLIs); name the tool and the
  behaviour copied. Mark what no proven tool covers.

Done when every branch has a starting state, choices, expected outcome and refusal next steps, and the
menu ↔ CLI table has no gap.

## 2. Walk, after the narrow cards land

- Target the assembled release state: the package candidate with all its cards merged and built, never a card
  branch. Record exact revision and build.
- Walk end to end in a BeUser sandbox: a disposable install the walker creates itself, where the persona ran
  init and is that install's person. Drive the real binary and terminal (a PTY for menus), not mocks. N1 or an
  owner project only for read-only observation the lead authorizes.
- One persona brief per walker: persona, goals, skill level, tastes, the journey spec, the install and its
  authority, the transcript path. Prefer walkers from a different maker than the author
  (Claude, Codex, Cursor); when none is available, say so in the report.
- Walk every branch, menu and CLI twin. Per step record the command or keys, what the screen showed (trimmed),
  confusion, dead ends, wrong or missing next steps and taste notes.
- Verdict per branch: GREEN (outcome as specified, nothing confusing), FRICTION (outcome reached with a clarity
  or taste finding), RED (wrong outcome, dead end, refusal without a usable next step, data at risk) or
  UNWALKED with its reason.
- Retain transcript and verdict table under `<refactor-work>/proof/<PACKAGE>/beuser/`, outside Git.

Done when every branch has a verdict tied to the exact revision.

## 3. Acceptance and findings

- Done = every journey branch walked GREEN on the assembled release, person-only steps included. FRICTION is
  fixed or explicitly accepted by the owner; RED and UNWALKED block. The owner reads the report; he never walks.
- Hermetic tests guard regressions on real risks (`deckent-lean-change`) and CI stays required; they are not the
  acceptance model, and bulk test runs never substitute for the walk.
- A finding on a surface in the package is fixed in the same package, then that branch and its neighbours are
  walked again on the new assembled state. It is not deferred to a later release.
- The walk is evidence for `deckent-closure`; it is not independent PASS, owner acceptance or release.

## Safety

- Person-only steps are walked as the persona only inside the walker's own BeUser sandbox, run without the
  walker's AI markers in a PTY the walker owns, labelled `synthetic-person`; never evidence of a real approval.
- On every other install (live, N1, owner projects, customer systems) never bypass person-only or AI markers,
  authority cards, approvals or policy, and never act as the person.
- Destructive actions (uninstall, purge, reset, force) only in a BeUser sandbox; never on live.
- No secrets, tokens, keys or private content in transcripts; redact before retaining.
- Bound each walk in time and retries; on an uncertain effect stop and report instead of retrying.
