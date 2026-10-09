# Deckent glossary

[Türkçe](glossary.tr.md) · [Architecture overview](architecture-overview.md) · [README](../README.md)

These terms describe product behavior. A configured identifier, persona or permission mode
never grants access by itself; identity and policy checks still apply.

## Scope

The identifier of the data and authority boundary for an operation. Policy, approval records,
Runs and spending accounts refer to a scope. `--scope my-project` selects that identifier;
it is not a filesystem path and does not create an OS sandbox.

For a new personal project, choose a stable ID such as `my-project` when previewing the initial
policy. Reuse it when applying that policy and managing its budget. In an existing installation,
use its configured scope ID. The terminal defaults to `terminal.scopeId`;
`deckent --scope my-project` selects this scope explicitly. See the [first-session example](../README.md#your-first-session).

The intended organizational hierarchy is installation → company → optional site/unit → project
→ session. Installation is the hosting and trust boundary; company is a scoped data boundary.
The hierarchy is an architectural direction, not a claim that every administration surface is shipped.

## Realm

The configured environment in which an operation executes, including its filesystem, process
and network restrictions. A shell realm selects a registered backend and its sandbox posture.
It is distinct from scope: scope decides which work you may access; realm constrains where and
how that work executes.

A `require-sandbox` posture refuses execution if confinement is unavailable. A `prefer-sandbox`
posture may execute on the host and exposes that posture in the approval card. Docker workers
have their own container configuration and share the host kernel.

## Run, task and attempt

- **Run:** one admitted execution of a task graph, with dependencies, limits and an overall outcome.
- **Task:** a unit of work within that graph, with an input and acceptance criteria.
- **Attempt:** one execution try for a task, bound to its worker, workspace and retained evidence.

A task can have more than one attempt when retry policy permits it. A worker exiting is an
execution observation; acceptance and delivery are separate steps. A Run can be parked awaiting
a decision or evidence. Missing evidence is unknown, not success, and an uncertain external
effect must not be retried blindly.

## Approval card

The terminal's presentation of a pending approval request: the action or command, location,
principal, scope, reason, risk, reversibility and expiry. The request and authorized decision
are durable records; the approval card itself is a view. Expiry or closing the window does not approve
execution. The MCP surface can list and inspect approvals; it cannot decide them.

## Hard floor

The protections a permission mode cannot relax. Sensitive paths and actions include Deckent
configuration, policy, approvals, secrets and the MCP registry. Depending on the operation,
the floor requires explicit approval or keeps sensitive state outside the execution view.
It prevents convenience modes from rewriting their own authority. It does not claim to protect
all files accessible to other programs running under the same OS account.

## Full access

A session permission mode available only with a company-policy grant. It broadens the shell
view to host files, home, network and Git writes, with protected state masked and effect calls
audited. Explicit policy denies and the hard floor still apply. It is materially broader than
**full auto**, which automates eligible calls inside the sandbox's closed view.

## Budget

A USD limit against which paid model calls reserve funds before sending. The current API model
path uses one shared budget per scope across providers. The account distinguishes the limit,
reserved amounts and settled amounts. Missing budget or insufficient available funds refuses
a new paid call. A cancelled or interrupted call may keep a reservation held until reconciliation.
This is Deckent's admission control, not a provider-side spending limit or invoice.

## Measured tariff

A charge calculated from the provider's reported final usage and a pinned published or declared
versioned tariff. The record carries usage dimensions, price tier and tariff identity; calculation
uses exact arithmetic. It is measured usage multiplied by a tariff, not provider-reported money.
An upper-bound tier is labelled as such. Missing final usage remains unresolved rather than
being replaced with zero or an interim estimate.

## Ledger

The durable transactional record of work, reservations, decisions, effects and receipts. The
current implementation uses SQLite. Its schema version identifies the storage format and
migration requirements; it is independent of the package version. Audit seals support integrity
checks, but local storage does not make a compromised host trustworthy.

## Protocol

The versioned message contract between Deckent clients and the local runtime service. It carries
typed commands, queries, events, errors and results. Protocol version, ledger schema and package
version are different identifiers. Supported lifecycle compatibility can allow describing or
stopping an older service without allowing execution through an incompatible client.
Use matching client and service builds for normal operation.

## Principal and policy

A **principal** is the verified person or process on whose behalf an operation runs. A **policy**
decides whether that principal may perform an action on a resource in a scope: allow, deny or
require approval. Scope membership alone is insufficient. A model, persona or extension cannot
supply itself with authority.
