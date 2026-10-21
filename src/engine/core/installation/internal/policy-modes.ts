import { createHash } from 'node:crypto';
import { chainAuthorityRevision, governedPolicyDigest } from '#engine/core/policy/index.js';
import { FIRST_RUN_POLICY_TEMPLATE_ID, FIRST_RUN_POLICY_TEMPLATE_VERSION, INSTALLER_PERMISSION_MODES_COMMAND_PREFIX, identitySchema, immutableJsonObjectSchema,
  planInstallerPermissionModes, type AuditEvent, type PermissionModeGrantState, type PolicyGrant } from '#domain/index.js';
import { installerAuthorityChangeEvent } from './authority-audit.js';
import type { PolicyTemplateDocumentWriter } from './policy-template.js';

type Person = { readonly issuer: string; readonly subject: string };
export interface InstallerPermissionModesResult {
  readonly schemaVersion: 1;
  /** `preview`: would change `added`/`removed`; `applied`: written now; `current`: nothing to change; `refused`: a rule still decides a wanted
   * mode (`reason`, each mode's `blockedBy`); `conflict`: the policy moved since the previewed revision; `unavailable`: not here (`reason`). */
  readonly status: 'preview' | 'applied' | 'current' | 'refused' | 'conflict' | 'unavailable';
  readonly reason: 'not-owner' | 'not-first-run' | 'not-this-person' | 'person-not-named' | 'invalid' | 'revision-changed' | 'policy-refused' | 'rule-conflict' | null;
  readonly scopeId: string; readonly principal: Person; readonly person: Person | null;
  readonly basis: 'first-run' | 'named-person' | null;
  /** The policy revision read (preview: the `--expect` token); after an apply, the new one. */
  readonly revision: string | null;
  /** Each openable mode's effective state before and after (managed-rule presence and effective permission are separate). */
  readonly modes: readonly PermissionModeGrantState[];
  readonly added: readonly PolicyGrant[]; readonly removed: readonly string[]; readonly conflicts: readonly string[];
  /** On a `not-first-run`/`person-not-named` refusal: the people the policy names on an allow rule of the scope (a display hint, capped). */
  readonly people: readonly Person[];
}
const revisionOf = (value: unknown) => typeof (value as { revision?: unknown } | null)?.revision === 'string' ? (value as { revision: string }).revision : null;
const digestOf = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * `deckent init policy --scope <id> --modes <set> --preview|--apply [--expect <revision>] [--person <issuer>/<subject>]` (PRE-9, owner 2026-10-21):
 * under exactly the installer's custody of `init policy --upgrade` — only the owner of the authority documents, the plan read first, the write
 * on exactly the revision read under a key of this change (`INSTALLER_PERMISSION_MODES_COMMAND_PREFIX`), the `authority-change` audit record
 * before publication and the archive of both documents. The witness (a person at the terminal; never the MCP actor) is the caller's gate.
 * `apply: false` reads only; the audit store is opened only for a write.
 */
export async function setInstallerPermissionModes(writer: PolicyTemplateDocumentWriter, input: { readonly scopeId: string; readonly principal: Person;
  readonly person?: Person; readonly modes: readonly string[]; readonly apply: boolean; readonly expect?: string; readonly owner: boolean; readonly peopleLimit: number;
  readonly openAudit: () => Promise<{ record(event: AuditEvent): void; close(): void }>; readonly now: () => number }): Promise<InstallerPermissionModesResult> {
  const scopeId = identitySchema.parse(input.scopeId), caller = { issuer: identitySchema.parse(input.principal.issuer), subject: identitySchema.parse(input.principal.subject) };
  const person = input.person ?? caller;
  const result = (status: InstallerPermissionModesResult['status'], extra: Partial<InstallerPermissionModesResult> = {}): InstallerPermissionModesResult => Object.freeze({ schemaVersion: 1,
    status, reason: null, scopeId, principal: { issuer: person.issuer, subject: person.subject }, person: input.person ? { issuer: input.person.issuer, subject: input.person.subject } : null,
    basis: null, revision: null, modes: [], added: [], removed: [], conflicts: [], people: [], ...extra });
  const plan = (policy: unknown, bindings: unknown) => {
    const revision = revisionOf(policy);
    const planned = planInstallerPermissionModes(policy, bindings, { person, explicit: input.person !== undefined, scopeId, modes: input.modes, peopleLimit: input.peopleLimit });
    if (planned.status === 'unavailable') return { result: result('unavailable', { reason: planned.reason, revision, people: planned.people }), next: null };
    if (planned.status === 'refused') return { result: result('refused', { reason: planned.reason, basis: planned.basis, revision, modes: planned.modes, conflicts: planned.conflicts }), next: null };
    const shown = { basis: planned.basis, revision, modes: planned.modes, added: planned.added, removed: planned.removed, conflicts: planned.conflicts };
    if (planned.status === 'current') return { result: result('current', shown), next: null };
    const body = planned.policy as Record<string, unknown>;
    const next = { ...body, revision: chainAuthorityRevision('installer-permission-modes:1', 'a', revision ?? '', { ...body, revision: undefined }) };
    return { result: result('preview', shown), next };
  };
  // Security: this path writes outside the governed chain (which cannot grant what the person does not hold: I2), so only the documents' owner.
  if (!input.owner) return result('unavailable', { reason: 'not-owner' });
  const first = await writer.updateAuthority(snapshot => ({ write: null, result: { planned: plan(snapshot.policy, snapshot.bindings), revision: revisionOf(snapshot.policy) } }));
  if (input.expect !== undefined && input.expect !== first.revision) return result('conflict', { reason: 'revision-changed', revision: first.revision });
  if (!input.apply || first.planned.result.status !== 'preview') return first.planned.result;
  const canonical = JSON.stringify(immutableJsonObjectSchema.parse(first.planned.next));
  const key = `${INSTALLER_PERMISSION_MODES_COMMAND_PREFIX}${digestOf(`${first.revision ?? ''}\0${canonical}`)}`;
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
