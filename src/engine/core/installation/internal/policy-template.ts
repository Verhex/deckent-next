import { createHash } from 'node:crypto';
import { firstRunPolicyTemplate, identitySchema, immutableJsonObjectSchema, matchFirstRunPolicyTemplate, policyFileSchema,
  type FirstRunPolicyTemplateInput } from '#domain/index.js';
import type { BootstrapJournalPayload, BootstrapObservation } from '#platform/index.js';
import { InstallationPublicationError } from './publish.js';

// SCR-A cross-lane note (owner 2026-09-28): tool names + the scratch write's own operation (target kind
// scratch-file; `workspace.scratch.write` is not yet a real catalog symbol on this base, written as data for
// the lead's merge). Product-fixed template content, not an adapter choice, so it lives here rather than composition.
export const FIRST_RUN_READ_TOOL_NAMES = Object.freeze(['read_file', 'list_dir', 'grep', 'glob']);
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
  readonly toolNames: Pick<FirstRunPolicyTemplateInput, 'readToolNames' | 'scratchToolNames' | 'scratchWriteOperationId' | 'editShellToolNames' | 'writeOperationId' | 'shellOperationId'>;
}
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
      observed = await this.ports.journal.write(observed, { ...current, updatedAtMs: this.ports.now(),
        resources: current.resources.map(resource => resource.resource === target.resource ? { ...resource, state: 'published' as const } : resource) });
    }
    // A second, whole-set re-verify right before commit (same as the heavy install's publication path): the
    // per-target verify above only confirms that one target immediately after its own publish, not that it is
    // still correct once every target has finished.
    for (const target of targets) await this.ports.verify(target, preview.transactionId);
    const { checksum: ignored, ...current } = observed.record!; void ignored;
    await this.ports.journal.write(observed, { ...current, phase: 'committed', blockers: [], updatedAtMs: this.ports.now() });
    return this.result(preview, 'installed');
  }
  private result(preview: PolicyTemplatePreview, status: 'installed' | 'replayed') {
    return Object.freeze({ schemaVersion: 1 as const, status, transactionId: preview.transactionId, planDigest: preview.planDigest,
      template: preview.template, scopeId: preview.scopeId, paths: preview.paths });
  }
}
