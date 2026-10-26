import { createHash } from 'node:crypto';
import { governedPolicyDigest, type AuthorityDocumentStore } from '#engine/core/policy/index.js';
import { firstRunPolicyTemplate, firstRunServiceId, firstRunTemplateAdditions, FIRST_RUN_POLICY_TEMPLATE_ID, FIRST_RUN_POLICY_TEMPLATE_VERSION, RECOVERY_ROLLOUT, identitySchema, immutableJsonObjectSchema, matchFirstRunPolicyTemplate,
  namedPersonPolicyAdditions, policyFileSchema, policyNamedPeople, upgradeFirstRunPolicy, type FirstRunPolicyTemplateInput } from '#domain/index.js';
import type { BootstrapJournalPayload, BootstrapObservation } from '#platform/index.js';
import { InstallationPublicationError } from './publish.js';
import { uninstallOperationDescriptors } from './uninstall-plan.js';
import environmentRegistry from './execution-environments.json' with { type: 'json' };
import { NERVOUS_RULES_SEED, loadNervousRules } from '#engine/core/nervous/index.js';
import { installerAuthorityChangeEvent } from './authority-audit.js';
import type { AuditEvent } from '#domain/index.js';

// Tool names + operation ids as data (engine may not import the adapters defining them); pinned against the real tool specs and
// Core operation descriptors by tests/contracts/installation/first-run-template-catalog.test.ts. Product-fixed template content,
// not an adapter choice, so it lives here rather than composition.
export const FIRST_RUN_READ_TOOL_NAMES = Object.freeze(['read_file', 'list_dir', 'grep', 'glob']);
/** v5 (owner 2026-10-07): the model's MCP proposal tool (read class: it writes nothing; a yes in its human window adds the server untrusted). */
export const FIRST_RUN_PROPOSE_MCP_TOOL_NAME = 'propose_mcp_server';
export const FIRST_RUN_MCP_CALL_OPERATION_ID = 'mcp.tool.call';
/** v5 (owner 2026-10-07, K1 option A): the governed policy change operation the installing owner may run (each change still asks and is audited). */
export const FIRST_RUN_POLICY_ADMINISTER_OPERATION_ID = 'policy.administer';
export const FIRST_RUN_SCRATCH_TOOL_NAMES = Object.freeze(['scratch_write', 'scratch_read', 'scratch_list']);
export const FIRST_RUN_EDIT_SHELL_TOOL_NAMES = Object.freeze(['edit_file', 'write_file', 'run_shell']);
export const FIRST_RUN_SCRATCH_WRITE_OPERATION_ID = 'workspace.scratch.write';
export const FIRST_RUN_WRITE_OPERATION_ID = 'workspace.file.write';
export const FIRST_RUN_SHELL_OPERATION_ID = 'host.shell.run';
/** v17: catalog identity only; the descriptor stays local to the coding onboarding adapter. */
export const FIRST_RUN_FIRST_COMMIT_OPERATION_ID = 'coding.first-commit';
/** v13 (owner A48-D3a, INIT D2): the execution environments the installing person may install — the execution-environment registry seed
 * (`execution-environments.json`, one entry today), which I-D2's adapter registry pins by test. A new entry changes the template's install rule,
 * so it comes with a template bump, never with a wider (`all`) grant. */
export const FIRST_RUN_EXECUTION_ENVIRONMENT_IDS: readonly string[] = Object.freeze(environmentRegistry.environments.map(entry => identitySchema.parse(entry.id)));
/** v16 (alpha.56 D1): the measured lost-worker rules at their Core seed version, the promotion cells the template names (a new rule version comes with
 * a template bump: the promotion is of an exact version, re-measured). */
export const FIRST_RUN_RECOVERY_RULES: readonly Readonly<{ id: string; version: number }>[] = Object.freeze(loadNervousRules(NERVOUS_RULES_SEED).rules
  .filter(rule => RECOVERY_ROLLOUT.rules.includes(rule.id)).map(rule => Object.freeze({ id: rule.id, version: rule.version })));
