# Known limits

[Türkçe](known-limits.tr.md) · [README](../README.md) · [Architecture overview](architecture-overview.md)

This page says plainly what Deckent does not do yet, what has not been tried, and what you should do instead. It
describes the pre-release `1.0.0-alpha.39`. A limit leaves this page when the change that closes it has landed and been
seen working, not before. Each item gives **what** the limit is, **the impact** on you and, where one exists, a
**workaround**. [CHANGELOG.md](../CHANGELOG.md) lists the limits each release carried at the time.

Deckent is a pre-release. Nothing here is a promise of a date.

## Platforms: tried and not tried

- **Tried:** Linux and Windows through WSL2 (the supported execution path). Hosted checks run on Ubuntu with Node 24 and
  Node 26.
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
- **The `prefer-sandbox` host fallback has no enforced filesystem boundary.** In the closed modes, when no sandbox is
  usable the call may run on the host. *Workaround:* set `require-sandbox` when confinement is required.
- **Credential and home-folder hiding is bounded.** The shared registry covers gh, Docker, kube, Codex, Git credentials and
  common cloud CLIs; hiding stops at depth 3 and 20,000 entries. *Impact:* custom locations and unusual file names are not
  masked. *Workaround:* keep such files out of the home folder the sandbox sees, or isolate separately.
- **The secret gate does not scan Git history.** Before dispatch it scans everything the worker receives (checkout, `.git`
  metadata, binds, task inputs, prompt context) and refuses on a hit; past commits in the object store are not scanned.
  Exclusions are configured paths or a declared dependency tree only, audited and shown on the Run card. *Workaround:*
  remove committed secrets from history and rotate them; never put credentials into a request, a prompt or `DECKENT.md`.
- **A declared dependency tree is trusted for content patterns.** A read-only bind the task profile declares
  `dependencyTree` (for example `node_modules`) is third-party content: credential-shaped text in it (test fixtures, type
  definitions, READMEs) passes as an audited exception instead of refusing, and a native binary above
  `execution.secretGate.maxFileBytes` is identified by its SHA-256 digest instead of being read for patterns. Deny-listed
  files (`.npmrc`, `.env`, keys) and configured secret values still refuse there; any other oversized file is still
  unscannable. Pattern results are cached per file content under the product's `state/secret-gate-cache`; a changed lockfile
  or release starts over, and the unsigned cache can change only which exceptions are listed, never a decision.
  *Impact:* a real token planted in a dependency package as plain text reaches the worker, visible only as an exception.
  *Workaround:* declare only trees installed from a lockfile you trust, and review the exceptions on the Run card.
- **The secret gate's config rule covers config-like files only.** A password written into ordinary source code is not
  detected. *Workaround:* keep secrets in a secret store, never in source.

- **An AI agent running on your own operating-system account is not contained by Deckent's approvals.** Approval and
  audit records are sealed with a key stored in your account, the interactive-terminal check proves a terminal rather than
  a person, and your account can write the policy file. Where your account can use Docker or sudo, such an agent can in
  practice do anything. *Impact:* approvals and policy hold against Deckent's own sandboxed workers, not against other
  agents you run as yourself. Audit checkpoints (`deckent audit verify`) show a changed policy or producer set and a cut
  or wiped audit trail; undoing both local histories together on your own account is only caught by a checkpoint export
  kept on a separate device. Hardware-key signed policy and approvals follow after beta. *Workaround:* run other AI agents under a
  separate account without Docker or sudo, and keep Deckent's workers in their sandbox.

## Providers and subscriptions

- **Claude subscription:** a Claude Code worker runs with your own Claude login. A subscription-backed Brain (the planner
  behind `/do`) is being prepared and is not available yet. Terminal chat with a Claude subscription is not supported for now.
  *Workaround:* use an Anthropic API key for terminal chat and `/do` planning.
- **Today the worker takes your login by reading the CLI's own credential file** in your home folder. *Impact:* that file
  must exist and be readable by Deckent. This path may change.
