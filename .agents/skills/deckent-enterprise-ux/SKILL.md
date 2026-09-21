---
name: deckent-enterprise-ux
description: Use for Deckent tenant and organization scope, principals, RBAC, policies, approvals, audit, secrets, cost controls, environments, compliance, or large-scale administration. Do not use to add enterprise-looking tables without real governance semantics.
---

## Next refactor scope — 2026-09-17

For current Deckent Next work, first apply `deckent-next-refactor` from the host skill directory.
Product writes target `/home/alperen/deckent-next`; legacy `/home/alperen/deckent-dev` is a read-only
reference except the owner-authorized host tooling/channel setup. Next ARCHITECTURE.md and PLAN.md
carry accepted refactor decisions. Relative legacy `docs/`, `.deckent/workspace/`, `src/` and
`scripts/` references below resolve in the legacy repository for reading only; inspect target
implementation separately. Do not run legacy generation, recovery, MCP or dogfood commands for Next.


# Deckent Enterprise UX

## Objective

Make governance understandable and safe at very large scale without damaging the solo-user
experience. Load deckent-design-dna, deckent-product-design and deckent-agentic-ux when autonomous
actions are involved.

## Scope model

Before designing a control, resolve:

- tenant, organization, workspace, project and environment hierarchy;
- human, service, agent and worker principals;
- inherited versus explicit roles and policies;
- resource, action, time and environment scope;
- source of authority and policy evaluation;
- audit and evidence retention;
- cross-tenant isolation guarantees.

Never let visual nesting stand in for actual authorization.

## Governance interaction rules

- Show effective permission and why it applies, including inheritance and deny precedence.
- Policy simulation or preview is clearly non-binding until applied.
- Approval requests show requestor, resource, action, scope, duration, risk and downstream effect.
- Bulk actions show selection scope, exclusions, partial-failure behavior and rollback limits.
- Secrets show metadata and lifecycle without exposing values.
- Cost controls distinguish observed usage, estimate, budget, limit and provider-reported evidence.
- Environment differences are visible before deployment or execution.
- Audit records are immutable in presentation, filterable and deep-linkable to related evidence.
- Impersonation or delegated administration is unmistakable, bounded and logged.
- Export respects redaction, authorization and tenant boundaries.

## Enterprise state matrix

Cover:

- allowed, denied, approval-required, expired and policy-unavailable;
- inherited, overridden, conflicting and shadowed policy;
- provisioned, invited, suspended, deprovisioned and orphaned principal;
- active, rotated, expiring, revoked and inaccessible credential metadata;
- within budget, forecast risk, limit reached and provider evidence unavailable;
- partial bulk success, retryable subset and reconciliation-required outcome.

Unknown is never displayed as allowed.

## Scale and operability

Large datasets require server-authoritative pagination or streaming where applicable, stable sort,
search, filters, saved views, bulk-selection semantics and export boundaries. Counts state whether
they are exact, sampled or delayed. Long-running administration operations use the same agentic
evidence and recovery contract as product runs.

## Accessibility and comprehension

Use plain language alongside exact policy identifiers. Provide keyboard-complete tables and trees,
stable focus after mutation, non-color risk cues, accessible diffs and locale-safe dates, numbers,
currencies and time zones.

## Required output

Provide the scope/principal model, effective-permission explanation, approval and policy flows,
audit/evidence model, secrets and cost handling, adverse-state matrix, scale behavior and
cross-tenant proof requirements. A generic admin dashboard without these semantics is NO-GO.
