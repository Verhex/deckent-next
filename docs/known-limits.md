# Known limits

[Türkçe](known-limits.tr.md) · [README](../README.md) · [Architecture overview](architecture-overview.md)

This page says plainly what Deckent does not do yet, what has not been tried, and what you should do instead. It
describes the current pre-release (the version is in the [README](../README.md) and the top line of the
[CHANGELOG](../CHANGELOG.md)). A limit leaves this page when the change that closes it has landed and been
seen working, not before. Each item gives **what** the limit is, **the impact** on you and, where one exists, a
**workaround**. [CHANGELOG.md](../CHANGELOG.md) lists the limits each release carried at the time.

Deckent is a pre-release. Nothing here is a promise of a date.

## Platforms: tried and not tried

- **Tried:** Linux and Windows through WSL2 (the supported execution path). Hosted checks run on Ubuntu with Node 24 and
  Node 26. Node.js 24.22.0 or newer is required (24.21 and older 24.x have a heap overrun in UTF-16LE decoding).
  *Impact:* these are the only places where behavior has been observed.
- **Not supported: native Windows runtime.** The service transport does not run there, and the file-based secret stores are
  not available there. The OS-user identity cannot be read and the private ledger files cannot be opened, so backup, the
  monitor, model calls, the Brain and acceptance do not work natively either. Platform tests skip these with an
  `[unsupported on Windows: …]` tag, so a green Windows check does not mean these parts work. *Workaround:* use WSL2.
- **macOS has separate, incomplete verification.** It is not part of the required checks. *Impact:* execution and security
  behavior there is unproven; do not rely on it for real work. The local runtime socket is Linux-only, so the service
  transport, backup and restore do not run on macOS either; platform tests skip them with a `[requires Linux …]` tag.
- **The terminal screen layout has not been tried** on physical Windows Terminal, macOS Terminal, VS Code's terminal or tmux.
  *Impact:* the input bar, windows and colors may misbehave there. *Workaround:* use a plain Linux or WSL2 terminal.
- **arm64 is not shipped.** The locked bubblewrap bundle ships for x86_64; an arm64 build check is not arm64 runtime proof.
  *Workaround:* use x86_64.
