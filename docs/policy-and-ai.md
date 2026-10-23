# Policy and AI: user and administrator guide

[Türkçe](policy-and-ai.tr.md) · [Architecture](architecture-overview.md) · [Compliance report](reports/ai-floor-compliance.md)

Last checked against source: 2026-10-23. Policy says which verified actor may perform an action on a
resource in a scope. A grant permits an application to consider that action; it does not
skip state checks, approvals, isolation, acceptance criteria or durable effect evidence.
An administrator grants only authority they hold. AI actors cannot administer authority.

## Human and AI actors

| Ingress | Identity and decision meaning |
|---|---|
| Human terminal / CLI | A verified OS user (`os-user`) can make human decisions with a service-attested interactive controlling terminal. A TTY flag alone is insufficient. |
| Noninteractive CLI / SDK | The transport name is not proof of a human. Noninteractive decisions need an explicit actor/action cell. A workload or token-verified principal is classified as AI. |
| MCP | Always a separate AI actor: issuer `<host>/mcp`, same OS subject, workload assurance. Even a legacy MCP principal claiming `os-user` remains AI. Owner grants do not become MCP grants. |
| SDK / local service | Uses the same verified principal, policy and application gates. Client-authored identity, persona or channel metadata grants nothing. |

Actor classification is defined in [principal.ts](../src/domain/core/principal/internal/principal.ts).
The service witness checks the peer, controlling terminal and process identity; it does not
prove that a biological person is present. An agent running under the owner's OS account
can potentially manufacture a PTY or access that account's files. Separate OS identities,
secret custody and actual sandbox boundaries matter; policy is not account isolation.

## Non-delegable floor

This versioned security floor applies before ordinary grants, including an explicit allow
or a full-access preference. An AI receives `deny / AI_NON_DELEGABLE`. A human still needs
policy authority and the relevant witnessed approval. Nothing in the following table is
made delegable by adding a policy rule.

The table is generated from the independent floor inventory used by the compliance report,
transcribed from [ai-floor.ts](../src/domain/core/policy/internal/ai-floor.ts). Listed mutation
and future-action cases represent open-ended guards; only the published vocabulary denotes
implemented public operations. The configuration rule also covers empty/root writes, array
entries, descendants and whole-object parents such as `terminal`, `terminal.shell` and
`terminal.fetch`; names that merely start similarly do not match.

