# Contributing to Deckent

Contributions in English or Turkish are welcome. Follow the [Code of Conduct](CODE_OF_CONDUCT.md).
Report vulnerabilities privately through [SECURITY.md](SECURITY.md).

## How work enters

Start with an issue that describes the problem, expected behavior and evidence. An issue or AI
recommendation is a proposal; work enters through an owner-admitted card in [PLAN.md](PLAN.md).
Read [AGENTS.md](AGENTS.md), [ARCHITECTURE.md](ARCHITECTURE.md), PLAN and the repository's
[core-memory index](.deckent/docs/core-memory/MEMORY.md) and
[product north star](.deckent/docs/core-memory/project_product_north_star.md) before changing the repo.
The target is a customer-installed Agent OS with a secure standalone open Core and separately
distributed proprietary Enterprise. Small slices must preserve that target and accepted contracts.

The lead assigns disjoint lanes and file ownership in separate worktrees based on the recorded
local `main` HEAD. Keep the base commit and owned diff in the handoff. Preserve concurrent WIP;
do not reset, clean, stash, amend or overwrite another contributor's changes. Worktree separation
is a collaboration boundary; filesystem/process/network/secret isolation needs its own controls.

The host process board owns who holds what and the next step:

```sh
node .agents/refactor/board.mjs show
```

It is coordination data outside Git/npm, not admission, independent review or liveness evidence.
Sessions update only their own row through `board.mjs`; main reconciles the role map and carries
workers in its own sub-list. A worker/lane without the shared board leaves the lead a handoff;
it does not create a competing board. PLAN owns remaining work, COMPLETED-PLAN owns completed work,
ARCHITECTURE owns contracts, core-memory owns lasting principles, and retained proof stays in the
external refactor proof area. `follow-up-works/current-flow.md` is a pointer only.

## Human branches and commits

- Use `lane/<card>` for an admitted card and `release/<version>` for an authorized release.
- Keep a lane bounded and reviewable; agree overlapping paths with the lead before editing.
- Commit only with owner authorization. Publishing/pushing needs its own authorization.
- Use the repository's observed `type(scope): description` style, such as
  `docs(repo): GitHub community standards, bilingual README, PR workflow` or `fix(runtime): …`.
  Recent history also contains unscoped `docs: …`; this is a convention, not a new commit hook.
- Preserve accurate attribution trailers. Recent commits use `Co-Authored-By` and a
  `Claude-Session` URL. Use the actual contributor/model and a real session URL where available;
  never invent a session or independent reviewer. Attribution does not confer acceptance.

Example with AI assistance (replace the contributor with the actual one):

```text
docs(repo): describe the admitted repository change

Explain the resulting behavior and scope when needed.

Co-Authored-By: Codex (gpt-6.1-sol) <noreply@openai.com>
```

## Style and machine gates

Core uses TypeScript with ESM/native subpath imports, Node.js **≥ 24.15.0** (see
[package.json](package.json)), Zod for typed validation and Vitest for contract/e2e tests.
Use the lockfile and `npm ci`; do not silently upgrade dependencies. Domain stays pure,
adapters sit behind ports, composition is explicit, and each transition has one application owner.
Carry principal, scope, resource and policy through operations; persona grants no authority.
Enterprise/ERP adapters must layer on through registries and public contracts without editing Core.

`npm run lint` aggregates package-metadata validation, typecheck, ESLint, architecture and
core-memory checks. [arch.json](arch.json) is the current machine contract enforced by
`scripts/lint-arch.mjs`: dependency direction, pure domain, cycles, public unit imports, package/
source/test budgets, Markdown and i18n gates. Current limits include 1,500 lines per governed text
file (800 design target), 2,000 per unit and 8,000 test cases; package/total budgets are in arch.json.
Do not remove capabilities to fit a budget. The hardcode ratchet rejects new mutable policy/vendor
hardcoding; its frozen legacy allowlist only shrinks. Put mutable policy in registries/config;
versioned protocol/security invariants stay in code. Every product user string needs both `en`
and `tr` catalog entries and the shared i18n renderer; do not inline user-facing literals.

