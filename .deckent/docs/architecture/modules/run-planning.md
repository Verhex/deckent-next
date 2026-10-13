# Brain Run planning

DO-DILIM-B author candidate, 2026-10-12, based on `4cd6837f`. This contract describes
the candidate; it does not grant release, independent review or live acceptance.
The owner-admitted `do` boundary is defined in [ARCHITECTURE.md](../../../../ARCHITECTURE.md).

`BrainPlanCommand` v1 carries intent, scope and command identity, with an optional
exact model reference. SDK `planRun`, CLI `do --request ... --json`, MCP `plan_run`
and terminal `/do <intent>` share one Brain planning application. Versioned
`brain_planner` configuration selects the prompt template. Capabilities derives
the JSON schema from the existing RunProposal contract and stages JSON, schema
and task-graph parse failures. The model proposes a graph; the authenticated
principal and existing engine admission own authority.

The existing connected-model invocation owns activation, binding, credentials,
spending, claim and response custody. Planning has one model step, no tool loop
and no automatic retry. Before metered invocation, the ledger-first scope budget
(with configured fallback) must exist and have available capacity. A literal-zero
tariff on exclusively literal-loopback endpoints needs no money budget; the
invocation still owns validation, quote, freeze checks and reservations.
Prompt context carries a budget only when applicable. Selected subscription-only
worker bindings carry `budgetSemantics: not-metered` into the sealed admission;
unknown/mixed/API profiles keep the admission ceiling check. No total Run spending
ceiling is enforced during execution. Native subscription planning transport is
not installed; its future binding must reuse these gates without bypassing invocation authority.

A successful repeated command/input reads its recorded proposal and sends no
second model request. Failed or interrupted invocation claims also forbid a
second send; configuration drift can conflict. The model source optionally carries
a v1 contribution: template/version/digest, input/context/output/request digests,
binding, activation, normalized usage and bounded masked summaries. Intent and
context are redacted before invocation; graph text and summaries are redacted
before proposal storage. A2 source verification consumes retained response
content under existing model `inspect-content` permission, revalidating its parsed
output digest. Purged or unavailable content cannot authorize a fresh Run.
Template/input summaries are planner attribution bound into the proposal, not a
reconstructed prompt trace. A full prompt/response trace store is separate work.

CLI and MCP return pending approvals without deciding them. The terminal previews
the original approval card and uses existing interactive TTY authority; rejecting
then submitting a revised request creates a new command. Registry standing
admission remains subject to scope and policy gates. Admitted Runs link to `/tasks`.
Graphs and durable acceptance criteria serve both dogfood and customer business
processes; the planner introduces no Git/ERP-specific execution or acceptance flow.

Aborting the model wait prevents proposal/Run handoff. It cannot prove remote
provider cancellation or zero charge. After atomic admission begins, the existing
admission/uncertain-outcome contract owns reconciliation; the terminal preserves
a returned Run identity even if local cancellation races with that handoff.
Author evidence and independent/live limits are in external
`proof/DO-DILIM-B-2026-10-12/WORKER.md`.

## Subscription quota recovery (KOTA-D1)

Native worker events carry an additive `quota-exhausted` hint with optional window,
nullable reset time and adapter source. Claude emits it only for the documented
rejected status; allowed/overage warnings remain observational. Codex error
matching comes from the adapter JSON registry. These hints never prove process
termination or authorize an API fallback.

The existing Task evaluation ingress verifies exact Attempt output custody, a
definite nonzero uninterrupted exit and sealed model evidence before recording
quota exhaustion. Model substitution retains its failure consequence. A quota
evaluation atomically classifies the finished Attempt, leaves its Task pending,
parks the Run and retains channel, reset/deadline, evidence digest and configured
retry bound in the immutable evaluation receipt and Run snapshot. It records no
acceptance metric and executes no business criterion or Git-specific retry flow.

`runRuntime.quotaRecovery` v1 supplies `maxResumes` (zero disables automatic
recovery; the shipped registry default allows one). Known future reset times
set the deadline. Unknown or stale reset times use `runRuntime.parking.timeoutMs`
and ordinary timeout closure; elapsed timeout is not reset evidence. After a
known reset, lifecycle advancement moves the finished binding to retained history
once and allows a fresh generation with the exact frozen profile. Fresh admission,
policy, approvals and launch authority still apply. Uncertain effects and
cancellation forbid automatic recovery. Multiple waits keep the latest deadline.

Installation ledger channel holds exclude matching tasks at reservation and
atomically refuse new dispatch claims, including already reserved tasks. Existing
dispatch custody continues under its original grant/claim; no claim is stolen or
replayed into a fresh launch. Holds survive cancellation/terminal Run state until
their deadline. Inspect and monitor expose only the target task and wait metadata,
not another scope's identities or output. Inspection wait projections also omit
channel identities and evidence digests; canonical records retain both. EN/TR labels distinguish a known reset,
an unknown reset and exhausted automatic retries.

The quota payload/config are versioned additions to existing JSON contracts;
legacy snapshots remain byte-equivalent on read. SQL tables and ledger version
do not change, so no database migration/backup is introduced. An older binary
that cannot parse the new evidence must not reopen these enriched records.
Author fixture/check evidence is outside Git in KOTA-D1 proof; paid, live, N1,
browser, hosted and independent acceptance were not performed by this lane.