<!-- ai-floor:start -->
| Non-delegable boundary | Source cells | Why |
|---|---|---|
| Policy administration execute/compensate | `operation/policy.administer/execute`, `operation/policy.administer/compensate` | Grants, bindings, delegation, restrictions, duties and standing grants must not let an AI enlarge its own authority. |
| Authority documents, authenticators and approval assurance: all mutations | `authority-document/fixture-record/write`, `authority-document/fixture-record/register`, `authority-document/fixture-record/activate`, `authority-document/fixture-record/remove`, `authority-document/fixture-record/future-mutation`, `authenticator/fixture-record/write`, `authenticator/fixture-record/register`, `authenticator/fixture-record/activate`, `authenticator/fixture-record/remove`, `authenticator/fixture-record/future-mutation`, `approval-assurance/fixture-record/write`, `approval-assurance/fixture-record/register`, `approval-assurance/fixture-record/activate`, `approval-assurance/fixture-record/remove`, `approval-assurance/fixture-record/future-mutation` | An actor cannot replace the identity or approval verifier that constrains it; inspect/list remain policy governed. |
| Backup restore | `backup/fixture-backup/restore` | A restore can replace authority data. |
| Execution environment install and installation repair | `execution-environment/fixture-target/install`, `installation/fixture-target/repair` | Both change the host outside the sandbox (Docker group membership is root-equivalent); only a person at a terminal runs them (owner 2026-10-19). |
| Permission mode set, including full access | `permission-mode/standart/set`, `permission-mode/full-auto/set`, `permission-mode/full-access/set` | An AI must not choose a weaker permission mode for itself. |
| Every secret action, including read/resolve | `secret/FIXTURE_SECRET/set`, `secret/FIXTURE_SECRET/delete`, `secret/FIXTURE_SECRET/switch`, `secret/FIXTURE_SECRET/read`, `secret/FIXTURE_SECRET/resolve`, `secret/FIXTURE_SECRET/inspect`, `secret/FIXTURE_SECRET/list`, `secret/FIXTURE_SECRET/future-action` | Reading, changing or moving credentials would bypass the secret boundary; read/resolve are defensive cells, not public secret-read APIs. |
| Authority approval cards | `approval/identity-profile/decide`, `approval/policy-mcp-capability/decide`, `approval/policy-template-upgrade/decide`, `approval/audit-rebaseline/decide` | Deciding an authority card is another authority-changing route. |
| Audit actions except inspect/verify | `audit/fixture-scope/rebaseline`, `audit/fixture-scope/write`, `audit/fixture-scope/delete`, `audit/fixture-scope/future-action` | An AI must not rewrite the baseline that detects authority drift. |
| edit-authority and edit-floor tool-call cells | `agent-tool-call/edit-authority/invoke`, `agent-tool-call/edit-floor/invoke` | Editing a protected boundary would otherwise circumvent the operation gate. |
| Memory verify, retire, contest and purge | `memory/fixture-target/verify`, `memory/fixture-target/retire`, `memory/fixture-target/contest`, `memory/fixture-target/purge` | Verified memory needs a person or an independent evaluation record, never the AI itself (law-audit fold 6); retiring is the same knowledge change; purging content is a person's act (S4B A11); verify and contest pass the floor only for the memory evaluator workload (S4B-3 A5), which these cells do not name. |
| Standing approval of a Nervous stop action or a lost-task continuation | `recovery-action/fixture-target/apply`, `recovery-action/fixture-target/future-action`, `recovery-action/fence-attempt/apply`, `recovery-action/fence-attempt/future-action`, `recovery-action/stop-orphan/apply`, `recovery-action/stop-orphan/future-action`, `recovery-action/hand-to-human/apply`, `recovery-action/hand-to-human/future-action`, `recovery-action/continue-new-attempt/apply`, `recovery-action/continue-new-attempt/future-action` | The recovery broker applies a sealed Nervous proposal, and the recovery system continues a lost task in a new Attempt, only under the owner's standing grant (K-B, S6R-3/S6R-4); no AI holds it, Nervous itself only proposes. |
| Protected configuration subtrees, descendants and whole-object ancestors | `policy`, `approvals`, `identity`, `security`, `storage`, `service`, `paths`, `shell`, `network`, `layout`, `execution`, `installation`, `company`, `enforce_principal_assurance`, `secrets`, `admission`, `operations`, `audit`, `memory`, `memoryAutomation`, `runRuntime.recovery`, `terminal.shell.realm`, `terminal.shell.environment`, `terminal.fetch.egress`, `terminal.fetch.allowedHosts` | Security, isolation, admission, operations, audit, the recovery mode, shell environment and network egress cannot be weakened through configuration. |
<!-- ai-floor:end -->

There is also an application gate when deciding cards: AI/noninteractive callers cannot
allow `edit-floor`, `edit-authority`, `mcp-floor`, an authority-effect card, a protected
configuration card, an undeclared tool-risk card, or a legacy card with unknown facts.
The last cases fail with `AI_AUTHORITY_NON_DELEGABLE`; they are not all simple evaluator
resource cells. These require the witnessed human path and its existing assurance checks.
AI cannot remember a protected call as a session/standing permission to bypass this floor.
The report covers pure policy cells; application-card protection has separate security tests.

## What can be delegated

A cell selects **principal (issuer + subject) × action × resource kind/id × scope**. Roles
and bindings supply the same cells; role names in a request confer no authority. Denies and
restrictions win, then `require-approval`, then allow; missing grant means deny. Scope
membership is also required. `delegationWithin` checks every cell touched by administration,
including both sides of replacements and revocations; it cannot turn an approval requirement
into an unconditional allow or lift the administrator's own restriction.

