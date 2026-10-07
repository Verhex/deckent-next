import { identitySchema } from '#domain/core/primitives/index.js';
import { bindingsFileSchema, policyFileSchema, policyGrantSchema, type PolicyFile, type PolicyGrant } from './schema.js';
import { policyChangeSchema, type PolicyChange } from './administer.js';

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
 * installed scope (`secret`/`set|delete`, all names). v1 had no secret grant. v3 (B1, owner 2026-10-01): Core's own minimum assurance
 * for hard-floor tool-call cards is written out as visible `approvalAssurance` data (the owner may raise it; Core never goes below it).
 * v4 (CONFIG-SURFACE): the explicitly named installing owner may write configuration; the installation grant covers global writes.
 * v5 (owner 2026-10-07, MCP decisions: Jev 04f75210, d3d1817d): the installing owner holds `mcp-server` for every server in every scope — the
 * authority a trust approval delegates per server inside I2 (the owner's own call still asks: `mcp-call` raises an allow) — plus the
 * `mcp.tool.call` operation side, and the read tool `propose_mcp_server` (a proposal opens a human window in every mode and carries no secret). */
// No template bump for assurance: Core's assurance minimum is a code constant; policy data can only raise it.
export const FIRST_RUN_POLICY_TEMPLATE_VERSION = 5;
/** The hard-floor tool-call cells (write floor and configuration file, destructive and always-ask shell, every fetch, every MCP call): only the
 * terminal of the turn that asked may allow them. The same set is Core's default in the approval engine (a test keeps the two equal). */
export const HARD_FLOOR_CARD_CELLS = Object.freeze(['edit-floor', 'edit-self-source', 'edit-authority', 'shell-destructive', 'shell-always-ask', 'fetch-listed', 'fetch-unlisted', 'mcp-call', 'mcp-floor'] as const);
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
  /** v5: the model's MCP proposal tool (a read tool) and the Core MCP call operation. */
  readonly proposeMcpToolName: string;
  readonly mcpCallOperationId: string;
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
  const built = buildTemplate(input, FIRST_RUN_POLICY_TEMPLATE_VERSION);
  return Object.freeze({ id: FIRST_RUN_POLICY_TEMPLATE_ID, version: FIRST_RUN_POLICY_TEMPLATE_VERSION, policy: built.policy, bindings: built.bindings });
}
function buildTemplate(input: FirstRunPolicyTemplateInput, version: 4 | 5) {
  const scopeId = identitySchema.parse(input.scopeId);
  const principal = { issuer: identitySchema.parse(input.principal.issuer), subject: identitySchema.parse(input.principal.subject) };
  const revision = `${FIRST_RUN_POLICY_TEMPLATE_ID}-v${version}`;
  const actionsOf = { 'agent-tool': ['invoke'], operation: ['execute'], secret: ['set', 'delete'], config: ['write'], 'mcp-server': ['invoke'] } as const;
  const grant = (id: string, effect: 'allow' | 'require-approval', kind: keyof typeof actionsOf, ids: readonly string[] | 'all', modeEligible?: boolean) =>
    Object.freeze({ id, effect, actions: [...actionsOf[kind]], scopes: [scopeId], principals: [principal],
      resource: { kind, ids: ids === 'all' ? ids : [...ids] }, ...(modeEligible === undefined ? {} : { modeEligible }) });
  const v5 = version === 5;
  const policy = policyFileSchema.parse({
    schemaVersion: 2, revision, roles: [], separationOfDuties: [], restrictions: [],
    approvalAssurance: [{ id: 'first-run-hard-floor-cards', scopes: [scopeId], subject: 'agent-tool-call', cells: [...HARD_FLOOR_CARD_CELLS], minimum: 'turn-bound' }],
    grants: [
      grant('first-run-read-tools', 'allow', 'agent-tool', v5 ? [...input.readToolNames, input.proposeMcpToolName] : input.readToolNames),
      grant('first-run-scratch-tools', 'allow', 'agent-tool', input.scratchToolNames),
      grant('first-run-edit-shell-tools', 'require-approval', 'agent-tool', input.editShellToolNames, true),
      grant('first-run-write-operation', 'allow', 'operation', [input.writeOperationId]),
      grant('first-run-shell-operation', 'allow', 'operation', [input.shellOperationId]),
      grant('first-run-scratch-write-operation', 'allow', 'operation', [input.scratchWriteOperationId]),
      // v2: the owner manages their own installation's secrets (every name; still decided per call and audited as `secret-change`).
      grant('first-run-secret-store', 'allow', 'secret', 'all'),
      { ...grant('first-run-config', 'allow', 'config', 'all'), scopes: 'all' },
      // v5: every MCP server in every scope (a user-scope server's trust grant covers all of this person's scopes), and the call operation.
      ...(v5 ? [{ ...grant('first-run-mcp-servers', 'allow', 'mcp-server', 'all'), scopes: 'all' }, grant('first-run-mcp-call-operation', 'allow', 'operation', [input.mcpCallOperationId])] : []),
    ],
  });
  const bindings = bindingsFileSchema.parse({ schemaVersion: 1, revision: `${revision}-bindings`, bindings: [] });
  return { policy, bindings };
}

/** Why an installation's policy cannot take the v4 → v5 upgrade in place: it already is v5, it is not exactly the v4 template this
 * installation's (scope, person) would get (hand-edited, administered since, another person's, or another version), or it is unreadable. */