/** The concrete Core tool/operation template contract, shared by installer composition and external catalog pin tests. */
export const FIRST_RUN_TOOL_NAMES: FirstRunToolNames = Object.freeze({ readToolNames: FIRST_RUN_READ_TOOL_NAMES, scratchToolNames: FIRST_RUN_SCRATCH_TOOL_NAMES,
  scratchWriteOperationId: FIRST_RUN_SCRATCH_WRITE_OPERATION_ID, editShellToolNames: FIRST_RUN_EDIT_SHELL_TOOL_NAMES, writeOperationId: FIRST_RUN_WRITE_OPERATION_ID,
  shellOperationId: FIRST_RUN_SHELL_OPERATION_ID, proposeMcpToolName: FIRST_RUN_PROPOSE_MCP_TOOL_NAME, mcpCallOperationId: FIRST_RUN_MCP_CALL_OPERATION_ID,
  policyAdministerOperationId: FIRST_RUN_POLICY_ADMINISTER_OPERATION_ID, executionEnvironmentIds: FIRST_RUN_EXECUTION_ENVIRONMENT_IDS, recoveryRules: FIRST_RUN_RECOVERY_RULES, firstCommitOperationId: FIRST_RUN_FIRST_COMMIT_OPERATION_ID, uninstallOperationIds: uninstallOperationDescriptors().map(item => item.operation.id) });
export interface PolicyTemplateSource { load(): Promise<unknown> }
/** Doctor's read-soft recognition: the application service the domain decision (`matchFirstRunPolicyTemplate`) is
 * invoked through (composition-purity), never called from composition directly. `source.load()` is the raw
 * policy.json document (`policyFileSchema`: v1 or v2 as written, never the bindings-resolved merge — its own
 * `revision` is exactly what the template writes). An unreadable/unsafe/missing policy, or one that is not
 * exactly this template, is null — never the trusted authorization path. */
export async function inspectFirstRunPolicyTemplate(source: PolicyTemplateSource): Promise<{ readonly id: string; readonly version: number } | null> {
  try { return matchFirstRunPolicyTemplate(policyFileSchema.parse(await source.load()).revision); }
  catch { return null; }
}

type ServiceIdentity = Readonly<{ scopeId: string; serviceId: string }>;
/** v12 (owner 2026-10-16): the service a first-run template's shutdown rule names — this scope's configured `service.identity`, else the deterministic,
 * non-secret default derived from the scope. One rule for the fresh install and the exact upgrade. */
export function firstRunServiceIdentity(scopeId: string, configured: ServiceIdentity | null): ServiceIdentity {
  return Object.freeze({ scopeId, serviceId: configured?.scopeId === scopeId ? configured.serviceId : firstRunServiceId(scopeId) });
}
/** What the first-run installer did with `service.identity`: `written` (the audited config write, or the journaled first config), `planned` (preview),
 * `kept` (already configured for this scope), `other-scope` (configured for another scope: kept, never overwritten), `skipped` (the upgrade was
 * refused or conflicted: nothing written) or `not-set` (a typed refusal; the policy result stands). */
export type FirstRunServiceIdentityResult = Readonly<{ status: 'written' | 'planned' | 'kept' | 'other-scope' | 'skipped' | 'changed' | 'not-set'; identity: ServiceIdentity | null; code?: string }>;
/** The configuration seam: the effective identity and the project layer's digest from one read; the write goes through the one config write contract.
 * `hold` runs `work` while every configuration layer's write lock is held (the one lock each configuration write takes): no configuration write
 * lands between a read inside it and the end of `work` (POLICY-V12, Astra 2598). */
export interface FirstRunServiceIdentityPort {
  read(): Promise<{ readonly identity: ServiceIdentity | null; readonly digest: string | null }>;
  write(identity: ServiceIdentity, expect: string | null): Promise<unknown>;
  hold<T>(work: () => Promise<T>): Promise<T>;
}
const sameIdentity = (a: ServiceIdentity | null, b: ServiceIdentity | null) => a === b || (!!a && !!b && a.scopeId === b.scopeId && a.serviceId === b.serviceId);
/** Writes `target` only when no identity is configured (on exactly the digest read); an existing one is never replaced. `write: false` reads only.
 * `seen` (POLICY-V12 Astra 2596): the identity the plan was chosen from; another one now is `changed` (nothing written, the caller re-previews). */