| Step | Required policy cell and other checks |
|---|---|
| Resume after failure / close | Explicit `run-decision` / Run id / `resume` or `close`, plus `run/reserve` or `run/cancel`. State and revision must permit the transition. |
| Accept / reject task | Explicit `task-decision` / Task id / `accept` or `reject`, plus attempt `evaluate`. AI requests still open a command-bound approval card; deciding it requires approval `decide` and the matching task step. Acceptance criteria remain enforced. |
| Answer a task question | Explicit `task-decision` / Task id / `answer`, plus attempt `evaluate`; the pending question, answer and revision are validated. |
| Ordinary approval | Explicit `approval` / approval id / `decide`, with current policy, session, request digest, expiry, separation of duties and assurance. Protected/unknown-risk cards remain on the floor. |
| Hold / resume an operator hold | Ordinary operator control uses `run/cancel` or `run/reserve`; resuming failure is a separate decision step. |
| Admission, operations, pools, models, spending, work targets | Ordinary cells from `deckent policy vocabulary --json`. Not on the floor does not guarantee every transport exposes the action or that its application allows it. |

For decision steps, the allow must name the actor and action explicitly: `principals: "all"`
or `actions: "all"` does not delegate a step. Resource ids/scopes can be selected; use the
narrowest set. Generic `evaluate` or `reserve` is not permission to accept or resume failure.

Fresh first-run policy gives the installing human authority and the MCP actor observation
rules only. No AI decision step or write capability group is delegated by default. Existing
custom installations keep their own grants; an upgrade preview is not a reset or grant.

## Inspect, grant and revoke using available surfaces

Run from the installed project. Replace `SCOPE_ID`, `GROUP_ID`, `PREVIEW_DIGEST` and grant ids
with values inspected in that installation; these are placeholders. Writes require the
administrator's own authority and an interactive confirmation. Inspect before applying.

```sh
deckent policy vocabulary --json
deckent policy status --scope SCOPE_ID --json
deckent policy mcp list --scope SCOPE_ID --json
deckent policy mcp grant --scope SCOPE_ID --group GROUP_ID --preview --json
deckent policy mcp grant --scope SCOPE_ID --group GROUP_ID --apply --expect PREVIEW_DIGEST --json
deckent policy mcp revoke --scope SCOPE_ID --group GROUP_ID --preview --json
deckent policy mcp revoke --scope SCOPE_ID --group GROUP_ID --apply --expect PREVIEW_DIGEST --json
```

Use the digest from that action's fresh preview. A stale snapshot, insufficient authority,
floor conflict or last-administrator violation refuses the change. The terminal `/policy`
panel offers the same registered MCP groups and preview/confirm path; it is not an arbitrary
policy editor. Group availability and effective state come from `list`, not a copied example.
A revoke removes that group's managed grants only: custom/role grants can still permit the
action. Inspect the **effective** state after revocation. No revocation erases past effects.

Standing tool permissions and template maintenance have separate commands:

```sh
deckent policy grants --mine --scope SCOPE_ID --json
deckent policy revoke STANDING_GRANT_ID --scope SCOPE_ID --json
deckent policy upgrade --template current --scope SCOPE_ID --preview --json
```

`grants` (with or without `--mine`) lists your standing tool approvals, not every delegation cell; everyone's
grants (`deckent policy grants --all [--after PAGE_MARK]`) need the grantable read action `policy`/`inspect-standing-grants`
(first-run template v13 gives it to the installing person; no AI actor gets it unless a policy rule names it). The policy decides
first; without the action the command refuses with `CLI_POLICY_GRANTS_ALL_UNAVAILABLE` and reads nothing else. Allowed, it shows
one bounded page (person, rule, tool, masked pattern, scope, since: the sealed audit change that created the rule, "—" for a
hand-written one) and the command for the next page.
On your own terminal `deckent policy` summarises the scope (administrators, your grants, AI steps and MCP groups
on/off), and `deckent policy mcp` / `deckent policy delegations` let you pick a group or step, read the change's
preview on a card and apply it through the same governed change as the commands above. `policy revoke`
revokes one of those entries, not an arbitrary policy grant. Non-TTY standing revocation has
a `--yes` confirmation flag; it does not bypass authority, policy or the AI floor.

## Opening modes and sharing provider keys