New tracked Markdown needs explicit owner admission in `markdown.trackedAllow` or an admitted glob,
with a reason in ARCHITECTURE's decision log. Product writers do not write repository standards
files; preserve `markdown.writerModule` and its existing gate. Keep AGENTS.md/CLAUDE.md byte-identical
and at most 70 lines. Refresh the core-memory manifest after authorized edits:

```sh
node scripts/lint-core-memory.mjs --write
```

## Checks and pull requests

Run checks appropriate to the admitted slice and put exact commands, exit results and the candidate
SHA in the [PR template](.github/PULL_REQUEST_TEMPLATE.md). For source changes, the usual set is:

```sh
npm run typecheck
npx eslint <changed-source-files>
node scripts/lint-arch.mjs
node scripts/lint-core-memory.mjs
VITEST_MAX_FORKS=2 npx vitest run <touched-test-files>
```

Angle-bracket paths above are placeholders, not shell commands to paste unchanged. For repository
standards documentation changes, run `lint-arch`, core-memory validation and relative-link/template
checks; `npm run lint` is not required for this slice. Add relevant failure/negative evidence for
behavior changes. Test green is author evidence, not independent acceptance or producer-to-surface proof.

Local tests stay within 16 GB. Targeted/lane Vitest runs use two forks; full verify uses four by
default. Do not build during an active test suite. Full `npm run verify` runs only for batches that
add broad features and only on owner request (2026-10-03); ordinary slices use targeted checks.

Open a PR from the admitted branch, filling card id, scope, checks, independent review status,
risks/limits and whether DOGFOOD/live remained untouched. CI already runs on `pull_request` via
[ci.yml](.github/workflows/ci.yml). Linux/Node 24 is the required cell; other OS/Node 26 cells are
advisory. A CI badge or author checks do not replace independent review of the exact candidate.
The implementer cannot award their own work independent PASS. In the host review arrangement,
Sol's channel address remains `astra`; use the assigned independent reviewer, not the author.

The lead owns landing: independent review + targeted checks for the exact scope/revision,
resolved blocking findings and owner authorization. Refresh affected docs and preserve proof
before landing. No direct push to `main` without this landing gate and separate push authority.
CODEOWNERS names the default owner; automatic review requests and enforcement depend on GitHub
permissions, the base branch and repository protection settings. These files do not enable settings.

## Deckent-worker branches and PRs — WORKER-GIT-PR

This is the owner-admitted **design and documentation** from 2026-10-03. The host PR script is not
implemented yet; workers do not currently open PRs automatically. The intended workflow is:

1. The admitted worker runs in its isolated attempt checkout. Git credentials stay out of worker
   containers; workers neither push nor open PRs. Existing product patch/delivery custody remains
   unchanged. The worker delivers its retained patch and final report with card/run id, exact base,
   scope, checks and outcomes, review status, risks/limits and DOGFOOD/live evidence.
2. The lead's host tooling checks patch identity, base and owned scope against the report, prepares
   a separate candidate and refuses conflicts or unknown custody. It creates `lane/<card>-<runId>`
   from the recorded base plus delivered patch, preserving other worktrees and source HEAD/index/WIP.
3. With separate push authority, only the lead's host tooling pushes that branch using host-held Git
   credentials, then opens a PR from it. The PR template is pre-filled from the worker's final report;
   missing checks/review remain unknown or pending, and attribution stays truthful.
4. The existing `pull_request` CI runs. Independent review and targeted checks govern landing;
   only the lead may land after the gate. A worker report, prepared candidate or opened PR is not
   Task acceptance, independent PASS or live delivery.

Proposed host-kit interface (not runnable today):

```text
node .agents/refactor/pr.mjs open <patch-dir> --card <id>
```

[PLAN.md](PLAN.md#worker-git-pr--host-branch-ve-pr-akışı) carries the script, patch/report contract,
replay/failure checks and owner test planned for **2026-10-04**. This lane implements no script,
credential plumbing, push, PR creation, main landing or DOGFOOD/live switch.
