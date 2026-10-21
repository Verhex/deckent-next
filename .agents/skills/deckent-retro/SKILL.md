---
name: deckent-retro
description: Session retrospective - lists improvements to the agent environment (navigation, checks, steering files, tooling), most severe first.
disable-model-invocation: true
---

# Deckent retro

The owner asked for a retrospective. Suggest changes to the **environment** that would have made this session
faster or safer, not changes to product code. Findings are candidates for the owner (law 2: a finding is not
work); nothing here edits files. Adapted from mattpocock/skills `retro` (MIT, see
[LICENSE-mattpocock.md](LICENSE-mattpocock.md)).

## Steps

1. Call the Skill tool with `deckent-skill-authoring` for how instruction text should be written.
2. Read the primary sources of the session: this conversation by default, or the transcript the owner names
   (`~/.claude/projects/<project>/<session>.jsonl`). Note where time, tokens or owner patience went.
3. Look for candidates in each category. A category with nothing real stays empty.
   - **Navigation**: the agent searched long for a file or fact. Would a pointer in a skill, the router or a
     doc have found it at once?
   - **Automated checks**: the agent made a mistake a check could catch. Read the existing commands first
     (`package.json` scripts, `.agents/refactor/*.test.mjs`, `host-guard.mjs`, CI); an existing check that is
     unwired or broken is the finding. A **mechanical** mistake (fixed pattern, banned path, file location)
     gets a deterministic check; reserve prose for judgement calls.
   - **Skills and router**: a skill that should have fired did not, or fired at the wrong moment; a description
     or router row is unclear; a skill carries a stale dated rule.
   - **Steering files**: instructions in rules, skills or hook text that change nothing (no-ops), contradict a
     newer owner decision, or belong in a check instead.
   - **Tool economy**: expensive or repeated tool calls; host tooling with token-heavy output.
   - **Information access**: a fact the agent needed but could not reach (log, runtime state, external doc).
4. Present the candidates in Turkish, most severe first: what happened (with evidence), the proposed
   environment change, its cost, and who would own it. End with the decisions the owner must make.
