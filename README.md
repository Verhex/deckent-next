<div align="center">

# Deckent

**Agent Control & Execution Plane**

Deckent turns what people and AI agents ask for into authorized, isolated and recorded work on your own machines.

*policy-driven agent runtime · governed execution · self-hosted agent control plane*

[![CI](https://img.shields.io/github/actions/workflow/status/Verhex/deckent-next/ci.yml?branch=main&label=CI)](https://github.com/Verhex/deckent-next/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/Verhex/deckent-next)](LICENSE)
[![Node engines](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FVerhex%2Fdeckent-next%2Fmain%2Fpackage.json&query=%24.engines.node&label=Node&color=43853d)](package.json)
[![Pre-release](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FVerhex%2Fdeckent-next%2Fmain%2Fpackage.json&query=%24.version&label=pre-release&color=orange)](CHANGELOG.md)

[Türkçe](README.tr.md) · [What it is](#what-is-deckent) · [How it works](#how-it-works) · [Get started](#get-started) · [First job](#your-first-job) · [Everyday use](#everyday-use) · [Safety](#safety-and-control) · [Today](#what-works-today) · [Roadmap](#roadmap)

<img src=".github/assets/screenshots/en/01-startup.png" alt="Deckent terminal right after start: logo, version, project, model and mode" width="880">

</div>

<!-- Node and pre-release badges read public main package.json, not this local branch.
Keep package.json version and CHANGELOG.md release line together at each release.
npm badges: enable only after the first npm publish. The unscoped name `deckent` is not usable (conflicts with an existing
package); the planned name is the scoped `@verhex/deckent` (proposed name; not finalized). Verify package identity first.
[![npm version](https://img.shields.io/npm/v/%40verhex%2Fdeckent)](https://www.npmjs.com/package/@verhex/deckent)
[![npm downloads](https://img.shields.io/npm/dm/%40verhex%2Fdeckent)](https://www.npmjs.com/package/@verhex/deckent)
-->

> [!NOTE]
> **Pre-release `1.0.0-alpha.53`** (release candidate; the latest released version is the first dated line in
> [CHANGELOG.md](CHANGELOG.md)). Deckent is not on npm yet: install it from source as shown in
> [Get started](#get-started). An npm package is planned for the beta, probably as `@verhex/deckent` (the name is
> not final yet).

## What is Deckent

AI agents can now run commands, change code and call business systems. Getting them to act is no longer the hard part.
The hard part is knowing who allowed an action, where it ran, what it cost and how to undo it. Most tools leave that to
the person watching the screen.

Deckent is the layer that answers those questions. You install it on your own machines, and every request goes through
the same checks, whether it comes from a person at the terminal, an AI agent over MCP or a script: identity, scope,
policy, approval and budget. The work then runs in a sandbox or a Docker worker, and every decision and effect is written
to a durable ledger. For example, before a paid model call Deckent reserves the most the call could cost against the
project's budget; if the price is unknown or the budget is too small, the call is refused before anything is sent.

The same foundations serve one person on a laptop and a company with many teams. Software work is the first use:
coding workers (Claude Code, Codex and Cursor) do a task in Docker and Deckent delivers the change to Git. Business
systems such as an ERP or a CRM use the same contract: a declared operation, a conditional write, a safe resend, acceptance
on evidence and compensation when something must be reversed. Core ships that contract and a generic HTTP target; connectors
for specific ERP products are not built yet.

The open-source Core (Apache-2.0) runs on its own. A proprietary Enterprise edition is planned as a separate distribution
that adds to Core through its registry without editing it; Enterprise SSO, fleet management and ERP connectors belong
there. The [glossary](docs/glossary.md) explains the terms used below, such as scope and realm.

## How it works

You ask for something in plain words. Deckent turns it into checked, isolated steps, and nothing runs unless policy and
your permission mode allow it.

```mermaid
sequenceDiagram
  autonumber
  actor You
  participant T as Deckent terminal
  participant R as Runtime service
  participant P as Policy and approvals
  participant B as Sandbox
  participant L as Ledger
  You->>T: "Run the tests and fix the failing one"
  T->>R: agent turn (model + tools)
  R->>P: may this tool call run here, for this person?
  alt needs approval
    P-->>You: approval window (what, where, who, risk, deadline)
    You->>P: yes once · no · note
  end
  P-->>R: allowed
  R->>B: run the command in the sandbox
  B-->>R: output + write set
  R->>L: record the call, decision and effect
  R-->>T: streamed answer
  T-->>You: result, with every step visible
```

Three jobs make this work:

| | |
|---|---|
| 🗼 **Govern** | One identity, scope and policy model for people and AI agents. When something needs approval, the window shows exactly what: the full command, where it runs, on whose behalf, the risk, whether it can be undone and a deadline. A persona or a model's advice never grants authority. |
| 🛫 **Execute** | Runs, tasks and workers are admitted, scheduled and recovered on your machines. Agent shell commands and MCP servers run in sandboxes (bubblewrap, Landlock); coding workers run in Docker. Models come from Anthropic, OpenAI, DeepSeek, Z.ai (GLM), OpenRouter, a local server or an OpenAI-compatible endpoint with published prices. |
| 📜 **Prove** | Every decision and effect lands in a durable ledger and audit trail. Approvals are sealed, patches are retained, and a change is integrated in an isolated candidate before it is delivered. |

Every way in speaks the same typed contract. Operations that need the runtime go through one local runtime service per
project, which checks identity, scope and policy on each call, writes the result to the ledger and lets effects happen
only where policy allows. Setup, observation and some patch steps use the same contract locally, without the service.

```mermaid
flowchart LR
  subgraph Ways in
    T[Terminal]
    C["deckent command"]
    M[MCP server]
    S[SDK]
  end
  T & C & M & S --> R["Runtime service<br/>one typed contract"]
  R --> P["Policy · approvals<br/>identity · scope"]
  R --> L[("Ledger · audit")]
  R --> X["Runs · tasks · workers"]
  X --> B["Sandboxes<br/>bubblewrap · Landlock · Docker"]
  R --> G["Model providers<br/>API · OpenRouter · local"]
  R --> N["MCP servers<br/>sandboxed · trust-pinned"]
```

## Get started

### Requirements

- Linux or Windows through WSL2, on x86_64. Native Windows is not supported yet; macOS is only partly verified.
- Node.js 24.22.1 or newer on 24.x, or 26.12.1 or newer (Node 25 is not supported).
- Docker. The build uses it to compile the locked bubblewrap sandbox (0.13.0), and coding workers run in it. Your first
  chat session needs neither Docker nor a paid call.
- Git and a C build toolchain (for the native sandbox helper).

### Install from source

Until the npm package is published, build Deckent once from source and link the `deckent` command:

```sh
git clone https://github.com/Verhex/deckent-next.git
cd deckent-next
npm ci
node scripts/build-bwrap.mjs --arch all --out .pack/bwrap/first-build
node scripts/build-bwrap.mjs --stage-dev .pack/bwrap/first-build
npm run build
npm link
```

The build ends with `bubblewrap=present` or `bubblewrap=staged from …`. If it stops with `BUBBLEWRAP_BUILD_REQUIRED`,
Docker was not reachable: start it and run the build again. On Ubuntu 24.04 and later the kernel may block the user
namespaces bubblewrap needs; Deckent then says so and falls back to Landlock. The
[operator reference](.deckent/docs/architecture/operator-reference.md#source-build-and-sandbox-posture) explains both
cases and how an administrator lifts the restriction. The [contributor quickstart](CONTRIBUTING.md#a-30-minute-quickstart)
lists the prerequisites again and runs one test without a provider key.

### Your first session

From an empty project to a governed chat and what it cost, without leaving Deckent. Change to your own project folder,
outside the Deckent source checkout; from here on everything is `deckent`.

```mermaid
flowchart LR
  I["1 · Set up<br/><sub>deckent init policy</sub>"] --> O["2 · Open<br/><sub>deckent</sub>"]
  O --> P["3 · Connect a provider<br/><sub>/provider · key · free check</sub>"]
  P --> B["4 · Set a budget<br/><sub>Create budget · USD</sub>"]
  B --> M["5 · Choose a model<br/><sub>/model</sub>"]
  M --> W["6 · Work<br/><sub>approvals · modes</sub>"]
  W --> U["7 · Check usage<br/><sub>/usage</sub>"]
```

1. **Set up once per project.** A *scope* is the stable name that ties policy, work records and spending to this project;
   it is not a folder or a sandbox. Choose one, such as `my-project`, preview the first-run policy and install it:

   ```sh
   deckent init policy --scope my-project --preview
   deckent init policy --scope my-project --apply
   deckent doctor
   ```

   The policy lets you connect and call models, keep keys and set budgets in that scope; each of those actions is still
   checked and recorded. `deckent doctor` reports what is ready and exits non-zero if setup cannot start. `deckent init`
   is the guided alternative: it walks through the same setup and lists what is still missing.
2. **Open the terminal** with `deckent`. It opens in the scope you just set up (`deckent --scope my-project` picks one
   explicitly) and starts the runtime service in the background.
3. **Connect a provider** with `/provider`. Type the key into a masked field; Deckent checks it with a free request where
   the provider offers one and stores it under its name. The value is never shown again, and no agent or worker receives
   it. Then choose **Connect a model** and pick an exact model from the provider's list.
4. **Set a budget.** Every paid API turn reserves money from one shared USD budget of the scope, so without a budget each
   paid turn is refused, and the windows say why. The first row of `/provider`, **Create budget**, offers 5 to 100 USD or
   another whole-dollar amount up to 1000, then a confirm step. Local models need no budget.
5. **Choose a model** with `/model`, for this session or as your default. A model you cannot use yet is shown locked,
   with the reason and the fix.
6. **Work.** Ask in plain words. Tool calls follow your company's policy and your permission mode; anything that needs
   you opens the approval window (see [Safety and control](#safety-and-control)).
7. **Check usage** with `/usage`: the tokens this conversation used and the scope's budgets. It is Deckent's
   measurement, not the provider's invoice.

<table>
  <tr>
    <td width="50%"><img src=".github/assets/screenshots/en/09-model.png" alt="/model with no budget: both models locked with the reason"><br><sub><b>Before a budget.</b> <code>/model</code> locks each model it cannot use yet and names the reason and the next step.</sub></td>
    <td width="50%"><img src=".github/assets/screenshots/en/08b-provider-budget-row.png" alt="/provider with Create budget as its first row and the provider list"><br><sub><b>/provider.</b> <b>Create budget</b> first, then each provider with its connection state.</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src=".github/assets/screenshots/en/10-budget.png" alt="Budget window with preset amounts"><br><sub><b>Budget window.</b> Preset amounts, or another amount with the arrow keys.</sub></td>
    <td width="50%"><img src=".github/assets/screenshots/en/11-budget-stepper.png" alt="Budget stepper set to 20 USD"><br><sub><b>Another amount.</b> Whole dollars, 1 to 1000; nothing is sent before you confirm.</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src=".github/assets/screenshots/en/12-model-ready.png" alt="/model after the budget: one model ready, one locked as not connected"><br><sub><b>After the budget.</b> The connected model is ready; the other stays locked until it is connected.</sub></td>
    <td width="50%"><img src=".github/assets/screenshots/en/13-usage.png" alt="/usage window after one chat turn"><br><sub><b>/usage.</b> Tokens this conversation measured and the scope's budgets.</sub></td>
  </tr>
</table>

The same steps work from the command line, which is how scripts and AI tools do them:

```sh
deckent secret set DECKENT_ANTHROPIC_KEY --main
deckent models create-budget --scope my-project --usd 10
deckent models connect --scope my-project --connection anthropic-api --command-id connect-1 --model claude-sonnet-5-5
```

`secret set` asks for the key in a hidden prompt and refuses a piped key. The
[operator reference](.deckent/docs/architecture/operator-reference.md#provider-connection-details) lists the secret name
of every provider, the local and OpenAI-compatible options and what works with a subscription today.

## Your first job

A chat is only the start. In a job Deckent plans the work, you approve the plan, a coding worker does it in Docker, and
the change is delivered to a Git reference. Nothing reaches one of your branches unless you choose it.

```mermaid
flowchart LR
  S["Set up once<br/><sub>worker image · pool</sub>"] --> D["/do<br/><sub>plan · approval card</sub>"]
  D --> T["/tasks<br/><sub>watch the worker</sub>"]
  T --> L["/deliver<br/><sub>Git reference</sub>"]
  L --> B["Adopt<br/><sub>into a branch, own y</sub>"]
```

Before you start: Docker is running; the project is a Git repository with at least one commit; a model with a budget is
connected (see [Your first session](#your-first-session)); and the coding CLI you want as the worker is installed and
logged in on this machine (`codex login`, or `claude` and then `/login` for Claude Code). The setup below was rehearsed on
a clean machine up to the model step; the rest of the path is used every day in Deckent's own development but has not
been rehearsed from scratch
([known limits](docs/known-limits.md)).

### One-time setup

Four steps prepare where work runs. Each `--preview` shows what would change and writes nothing. `deckent init` and
`deckent doctor` list whichever of these steps are still missing, with the exact command.

```sh
# 1. In the Deckent source checkout: build the worker image; it prints the image id (sha256:…)
npm run worker:image -- /abs/path/worker-images/r4-20260930.json

# 2. In your project: tell Deckent where work runs (use the image id from step 1)
deckent config set execution '{"docker":{"executable":"/usr/bin/docker","imageId":"sha256:<from step 1>","memoryBytes":2147483648,"pids":512,"cpus":1,"logMaxSizeKiB":2048,"logMaxFiles":2,"tmpBytes":1073741824,"deadlineMs":1200000,"controlTimeoutMs":15000,"outputBytes":1048576},"git":{"gitExecutable":"/usr/bin/git","timeoutMs":180000,"outputBytes":8388608}}'

# 3. Declare the worker pool and the first kind of work
deckent init registry --scope my-project --provider codex --kind coding --pool my-workers \
  --execution-slots 2 --in-flight-slots 2 --discovery repository --preview
deckent init registry --scope my-project --provider codex --kind coding --pool my-workers \
  --execution-slots 2 --in-flight-slots 2 --discovery repository --apply
deckent init pool --scope my-project --preview
deckent init pool --scope my-project --apply

# 4. Restart the service so it reads the new configuration
deckent runtime restart
```

The values are examples: choose the worker (`codex` or `claude`), the pool name and the capacity for your machine.
The [operator reference](.deckent/docs/architecture/operator-reference.md#first-job-setup-in-detail) explains every value,
what each preview checks, and what to do on an installation set up before the current first-run policy.

### Run the job

1. **Ask.** In the terminal type `/do` and your request in plain words (`deckent do --request "<text>"` from the command
   line). A connected model plans it, and Deckent prints the plan with an acceptance line for each task:

   ```text
   Plan for Run <run-id> · <status>
   Task t1: <what the task does> · kind coding · WorkClass <class>
     Acceptance: <the criterion the result must meet>
   Permissions checked by policy at admission: <one task/execute per task>
   Waiting for your TTY approval <approval-id>, expires <time>. The model cannot authorize this work.
   ```

2. **Approve.** A card asks you to approve creating the Run. Judge the plan and its acceptance lines (the card's risk and
   undo lines are not classified yet for plans), then press `y`. The card expires after 10 minutes, and the model cannot
   approve for you. "Admitted" then means the work started, not that its result was accepted.
3. **Watch** with `/tasks`, or `/monitor` (`deckent monitor` outside the terminal). When the worker's result is accepted,
   the task waits for delivery.
4. **Deliver** with `/deliver`. The window first sums up the work in plain words: its title, what changed, why it was
   accepted (the worker's own report is marked as a claim), the risk and what yes or no will do. It then lists the
   changed files. `y` writes the change only to a dedicated reference under `refs/deckent/deliveries/`, never to a branch,
   your index or your working files.
5. **Adopt** it into a branch if you want, with a separate `y`. Deckent moves only a branch you allowed and nobody has
   checked out, so create one first:

   ```sh
   git branch deckent/first-job HEAD
   deckent config set execution.adoption.targets '["refs/heads/deckent/first-job"]'
   ```

   Look at the result with `git log deckent/first-job` and merge it yourself. An adoption through the delivery queue can be
   rolled back with its own confirmation; the
   [operator reference](.deckent/docs/architecture/operator-reference.md#delivery-queue-inspect-and-undo) shows the
   commands.

<img src=".github/assets/screenshots/en/16-tasks.png" alt="/tasks live window with no work yet" width="880">

<sub><b>/tasks.</b> Workers and Runs in one live, read-only window (empty here: no background work yet).</sub>

## Everyday use

### In the terminal

`deckent` opens the interactive terminal. Every slash command answers in its own window; <kbd>Esc</kbd> closes it and leaves
one framed `Deckent system` line in the conversation instead of a wall of text. Settings are changed by choosing, not
typing: `/config` walks from section to key to the allowed values, and each change goes through policy and may become
an approval. `/help` lists every command by purpose; the most used ones are:

| Purpose | Commands |
|---|---|
| Work | `/do` ask for a job · `/tasks` live work · `/runs` every Run, with hold, resume and close · `/deliver` · `/cancel` |
| Approvals | `/approvals` pick a pending approval and decide it |
| Settings | `/provider` · `/model` · `/config` · `/mode` · `/mcp` · `/policy` |
| Information | `/status` · `/usage` · `/context` · `/doctor` · `/monitor` · `/scope` · `/help` |

These screens come from the real terminal, recorded on alpha.17 (120×36) in a throwaway project with a small local test
model: no provider was called and no real key was used. They show the inline layout (`terminal.layout: inline`); the
default full-window layout keeps the same windows above a fixed input bar, and some windows have gained rows since.

<table>
  <tr>
    <td width="50%"><img src=".github/assets/screenshots/en/02-chat.png" alt="A chat turn: your line marked You, the answer under Deckent"><br><sub><b>Chat.</b> Your lines and Deckent's answers are visibly distinct, with time and tokens per turn.</sub></td>
    <td width="50%"><img src=".github/assets/screenshots/en/05-approval.png" alt="Approval window for a shell command"><br><sub><b>Approval window.</b> What, where, on whose behalf, scope, why, risk, undo and a live deadline. Current cards also offer "this session" and "always in this project" where policy allows.</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src=".github/assets/screenshots/en/04-status.png" alt="/status window"><br><sub><b>/status.</b> A human summary first; identities, process and build under the details.</sub></td>
    <td width="50%"><img src=".github/assets/screenshots/en/06-full-access.png" alt="Full access mode indicator"><br><sub><b>Modes.</b> <kbd>Shift</kbd>+<kbd>Tab</kbd> cycles the modes you are allowed; full access is clearly marked.</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src=".github/assets/screenshots/en/03-help.png" alt="/help window grouped by purpose"><br><sub><b>/help.</b> Commands grouped by purpose, one line each (newer commands such as <code>/do</code> and <code>/deliver</code> are not in this older screen).</sub></td>
    <td width="50%"><img src=".github/assets/screenshots/en/07-mcp.png" alt="/mcp window"><br><sub><b>/mcp.</b> Add a server step by step; configured servers with their trust state.</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src=".github/assets/screenshots/en/08-provider.png" alt="/provider window listing provider kinds"><br><sub><b>/provider.</b> Each provider's state. OpenRouter now offers model connections; this screen predates them.</sub></td>
    <td width="50%"><img src=".github/assets/screenshots/en/14-config.png" alt="/config window choosing the terminal theme"><br><sub><b>/config.</b> Section, key, then one of the allowed values; the current one is marked.</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src=".github/assets/screenshots/en/15-system-line.png" alt="Framed system lines left by closed windows"><br><sub><b>System lines.</b> Each closed window leaves one framed summary line.</sub></td>
    <td width="50%"></td>
  </tr>
</table>

### On the command line

The `deckent` command does one thing per call and prints text for people; add `--json` for the same result as data.
On a person's terminal, commands that change something pick missing values with arrow keys and confirm on a card; AI
tools, pipes and CI pass every value as a flag and are never asked. `deckent --help` lists every command, and
`deckent <command> --help` shows the details.

```sh
deckent doctor                            # health of this installation
deckent monitor                           # live, read-only view of installations and work
deckent run list                          # Runs of this scope, newest first
deckent approval list                     # waiting approvals first, with the time left
deckent report --scope my-project --run <id>   # one Run's cost and acceptance evidence
deckent audit verify                      # check the audit history
deckent backup create                     # write a verifiable recovery set
deckent policy grants --mine              # your standing "always" grants
```

### Connect an AI client over MCP

MCP works in two directions. To give Deckent's own agent an MCP server, add it with `/mcp` or
`deckent mcp add context7 -- npx -y @upstash/context7-mcp`; it runs sandboxed and starts only after you trust it.

To let an outside AI client use Deckent, register `deckent-mcp`, Deckent's stdio MCP server, in that client; in Claude
Code that is `claude mcp add deckent -- deckent-mcp --project /path/to/project`. Most of its tools need the runtime
service, so keep `deckent runtime serve` running. The client acts as a separate MCP actor that can only observe at
first. To let it do more, open `/policy` (**MCP permissions**), choose a scope and a capability group and grant it after
reviewing the exact rules; the same works from the command line:

```sh
deckent policy mcp list --json
deckent policy mcp grant --group work --scope my-project --preview
deckent policy mcp grant --group work --scope my-project --apply --expect <preview-digest>
```

Applying needs your approval at your own terminal and is audited. [Policy and AI](docs/policy-and-ai.md) explains how
human and AI authority differ.

### The runtime service

Model turns, approvals, `/do` and recovery run in one local runtime service per project. `deckent` starts it in the
background when none is running, and a service the terminal started stops itself after 15 minutes without work.
`deckent runtime serve` runs it in the foreground instead; `deckent runtime restart` restarts it with the current build
and configuration, and `deckent runtime describe` shows the running one. The
[operator reference](.deckent/docs/architecture/operator-reference.md#runtime-service) covers logs, stop permission and
older installations.

## Safety and control

Two things decide every tool call an agent makes: your organization's policy and the permission mode you chose. Policy
sets the limits; the mode only chooses how often you are asked inside them, and a deny always wins. You move between
the modes you are allowed with <kbd>Shift</kbd>+<kbd>Tab</kbd> or `/mode`.

```mermaid
flowchart LR
  S["Standard<br/><sub>edits run · shell and MCP ask</sub>"] -->|Shift+Tab| C["Careful<br/><sub>edits ask too</sub>"]
  C -->|Shift+Tab| A["Full auto<br/><sub>sandboxed shell and MCP run</sub>"]
  A -->|Shift+Tab| F["Full access<br/><sub>company grant · this session · every call audited</sub>"]
  F -->|Shift+Tab| S
  H[["Hard floor · closed in every mode<br/>Deckent state, policy, approvals, audit, credentials"]]
```

| Mode | Runs without asking | Asks first |
|---|---|---|
| **Standard** | Reads, ordinary file edits | Shell commands, protected paths, MCP calls |
| **Careful** | Reads | Every edit as well |
| **Full auto** | Edits, shell commands contained in the sandbox, MCP calls | Host shell, destructive commands (`rm -r`, …), protected paths |
| **Full access** | Everything company policy allows above the hard floor; every call is audited | The hard floor and whatever company policy still requires; needs a company grant and lasts for this session |

The installation owner opens full auto and full access with
`deckent init policy --scope <id> --modes full-auto,full-access --preview` and then `--apply` at their own terminal;
AI tools, pipes and CI cannot. Agent shell commands run in a sandbox: in the first three modes the project is writable
within the call's approval, `.git` is read-only, your home folder is hidden and the network is off. Full access needs an
open bubblewrap sandbox, which adds the network and your home folder but still hides Deckent's own state and known
credential files. The [operator reference](.deckent/docs/architecture/operator-reference.md#sandbox-views) describes
each view and its limits.

### Approvals

When a call needs you, the approval window shows the full command, where it runs, on whose behalf, why it asks, the risk,
whether it can be undone and how long you have; if nobody decides, nothing runs. Only the terminal that started the turn
can answer, and a model can never approve. Answer once, for this session or always in this project where policy offers
it; your "always" grants are listed with `deckent policy grants --mine` and removed with `deckent policy revoke`. For an
operation on a business system the card names the operation, the target and a short digest of the input; the individual
fields it will write are not shown yet.

### API keys

Store a provider key once, in the masked field of `/provider` or with `deckent secret set NAME --main` (a hidden prompt;
a key passed as an argument or through a pipe is refused). Never put it in `ANTHROPIC_API_KEY`, a shell profile or a
`.env` file: other tools read those. Fresh installations on Linux, WSL and macOS keep keys in an encrypted store.
Provider calls resolve the key inside the runtime, so it never reaches a prompt, the shell environment, an agent or a
worker. The encrypted store's unlock key sits next to it, so other programs running as your user could still open it;
`deckent doctor --verbose` says who can read your store, and the
[operator reference](.deckent/docs/architecture/operator-reference.md#secret-stores-and-strict-install) shows the stores
and a stricter setup.

### Spending

Each scope has one USD budget shared by every API provider. Before a paid call Deckent reserves the most it could cost;
afterwards it settles the call from the usage the provider reported, multiplied by the verified published price
(OpenRouter calls settle from the cost OpenRouter reports). A remote model without a verified price is refused. A call
that never reported its final usage stays reserved until you resolve it with `deckent models reconcile-spending`. If a
charge ever exceeds what was reserved, the scope stops new paid calls until you lift the freeze with
`deckent models revise-budget --scope <id> --usd <n> --unfreeze`. The settled amount is Deckent's calculation, not the
provider's invoice, so keep a spending limit in your provider account as well. The
[operator reference](.deckent/docs/architecture/operator-reference.md#spend-settlement) covers price tiers and
OpenRouter settings.

## What works today

- **Work with an agent in the terminal**: streamed turns, file edits and a sandboxed shell, approval and monitor windows,
  permission modes, MCP tools, conversation compaction, in English and Turkish.
- **Ask for a job in plain words**: `/do` plans it with acceptance criteria, you approve, a coding worker (Claude Code,
  Codex or Cursor) does it in Docker, and `/deliver` writes the result to Git and adopts it into a branch only when you
  choose.
- **Orchestrate work**: Runs, tasks and attempts are admitted, scheduled, held, resumed, cancelled and recovered, all
  recorded in a durable SQLite ledger.
- **Choose models and control cost**: connect your own key, pick a model per session or as default, run local models,
  use the Anthropic prompt cache, and keep every paid call inside a budget you set.
- **Govern**: local identities, scoped company policy, one approval broker for every surface, standing grants you can
  list and revoke, and an audit trail you can verify.
- **Operate**: `deckent monitor` for a read-only view, `deckent doctor` for health, `deckent config` for settings, and
  `deckent backup create|verify|restore` for verifiable recovery sets on a schedule if you choose.

### Not yet

- **No npm package.** Install from source until the beta.
- **No Desktop app, Dashboard or remote HTTP API.** Use the terminal, the `deckent` command, MCP or the SDK.
- **No coordination of multi-step business processes yet.** One request becomes one Run; Missions that coordinate
  several rounds and waits are planned.
- **No ERP or CRM connectors.** The operation contract and a generic HTTP target exist; product connectors do not.
- **Delivery is never automatic.** A rule records whether it *would* deliver each queued item, but it only advises; every
  delivery, adoption and rollback waits for your `y`.
- **Coding tasks are accepted on the worker's exit code.** The content is not verified independently yet, and the
  window says so.
- **Subscriptions are partial.** A Claude Code worker runs with your own Claude login; chatting in the terminal with a
  Claude subscription, a subscription-backed planner and Sign in with ChatGPT are not available yet.
- **Platforms.** Native Windows is not supported, macOS is only partly verified and arm64 is not shipped. A Docker worker
  shares the host kernel; it is not a virtual machine.
- **No Enterprise SSO, fleet management or central policy service** in Core.

[Known limits](docs/known-limits.md) lists every open, untried or partial item with its impact and a workaround.

## Roadmap

Dates are not promised; the order is. The beta begins with the npm package and continues with orchestration, then the
Desktop app.

```mermaid
flowchart LR
  N["Now · alpha.53 release candidate<br/>terminal · approvals · budgets · MCP<br/>/do → coding workers → Git delivery<br/>backup and audit"] --> B1["Beta.1<br/>npm package · Node 26 verified<br/>Linux and WSL2"]
  B1 --> O["Beta · orchestration first<br/>Brain plans and accepts · Nervous watches<br/>model chosen per kind of work<br/>delivery by rule, after its advisory phase"]
  O --> D["Beta · then Desktop<br/>calm, chat-first app<br/>agent organization · native Windows and macOS"]
  D --> E["Enterprise · separate distribution<br/>SSO · fleet · central policy<br/>ERP connectors"]
```

In the beta the **Brain** is the planner that turns a request into a plan and accepts the results, and the **Nervous**
layer watches running work and reacts when it stalls or fails. Both act only through the same policy and approvals as
everything else.

## Learn more

- [Architecture overview](docs/architecture-overview.md): layers, security, extension points and current limits
- [Policy and AI](docs/policy-and-ai.md): human and AI authority, delegation, administration commands and compliance evidence
- [Glossary](docs/glossary.md): scope, realm, work lifecycle, approvals and spending
- [Known limits](docs/known-limits.md): what is not tried, not built or still open, with the impact and a workaround
- [Operator reference](.deckent/docs/architecture/operator-reference.md): setup values, sandbox views, key stores,
  spending, worker images, patch custody and recovery sets in detail
- [ARCHITECTURE.md](ARCHITECTURE.md): detailed engineering contracts and implementation notes
- [CHANGELOG.md](CHANGELOG.md): what each release brought
- [CONTRIBUTING.md](CONTRIBUTING.md) · [Code of Conduct](CODE_OF_CONDUCT.md) · [Security](SECURITY.md)

## License

Apache-2.0 (see [LICENSE](LICENSE)).