export async function settleFirstRunServiceIdentity(port: FirstRunServiceIdentityPort, target: ServiceIdentity, write: boolean, seen?: ServiceIdentity | null): Promise<FirstRunServiceIdentityResult> {
  try {
    const { identity, digest } = await port.read();
    if (seen !== undefined && !sameIdentity(identity, seen)) return Object.freeze({ status: 'changed', identity: identity ? Object.freeze({ scopeId: identity.scopeId, serviceId: identity.serviceId }) : null });
    if (identity) return Object.freeze({ status: identity.scopeId === target.scopeId ? 'kept' : 'other-scope', identity: Object.freeze({ scopeId: identity.scopeId, serviceId: identity.serviceId }) });
    if (!write) return Object.freeze({ status: 'planned', identity: target });
    await port.write(target, digest);
    return Object.freeze({ status: 'written', identity: target });
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    return Object.freeze({ status: 'not-set', identity: null, ...(typeof code === 'string' ? { code } : {}) });
  }
}
export const SKIPPED_SERVICE_IDENTITY: FirstRunServiceIdentityResult = Object.freeze({ status: 'skipped', identity: null });

/** `gitignore` (G2-1, analysis 2026-10-18): the new data root's ignore file, so `git add -A` never commits the product state; first-session material. */
export type PolicyTemplateResource = 'policy' | 'bindings' | 'config' | 'ledger' | 'gitignore';
export interface PolicyTemplatePublishTarget { readonly resource: PolicyTemplateResource; readonly path: string; readonly content: string; readonly digest: string }
export interface PolicyTemplatePreview {
  readonly schemaVersion: 1; readonly status: 'preview';
  readonly scopeId: string; readonly principal: { readonly issuer: string; readonly subject: string };
  readonly template: { readonly id: string; readonly version: number };
  readonly planDigest: string; readonly transactionId: string;
  readonly paths: { readonly policy: string; readonly bindings: string };
  readonly policy: unknown; readonly bindings: unknown;
}
export interface PreparedPolicyTemplateInstallation { readonly preview: PolicyTemplatePreview; readonly targets: readonly PolicyTemplatePublishTarget[] }
export interface PolicyTemplateInstallationPorts {
  readonly journal: { observe(): Promise<BootstrapObservation>; write(expected: BootstrapObservation, next: BootstrapJournalPayload): Promise<BootstrapObservation> };
  inspectPreimage(target: PolicyTemplatePublishTarget): Promise<string | null>;
  publish(target: PolicyTemplatePublishTarget, transactionId: string): Promise<void>;
  verify(target: PolicyTemplatePublishTarget, transactionId: string): Promise<void>;
  now(): number;
}

function canonical(input: unknown): string {
  const parsed = immutableJsonObjectSchema.safeParse(input);
  if (!parsed.success) throw new InstallationPublicationError('INSTALLATION_PUBLICATION_INVALID');
  return JSON.stringify(parsed.data);
}
const digestOf = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

export interface PreparePolicyTemplateInput {
  readonly scopeId: string; readonly principal: { readonly issuer: string; readonly subject: string };
  readonly paths: { readonly policy: string; readonly bindings: string };
  readonly toolNames: FirstRunToolNames;
  /** v12: the runtime service id the template's shutdown rule names (the configured `service.identity` of this scope, else the default). */
  readonly serviceId?: string;
  /** Optional installer-owned first-session targets; retained in the same recovery journal. */
  readonly firstSessionTargets?: readonly PolicyTemplatePublishTarget[];
}
export type FirstRunToolNames = Pick<FirstRunPolicyTemplateInput, 'readToolNames' | 'scratchToolNames' | 'scratchWriteOperationId' | 'editShellToolNames' | 'writeOperationId'
  | 'shellOperationId' | 'proposeMcpToolName' | 'mcpCallOperationId' | 'policyAdministerOperationId' | 'executionEnvironmentIds' | 'recoveryRules' | 'firstCommitOperationId' | 'uninstallOperationIds'>;
/**
 * Pure preparation (SCR-B, owner 2026-09-28 option B): no I/O, deterministic in `(scopeId, principal)`, so
 * `init policy --preview` and a later `init policy --apply` for the same scope always agree on exactly what
 * gets written, and `--apply` run twice for the unchanged plan is always the same transaction (its identity
 * IS its plan digest — no random consent id, unlike the Docker-gated heavy install, which needs one because
 * its content depends on external, possibly-drifting evidence).
 */
