---
name: deckent-skill-authoring
description: Write or edit Deckent agent instructions - a SKILL.md, its agents/openai.yaml, a rule file under .claude/.codex/.cursor rules, or a doc an agent reaches by a pointer. Covers trigger-first descriptions, user- vs model-invocation, pruning and router upkeep.
---

# Deckent skill authoring

Apply `deckent-next-refactor`. This skill shapes instruction text; it grants no authority and never moves a
dated owner rule into a skill. Skills point to the law or record that owns a rule; when a rule changes, the
record changes and the skill keeps pointing. `CLAUDE.md` and `AGENTS.md` change only on an explicit owner order.
Adapted from mattpocock/skills `writing-for-agents` (MIT, see [LICENSE-mattpocock.md](LICENSE-mattpocock.md)).

## The description is a context pointer

A model-invoked skill's `description` sits in every agent's context on every turn (Claude, Codex, Cursor and
Deckent's own Claude workers, which clone the repository). It decides when the skill is reached.

- Lead with the trigger: the moment or object the agent will actually see ("Plan one owner-admitted outcome",
  "Write or edit ... SKILL.md"). Front-load the leading word; one trigger per distinct branch.
- State the positive target. A trailing "Do not use for X" makes X more available; name the neighbouring
  skill's moment instead, or drop the line when the router already separates them.
- Keep triggers in `description` itself. Claude-only fields (`when_to_use`, `paths`) do not reach Codex or
  Cursor, so a trigger placed there silently splits the surfaces.
- Cut identity the body already carries. Every word costs on every turn.

## User- or model-invoked

- **Model-invoked** (default): the agent must reach it on its own, or another skill must. `agents/openai.yaml`
  keeps `policy.allow_implicit_invocation: true`.
- **User-invoked**: only the owner types it (`/deckent-retro`). Set `disable-model-invocation: true` in the
  frontmatter and `policy.allow_implicit_invocation: false` in `agents/openai.yaml`; keep both in sync. The
  description becomes a one-line human summary. Zero context load; the owner is the index.
- A step that needs another skill says "call the Skill tool with `<name>`". A user-invoked skill cannot be
  called that way; tell the owner to type it.

## Body

- Steps in order, each ending on a checkable completion criterion; reference the agent consults on demand.
  Move reference only some branches need into a sibling file behind a pointer.
- Prune no-ops (instructions the model already follows), duplicated meanings and stale layers. The
  environment (`package.json`, `--help`, config) is the source of truth; restate it only when the lookup is
  expensive or the reason is unwritten.
- Keep a concept's rule, reason and caveat under one heading.

## Router and mirrors

- `.claude/rules/deckent-route.md` maps moments to skills and stays at or below 12 lines. Adding, renaming or
  removing a model-invoked skill means re-reading the router; a skill it never mentions or a stale row is a
  router that lies.
- `.claude/rules/*.md` and `.codex/rules/*.md` are byte-identical; `.cursor/rules/*.mdc` carries the same body
  under its `alwaysApply: true` frontmatter. `.claude/skills` and `.codex/skills` are symlinks to `.agents/skills`.
- Third-party adapted text carries its full license notice in the skill directory.

## Check

    node --test .agents/refactor/rules-parity.test.mjs
    node scripts/lint-docs.mjs

Done when every changed description leads with its trigger, both invocation fields agree, the router and
mirrors match, and the parity test passes.