- **No npm package yet.** You install from source (see [Get started](../README.md#get-started)).
- **Some install-time messages are English only** (build and sandbox preparation messages appear before translation exists).

## Isolation

- **A Docker worker is not a virtual machine.** It shares the host kernel. *Impact:* a kernel-level escape is not
  contained by Deckent. A microVM sandbox is planned, not built.
- **A coding worker's own tools sit outside Deckent's model ingress.** Claude Code, Codex and Cursor use their own tools
  inside the container. *Impact:* those tool calls are not decided by Deckent's per-call approval windows; what contains
  them is the container, the checkout and the delivery gate. *Workaround:* give workers only the checkout and the
  permissions the job needs.
- **Ubuntu 24.04 and later can block the sandbox.** If `kernel.apparmor_restrict_unprivileged_userns` is `1`, bubblewrap cannot
  start; Deckent falls back to Landlock visibly and refuses full-access shell calls. *Workaround:* an administrator installs
  bubblewrap root-owned as `/usr/local/bin/bwrap` with an AppArmor profile that allows `userns` for it (see
  [Get started](../README.md#get-started)).
- **On a Landlock-only host a large `.gitignore`d folder can refuse the shell.** Landlock now checks folders named in
  `.gitignore` for credential files like bubblewrap does, so they count toward its 20,000-entry limit (bubblewrap: 50,000).
  *Impact:* a project over the limit gets the shell refused with a visible reason instead of running. *Workaround:* make
  bubblewrap usable, or keep large generated folders out of the project folder.
- **The `prefer-sandbox` host fallback has no enforced filesystem boundary.** In the closed modes, when no sandbox is
  usable the call may run on the host. *Workaround:* set `require-sandbox` when confinement is required.
- **Credential and home-folder hiding is bounded.** The shared registry covers gh, Docker, kube, Codex, Git credentials and
  common cloud CLIs; hiding stops at depth 3 and 20,000 entries. *Impact:* custom locations and unusual file names are not
  masked. *Workaround:* keep such files out of the home folder the sandbox sees, or isolate separately.
- **Only the installation config may name a secret.** A `$DECK:NAME` reference in the project config (`.deckent/config.json`)
  refuses the whole config load with `SECRET_REFERENCE_PROJECT_LAYER`, and the delivery commit author may not be a reference
  in any config (`SECRET_REFERENCE_LEAVES_HOST`). *Impact:* a project file written before alpha.48 that used `$DECK:` stops
  loading until it is changed. *Workaround:* move the reference into the installation config, or write the plain value.
- **The secret gate does not scan Git history.** Before dispatch it scans everything the worker receives (checkout, `.git`
  metadata, binds, task inputs, prompt context) and refuses on a hit; past commits in the object store are not scanned.
  Exclusions are configured paths or a declared dependency tree only, audited and shown on the Run card. *Workaround:*
  remove committed secrets from history and rotate them; never put credentials into a request, a prompt or `DECKENT.md`.
- **A declared dependency tree is trusted for content patterns.** A read-only bind the task profile declares
  `dependencyTree` (for example `node_modules`) whose real path lies outside the attempt workspace and the work-target
  checkout is third-party content (without a separate work target the project root is the checkout, so a bind inside it
  keeps the normal rules): credential-shaped text in it (test fixtures, type
  definitions, READMEs) passes as an audited exception instead of refusing, and a native binary above
  `execution.secretGate.maxFileBytes` is read in bounded windows and listed by its SHA-256 digest. In a file whose header
  claims a native format, private keys and provider or cloud tokens refuse. Deny-listed
  files (`.npmrc`, `.env`, keys) and configured secret values still refuse there; archives and any other oversized file
  are still unscannable; oversized binaries are read only in 1 MiB windows, and one whose window carry cannot be bounded
  (more than 1 MiB) or that holds an archive anywhere in its body (an appended zip, an embedded gzip member) is unscannable.
  Archive detection follows each container's most lenient common extractor (a zip end record anywhere in the body, judged without its stated
  offsets, gzip with reserved flag bits, a signed tar checksum), but compressed or encoded data without a container header (raw
  deflate, zlib, brotli, LZMA-alone, lz4, a custom encoding) cannot be told apart from machine code: it passes inside the
  binary's digest exception, and a worker can decompress it at a known offset (for example with Node's own zlib). A native binary at or below `maxFileBytes` is read whole and an archive is recognised only at its start, so an archive embedded later in such a binary passes (closing it would refuse common dependency binaries such as esbuild; during beta this moves to scanning every offset with lockfile-pinned digest exceptions). Pattern results are cached per file content under the product's `state/tree-scan-cache`; a changed lockfile
  or release starts over, and the unsigned cache can change only which exceptions are listed, never a decision.
  The tree is scanned on the host and bound live, read-only: a change made on
  the host after the scan reaches the worker unscanned (as for any bind).
  *Impact:* a real token planted in a dependency package as plain text reaches the worker, visible only as an exception.
  *Workaround:* declare only trees installed from a lockfile you trust, and review the exceptions on the Run card.
- **Concurrent dispatches share one secret scan of an identical dependency tree only inside one process.** The runtime service admits
  `execution.secretGate.maxConcurrentScans` scans at a time, and dispatches whose declared dependency bind has the same source, target,
  lockfile bytes and configuration await the scan already in flight. A separate CLI `execute` process scans on its own, a bind without a
  readable lockfile is never shared, and a dispatch that joins a scan in flight relies on files that scan read before the dispatch arrived
  (the same window as any change after a scan). Bounds now apply to the dispatch's own views and to the shared binds separately. A scan
  that runs out of time under load is retried up to `maxTimeRefusals` times per attempt before the attempt is refused.
  *Workaround:* raise `maxConcurrentScans` or `timeoutMs` for large trees; run the service rather than parallel CLI executions.
- **The secret gate's config rule covers config-like files only.** A password written into ordinary source code is not
  detected. *Workaround:* keep secrets in a secret store, never in source.

- **An AI agent running on your own operating-system account is not contained by Deckent's approvals.** Approval and
  audit records are sealed with a key stored in your account, the interactive-terminal check proves a terminal rather than
  a person, and your account can write the policy file. Where your account can use Docker or sudo, such an agent can in
  practice do anything. *Impact:* approvals and policy hold against Deckent's own sandboxed workers, not against other
  agents you run as yourself. Audit checkpoints (`deckent audit verify`) show a changed policy or producer set and a cut
  or wiped audit trail; undoing both local histories together on your own account is only caught by a checkpoint export
  kept on a separate device. A separate approval channel, a fixed audit floor and the design for remote decisions are worked on during the beta process; hardware-key signed policy and approvals follow after beta. *Workaround:* run other AI agents under a
  separate account without Docker or sudo, and keep Deckent's workers in their sandbox.

## Providers and subscriptions

- **Claude subscription:** a Claude Code worker runs with your own Claude login. A subscription-backed Brain (the planner
  behind `/do`) is being prepared and is not available yet. Terminal chat with a Claude subscription is not supported for now.
  *Workaround:* use an Anthropic API key for terminal chat and `/do` planning.
- **Today the worker takes your login by reading the CLI's own credential file** in your home folder. *Impact:* that file
  must exist and be readable by Deckent. This path may change.
- **A subscription worker holds a short-lived copy of your login token while it runs.** Deckent copies only the current
  access token (for Codex also the ID token) into the worker's container and checks that it has not expired; refresh tokens,
  API keys and the rest of the login file stay on the host. *Impact:* the worker's CLI can act as your subscription account
  until that token expires. *Workaround:* none; the token's own lifetime is the bound.
- **Sign in with ChatGPT is not available yet.** `/provider` lists it as not available; a visible sign-in is worked on during the beta process. *Workaround:* an OpenAI API key, or a
  Codex worker with its own login.
- **No automatic fallback from a subscription to an API model yet.** Deckent does not switch to a paid API by itself when a
  subscription window is used up; routing across a declared candidate list is planned. *Workaround:* connect an API model
  yourself and choose it.
- **A remote model without a verified published price is locked.** Zhipu GLM China stays locked because its prices are in
  CNY. DeepSeek settles at the published peak price, labelled an upper bound. *Workaround:* use a priced model or a local
  one.
- **A model server on another machine cannot be connected yet.** Plain `http` is accepted only on this machine
  (`127.0.0.1` or `[::1]`), and a remote OpenAI-compatible server needs a published price row; today those exist only for
  the OpenAI, DeepSeek and Z.ai APIs, and there is no way to declare your own price. *Impact:* a company model server on
  your network cannot be used. *Workaround:* run the model server on this machine.
- **The model a Codex or Cursor worker used cannot be verified.** Only Claude Code reports per-model usage; Codex and Cursor
  results are recorded as unverified and accepted by their criteria. *Impact:* if such a worker ran another model, the work
  is still accepted.
- **Cursor has no packaged worker model catalog.** A worker is admitted only on an active `native-cli` catalog channel;
  Claude Code and Codex have packaged catalogs, Cursor does not. *Workaround:* write a catalog and register it with
  `deckent models catalog register --file`.
- **Deckent cannot see provider-side settings.** For OpenRouter it cannot see the "Prevent overrides" plugin setting or your
  OpenRouter credit limit. *Workaround:* check both yourself before the first paid call.
- **MCP trust from before alpha.48 is asked again once.** Trust for project and local MCP servers moved out of the project
  folder into the Deckent global root, so a repository can no longer ship it. A server trusted before alpha.48 waits for its
  card (`mcp list` reason `trust-moved`); `deckent mcp approve <name> --yes` refuses it with `MCP_TRUST_NEEDS_CARD`. The old
  `integrations/mcp-trust.json` in the data folder is left in place and never read as trust. *Workaround:* answer the card on
  first use in the terminal, or run `deckent mcp approve <name>` in a terminal; then delete the old file if you like.
- **A project MCP file reads only a few environment variables.** `${VAR}` in a project `.deckent/mcp.json` reads only `HOME`,
  `USER`, `LOGNAME`, `LANG`, `LC_ALL`, `TZ` and `TMPDIR`; any other name reads as its written default or empty, and a value
  that carries a credential refuses the server. Known installation secrets are not yet compared (credential patterns only).
  *Workaround:* put a server that needs other variables in your local or user scope (`deckent mcp add`).
- **Project MCP trust needs a global root outside the project.** When `DECKENT_GLOBAL_HOME` (or, without it, `DECKENT_HOME`)
  points inside the project, project and local servers show `trust-store-unavailable` and never start. *Workaround:* point
  `DECKENT_GLOBAL_HOME` outside the project.
- **Trusting an MCP server needs a person at a terminal.** `deckent mcp approve` and `deckent mcp add` to a local or user scope
  show their card only on a real terminal; from a pipe, CI or an AI tool they are refused (`MCP_APPROVAL_NEEDS_TERMINAL`), and
  `--yes` no longer skips the card. *Workaround:* add the server with `--no-approve` from a script; it asks on first use.
- **`deckent mcp import` takes every server of the chosen client.** On a terminal you pick the client; picking single servers is
  not offered yet. Imported servers stay untrusted. *Workaround:* `deckent mcp remove <name>` after the import.
- **MCP servers over OAuth are not supported.** Streamable HTTP servers work without OAuth. *Workaround:* use a local stdio server or an
  HTTP server that does not need OAuth.

## Budgets and spend

- **There is no spend ceiling for a whole Run.** Each paid model call is reserved against the scope's USD budget at the
  dearest applicable price, but there is no limit on the total a long-running API worker may spend. *Impact:* a Run on an
  API worker can use up the scope budget. *Workaround:* set a small scope budget and a credit limit at your provider.
- **Subscription and local models are not metered by the USD budget.** A subscription or local model keeps working with no
  budget. *Impact:* their limits are your provider plan's limits, not Deckent's.
- **Per-provider spend limits are not built.** There is one shared USD budget per scope. *Workaround:* set limits in each
  provider account.
- **Settled spend is Deckent's own calculation,** from the usage the provider reports times a verified price (OpenRouter
  calls settle from the cost OpenRouter reports). It is not the provider's invoice.
- **A call that never reported final usage stays held** until you resolve it with `deckent models reconcile-spending`.

## Delivery and adoption

- **A work task needs a valid result report, but a worker CLI without one is not checked.** Since 1.0.0-alpha.47 a work task that
  exits 0 without a valid report fails as `report-missing` or `report-invalid`. A CLI that has no structured result channel (today
  Cursor) or whose installed version no longer offers it reads `unsupported` and is not gated. Typed report checks (`checkId`,
  `role`) are defined but the container bridge does not accept them yet. *Workaround:* prefer Claude or Codex workers for tasks
  whose completion must be proven.
- **A silent worker is stopped and retried once, but only some tasks are watched.** Since 1.0.0-alpha.47 a native-subscription worker
  that sends no event and no model traffic for the silence limit (default 1 hour, `runRuntime.stallRecovery.stopAfterMs`; warning
  after 3 minutes) is stopped. A task whose effects stay in its own workspace is retried once on a new Attempt; any other task waits
  for a human as before. The limit applies only when it stops before the profile deadline: a task whose profile deadline is shorter
  than the limit (with the 1-hour default, any deadline under an hour) is not watched, gets no silence warning and is bounded by its
  deadline only. Runs created before alpha.47 and workers without the native gateway are also bounded by the deadline only. A silent
  worker keeps its execution slot until it is stopped, so a hung worker can hold a slot for up to the limit. The monitor's
  `worker-silent` warning sees worker events, not model traffic, so it can warn while the worker is still working. A single long
  tool call inside the worker (a build, a test run or a lock wait) sends no event and no model traffic while it runs, so it counts as
  silence: a call longer than the limit is stopped, and a repeat fails the task as `worker-stalled`. The stopped Attempt's workspace
  clone stays held. *Workaround:* keep `runRuntime.stallRecovery.stopAfterMs` (or a work class's `inactivity`) above your longest
  tool call; lower it, or raise the profile deadline, when the deadline comes first and you want silent workers stopped earlier.
- **The target queue is in live use but not yet accepted for the beta.** It has run live since 1.0.0-alpha.43 and settled real deliveries. It connects registered Git targets, private
  combined-candidate verification, separate publish/adopt batch cards and a separately confirmed rollback. Runtime protocol
  v29 and ledger v58 need a rebuilt binary and verified pre-switch ledger backup. Native terminal/socket/crash and N1 load
  acceptance are still separate gates; there is no measured capacity claim. Queue inspection reports last-known state, and
  position counts this authorized scope only. Explicit refresh is currently needed in the delivery window.
- **Queue verification needs an installed profile and normal Run authority.** The original evaluator criteria and the current
  adoption bar are conjunctive. An unsupported profile/changed evaluator refuses; a Run-create approval can leave the ticket
  waiting. After answering that ordinary approval, replay the same enqueue command; no policy is bypassed. Unknown effects
  stay reconciling; elapsed TTL does not prove an old process ended.
- **Queue generation blocks direct legacy writes.** Activation is the first consented queue execution on a target; enqueue,
  preparation, verification, a conflict and a declined or expired card write nothing to it, and a direct write before
  activation only makes a waiting ticket stale (typed refusal). After activation use the queue command family, including
  `integration-queue-rollback` plus `integration-queue-confirm`; a busy target refuses rollback. Existing direct-path limits
  below describe historical/direct integrations, not a weaker way around the queue. No remote-host branch-protection lookup
  is performed: protection uses registered policy and local repository/remote-HEAD metadata.


- **Delivery and adoption are Git only.** A work target is one Git repository (exactly one is supported). *Impact:* work on a
  business system has no delivery surface; its results are not delivered like a patch.
- **A checked-out branch cannot be adopted into.** Adoption only moves a branch no worktree uses, so the branch you are
  working on (often `main`) is refused. *Workaround:* create a separate branch (`git branch deckent/first-job HEAD`),
  list it in `execution.adoption.targets`, and merge it yourself.
- **A stale prepared direct delivery to the same branch is refused** unless the branch is still at the delivery base
  (`ADOPTION_BASE_CHANGED`). Deckent never rebases or merges for you. *Workaround:* deliver again on the current base.
- **A patch made on a stale checkout can fail to apply.** The delivery check stops it before anything is written.
  *Workaround:* re-run the request on the current source.
- **There is no rollback window in the terminal.** Rolling back an adoption is a command-line step; the terminal shows the
  adoption's command id and the `deckent task integration-rollback --adoption-command-id` hint. *Workaround:* run that
  command, or move the branch back with Git yourself, using the commit shown in the `Adopted:` line.
- **After a delivery the terminal window does not reopen** for that task, although some messages say `/deliver` opens it
  again. *Workaround:* adopt from the command line, as in the previous item.
- **The adoption window cannot pre-filter verification Runs by commit.** It lists accepted verification Runs of the configured
  kind; one that verified a different commit is refused at adoption and the window returns to the choice.
- **A verification Run cannot be created from the terminal.** *Workaround:* run the `deckent run create ...
  --delivery-command-id <id>` command the window shows from another shell, then press `r` in the window.
- **By default adoption rests on recorded acceptance, not verification.** The `Adopted:` line says so. *Workaround:* configure
  `execution.adoption.verification` so a verification Run is required.
- **The approval card for creating a Run does not fill every line.** Its Risk and Undo lines say the tool did not classify or
  declare them. *Workaround:* read the plan and its acceptance criterion; approving creating a Run does not accept its result.
- **`deckent do` on the command line does not continue after you approve.** It plans and records the proposal, then you
  repeat the same command with the same `--command-id` after the decision; the id is not printed, so pass your own with
  `--command-id`. In the terminal `/do` continues by itself.
- **A worker that asks you a question cannot be answered from the terminal yet.** *Workaround:* `deckent run resume --scope <id>
  --id <run> --command-id <id> --expected-revision <n> --task <id> --answer <text>`.
- **Autonomous delivery is designed but off.** Every delivery and adoption needs your `y` in a verified terminal.

## ERP and operations

- **There are no ERP connectors.** The operation contract (intent, conditional write, idempotent resend, evidence-based
  acceptance, compensation) and the extension entry exist; IFS, SAP, Oracle, Microsoft, Uyumsoft or Logo adapters do not.
  The only worked target is a test fixture. Core also ships a generic `http-conditional` REST target (ETag, `If-Match`,
  `Idempotency-Key`; its operations are declared in config); it sends no credentials. *Impact:* you must write your own
  adapter to run ERP effects, including any ERP that requires authentication.
- **There is no `deckent operation list`.** You can look up one operation with `deckent operation inspect --scope <id>
  --command-id <id>`, so you must keep the command ids you used. *Impact:* pending and uncertain effects cannot be listed.
- **An uncertain ERP write has no exit except a resend.** If the target cannot say whether the write happened, Deckent does not
  retry it by itself and the record keeps the target busy. When the target can confirm afterwards, resend the same command id and
  its evidence settles the record; if it cannot, the record stays unresolved. *Impact:* a person cannot close it yet. Closing
  it with a human declaration (with attached evidence, not counted as acceptance) is planned.
- **The approval card for an operation shows the operation, the target and a 12-character input digest,** not the fields it will
  write. *Impact:* the approver cannot see an amount or status. *Workaround:* inspect the input file before approving.
- **Ten of the seventeen reasons an ERP result may be not accepted have no readable text** (six about evidence, four
  about compensation); you see the code.
- **A read operation returns only the record version,** not the business data.
- **Each operation is a hand-written JSON command** with its own command id, idempotency key and expected version, and the
  operation catalog and target configuration are not described in user documents.
- **ERP effect results are not yet written to the audit trail as their own events.** Authority and policy changes are audited;
  the generic effect path records its result in the ledger.
- **Enterprise SSO, fleet management and the central policy service are not available.** The policy module's remaining
  parts (founder-admin recovery with a card, two-person handover, role editing, signed packages) are not built.

## Recovery and upgrades

- **Backup sets are not fully encrypted.** Only the authority key inside a set is encrypted with your passphrase; the ledger and
  the state archive are plain files. *Workaround:* store sets on encrypted storage and keep the passphrase apart.
- **A restore turns the backup schedule off,** and provider keys and the backup passphrase are not in the set. *Workaround:*
  after a restore, choose `backup.schedule` again and run `deckent secret set` for each key.
- **A restore needs the service stopped,** and the message does not name the command. *Workaround:* `deckent runtime shutdown`
  (the long form with `--service`, `--instance`, `--command-id` and `--reason` also works), close open terminals, then run
  the restore again.
- **The relative path of a backup set is refused with a misleading message.** Use an absolute path.
- **You cannot go back to an older Deckent after a ledger upgrade** without restoring the backup taken before the upgrade
  (newer ledger versions cannot be opened by older builds).
- **The daily backup schedule takes no backup right before a ledger upgrade.** `backup.schedule` holds one value (off, daily or
  before-upgrade), so with daily the upgrade starts without a fresh set and the way back is the newest daily set, up to about a
  day old. *Workaround:* before an upgrade run `deckent backup create --scope <id> --set <absolute path>` yourself, or choose
  before-upgrade instead of daily.
- **A lost worker can keep its slot.** A granted attempt can stay active and hold an execution slot until custody is resolved.
  *Workaround:* watch it with `deckent monitor`; the slot is freed only by a typed manual decision or by evidence that the worker ended.
- **The clean-machine rehearsal stopped at the model step.** A fresh clone on 2026-10-15/16 reached install, `doctor`, policy,
  registry and pool. The model connection, `/do`, a worker image build on an empty Docker daemon and the start-up
  toolchain refresh on a clean daemon were not exercised there. *Workaround:* follow the README first-job path and report what differs.
- **Restart recovery has not had an independent review** with a real container kill and service restart.
- **After an upgrade that sets `service.identity`, a running service needs one manual stop** (Ctrl+C on `deckent runtime serve`,
  or its idle stop) before `runtime restart` works: a service reads its identity only when it starts.
- **The service identity and the clock.** A rare window remains at first publication of the installation identity; a slow
  clock drift inside the tolerance is not detected; one overlay case where a stopped run reports `cancelled` is not reproduced.
- **A /do plan that is still waiting for approval from before this release, and that was waiting only because of a task-level
  approval rule, does not continue after the upgrade:** resubmitting it parks it (`APPROVAL_CONFLICT`). *Workaround:* start a new
  /do; the task approval is then asked once, just before the task runs. Installations without a `task` rule in their policy are not
  affected.

## Desktop and other surfaces

- **There is no Desktop app, no Dashboard and no remote HTTP API.** Use the terminal, the `deckent` command, MCP or the SDK.
  `deckent monitor` is a read-only live view. The Desktop is planned after the beta.
- **The monitor shows only the pools you may inspect** (`pool inspect`); other pools appear as one count ("Other work: N
  pool(s) not shown to you"), with no name, capacity or holder. *Impact:* a Run you can see that waits in a pool you cannot inspect
  shows no pool-wait reason. The MCP actor's first-run rules include no `pool inspect`, so `inspect_monitor` over MCP shows only
  that count. *Workaround:* ask an administrator for `pool inspect` on that pool; `deckent pool status` uses the same decision.
- **The monitor does not say which scope it could not read.** A refused scope and a scope whose access check could not run (for
  example a locked ledger) are both shown only as counts ("access to N scope(s) was refused", "N scope(s) could not be read
  (<code>)"), never by name. *Workaround:* none needed for refused scopes; for a failed check, `deckent doctor` and the named code.
- **The monitor shows no build time and no release number for a service.** The service reports only its commit and source tree, so
  Installs shows `build <commit> · source tree <hash>`. *Workaround:* `deckent --version` on the machine that runs the service.
- **An idle interactive `deckent monitor` keeps using CPU** because it re-reads everything on every refresh
  (`inspection.workers.heartbeatMs`, default 2 s). It grows with the number of Runs and scopes. *Workaround:* press `p` to
  pause it, raise `inspection.workers.heartbeatMs`, or use `deckent monitor --once`.
- **The SDK still exports raw writers** next to the managed ones; a later versioned SDK contract is meant to keep only the
  managed ones.

## Concurrency and scale

- **Nothing here is measured at scale.** Local checks do not establish fleet-scale performance. The worker pool has a
  configured slot count (`executionSlots`, `inFlightSlots`).
- **Conflicts between workers are caught at delivery, not prevented while they work.** Two workers, or a worker and a person,
  editing the same files meet at the patch base check. A source lock does not stop an outside person or an ERP writer.
  Inside one Run, tasks whose declared scope paths or business records overlap now run one after another (the card shows the
  order); tasks of different Runs, and a branch Run's tasks before they start, still meet only at delivery. Declared record
  `resources` order work but are not enforced on the worker yet.
- **A delivery whose base advanced is re-attempted once, and only under your delivery intent.** Enqueue with
  `deliveryIntent: "service-reattempt"` and the service re-runs that task once as a new Run on the current base. A chained task
  is re-run after its predecessor is adopted. The re-run task gets the same two delivery cards. Without the intent, or past the
  bound (`targetQueue.reattempts`, default 1), you create the new attempt yourself. The work is re-run, not merged, so it costs a
  second worker run. Tasks with unproven or unresolved effects are never re-run. The `/deliver` window always sends the intent and says so in one
  line, also on the refused-preview screen where `r` prepares on the current base; with `targetQueue.reattempts` 0 it sends none
  and shows no line. If that setting changes between the line and your key, the request follows the setting at that moment.
- **A Run's delivery intent can be given only in the proposal JSON, by you.** `deckent run propose` with `delivery: { target,
  mode: "enqueue-accepted" }` asks your Run card and then lets the service queue each accepted task for your cards, re-queue one
  that stopped before any effect (up to `targetQueue.requeueMax`, default 2) and re-attempt once on a conflict. `/do` has no
  option for it yet; an AI (MCP) proposer can never carry one (MCP `propose_run` does not accept the field), and an AI-proposed plan cannot get one through your approval yet.
  A re-attempt Run's own tickets are not re-queued. The service reads the intent Runs once per queue lease.
- **A worker's resource use is measured in bounded local traces only.** There is no cost or quality report per worker yet.
- **The ledger is one local SQLite file shared by every process.** Writes are serialized; a write that waits longer than
  `storage.sqlite.busyTimeoutMs` (default 5 seconds) is refused with `ATTEMPT_STORE_BUSY` and nothing is written. *Workaround:*
  retry the command; on a slow or heavily loaded host raise the timeout in `.deckent/config.json`. Opens no longer wait for the write
  lock and the running service keeps the ledger's side files in place; this was measured on one loaded core, not at fleet scale.
