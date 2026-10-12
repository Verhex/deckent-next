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
and no automatic retry. Before invocation, a current scope budget must exist and
have available capacity; the invocation still owns the exact quote/reservation.
Prompt context includes the configured budget limit. Current remaining capacity
is separately checked by invocation spending and A2 admission. No total Run
spending ceiling is enforced during execution.

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
