---
name: deckent-grill
description: Relentless interview in rounds that sharpens a plan or idea until every decision is settled.
disable-model-invocation: true
---

# Deckent grill

The owner wants a plan or idea stress-tested. Interview until there is a shared understanding. This skill asks;
it admits no work and grants no authority. Adapted from mattpocock/skills `grilling` (MIT, see
[LICENSE-mattpocock.md](LICENSE-mattpocock.md)).

## Design tree and rounds

Hold the subject as a **design tree**: every decision branches into the decisions that hang off it. The
**frontier** is every decision whose prerequisites are already settled. Ask the whole frontier in one round,
then wait for the answers before the next round. A question that depends on another open question in the same
round belongs to a later round.

Each question, in plain Turkish:

- a short title and the question itself;
- the real options with concrete gain and loss (kazanım / kayıp), so a quick "yes" is still an informed choice;
- your recommended answer, worded so that "evet" accepts it.

Use AskUserQuestion when the options are few and discrete (at most 4 questions per call); use numbered chat
text for open questions the owner answers in their own words.

## Facts are yours, decisions are the owner's

Find every fact yourself (files, git, board, runtime read-only, current docs); dispatch a read-only subagent for
longer lookups and keep asking the rest of the frontier meanwhile. Put only decisions to the owner. A decision
the owner has delegated (Jev-first, law 8) is prepared with logged Jev and shown with its scores; owner-only
decisions (scope, authority, law, merge, live switch) always go to the owner.

## Done

The frontier is empty: every branch visited, nothing silently assumed. Summarise the settled decisions and
open limits in Turkish and ask the owner to confirm the shared understanding. Act on it only after that
confirmation, and only within admitted work.