export function preparePolicyTemplateInstallation(input: PreparePolicyTemplateInput): PreparedPolicyTemplateInstallation {
  const scopeId = identitySchema.parse(input.scopeId);
  const principal = { issuer: identitySchema.parse(input.principal.issuer), subject: identitySchema.parse(input.principal.subject) };
  const template = firstRunPolicyTemplate({ scopeId, principal, ...input.toolNames, ...(input.serviceId === undefined ? {} : { serviceId: input.serviceId }) });
  const policyContent = `${canonical(template.policy)}\n`, bindingsContent = `${canonical(template.bindings)}\n`;
  const targets: readonly PolicyTemplatePublishTarget[] = Object.freeze([
    Object.freeze({ resource: 'policy' as const, path: input.paths.policy, content: policyContent, digest: digestOf(policyContent) }),
    Object.freeze({ resource: 'bindings' as const, path: input.paths.bindings, content: bindingsContent, digest: digestOf(bindingsContent) }),
    ...(input.firstSessionTargets ?? []),
  ]);
  const planDigest = digestOf(`deckent.policy-template-plan.v1\n${canonical({ id: template.id, version: template.version, scopeId, principal,
    targets: targets.map(target => ({ resource: target.resource, path: target.path, digest: target.digest })) })}`);
  const transactionId = digestOf(`deckent.policy-template-transaction.v1\n${planDigest}`);
  const preview: PolicyTemplatePreview = Object.freeze({ schemaVersion: 1, status: 'preview', scopeId, principal,
    template: { id: template.id, version: template.version }, planDigest, transactionId, paths: { ...input.paths },
    policy: template.policy, bindings: template.bindings });
  return Object.freeze({ preview, targets });
}

/**
 * Fresh installation and exact retry (a crashed `--apply` run again) share this sequence: a complete pending
 * journal entry precedes every target effect (same custody as the heavy install's `InstallationPublicationApplication`,
 * same `INSTALLATION_PUBLICATION_*` vocabulary, deliberately not the same class — that one is tied to Docker/pool
 * evidence this flow never has). An existing `policy.json`/`bindings.json` whose bytes differ from the template is
 * never overwritten: refused before the journal's pending entry is even written.
 * Journal time is record-local monotonic (I40): an update never carries an earlier `updatedAtMs` than the record already holds,
 * because the host wall clock steps backwards (WSL2, NTP, VM resume) and a retry may run in a process whose clock is behind the
 * persisted `createdAtMs`. The journal's TIME_ORDER rule stays exact; this orders the record only and extends nothing.
 */
export class PolicyTemplateInstallationApplication {
  constructor(private readonly ports: PolicyTemplateInstallationPorts) {}
  async apply(prepared: PreparedPolicyTemplateInstallation) {
    const { preview, targets } = prepared;
    let observed = await this.ports.journal.observe();
    if (observed.record) {
      if (observed.record.transactionId !== preview.transactionId || observed.record.planDigest !== preview.planDigest) {
        throw new InstallationPublicationError('INSTALLATION_PUBLICATION_CONFLICT');
      }
      if (observed.record.resources.length !== targets.length || targets.some(target => !observed.record!.resources.some(resource =>
        resource.resource === target.resource && resource.path === target.path && resource.targetDigest === target.digest))) throw new InstallationPublicationError('INSTALLATION_PUBLICATION_CONFLICT');
    } else {
      const preimages = new Map<PolicyTemplateResource, string | null>();
      for (const target of targets) {
        const preimage = await this.ports.inspectPreimage(target);
        if (preimage !== null && preimage !== target.digest) throw new InstallationPublicationError('INSTALLATION_PUBLICATION_CONFLICT');
        preimages.set(target.resource, preimage);
      }
      const now = this.ports.now();
      const payload: BootstrapJournalPayload = { schemaVersion: 2, transactionId: preview.transactionId, planDigest: preview.planDigest,
        // No separate "profile" concept here (unlike the heavy flow): one deterministic plan, so both journal digests are the same value.
        profileDigest: preview.planDigest, phase: 'pending', createdAtMs: now, updatedAtMs: now, blockers: ['POLICY_TEMPLATE_NOT_APPLIED'],
        resources: targets.map(target => ({ resource: target.resource, path: target.path, preimageDigest: preimages.get(target.resource)!,
          targetDigest: target.digest, state: 'pending' as const })),
        recovery: immutableJsonObjectSchema.parse({ schemaVersion: 1, scopeId: preview.scopeId, principal: preview.principal, template: preview.template, ...(targets.length > 2 ? { firstSessionTargets: targets.filter(target => target.resource !== 'policy' && target.resource !== 'bindings') } : {}) }) };
      observed = await this.ports.journal.write(observed, payload);
    }
    if (!observed.record) throw new InstallationPublicationError('INSTALLATION_PUBLICATION_CHANGED');
    if (observed.record.phase === 'committed') {
      for (const target of targets) await this.ports.verify(target, preview.transactionId);
      return this.result(preview, 'replayed');
    }
    for (const target of targets) {
      await this.ports.publish(target, preview.transactionId);
      await this.ports.verify(target, preview.transactionId);
      const { checksum: ignored, ...current } = observed.record!; void ignored;
      observed = await this.ports.journal.write(observed, { ...current, updatedAtMs: Math.max(current.updatedAtMs, this.ports.now()),
        resources: current.resources.map(resource => resource.resource === target.resource ? { ...resource, state: 'published' as const } : resource) });
    }
    // A second, whole-set re-verify right before commit (same as the heavy install's publication path): the
    // per-target verify above only confirms that one target immediately after its own publish, not that it is
    // still correct once every target has finished.
    for (const target of targets) await this.ports.verify(target, preview.transactionId);
    const { checksum: ignored, ...current } = observed.record!; void ignored;
    await this.ports.journal.write(observed, { ...current, phase: 'committed', blockers: [], updatedAtMs: Math.max(current.updatedAtMs, this.ports.now()) });
    return this.result(preview, 'installed');
  }
  private result(preview: PolicyTemplatePreview, status: 'installed' | 'replayed') {
    return Object.freeze({ schemaVersion: 1 as const, status, transactionId: preview.transactionId, planDigest: preview.planDigest,
      template: preview.template, scopeId: preview.scopeId, paths: preview.paths });
  }
}

