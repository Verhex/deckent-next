# Internal development process (retained)

Moved from CONTRIBUTING.md on 2026-10-09. This preserves the existing internal process;
it is not a new public contribution requirement. External contributors use
[CONTRIBUTING.md](../../../CONTRIBUTING.md). Dated status remains historical.

# Contributing to Deckent

Contributions in English or Turkish are welcome. Follow the [Code of Conduct](../../../CODE_OF_CONDUCT.md).
Report vulnerabilities privately through [SECURITY.md](../../../SECURITY.md).

## How work enters

Start with an issue that describes the problem, expected behavior and evidence. An issue or AI
recommendation is a proposal; work enters through an owner-admitted card in [PLAN.md](../../../PLAN.md).
Read [AGENTS.md](../../../AGENTS.md), [ARCHITECTURE.md](../../../ARCHITECTURE.md), PLAN and the repository's
[core-memory index](../../../.deckent/docs/core-memory/MEMORY.md) and
[product north star](../../../.deckent/docs/core-memory/project_product_north_star.md) before changing the repo.
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
[package.json](../../../package.json)), Zod for typed validation and Vitest for contract/e2e tests.
Use the lockfile and `npm ci`; do not silently upgrade dependencies. Domain stays pure,
adapters sit behind ports, composition is explicit, and each transition has one application owner.
Carry principal, scope, resource and policy through operations; persona grants no authority.
Enterprise/ERP adapters must layer on through registries and public contracts without editing Core.

`npm run lint` aggregates package-metadata validation, typecheck, ESLint, architecture and
core-memory checks. [arch.json](../../../arch.json) is the current machine contract enforced by
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
SHA in the [PR template](../../../.github/PULL_REQUEST_TEMPLATE.md). For source changes, the usual set is:

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
[ci.yml](../../../.github/workflows/ci.yml). The required cells are Ubuntu on Node 24 and Node 26
(owner 2026-10-06 ruleset; the earlier six-cell rule of 2026-10-03 is superseded). macOS and Windows run separately in the nightly
[platform-verification.yml](../../../.github/workflows/platform-verification.yml) and are not merge gates; a red required cell is a real failure, not noise. A CI badge or author checks do not replace independent review of the exact candidate.
The implementer cannot award their own work independent PASS. In the host review arrangement,
Sol's channel address remains `astra`; use the assigned independent reviewer, not the author.

The lead owns landing: independent review + targeted checks for the exact scope/revision,
resolved blocking findings and owner authorization. Refresh affected docs and preserve proof
before landing. No direct push to `main` without this landing gate and separate push authority.
CODEOWNERS names the default owner; automatic review requests and enforcement depend on GitHub
permissions, the base branch and repository protection settings. These files do not enable settings.

## Deckent-worker branches and PRs — WORKER-GIT-PR

This is the owner-admitted **design and documentation** from 2026-10-03. The host PR script
(`.agents/refactor/pr.mjs`) is present; workers still do not open PRs automatically. Owner test and landing remain open. The intended workflow is:

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

Host-kit interface (script present; owner test and landing remain open):

```text
node .agents/refactor/pr.mjs prepare <patch-dir> --card <id> [--scope <glob>]...
node .agents/refactor/pr.mjs open <patch-dir> --card <id> --push
```

[PLAN.md](../../../.deckent/docs/plan/workstreams.md#worker-git-pr--host-branch-ve-pr-akışı) carries the script, patch/report contract,
replay/failure checks and owner test planned for **2026-10-04**. The script is present; owner test and landing remain open.
Credential plumbing, live GitHub push, live PR creation, main landing and a DOGFOOD/live switch stay outside this script.

## Development host

This checkout is the execution workspace. `deckent-dev` is a read-only refactor reference;
its runtime and workers must not be launched. Local development entry points are below. On the host, `deckent` is a symlink to
`.agents/refactor/next-entry.mjs` (for example `ln -s "$PWD/.agents/refactor/next-entry.mjs" ~/.local/bin/deckent`), so the
product command and the host entry are the same; the explicit forms are:

```sh
node .agents/refactor/next-entry.mjs cli --version
node .agents/refactor/next-entry.mjs cli workers watch --scope pilot
node .agents/refactor/next-entry.mjs mcp
# For local SDK scripts, use the same environment and cwd:
node .agents/refactor/next-entry.mjs node /absolute/path/to/script.mjs
```

The host entry pins cwd to this checkout and `DECKENT_GLOBAL_HOME` to
`~/.local/state/deckent-next-dev`, outside the checkout (the runtime copies the bundled bubblewrap there,
and a launcher inside the project is refused). It drops an inherited `DECKENT_HOME` to avoid redirecting project
runtime data. Each project's `.deckent/config.json` still chooses its own `layout.root`.
`DECKENT_GLOBAL_HOME` is a shared CLI/MCP/SDK configuration input; it selects the global
configuration/state directory independently of project data. Without it, installed product
defaults remain unchanged. It contains no provider credentials and does not migrate legacy state.

The local observer reads only explicitly configured `inspection.workers.sources` and preserves
source policy checks. Docker workers see their attempt checkout at `/workspace`; host storage
is `<layout.root>/workspaces/<attempt-hash>/tree`. `worker.hb`, `worker.log` and `worker.result`
are host-owned observations beside `tree`, outside the worker mount. Log summaries expose
safe state/diagnostic fields, not arbitrary provider output. `Ctrl+C` stops the view only.
The `pilot` scope and local source catalog are development fixtures, not an installed default.
DOGFOOD is owner-approved (2026-10-09; see internal-contract.md). Changing MCP configuration requires reconnecting already-open clients.

The process board (`node .agents/refactor/board.mjs show`) owns who holds what and the next step;
[PLAN.md](../../../PLAN.md) owns admitted work. The board is host coordination data outside Git/npm,
not authority or liveness proof. `deckent monitor` observes installations without admitting work.
If a lane lacks the shared host board, leave the lead a handoff instead of creating a competing board.

### Development duration measurement (A02/W0-3)

`node .agents/refactor/effort.mjs` records how long development slices actually take. It is
host tooling for M1–M5 forecast updates, not a product feature or a second work ledger.

```sh
node .agents/refactor/effort.mjs start A02-my-slice --milestone M1 --title "…" --actor "…" --kind active
node .agents/refactor/effort.mjs phase A02-my-slice blocked --reason owner-decision   # active|blocked|verification|rework
node .agents/refactor/effort.mjs pause A02-my-slice        # time until the next event is unknown, never active
node .agents/refactor/effort.mjs end A02-my-slice done     # done|canceled|handed-off
node .agents/refactor/effort.mjs report --format table     # observed hours per kind and milestone
```

Events are immutable private files under `.deckent/host/effort/<slice>/` (Git-ignored). Time is
counted only between explicit events; unobserved time is reported as unknown and never estimated.
`--at <ISO>` records an operator-supplied timestamp and is counted separately in reports.
