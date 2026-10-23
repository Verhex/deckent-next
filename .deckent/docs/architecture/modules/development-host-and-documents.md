# Development host, skills and document process — module note

Moved verbatim from ARCHITECTURE.md on 2026-10-23 so that file keeps product contracts only. These are development-host and
documentation-process decisions: they grant no product, runtime, review or release authority.

## Roles and review channel

**Owner 2026-10-05 — rol uzlaştırması:** Main Opus (`opus`), bağımsız inceleyen Astra (`gpt-6-astra`, `01a10b4c-23ad-7730-b492-9c81e1eeab98`, `astra`); Sol yalnız analiz, Codex lane’leri `gpt-6-astra`. 2026-10-04 Sol-main devri tarihseldir (COMPLETED-PLAN 2026-10-05); pano kaydı tek başına yetki/liveness kanıtı değildir. Uygulayıcı kendi değişikliğine bağımsız PASS vermez; commit, push ve canlı geçiş ayrı yetki sınırlarıdır.

Owner 2026-10-01 Sol-review ataması tarihseldir; 2026-10-05 bağımsız inceleyen Astra, modelden bağımsız kanal adresi `astra`. A host-only user-systemd
timer checks recipient-pending channel entries every 45 minutes and admits a wake prompt to the existing Codex thread
only when idle; no model call on an empty channel, no interruption of an active turn, no authority from message bodies.
The ignored `.deckent/host/channel/watch` kit reconciles its own queued submissions and preserves other clients' prompts.
Polling persists through logout with user linger; machine/WSL downtime, authentication and daemon availability bound operation.
This is development coordination, not a Deckent scheduler, product recovery mechanism or continuous product-runtime admission.

## Host kit, skills and documents

Host refactor kit lives in `.agents/` and is development tooling, not a runtime or Enterprise module.
The former `markdown.writerModule` gate was removed (`a21f554d`). `.github/CODEOWNERS` and issue `config.yml` are
non-Markdown community configuration; GitHub settings, actual review and private reporting availability
remain separate proof. Node/pre-release badges read public main package metadata; npm badges stay commented
until the first verified publish. README and SECURITY name the last recorded release (bound to package metadata by lint-docs), not a fresh live check.
Owner 2026-10-02: `deckent-next-refactor` retains its name as the shared entry guide for owner-admitted
Next development, fixes, refactoring, reviews and handoffs. Codex, Claude and Cursor resolve this skill
to the same `.agents/skills/deckent-next-refactor` source; specialist skills supply task-specific methods.
Jev details live in the skill's `jev-workflow.md`, read before case preparation or consultation.
ROOT-DOCS (DOC-01/DOC-06, owner 2026-10-09): the complete former root contract is retained verbatim for
`.agents/skills/deckent-next-refactor/internal-contract.md`; owner 2026-10-18: it is short, dated rules point to laws, no read-first gate.
The internal guide and exact skill patch are staged in external `proof/ROOT-DOCS-2026-10-09/` for lead transfer
with the public roots. Existing Claude rules and the Cursor always-apply rule select the internal skill;
a full source clone therefore cannot be claimed to load public rules only. Fresh session loading and
the public export boundary remain to verify. CONTRIBUTING requires responsibility, testing and a brief PR
disclosure of material AI assistance; prompts/transcripts are not required and the review bar is shared.
Bulk automated PRs require prior agreement in an issue. Author checks do not establish independent acceptance.
Owner 2026-10-06 host amendment: checks remain Noul, with local advisory non-binary/multi-question diagnostics;
report v3 orders recorded requests by time within a bounded scan and exposes missing decision/outcome and label coverage.
Undated/truncated recency and absent outcomes remain unknown; agreement is not correctness. Provider thresholds,
full curated charter, both abstentions, immutable receipts and product authority stay unchanged. Evaluation freezes
claim/state/labels and model version; context compaction requires measured quality retention, not automatic promotion.
Shared content does not prove identical host activation or grant work/runtime authority.
Owner 2026-10-02: `deckent-authority-bootstrap` remains a separate read-only Next authority/context
snapshot, refreshed on relevant changes. It checks scope and work ownership; runtime inspection is
task-dependent. A reported HOLD neither mutates product state nor blocks unrelated admitted work.
Owner 2026-10-02: `deckent-readonly-audit` remains a separate bounded Next investigation. It follows
actual wiring and distinguishes source evidence, retained execution proof and current observations.
Audit findings admit no work; tests, fixes and document/state changes are separate authorized actions.
Owner 2026-10-02: the standalone `deckent-outcome-ordering` skill is retired; owner-requested ordering
principles live in `deckent-next-refactor`. Accepted order and execution admission remain separate.
The original files are retained outside skill discovery; `.agents/refactor/migration.json` remains
historical migration evidence, not the current active skill catalog.
Owner-delegated 2026-10-02: the remaining 19 skills were individually compared with logged Jev;
17 specialist entries retain distinct responsibilities with corrected Next instructions. Session
handoff principles move into the common guide; the unsupported standalone versioned-handoff
protocol and out-of-scope generic design-system package leave active discovery, with originals
retained outside Git/npm. Planning, authorized parallel coordination, observation, recovery and
completion assessment remain separate roles over actual Next contracts. Design guidance preserves
accepted Desktop/Terminal direction and distinguishes target surfaces from implemented consumers;
critic self-review cannot claim independent PASS. Token guidance describes the actual Terminal map,
writing palette builder and output, without a nonexistent check mode or cross-surface generator.
These are host instruction decisions within delegated scope, not product authority or implementation.
Design reasoning goes into the decision log below, not arbitrary new documents.
Owner 2026-09-21: `follow-up-works/current-flow.md` is an optional, replaceable development tracker;
its exact path is admitted by the Markdown gate, excluded from product distribution, and may be deleted.
Owner 2026-10-03: it is a pointer only; who holds what and what comes next live on the host process board
(`.deckent/host/process-board.json`, outside Git/npm, written through `.agents/refactor/board.mjs`), and review
packages cite the board and PLAN as status source. The board is coordination data: no authority, PASS or liveness.
PLAN.md retains durable roadmap/decisions, remaining work and material open findings; owner 2026-09-24: completed work
and closed findings move to COMPLETED-PLAN.md (read only when history is needed), so PLAN stays short. Small work/history
lives in the external refactor proof area (kept until the batch lands and its review closes), not an append-only product plan.