/** The single conditional writer of policy.json/bindings.json (structurally the policy unit's `AuthorityDocumentStore`; archived, keyed). */
export type PolicyTemplateDocumentWriter = Pick<AuthorityDocumentStore, 'updateAuthority'>;
type Person = { readonly issuer: string; readonly subject: string };
export interface PolicyTemplateUpgradeResult {
  readonly schemaVersion: 1;
  /** `preview`: would add `rules`; `upgraded`: written now; `current`: nothing to add; `unavailable`: not upgradable here (`reason`);
   * `conflict`: the policy moved since the previewed revision (`expect`). */
  readonly status: 'preview' | 'upgraded' | 'current' | 'unavailable' | 'conflict';
  /** `not-first-run`: no template read rule (a hand-built policy: name its person with `person`); `not-this-person`: the template's read rule does
   * not name the person; `person-not-named`: the named person is on no explicit allow rule of this scope; `invalid`: unreadable policy or person. */
  readonly reason: 'not-first-run' | 'not-this-person' | 'person-not-named' | 'not-owner' | 'invalid' | 'revision-changed' | 'service-identity-changed' | 'service-identity-unbound' | null;
  readonly template: { readonly id: string; readonly to: number };
  /** The person the added rules name (the OS identity, or the explicitly named `person`). */
  readonly scopeId: string; readonly principal: Person;
  /** The explicitly named person (`--person`), repeated in the next command; null when the OS identity was used. */
  readonly person: Person | null;
  /** Which plan applies: the first-run template's read rule (`first-run`) or a hand-built policy's named person (`named-person`); null when refused early. */
  readonly basis: 'first-run' | 'named-person' | null;
  /** Whether the policy read is exactly an older or the current first-run template of this scope and person (the only path to v12's owner rules). */
  readonly exact: boolean;
  /** On a `not-first-run`/`person-not-named` refusal: the people this policy already names on an allow rule of the scope (a display hint, capped). */
  readonly people: readonly Person[];
  /** The policy revision read (preview: pass it back as `--expect`); after an upgrade, the new one. */
  readonly revision: string | null;
  /** The current template rules this upgrade adds (nothing is replaced or removed). */
  readonly rules: readonly unknown[];
  /** Rule ids the upgrade would add that already exist with other content: kept as they are, shown for the person to review. */
  readonly conflicts: readonly string[];
  /** Hand-added `agent-tool` rules naming MCP wire names (`mcp__…`): kept, but since T3 an MCP call is decided on `mcp-server`, not on them. */
  readonly wireRules: readonly string[];
}
const revisionOf = (value: unknown) => typeof (value as { revision?: unknown } | null)?.revision === 'string' ? (value as { revision: string }).revision : null;
/**
 * The first-run older-template → current migration (owner 2026-10-07; `deckent init policy --scope <id> --upgrade --preview|--apply [--expect <revision>]
 * [--person <issuer>/<subject>]`), under the template installation's authority: the local person the first-run rules name, who could install the
 * current template on a fresh installation today. An untouched v4–v12 template becomes exactly the current one (v12 adds the owner's scope inspect and
 * service shutdown, owner 2026-10-16; v13 the seven A48-D3 rules); edited and hand-built policies take the add-only plan below, which (owner 2026-10-16 option A) includes the two v12 rules for the named person. It adds every current template rule that person does not hold yet (`firstRunTemplateAdditions`: MCP server authority, the MCP
 * call operation, the proposal tool, the `policy.administer` operation and approval decisions — K1 option A) and keeps everything else:
 * hand-added rules, edited first-run rules, modes and bindings; a rule id that exists with other content is kept and named as a conflict. An
 * untouched v4–v10 template becomes exactly the v11 template. A hand-built policy (no template read rule; POLICY-UPGRADE-HANDBUILT, lead 2026-10-08)
 * takes the same additions only for a person the file owner names explicitly (`person`), who must already be named on an allow rule of this
 * scope (`namedPersonPolicyAdditions`); without `person` the refusal lists the people the policy names. On a template policy `person` replaces
 * the OS identity and the template's read rule must name it. The write goes through the authority documents' one conditional, archived writer
 * (the archive holds the documents before and after: the backup and the way back) on exactly the revision read; a second run is `current`.
 * `apply: false` reads only.
 */
