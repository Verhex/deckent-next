import { createHash } from 'node:crypto';
import { chainAuthorityRevision, governedPolicyDigest } from '#engine/core/policy/index.js';
import { FIRST_RUN_POLICY_TEMPLATE_ID, FIRST_RUN_POLICY_TEMPLATE_VERSION,  identitySchema, immutableJsonObjectSchema,
  mcpCapabilityIdChunks, getDecisionSteps, policySchema, authorityDocuments, planOwnerBaseline, type McpCapabilityGroup, type OperationDescriptor, type AuditEvent, type OwnerBaselineState, type OwnerBaselineCell, type PolicyGrant } from '#domain/index.js';
import { installerAuthorityChangeEvent } from './authority-audit.js';
import type { PolicyTemplateDocumentWriter } from './policy-template.js';

type Person = { readonly issuer: string; readonly subject: string };
export interface InstallerOwnerBaselineResult {
  readonly schemaVersion: 1;
  /** `preview`: would change `added`/`removed`; `applied`: written now; `current`: nothing to change; `refused`: a rule still decides a wanted
   * mode (`reason`, each mode's `blockedBy`); `conflict`: the policy moved since the previewed revision; `unavailable`: not here (`reason`). */
  readonly status: 'preview' | 'applied' | 'current' | 'refused' | 'conflict' | 'unavailable';
  readonly reason: 'not-owner' | 'not-first-run' | 'not-this-person' | 'person-not-named' | 'invalid' | 'revision-changed' | 'policy-refused' | 'rule-conflict' | null;
  readonly scopeId: string; readonly principal: Person; readonly person: Person | null;
  readonly basis: 'first-run' | 'named-person' | null;
  /** The policy revision read (preview: the `--expect` token); after an apply, the new one. */
  readonly revision: string | null; readonly expect?: string;
  /** Each baseline cell's effective state before and after (managed-rule presence and effective permission are separate). */
  readonly cells: readonly OwnerBaselineState[]; readonly remaining: number;
  readonly added: readonly PolicyGrant[]; readonly removed: readonly string[]; readonly conflicts: readonly string[];
  /** On a `not-first-run`/`person-not-named` refusal: the people the policy names on an allow rule of the scope (a display hint, capped). */
  readonly people: readonly Person[];
}
const revisionOf = (value: unknown) => typeof (value as { revision?: unknown } | null)?.revision === 'string' ? (value as { revision: string }).revision : null;
const digestOf = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * `deckent init policy --scope <id> --owner-baseline <families> --preview|--apply [--expect <revision>] [--person <issuer>/<subject>]` (PRE-9, owner 2026-10-21):
 * under exactly the installer's custody of `init policy --upgrade` — only the owner of the authority documents, the plan read first, the write
 * on exactly the revision read under a key of this change (`installer-owner-baseline-v1-`), the `authority-change` audit record
 * before publication and the archive of both documents. The witness (a person at the terminal; never the MCP actor) is the caller's gate.
 * `apply: false` reads only; the audit store is opened only for a write.
 */