- **Sign in with ChatGPT is not available yet.** `/provider` lists it as not available. *Workaround:* an OpenAI API key, or a
  Codex worker with its own login.
- **No automatic fallback from a subscription to an API model yet.** Deckent does not switch to a paid API by itself when a
  subscription window is used up; routing across a declared candidate list is planned. *Workaround:* connect an API model
  yourself and choose it.
- **A remote model without a verified published price is locked.** Zhipu GLM China stays locked because its prices are in
  CNY. DeepSeek settles at the published peak price, labelled an upper bound. *Workaround:* use a priced model or a local
  one.
- **Deckent cannot see provider-side settings.** For OpenRouter it cannot see the "Prevent overrides" plugin setting or your
  OpenRouter credit limit. *Workaround:* check both yourself before the first paid call.
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
- **Settled spend is Deckent's own calculation,** from the usage the provider reports times a verified price. It is not the
  provider's invoice.
- **A call that never reported final usage stays held** until you resolve it with `deckent models reconcile-spending`.

## Delivery and adoption

- **The target queue is a source candidate, not accepted runtime behavior.** It connects registered Git targets, private
  combined-candidate verification, separate publish/adopt batch cards and a separately confirmed rollback. Runtime protocol
  v29 and ledger v57 need a rebuilt binary and verified pre-switch ledger backup. Native terminal/socket/crash and N1 load
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
- **A worker that asks you a question cannot be answered from the terminal yet.**
- **Autonomous delivery is designed but off.** Every delivery and adoption needs your `y` in a verified terminal.

## ERP and operations

- **There are no ERP connectors.** The operation contract (intent, conditional write, idempotent resend, evidence-based
  acceptance, compensation) and the extension entry exist; IFS, SAP, Oracle, Microsoft, Uyumsoft or Logo adapters do not.
  The only worked target is a test fixture. *Impact:* you must write your own adapter to run ERP effects.
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
- **A restore needs the service stopped,** and the message does not name the command. *Workaround:* `deckent runtime shutdown
  --service <id> --instance <id> --command-id <id> --reason <text>`, close open terminals, then run the restore again.
- **The relative path of a backup set is refused with a misleading message.** Use an absolute path.
- **You cannot go back to an older Deckent after a ledger upgrade** without restoring the backup taken before the upgrade
  (newer ledger versions cannot be opened by older builds).
- **A lost worker can keep its slot.** A granted attempt can stay active and hold an execution slot until custody is resolved.
  *Workaround:* watch it with `deckent monitor`; the slot is freed only by a typed manual decision or by evidence that the worker ended.
- **Restart recovery has not had an independent review** with a real container kill and service restart.
- **After an upgrade that sets `service.identity`, a running service needs one manual stop** (Ctrl+C on `deckent runtime serve`,
  or its idle stop) before `runtime restart` works: a service reads its identity only when it starts.
- **The service identity and the clock.** A rare window remains at first publication of the installation identity; a slow
  clock drift inside the tolerance is not detected; one overlay case where a stopped run reports `cancelled` is not reproduced.

## Desktop and other surfaces

- **There is no Desktop app, no Dashboard and no remote HTTP API.** Use the terminal, the `deckent` command, MCP or the SDK.
  `deckent monitor` is a read-only live view. The Desktop is planned after the beta.
- **The SDK still exports raw writers** next to the managed ones; a later versioned SDK contract is meant to keep only the
  managed ones.

## Concurrency and scale

- **Nothing here is measured at scale.** Local checks do not establish fleet-scale performance. The worker pool has a
  configured slot count (`executionSlots`, `inFlightSlots`).
- **Conflicts between workers are caught at delivery, not prevented while they work.** Two workers, or a worker and a person,
  editing the same files meet at the patch base check. A source lock does not stop an outside person or an ERP writer.
- **A worker's resource use is measured in bounded local traces only.** There is no cost or quality report per worker yet.