export async function upgradePolicyTemplate(writer: PolicyTemplateDocumentWriter, input: { readonly scopeId: string;
  readonly principal: Person; readonly toolNames: FirstRunToolNames; readonly apply: boolean; readonly expect?: string;
  /** v12: the runtime service id the exact template's shutdown rule names (the configured `service.identity` of this scope, else the default). */
  readonly serviceId?: string;
  /** Whether the caller owns the installation's authority documents (the files' owner uid is the caller's): only the owner may write here. */
  readonly owner: boolean;
  /** The explicitly named person (`--person`): required for a hand-built policy; on a template policy it must be the person the template names. */
  readonly person?: Person;
  /** At most this many named people in a refusal hint (display only; the policy may name more): the installation's inspection page size. */
  readonly peopleLimit: number; readonly audit: (event: AuditEvent) => void; readonly now: () => number }): Promise<PolicyTemplateUpgradeResult> {
  const scopeId = identitySchema.parse(input.scopeId);
  const named = input.person === undefined ? null : { issuer: identitySchema.safeParse(input.person.issuer), subject: identitySchema.safeParse(input.person.subject) };
  const person = named === null ? null : named.issuer.success && named.subject.success ? { issuer: named.issuer.data, subject: named.subject.data } : undefined;
  const principal = person ?? { issuer: identitySchema.parse(input.principal.issuer), subject: identitySchema.parse(input.principal.subject) };
  const template = { scopeId, principal, ...input.toolNames, ...(input.serviceId === undefined ? {} : { serviceId: input.serviceId }) };
  const names = { person: principal, scopeId, proposeMcpToolName: input.toolNames.proposeMcpToolName, mcpCallOperationId: input.toolNames.mcpCallOperationId,
    policyAdministerOperationId: input.toolNames.policyAdministerOperationId, ...(input.toolNames.uninstallOperationIds === undefined ? {} : { uninstallOperationIds: input.toolNames.uninstallOperationIds }), ...(input.toolNames.firstCommitOperationId === undefined ? {} : { firstCommitOperationId: input.toolNames.firstCommitOperationId }), executionEnvironmentIds: input.toolNames.executionEnvironmentIds,
    ...(input.toolNames.recoveryRules === undefined ? {} : { recoveryRules: input.toolNames.recoveryRules }), ...(input.serviceId === undefined ? {} : { serviceId: input.serviceId }) };
  const result = (status: PolicyTemplateUpgradeResult['status'], extra: Partial<PolicyTemplateUpgradeResult> = {}): PolicyTemplateUpgradeResult => Object.freeze({ schemaVersion: 1,
    status, reason: null, template: Object.freeze({ id: FIRST_RUN_POLICY_TEMPLATE_ID, to: FIRST_RUN_POLICY_TEMPLATE_VERSION }), scopeId, principal, person: person ?? null, basis: null,
    exact: false, people: [], revision: null, rules: [], conflicts: [], wireRules: [], ...extra });
  type Planned = { readonly result: PolicyTemplateUpgradeResult; readonly next: unknown | null };
  const nextWith = (current: unknown, revision: string | null, rules: readonly unknown[]) => {
    const body = { ...(current as Record<string, unknown>), grants: [...(current as { grants: readonly unknown[] }).grants, ...rules] };
    return { ...body, revision: `a-${digestOf(`policy-template-upgrade:1\0${revision ?? ''}\0${JSON.stringify({ ...body, revision: undefined })}`).slice(0, 40)}` };
  };
  const plan = (current: unknown): Planned => {
    const revision = revisionOf(current);
    if (input.expect !== undefined && input.expect !== revision) return { result: result('conflict', { reason: 'revision-changed', revision }), next: null };
    const wireRules = ((current as { grants?: { id: string; resource?: { kind?: string; ids?: unknown } }[] } | null)?.grants ?? [])
      .filter(grant => grant.resource?.kind === 'agent-tool' && Array.isArray(grant.resource.ids) && grant.resource.ids.some(id => typeof id === 'string' && id.startsWith('mcp__')))
      .map(grant => grant.id);
    // An untouched older template becomes exactly the current one (doctor names its version).
    const exact = upgradeFirstRunPolicy(current, template);
    if (exact.status === 'upgrade') {
      const rules = (exact.policy.schemaVersion === 2 ? exact.policy.grants : []).filter(rule => !((current as { grants: { id: string }[] }).grants.some(held => JSON.stringify(held) === JSON.stringify(rule))));
      return { result: result('preview', { basis: 'first-run', exact: true, revision, rules, wireRules }), next: exact.policy };
    }
    if (exact.status === 'current') return { result: result('current', { basis: 'first-run', exact: true, revision, wireRules }), next: null };
    const additions = firstRunTemplateAdditions(current, names);
    if (additions.status === 'unavailable' && additions.reason === 'not-first-run') {
      // A hand-built policy: only for an explicitly named person (never the OS identity implicitly); refusals carry the people it names.
      const people = policyNamedPeople(current, scopeId, input.peopleLimit);
      if (person === null) return { result: result('unavailable', { reason: 'not-first-run', revision, people }), next: null };
      const mine = namedPersonPolicyAdditions(current, { ...names, scopeId });
      if (mine.status === 'unavailable') return { result: result('unavailable', { reason: mine.reason, revision, people }), next: null };
      if (mine.status === 'current') return { result: result('current', { basis: 'named-person', revision, conflicts: mine.conflicts, wireRules }), next: null };
      return { result: result('preview', { basis: 'named-person', revision, rules: mine.rules, conflicts: mine.conflicts, wireRules }), next: nextWith(current, revision, mine.rules) };
    }
    if (additions.status === 'unavailable') return { result: result('unavailable', { reason: additions.reason, revision }), next: null };
    if (additions.status === 'current') return { result: result('current', { basis: 'first-run', revision, conflicts: additions.conflicts, wireRules }), next: null };
    return { result: result('preview', { basis: 'first-run', revision, rules: additions.rules, conflicts: additions.conflicts, wireRules }), next: nextWith(current, revision, additions.rules) };
  };
  // Security (lead 2026-10-07): this path writes outside the governed chain, so only the installation's owner may use it; anyone else is sent to
  // `deckent policy upgrade --template current` (policy.administer@1, card, audit, I2). Fail closed before anything is read.
  if (!input.owner) return result('unavailable', { reason: 'not-owner' });
  // An unusable named person (control characters, too long) is refused as such, before anything is read.
  if (person === undefined) return result('unavailable', { reason: 'invalid' });
  // Read first (no write), then write on exactly that revision under a key of this very change (a crash is looked up, never re-applied blindly).
  const first = await writer.updateAuthority(snapshot => ({ write: null, result: { planned: plan(snapshot.policy), revision: revisionOf(snapshot.policy) } }));
  if (!input.apply || first.planned.result.status !== 'preview') return first.planned.result;
  const key = `policy-template-upgrade-v${FIRST_RUN_POLICY_TEMPLATE_VERSION}-${digestOf(`${first.revision ?? ''}\0${canonical(first.planned.next as object)}`).slice(0, 64)}`;
  return writer.updateAuthority(snapshot => {
    if (revisionOf(snapshot.policy) !== first.revision) return { write: null, result: result('conflict', { reason: 'revision-changed', revision: revisionOf(snapshot.policy) }) };
    const again = plan(snapshot.policy);
    if (again.result.status !== 'preview' || again.next === null) return { write: null, result: again.result };
    const beforePublish = () => input.audit(installerAuthorityChangeEvent({ scopeId, caller: input.principal, person: principal, basis: again.result.basis!,
      template: { id: FIRST_RUN_POLICY_TEMPLATE_ID, version: FIRST_RUN_POLICY_TEMPLATE_VERSION }, commandId: key,
      inputDigest: digestOf(canonical(again.next as object)), before: first.revision!, after: revisionOf(again.next)!,
      grantsAdded: again.result.rules.length, atMs: input.now(), policyDigestBefore: governedPolicyDigest(snapshot.policy, snapshot.bindings), policyDigest: governedPolicyDigest(again.next, snapshot.bindings) }));
    return { write: { policy: again.next, bindings: null, order: 'policy-first', beforePublish }, result: { ...again.result, status: 'upgraded', revision: revisionOf(again.next) } };
  }, key);
}