export async function setInstallerOwnerBaseline(writer: PolicyTemplateDocumentWriter, input: { readonly scopeId: string; readonly principal: Person;
  readonly person?: Person; readonly families: readonly string[]; readonly candidates: readonly OwnerBaselineCell[]; readonly apply: boolean; readonly expect?: string; readonly owner: boolean; readonly peopleLimit: number;
  readonly openAudit: () => Promise<{ record(event: AuditEvent): void; close(): void }>; readonly now: () => number }): Promise<InstallerOwnerBaselineResult> {
  const scopeId = identitySchema.parse(input.scopeId), caller = { issuer: identitySchema.parse(input.principal.issuer), subject: identitySchema.parse(input.principal.subject) };
  const person = input.person ?? caller;
  const result = (status: InstallerOwnerBaselineResult['status'], extra: Partial<InstallerOwnerBaselineResult> = {}): InstallerOwnerBaselineResult => Object.freeze({ schemaVersion: 1,
    status, reason: null, scopeId, principal: { issuer: person.issuer, subject: person.subject }, person: input.person ? { issuer: input.person.issuer, subject: input.person.subject } : null,
    basis: null, revision: null, cells: [], remaining: 0, added: [], removed: [], conflicts: [], people: [], ...extra });
  const plan = (policy: unknown, bindings: unknown) => {
    const revision = revisionOf(policy);
    const planned = planOwnerBaseline(policy, bindings, { person, explicit: input.person !== undefined, scopeId, families: input.families, candidates: input.candidates, digest: digestOf, peopleLimit: input.peopleLimit });
    if (planned.status === 'unavailable') return { result: result('unavailable', { reason: planned.reason ?? null, revision, people: planned.people }), next: null };
    if (planned.status === 'refused') return { result: result('refused', { reason: planned.reason ?? null, basis: planned.basis, revision, cells: planned.cells, conflicts: planned.conflicts }), next: null };
    const expect = digestOf(JSON.stringify([revision, input.families, planned.added, planned.removed, planned.cells]));
    const shown = { expect, basis: planned.basis, revision, cells: planned.cells, remaining: planned.remaining, added: planned.added, removed: planned.removed, conflicts: planned.conflicts };
    if (planned.status === 'current') return { result: result('current', shown), next: null };
    const body = planned.policy as Record<string, unknown>;
    const next = { ...body, revision: chainAuthorityRevision('installer-owner-baseline:1', 'a', revision ?? '', { ...body, revision: undefined }) };
    return { result: result('preview', shown), next };
  };
  // Security: this path writes outside the governed chain (which cannot grant what the person does not hold: I2), so only the documents' owner.
  if (!input.owner) return result('unavailable', { reason: 'not-owner' });
  const first = await writer.updateAuthority(snapshot => ({ write: null, result: { planned: plan(snapshot.policy, snapshot.bindings), revision: revisionOf(snapshot.policy) } }));
  if (input.expect !== undefined && input.expect !== first.planned.result.expect) return result('conflict', { reason: 'revision-changed', revision: first.revision });
  if (input.apply && input.expect === undefined) return result('conflict', { reason: 'revision-changed', revision: first.revision });
  if (!input.apply || first.planned.result.status !== 'preview') return first.planned.result;
  const canonical = JSON.stringify(immutableJsonObjectSchema.parse(first.planned.next));
  const key = `installer-owner-baseline-v1-${digestOf(`${first.revision ?? ''}\0${canonical}`)}`;
  const audit = await input.openAudit();
  try {
    return await writer.updateAuthority(snapshot => {
      if (revisionOf(snapshot.policy) !== first.revision) return { write: null, result: result('conflict', { reason: 'revision-changed', revision: revisionOf(snapshot.policy) }) };
      const again = plan(snapshot.policy, snapshot.bindings);
      if (again.result.status !== 'preview' || again.next === null) return { write: null, result: again.result };
      const beforePublish = () => audit.record(installerAuthorityChangeEvent({ scopeId, caller, person, basis: again.result.basis!,
        template: { id: FIRST_RUN_POLICY_TEMPLATE_ID, version: FIRST_RUN_POLICY_TEMPLATE_VERSION }, commandId: key,
        inputDigest: digestOf(JSON.stringify(immutableJsonObjectSchema.parse(again.next))), before: first.revision!, after: revisionOf(again.next)!,
        grantsAdded: again.result.added.length, grantsRemoved: again.result.removed.length, atMs: input.now(),
        policyDigestBefore: governedPolicyDigest(snapshot.policy, snapshot.bindings), policyDigest: governedPolicyDigest(again.next, snapshot.bindings) }));
      return { write: { policy: again.next, bindings: null, order: 'policy-first' as const, beforePublish }, result: { ...again.result, status: 'applied' as const, revision: revisionOf(again.next) } };
    }, key);
  } finally { audit.close(); }
}

/** Catalog-derived person cells. Floors are filtered by the pure planner, never by profile or evaluator exceptions. */
export function ownerBaselineCells(groups: readonly McpCapabilityGroup[], descriptors: readonly OperationDescriptor[]): readonly OwnerBaselineCell[] {
  const operations = descriptors.filter(descriptor => descriptor.surface !== 'authority').map(descriptor => descriptor.operation.id).sort();
  const cells: OwnerBaselineCell[] = [];
  for (const group of groups.filter(group => group.availability === 'default')) for (const cell of group.cells) {
    if (cell.source === 'registered-operations') {
      for (const ids of mcpCapabilityIdChunks(operations)) cells.push({ family: 'mcp-delegable', kind: cell.resource.kind, actions: cell.actions, ids, scope: cell.scope });
    } else cells.push({ family: 'mcp-delegable', kind: cell.resource.kind, actions: cell.actions, ids: cell.resource.ids, scope: cell.scope });
  }
  for (const step of getDecisionSteps().filter(step => ['run-decision', 'task-decision'].includes(step.kind)))
    cells.push({ family: 'decision-steps', kind: step.kind, actions: [step.action], ids: 'all', scope: 'selected' });
  return cells;
}

/** Read-only doctor projection. Counts the missing registry-derived cells without invoking the conditional writer. */
export function describeOwnerBaseline(document: unknown, person: Person, scopeId: string, candidates: readonly OwnerBaselineCell[]) {
  const files = authorityDocuments(policySchema.parse(document));
  const plan = planOwnerBaseline(files.policy, files.bindings, { person, explicit: true, scopeId, families: ['mcp-delegable', 'decision-steps'], candidates, peopleLimit: 1, digest: digestOf });
  return { status: plan.status, missing: plan.added.length + plan.remaining, digest: digestOf(JSON.stringify(plan.cells)) };
}