export type FirstRunTemplateUpgrade = { readonly status: 'upgrade'; readonly from: 4; readonly policy: PolicyFile }
  | { readonly status: 'current' } | { readonly status: 'unavailable'; readonly reason: 'not-v4-template' | 'invalid' };
/**
 * The first-run v4 → v5 migration (owner 2026-10-07): only a policy document that is exactly the v4 template of this (scope, person) — the
 * bytes `init policy` wrote, never touched since — is replaced by the v5 template, as `init policy` would install it today. Anything else is
 * not changed here: the caller shows the explicit step (the v5 rules to add) instead. Pure; the caller pins the bytes it read.
 */
export function upgradeFirstRunPolicy(current: unknown, input: FirstRunPolicyTemplateInput): FirstRunTemplateUpgrade {
  const parsed = policyFileSchema.safeParse(current);
  if (!parsed.success) return Object.freeze({ status: 'unavailable', reason: 'invalid' });
  const target = buildTemplate(input, FIRST_RUN_POLICY_TEMPLATE_VERSION).policy;
  if (canonicalJson(parsed.data) === canonicalJson(target)) return Object.freeze({ status: 'current' });
  if (canonicalJson(parsed.data) !== canonicalJson(buildTemplate(input, 4).policy)) return Object.freeze({ status: 'unavailable', reason: 'not-v4-template' });
  return Object.freeze({ status: 'upgrade', from: 4, policy: target });
}
/** Key-order independent JSON of a parsed document (both sides went through the same schema). */
const canonicalJson = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);

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

/** The v5 rule ids a governed upgrade adds (never replaces: the proposal tool gets its own rule so a hand-edited read rule stays as it is). */
export const FIRST_RUN_UPGRADE_RULE_IDS = Object.freeze({ servers: 'first-run-mcp-servers', operation: 'first-run-mcp-call-operation', propose: 'first-run-mcp-propose-tool' });
export type FirstRunTemplateAdditions = { readonly status: 'plan'; readonly change: PolicyChange; readonly rules: readonly PolicyGrant[] }
  | { readonly status: 'current' } | { readonly status: 'unavailable'; readonly reason: 'not-first-run' | 'invalid' };
/**
 * The governed v4 → v5 upgrade plan (owner 2026-10-07, `deckent policy upgrade --template v5`): over any v2 policy that carries the first-run
 * template's `first-run-read-tools` rule (its scopes are the installation's), the `grant.add` changes for whatever v5 rule is missing — the
 * person's `mcp-server` authority over every server in every scope, the `mcp.tool.call` operation in the template's scopes, and
 * `propose_mcp_server` as an allowed read tool (unless some rule of this person already allows it). Nothing is removed or replaced, so hand-added
 * rules stay; an empty plan is `current` (a second run changes nothing). Pure; the caller submits it through `policy.administer@1` (I2, audit).
 */
export function firstRunTemplateAdditions(current: unknown, input: { readonly person: { readonly issuer: string; readonly subject: string };
  readonly proposeMcpToolName: string; readonly mcpCallOperationId: string }): FirstRunTemplateAdditions {
  const parsed = policyFileSchema.safeParse(current);
  if (!parsed.success || parsed.data.schemaVersion !== 2) return Object.freeze({ status: 'unavailable', reason: 'invalid' });
  const grants = parsed.data.grants, read = grants.find(grant => grant.id === 'first-run-read-tools');
  if (!read || read.scopes === 'all') return Object.freeze({ status: 'unavailable', reason: 'not-first-run' });
  const person = { issuer: identitySchema.parse(input.person.issuer), subject: identitySchema.parse(input.person.subject) };
  const mine = (grant: PolicyGrant) => grant.principals === 'all' || grant.principals.some(item => item.issuer === person.issuer && item.subject === person.subject);
  const has = (id: string) => grants.some(grant => grant.id === id);
  const proposes = grants.some(grant => grant.effect === 'allow' && mine(grant) && grant.resource.kind === 'agent-tool'
    && (grant.resource.ids === 'all' || grant.resource.ids.includes(input.proposeMcpToolName)));
  const rule = (id: string, kind: string, action: string, ids: readonly string[] | 'all', scopes: readonly string[] | 'all'): PolicyGrant => policyGrantSchema.parse({
    id, effect: 'allow', actions: [action], scopes: scopes === 'all' ? 'all' : [...scopes], principals: [person], resource: { kind, ids: ids === 'all' ? 'all' : [...ids] } });
  const rules = [
    ...(has(FIRST_RUN_UPGRADE_RULE_IDS.servers) ? [] : [rule(FIRST_RUN_UPGRADE_RULE_IDS.servers, 'mcp-server', 'invoke', 'all', 'all')]),
    ...(has(FIRST_RUN_UPGRADE_RULE_IDS.operation) ? [] : [rule(FIRST_RUN_UPGRADE_RULE_IDS.operation, 'operation', 'execute', [input.mcpCallOperationId], read.scopes)]),
    ...(proposes || has(FIRST_RUN_UPGRADE_RULE_IDS.propose) ? [] : [rule(FIRST_RUN_UPGRADE_RULE_IDS.propose, 'agent-tool', 'invoke', [input.proposeMcpToolName], read.scopes)]),
  ];
  if (!rules.length) return Object.freeze({ status: 'current' });
  return Object.freeze({ status: 'plan', rules: Object.freeze(rules),
    change: policyChangeSchema.parse({ schemaVersion: 1, changes: rules.map(grant => ({ kind: 'grant.add', grant })) }) });
}