Two actions stay with a person at their own terminal. `deckent init policy --scope <id> --modes <list>|none` opens or closes
full-auto and full-access for the installation owner; AI tools, pipes and CI cannot. Provider keys live in a main vault (the
installation's) or a project vault. Outside a terminal, `deckent secret set NAME` needs `--main` or `--project`. A main-vault key
is used in a project only after a grant: a card at a solo terminal, or `deckent secret grant NAME --scope <id>`. Project keys need a
`.deck` file, which holds references only. Limits (no terminal witness on native macOS and Windows, rollback to alpha.50) are
in [known limits](known-limits.md).

## Delegate human steps to AI

The CLI and the terminal `/policy` → **AI delegation** section share one versioned command.
List first; select a step from that inventory, then confirm its actor, scope, resource class/id
and policy revision on the card. The CLI card is answered with the arrow keys or `y`/`n` (the change re-reads the
view, and the card shows exactly that); the terminal card uses `y`.
Enter, N and Escape cancel the terminal card. Writes require verified interactive stdin/output;
there is no `--yes` bypass. SDK `inspectConfiguredDecisionDelegations(root, query, options)` is
read-only. No MCP mutation or new decision tool is exposed.

```sh
deckent policy delegations --scope SCOPE_ID --json
deckent policy delegate --scope SCOPE_ID --step run-resume --resource RUN_ID --actor mcp
deckent policy undelegate --scope SCOPE_ID --step run-resume --resource RUN_ID --actor mcp
deckent policy delegate --scope SCOPE_ID --step task-accept --resource TASK_ID
```

Steps are `run-resume`, `run-close`, `task-accept`, `task-reject`, `task-answer` and
`approval-decide`. The default and only supported `--actor` is `mcp`, bound to the verified
human's MCP principal. `--resource` narrows the cell to one Run, Task or approval id; omit it
only when you intend to delegate the whole resource class in that scope. The terminal section
uses that scope-wide class. Protected steps are absent, protected approval ids are refused,
and the floor remains enforced even for a class-wide grant. Other execution/approval cells
must already exist; this command never adds them implicitly.

The listing separates the **managed grant** from **effective permission**. Undelegate removes
only the matching managed rule at the same scope, step and resource selection; a custom or role
rule can still allow the step. A concurrent policy change refuses the old card; inspect and
confirm again. Every applied change uses `policy.administer@1`, its expected revision,
approval, authority bound, audit and archive; the approval/audit names the human granter.
Generic `deckent operation execute` and public SDK execution still refuse `policy.administer@1`
with `OPERATION_SURFACE_RESTRICTED`. Never hand-edit protected authority files.

## Examples and their limits

**“Let AI resume its own failed runs.”** Select the AI principal, scope and already inspected
Run ids. The JSON below illustrates the cell created by the dedicated delegation command; it is not
CLI input. Give `run/reserve` separately; use undelegate with the same resource selection
to revoke. There is no dynamic “own runs” predicate or automatic grant for future Run ids.

```json
{
  "id": "selected-run-resume",
  "effect": "allow",
  "principals": [{ "issuer": "HOST/mcp", "subject": "SUBJECT" }],
  "actions": ["resume"],
  "scopes": ["SCOPE_ID"],
  "resource": { "kind": "run-decision", "ids": ["RUN_ID"] }
}
```

Once the required cells have been granted, the existing CLI
transition is `deckent run resume --scope SCOPE_ID --id RUN_ID --command-id COMMAND_ID --expected-revision REVISION --json`.
This command uses the invoking CLI actor; it does not impersonate MCP. A witnessed human can
resume without an AI delegation cell, while the shared AI ingress needs the explicit cell.

**“Let AI accept tasks under N.”** There is no numeric amount/risk/quality-threshold predicate
in policy cells. Define the business criterion separately, inspect durable evidence, then
select specific Task ids and `task-decision/accept`; also supply attempt `evaluate` and
approval `decide`. Do not use a wildcard as a substitute for an unenforced threshold. AI
accept/reject still routes through its card; model advice, test success or policy allow alone
is not business acceptance. The existing CLI is
`deckent task accept --scope SCOPE_ID --run RUN_ID --task TASK_ID --command-id COMMAND_ID --expected-revision REVISION --json`
(`reject` has the same flags). Approval inspection/decisions use versioned JSON, for example
`deckent approval inspect --input approval-query.json --json`; query shape is
`{"schemaVersion":1,"scopeId":"SCOPE_ID","approvalId":"APPROVAL_ID"}`.

**“MCP read-only observer.”** Retain the first-run observation rules; inspect `policy mcp list`
and grant no write groups. On an existing installation revoke each unwanted managed group
with the preview/apply sequence above and review custom/role grants too. “No managed groups”
does not prove read-only when other grants exist. Tool discovery is not authority; ordinary
inspection still needs the applicable scope and grants. MCP exposes no approval-decision tool.

## Decision history and integrity

Decision record v4 carries `deciderClass`: `human-tty`, `ai-policy` or `system`. The UI renders
“Interactive terminal”, “AI via policy” or “System”; older decisions can be unknown and must
not be called human. The record also preserves the actor, reason, request binding and policy
revision. Run lifecycle evidence/audit records the class and rule or approval id. A class
describes how a decision was authorized, not whether the business outcome was correct.

```sh
deckent audit verify --scope SCOPE_ID --json
deckent audit verify --scope SCOPE_ID --export-checkpoint > checkpoint.json
deckent audit verify --scope SCOPE_ID --checkpoint checkpoint.json --json
deckent audit rebaseline --scope SCOPE_ID --reason "Reviewed authority change" --json
```

Verify returns non-zero for every non-match, including unknown/unavailable/no checkpoint.
Reads do not heal or create a baseline. Policy/producer drift, broken chains and some wipes
are detected by sealed checkpoints. Retain exported witnesses outside the writable account:
an attacker with the same account who removes both all markers and checkpoints can look
like a fresh installation locally. Rebaseline is a witnessed human y/N action, on the AI floor,
after investigating the cause; it establishes a new reference, not proof the past was safe.
Hardware-backed FIDO2 confirmation and signed policy bundles are post-beta work, not current
protection. See [audit limits](architecture-overview.md#audit-integrity-and-pull-witnesses).

## What the compliance report proves

From a source checkout with locked development dependencies, run `npm run report:ai-floor`
to regenerate the [Markdown](reports/ai-floor-compliance.md) and [JSON](reports/ai-floor-compliance.json),
or `npm run report:ai-floor -- --check` to reject drift without writing. Floor tables here and
in Turkish are generated from the same bilingual inventory. The contract test prints one
`ai-floor:` summary in CI and fails on any `İHLAL` or committed-artifact drift. Expected
results are independent of the production floor function; deleting its secret guard is tested
in an isolated source-loader mutation and must produce violations and a failing exit.

Every published vocabulary action and floor family is evaluated for AI without a cell, AI
with a named granting cell and a human `os-user` fixture; legacy MCP, workload and token actors
are also checked. Explicit step tests cover wildcard/nonexistent/revoked/out-of-scope grants,
deny and approval requirements. Open-ended ids and configuration paths use boundary examples.
These are pure evaluator checks, not real TTY, service, secret-store, OS-isolation, ERP or live
acceptance evidence. Application-card security is checked separately. For dogfood, Git tests
are one adapter's evidence; customers accept ERP/CRM outcomes against business criteria and
durable receipts using the same principal/scope/operation/approval contracts.

Command sources: [policy grants/status/upgrade](../src/surfaces/core/cli-approval/internal/policy-grants.ts),
[MCP policy](../src/surfaces/core/cli-approval/internal/policy-mcp.ts), [Run](../src/surfaces/core/cli-run/internal/run.ts),
[Task](../src/surfaces/core/cli-task/internal/task.ts), [approvals](../src/surfaces/core/cli-approval/internal/approvals.ts),
[audit](../src/surfaces/core/cli-admin/internal/audit.ts). Decision rules:
[step grant](../src/domain/core/policy/internal/decision-step.ts),
[lifecycle broker](../src/engine/core/runs/internal/decision-approval.ts),
[card authority](../src/engine/core/approval/internal/application.ts).

Delegation sources: [CLI](../src/surfaces/core/cli-approval/internal/policy-delegations.ts), [application](../src/engine/core/approval/internal/delegations.ts), [inventory](../src/domain/core/policy/internal/delegations.ts).
