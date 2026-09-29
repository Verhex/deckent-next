import { identitySchema } from '#domain/core/primitives/index.js';
import { bindingsFileSchema, policyFileSchema, type PolicyFile } from './schema.js';

/**
 * SCR-B (owner 2026-09-28): the versioned default policy a fresh, terminal-only installation gets when it opts
 * into the lightweight `init policy` path (checkpoint decided in proof/SCR-B-2026-09-28/review.md, option B —
 * a new journaled install command, not the Docker/pool-gated `init apply`). Pure and side-effect free: the
 * caller (engine/core/installation) owns where/when this is written and under what journal custody.
 *
 * Read tools and the caller's scratch tool names are silently `allow`d (`agent-tool/invoke`); edit/shell tool
 * names are `require-approval` and `modeEligible: true` (owner q2) so a person's own later `auto-edit`/
 * `full-auto` mode may relax them (nobody has chosen one yet: bindings start with no mode entries). Every
 * operation these tools' effects use is granted `allow` at the operation side too, because `decideAgentToolCall`
 * requires both the `agent-tool` and the `operation` side to allow before a call is silent (see
 * src/engine/core/policy/internal/permission-mode.ts) — otherwise a silently-allowed scratch write would still
 * ask. The scratch write operation (SCR-A cross-lane note, 2026-09-28: `workspace.scratch.write`, target kind
 * `scratch-file`) is its own operation, separate from `workspace.file.write` (edit_file/write_file's effect):
 * without that separate grant a scratch write safely falls back to asking, never to a silent allow. No
 * pool/service/other operation grant is produced: that authority stays the owner's explicit decision
 * ("operasyon/servis yönetimi owner'a"), so any such request defaults to `NO_GRANT` (deny) until granted elsewhere.
 */
export const FIRST_RUN_POLICY_TEMPLATE_ID = 'first-run-template';
/** v2 (SECRET-WRITE, owner 2026-09-29 option A): the installing owner may set and delete every secret of the installation's store in the
 * installed scope (`secret`/`set|delete`, all names). v1 had no secret grant. */
export const FIRST_RUN_POLICY_TEMPLATE_VERSION = 2;
const REVISION_PATTERN = /^first-run-template-v(\d+)$/;

export interface FirstRunPolicyTemplateInput {
  readonly scopeId: string;
  readonly principal: { readonly issuer: string; readonly subject: string };
  readonly readToolNames: readonly string[];
  readonly scratchToolNames: readonly string[];
  readonly scratchWriteOperationId: string;
  readonly editShellToolNames: readonly string[];
  readonly writeOperationId: string;
  readonly shellOperationId: string;
}
export interface FirstRunPolicyTemplate {
  readonly id: typeof FIRST_RUN_POLICY_TEMPLATE_ID;
  readonly version: typeof FIRST_RUN_POLICY_TEMPLATE_VERSION;
  readonly policy: PolicyFile;
  readonly bindings: unknown;
}

/** The exact v2 policy + v1 bindings pair the template installs; deterministic in its (scopeId, principal) input, so two
 * `--preview` calls, or a `--preview` followed by `--apply`, produce byte-identical content. */
export function firstRunPolicyTemplate(input: FirstRunPolicyTemplateInput): FirstRunPolicyTemplate {
  const scopeId = identitySchema.parse(input.scopeId);
  const principal = { issuer: identitySchema.parse(input.principal.issuer), subject: identitySchema.parse(input.principal.subject) };
  const revision = `${FIRST_RUN_POLICY_TEMPLATE_ID}-v${FIRST_RUN_POLICY_TEMPLATE_VERSION}`;
  const actionsOf = { 'agent-tool': ['invoke'], operation: ['execute'], secret: ['set', 'delete'] } as const;
  const grant = (id: string, effect: 'allow' | 'require-approval', kind: keyof typeof actionsOf, ids: readonly string[] | 'all', modeEligible?: boolean) =>
    Object.freeze({ id, effect, actions: [...actionsOf[kind]], scopes: [scopeId], principals: [principal],
      resource: { kind, ids: ids === 'all' ? ids : [...ids] }, ...(modeEligible === undefined ? {} : { modeEligible }) });
  const policy = policyFileSchema.parse({
    schemaVersion: 2, revision, roles: [], separationOfDuties: [], restrictions: [],
    grants: [
      grant('first-run-read-tools', 'allow', 'agent-tool', input.readToolNames),
      grant('first-run-scratch-tools', 'allow', 'agent-tool', input.scratchToolNames),
      grant('first-run-edit-shell-tools', 'require-approval', 'agent-tool', input.editShellToolNames, true),
      grant('first-run-write-operation', 'allow', 'operation', [input.writeOperationId]),
      grant('first-run-shell-operation', 'allow', 'operation', [input.shellOperationId]),
      grant('first-run-scratch-write-operation', 'allow', 'operation', [input.scratchWriteOperationId]),
      // v2: the owner manages their own installation's secrets (every name; still decided per call and audited as `secret-change`).
      grant('first-run-secret-store', 'allow', 'secret', 'all'),
    ],
  });
  const bindings = bindingsFileSchema.parse({ schemaVersion: 1, revision: `${revision}-bindings`, bindings: [] });
  return Object.freeze({ id: FIRST_RUN_POLICY_TEMPLATE_ID, version: FIRST_RUN_POLICY_TEMPLATE_VERSION, policy, bindings });
}

/**
 * Doctor's recognition (never authority): whether a v2 policy document's own revision (its `revision` when read
 * as a plain file, or its `policyRevision` once resolved with bindings — the caller passes the right one; both
 * are the *policy's* revision, never the merged `policy+bindings` string) is exactly this template's revision
 * for a published template version (1..current). Any other revision (a custom or hand-edited policy, or an unknown template
 * version) is not recognized — this never inspects grants, only the revision identity the template itself writes.
 */
export function matchFirstRunPolicyTemplate(policyRevision: string): { readonly id: string; readonly version: number } | null {
  const match = REVISION_PATTERN.exec(policyRevision);
  if (!match) return null;
  const version = Number(match[1]);
  // Every published version is recognized (a v1 installation keeps its name; it lacks the v2 secret grant).
  return version >= 1 && version <= FIRST_RUN_POLICY_TEMPLATE_VERSION ? Object.freeze({ id: FIRST_RUN_POLICY_TEMPLATE_ID, version }) : null;
}
