import { createHash } from 'node:crypto';
import { firstRunPolicyTemplate, firstRunTemplateAdditions, FIRST_RUN_POLICY_TEMPLATE_ID, FIRST_RUN_POLICY_TEMPLATE_VERSION, identitySchema, immutableJsonObjectSchema, matchFirstRunPolicyTemplate,
  namedPersonPolicyAdditions, policyFileSchema, policyNamedPeople, upgradeFirstRunPolicy, type FirstRunPolicyTemplateInput } from '#domain/index.js';
import type { BootstrapJournalPayload, BootstrapObservation } from '#platform/index.js';
import { InstallationPublicationError } from './publish.js';

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

export type PolicyTemplateResource = 'policy' | 'bindings';
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
}
export type FirstRunToolNames = Pick<FirstRunPolicyTemplateInput, 'readToolNames' | 'scratchToolNames' | 'scratchWriteOperationId' | 'editShellToolNames' | 'writeOperationId'
  | 'shellOperationId' | 'proposeMcpToolName' | 'mcpCallOperationId' | 'policyAdministerOperationId'>;
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
  const template = firstRunPolicyTemplate({ scopeId, principal, ...input.toolNames });
  const policyContent = `${canonical(template.policy)}\n`, bindingsContent = `${canonical(template.bindings)}\n`;
  const targets: readonly PolicyTemplatePublishTarget[] = Object.freeze([
    Object.freeze({ resource: 'policy' as const, path: input.paths.policy, content: policyContent, digest: digestOf(policyContent) }),
    Object.freeze({ resource: 'bindings' as const, path: input.paths.bindings, content: bindingsContent, digest: digestOf(bindingsContent) }),
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
        recovery: immutableJsonObjectSchema.parse({ schemaVersion: 1, scopeId: preview.scopeId, principal: preview.principal, template: preview.template }) };
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
export interface PolicyTemplateDocumentWriter {
  updateAuthority<T>(work: (snapshot: { readonly policy: unknown; readonly bindings: unknown }) => { readonly write: { readonly policy: unknown | null;
    readonly bindings: unknown | null; readonly order: 'policy-first' | 'bindings-first' } | null; readonly result: T }, key?: string): Promise<T>;
}
type Person = { readonly issuer: string; readonly subject: string };
export interface PolicyTemplateUpgradeResult {
  readonly schemaVersion: 1;
  /** `preview`: would add `rules`; `upgraded`: written now; `current`: nothing to add; `unavailable`: not upgradable here (`reason`);
   * `conflict`: the policy moved since the previewed revision (`expect`). */
  readonly status: 'preview' | 'upgraded' | 'current' | 'unavailable' | 'conflict';
  /** `not-first-run`: no template read rule (a hand-built policy: name its person with `person`); `not-this-person`: the template's read rule does
   * not name the person; `person-not-named`: the named person is on no explicit allow rule of this scope; `invalid`: unreadable policy or person. */
  readonly reason: 'not-first-run' | 'not-this-person' | 'person-not-named' | 'not-owner' | 'invalid' | 'revision-changed' | null;
  readonly template: { readonly id: string; readonly to: number };
  /** The person the added rules name (the OS identity, or the explicitly named `person`). */
  readonly scopeId: string; readonly principal: Person;
  /** The explicitly named person (`--person`), repeated in the next command; null when the OS identity was used. */
  readonly person: Person | null;
  /** Which plan applies: the first-run template's read rule (`first-run`) or a hand-built policy's named person (`named-person`); null when refused early. */
  readonly basis: 'first-run' | 'named-person' | null;
  /** On a `not-first-run`/`person-not-named` refusal: the people this policy already names on an allow rule of the scope (a display hint, capped). */
  readonly people: readonly Person[];
  /** The policy revision read (preview: pass it back as `--expect`); after an upgrade, the new one. */
  readonly revision: string | null;
  /** The v5 rules this upgrade adds (nothing is replaced or removed). */
  readonly rules: readonly unknown[];
  /** Rule ids the upgrade would add that already exist with other content: kept as they are, shown for the person to review. */
  readonly conflicts: readonly string[];
  /** Hand-added `agent-tool` rules naming MCP wire names (`mcp__…`): kept, but since T3 an MCP call is decided on `mcp-server`, not on them. */
  readonly wireRules: readonly string[];
}
const revisionOf = (value: unknown) => typeof (value as { revision?: unknown } | null)?.revision === 'string' ? (value as { revision: string }).revision : null;
/**
 * The first-run v4 → v5 migration (owner 2026-10-07; `deckent init policy --scope <id> --upgrade --preview|--apply [--expect <revision>]
 * [--person <issuer>/<subject>]`), under the template installation's authority: the local person the first-run rules name, who could install v5
 * on a fresh installation today. It adds every v5 rule that person does not hold yet (`firstRunTemplateAdditions`: MCP server authority, the MCP
 * call operation, the proposal tool, the `policy.administer` operation and approval decisions — K1 option A) and keeps everything else:
 * hand-added rules, edited first-run rules, modes and bindings; a rule id that exists with other content is kept and named as a conflict. An
 * untouched v4 template becomes exactly the v5 template. A hand-built policy (no template read rule; POLICY-UPGRADE-HANDBUILT, lead 2026-10-08)
 * takes the same additions only for a person the file owner names explicitly (`person`), who must already be named on an allow rule of this
 * scope (`namedPersonPolicyAdditions`); without `person` the refusal lists the people the policy names. On a template policy `person` replaces
 * the OS identity and the template's read rule must name it. The write goes through the authority documents' one conditional, archived writer
 * (the archive holds the documents before and after: the backup and the way back) on exactly the revision read; a second run is `current`.
 * `apply: false` reads only.
 */
export async function upgradePolicyTemplate(writer: PolicyTemplateDocumentWriter, input: { readonly scopeId: string;
  readonly principal: Person; readonly toolNames: FirstRunToolNames; readonly apply: boolean; readonly expect?: string;
  /** Whether the caller owns the installation's authority documents (the files' owner uid is the caller's): only the owner may write here. */
  readonly owner: boolean;
  /** The explicitly named person (`--person`): required for a hand-built policy; on a template policy it must be the person the template names. */
  readonly person?: Person;
  /** At most this many named people in a refusal hint (display only; the policy may name more): the installation's inspection page size. */
  readonly peopleLimit: number }): Promise<PolicyTemplateUpgradeResult> {
  const scopeId = identitySchema.parse(input.scopeId);
  const named = input.person === undefined ? null : { issuer: identitySchema.safeParse(input.person.issuer), subject: identitySchema.safeParse(input.person.subject) };
  const person = named === null ? null : named.issuer.success && named.subject.success ? { issuer: named.issuer.data, subject: named.subject.data } : undefined;
  const principal = person ?? { issuer: identitySchema.parse(input.principal.issuer), subject: identitySchema.parse(input.principal.subject) };
  const template = { scopeId, principal, ...input.toolNames };
  const names = { person: principal, proposeMcpToolName: input.toolNames.proposeMcpToolName, mcpCallOperationId: input.toolNames.mcpCallOperationId,
    policyAdministerOperationId: input.toolNames.policyAdministerOperationId };
  const result = (status: PolicyTemplateUpgradeResult['status'], extra: Partial<PolicyTemplateUpgradeResult> = {}): PolicyTemplateUpgradeResult => Object.freeze({ schemaVersion: 1,
    status, reason: null, template: Object.freeze({ id: FIRST_RUN_POLICY_TEMPLATE_ID, to: FIRST_RUN_POLICY_TEMPLATE_VERSION }), scopeId, principal, person: person ?? null, basis: null,
    people: [], revision: null, rules: [], conflicts: [], wireRules: [], ...extra });
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
    // An untouched v4 template becomes exactly the v5 template (doctor names it v5).
    const exact = upgradeFirstRunPolicy(current, template);
    if (exact.status === 'upgrade') {
      const rules = (exact.policy.schemaVersion === 2 ? exact.policy.grants : []).filter(rule => !((current as { grants: { id: string }[] }).grants.some(held => JSON.stringify(held) === JSON.stringify(rule))));
      return { result: result('preview', { basis: 'first-run', revision, rules, wireRules }), next: exact.policy };
    }
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
  // `deckent policy upgrade --template v5` (policy.administer@1, card, audit, I2). Fail closed before anything is read.
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
    return { write: { policy: again.next, bindings: null, order: 'policy-first' }, result: { ...again.result, status: 'upgraded', revision: revisionOf(again.next) } };
  }, key);
}
