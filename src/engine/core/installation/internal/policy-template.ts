import { createHash } from 'node:crypto';
import { firstRunPolicyTemplate, FIRST_RUN_POLICY_TEMPLATE_ID, FIRST_RUN_POLICY_TEMPLATE_VERSION, identitySchema, immutableJsonObjectSchema, matchFirstRunPolicyTemplate,
  policyFileSchema, upgradeFirstRunPolicy, type FirstRunPolicyTemplateInput } from '#domain/index.js';
import type { BootstrapJournalPayload, BootstrapObservation } from '#platform/index.js';
import { InstallationPublicationError } from './publish.js';

// Tool names + operation ids as data (engine may not import the adapters defining them); pinned against the real tool specs and
// Core operation descriptors by tests/contracts/installation/first-run-template-catalog.test.ts. Product-fixed template content,
// not an adapter choice, so it lives here rather than composition.
export const FIRST_RUN_READ_TOOL_NAMES = Object.freeze(['read_file', 'list_dir', 'grep', 'glob']);
/** v5 (owner 2026-10-07): the model's MCP proposal tool (read class: it writes nothing; a yes in its human window adds the server untrusted). */
export const FIRST_RUN_PROPOSE_MCP_TOOL_NAME = 'propose_mcp_server';
export const FIRST_RUN_MCP_CALL_OPERATION_ID = 'mcp.tool.call';
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
  | 'shellOperationId' | 'proposeMcpToolName' | 'mcpCallOperationId'>;
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
export interface PolicyTemplateUpgradeResult {
  readonly schemaVersion: 1;
  /** `preview`: would upgrade; `upgraded`: written now; `current`: already the v5 template; `unavailable`: not exactly this installation's v4 template. */
  readonly status: 'preview' | 'upgraded' | 'current' | 'unavailable';
  readonly reason: 'not-v4-template' | 'invalid' | null;
  readonly template: { readonly id: string; readonly from: 4 | null; readonly to: number };
  readonly scopeId: string; readonly principal: { readonly issuer: string; readonly subject: string };
  /** The rules v5 adds or changes, exactly as the v5 template writes them: what the upgrade writes, or the explicit step to take by hand. */
  readonly rules: readonly unknown[];
}
/**
 * The first-run v4 → v5 migration (owner 2026-10-07): `deckent init policy --upgrade`. Only a policy that is exactly the v4 template of this
 * installation's (scope, person) — the bytes `init policy` wrote, untouched since — is replaced by the v5 template, through the one conditional,
 * archived writer of the authority documents (a concurrent change of either file writes nothing). The authority is the template installation's:
 * the local person the template names, who could install v5 on a fresh installation today; nothing else is touched (bindings, modes stay).
 * Anything else is `unavailable`, never rewritten: the result lists the v5 rules as the explicit step (a company or hand-edited policy adds them
 * itself, inside its own authority). `apply: false` reads only.
 */
export async function upgradePolicyTemplate(writer: PolicyTemplateDocumentWriter, input: { readonly scopeId: string;
  readonly principal: { readonly issuer: string; readonly subject: string }; readonly toolNames: FirstRunToolNames; readonly apply: boolean }): Promise<PolicyTemplateUpgradeResult> {
  const scopeId = identitySchema.parse(input.scopeId);
  const principal = { issuer: identitySchema.parse(input.principal.issuer), subject: identitySchema.parse(input.principal.subject) };
  const template = { scopeId, principal, ...input.toolNames }, target = firstRunPolicyTemplate(template);
  const v4 = new Set(['first-run-read-tools', 'first-run-mcp-servers', 'first-run-mcp-call-operation']);
  const rules = Object.freeze((target.policy.schemaVersion === 2 ? target.policy.grants : []).filter(rule => v4.has(rule.id)));
  const result = (status: PolicyTemplateUpgradeResult['status'], reason: PolicyTemplateUpgradeResult['reason'] = null, from: 4 | null = null): PolicyTemplateUpgradeResult =>
    Object.freeze({ schemaVersion: 1, status, reason, template: Object.freeze({ id: FIRST_RUN_POLICY_TEMPLATE_ID, from, to: FIRST_RUN_POLICY_TEMPLATE_VERSION }), scopeId, principal, rules });
  const key = `policy-template-upgrade-v${FIRST_RUN_POLICY_TEMPLATE_VERSION}-${digestOf(canonical(target.policy)).slice(0, 64)}`;
  return writer.updateAuthority(snapshot => {
    const plan = upgradeFirstRunPolicy(snapshot.policy, template);
    if (plan.status !== 'upgrade') return { write: null, result: plan.status === 'current' ? result('current') : result('unavailable', plan.reason) };
    if (!input.apply) return { write: null, result: result('preview', null, plan.from) };
    return { write: { policy: plan.policy, bindings: null, order: 'policy-first' }, result: result('upgraded', null, plan.from) };
  }, input.apply ? key : undefined);
}