/** The `--expect` token the installer preview prints (POLICY-V12, Astra 2596): the policy revision and the runtime service identity the plan names,
 * `<revision>~<12 hex>`, so an apply on another identity is refused instead of granting a stale service id. */
const serviceToken = (identity: ServiceIdentity) => digestOf(`deckent.first-run-service.v1\0${identity.scopeId}\0${identity.serviceId}`).slice(0, 12);
export type InstalledPolicyTemplateUpgrade = PolicyTemplateUpgradeResult & { readonly expect: string | null; readonly serviceIdentity: FirstRunServiceIdentityResult };
/**
 * `deckent init policy --upgrade` end to end (owner 2026-10-16 v12 + option A): the service identity is read once and the plan names it; the apply
 * refuses a token naming another identity (`service-identity-unbound` without one), refuses an identity that changed since that read (typed
 * `conflict` / `service-identity-changed`, re-preview), writes a missing identity before the policy (it grants nothing), and then holds every
 * configuration layer's write lock from a last identity read to the policy publication (Astra 2598): the published stop rule names the identity
 * that is configured at publication, or nothing is published.
 */
export async function upgradeInstalledPolicyTemplate(writer: PolicyTemplateDocumentWriter, port: FirstRunServiceIdentityPort, input: Omit<Parameters<typeof upgradePolicyTemplate>[1], 'serviceId' | 'audit'> & {
  readonly openAudit: () => Promise<{ record(event: AuditEvent): void; close(): void }> }): Promise<InstalledPolicyTemplateUpgrade> {
  const seen = (await port.read()).identity, target = firstRunServiceIdentity(input.scopeId, seen);
  const split = input.expect === undefined ? null : /^(.*)~([a-f0-9]{12})$/u.exec(input.expect);
  const { openAudit, expect: _expect, ...rest } = input; void _expect;
  const base = { ...rest, serviceId: target.serviceId, ...(input.expect === undefined ? {} : { expect: split ? split[1]! : input.expect }) };
  const done = (result: PolicyTemplateUpgradeResult, serviceIdentity: FirstRunServiceIdentityResult): InstalledPolicyTemplateUpgrade => Object.freeze({ ...result,
    expect: result.revision === null ? null : `${result.revision}~${serviceToken(target)}`, serviceIdentity });
  const preview = await upgradePolicyTemplate(writer, { ...base, apply: false, audit: () => { throw new Error('INSTALLER_PREVIEW_WRITE'); } });
  const refused = (reason: 'service-identity-changed' | 'service-identity-unbound', identity: FirstRunServiceIdentityResult) =>
    done({ ...preview, status: 'conflict', reason, rules: [], conflicts: [] }, identity);
  if (!preview.basis) return done(preview, SKIPPED_SERVICE_IDENTITY);
  if (input.apply && input.expect !== undefined && !split) return refused('service-identity-unbound', SKIPPED_SERVICE_IDENTITY);
  if (split && split[2] !== serviceToken(target)) return refused('service-identity-changed', SKIPPED_SERVICE_IDENTITY);
  const named = await settleFirstRunServiceIdentity(port, target, input.apply, seen);
  if (named.status === 'changed') return refused('service-identity-changed', named);
  if (!input.apply || preview.status !== 'preview') return done(preview, named);
  const settled = named.status === 'written' ? target : seen;
  return port.hold(async () => {
    if (!sameIdentity((await port.read()).identity, settled)) return refused('service-identity-changed', named);
    const audit = await openAudit();
    try { return done(await upgradePolicyTemplate(writer, { ...base, apply: true, audit: event => { audit.record(event); } }), named); } finally { audit.close(); }
  });
}
