import { isMcpPrincipal, isWorkloadPrincipalRef, mcpPrincipalRef, memoryDistillerPrincipalRef, memoryEvaluatorPrincipalRef, recoveryPrincipalRef } from '#domain/core/principal/index.js';
import { IDENTITY_MAX_LENGTH, identitySchema } from '#domain/core/primitives/index.js';
import { bindingsFileSchema, policyFileSchema, policyGrantSchema, type PolicyFile, type PolicyGrant } from './schema.js';
import { policyResources } from './vocabulary.js';
import { POLICY_CHANGE_MAX, policyChangeSchema, type PolicyChange } from './administer.js';

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
 * without that separate grant a scratch write safely falls back to asking, never to a silent allow. Service
 * authority stays the owner's explicit decision ("operasyon/servis yönetimi owner'a"): until v11 no service grant was produced. The owner
 * decided it on 2026-10-16 ("Evet, v12 hazırla", clean-install rehearsal F1/F2): from v12 the named installing person (never the MCP actor or
 * another principal) may stop their own installation's runtime service (`service`/`shutdown` on exactly that service id in the installed
 * scope; restart is shutdown + start) and inspect the installed scope (`scope`/`inspect`). Every other service/operation request still
 * defaults to `NO_GRANT` (deny) until granted elsewhere.
 */
export const FIRST_RUN_POLICY_TEMPLATE_ID = 'first-run-template';
/** v2 (SECRET-WRITE, owner 2026-09-29 option A): the installing owner may set and delete every secret of the installation's store in the
 * installed scope (`secret`/`set|delete`, all names). v1 had no secret grant. v3 (B1, owner 2026-10-01): Core's own minimum assurance
 * for hard-floor tool-call cards is written out as visible `approvalAssurance` data (the owner may raise it; Core never goes below it).
 * v4 (CONFIG-SURFACE): the explicitly named installing owner may write configuration; the installation grant covers global writes.
 * v5 (owner 2026-10-07, MCP decisions: Jev 04f75210, d3d1817d): the installing owner holds `mcp-server` for every server in every scope — the
 * authority a trust approval delegates per server inside I2 (the owner's own call still asks: `mcp-call` raises an allow) — plus the
 * `mcp.tool.call` operation side, and the read tool `propose_mcp_server` (a proposal opens a human window in every mode and carries no secret).
 * With it (owner 2026-10-07, K1 option A, Jev 3e7c5b38) the owner may run the governed `policy.administer@1` operation and inspect/decide approvals in
 * the installed scope: the trust grant and every other policy change still pass the card, the audit and the delegation bound (I2). */
// No template bump for assurance: Core's assurance minimum is a code constant; policy data can only raise it.
/** v7 (T4-B K3 + SPEND-SETTLEMENT, owner 2026-10-08, Jev 125e4435): the installing owner may activate and inspect models (`model-activation`,
 * every scope: the ledger catalog register is installation-wide), invoke, inspect and cancel model calls in the installed scope (`model-invocation`),
 * and inspect, audit, reconcile and revise the provider spend accounts of the installed scope (`provider-spend-account`), so `models connect`,
 * terminal turns and the governed budget revision work on a fresh installation; every activation, call and spend is still decided, budgeted and
 * recorded per call. */
/** v8 (BACKUP-COMMAND, owner 2026-10-08): the installing owner may create, verify and restore recovery sets (`backup`, every scope: a
 * recovery set is installation-wide); restore still needs the service stopped and every operation is audited. */
/** v9 (W3-AUTHORITY): a separately named MCP actor gets observation only. Mutations and paid calls need an explicit MCP grant;
 * neither an owner grant nor `principals: all` is a delegation to MCP. No approval broker is claimed on model/spend paths. */
/** v10 (RUN-HAZIR-A): the named installing person can run work in the installed scope; pool management and integration remain separate. */
/** v11 (SABLON-V11): the named person gets separate installation-wide quota release and scoped integration/adoption authority. */
/** v12 (POLICY-V12, owner 2026-10-16): the named person may inspect the installed scope (inventory, worker observation and the service's own
 * recovery passes run as this person) and shut down exactly their installation's runtime service (`service.identity`, written at install).
 * Owner 2026-10-16 option A: edited first-run and named hand-built policies get the same two rules through the add-only plan (named person only). */
/** v13 (alpha.48, owner A48-D3 + MON-NAMES + CA-1 + C3, 2026-10-19): seven add-only rules, each its own id (`FIRST_RUN_V13_RULE_IDS`). The named
 * person may install the registered execution environments (`execution-environment`/`install`), repair the installation (`installation`/`repair`),
 * deactivate models (`model-activation`/`deactivate`, a separate rule beside the v7 activation rule so the add-only plan and the rollback can carry it),
 * read decisions in the installed scope (`decision`/`inspect`), see refused and failed scopes by name in the monitor (`monitor`/
 * `inspect-scope-diagnostics`) and read everyone's standing approvals (`policy`/`inspect-standing-grants`); the MCP actor gets one more observation
 * rule, `pool`/`inspect` in the installed scope. No authority action for the MCP actor; a terminal-only action (install, repair) is enforced by its
 * consumer, never by grant data. Every rule is revocable like any other; `policy upgrade --template current --rollback` removes exactly these. */
/** v14 (alpha.55 S4, lead 2026-10-23): two add-only rules (`FIRST_RUN_CURRENT_UPGRADE_RULE_IDS`): the named person and the MCP actor read the installed
 * scope's memory journal (`memory`/`inspect`). No memory change is granted to anyone (propose/verify/retire stay a separate decision); every rule is
 * revocable, and `policy upgrade --template current --rollback` removes exactly these two. */
/** v15 (alpha.55 S4B-1 + S7, owner S-M1/S-M2 2026-10-23): add-only rules (`FIRST_RUN_CURRENT_UPGRADE_RULE_IDS`): the named person may propose memory
 * candidates (needed to delegate D2), the memory distiller workload reads
 * and proposes in the installed scope's memory journal (D1, D2), reads Runs (D4) and, as its own rule, the raw sealed output of Attempts (D3, A2b);
 * the named person inspects and defines in the agent/skill catalog, the MCP actor inspects it. Its floor allows nothing beyond D1–D4 whatever is
 * granted; every rule is revocable, and `policy upgrade --template current --rollback` removes exactly these. */
export const FIRST_RUN_POLICY_TEMPLATE_VERSION = 15;
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
  /** v5 (K1 option A): the governed policy change operation (`policy.administer`). */
  readonly policyAdministerOperationId: string;
  /** v12: the runtime service id the person may shut down (the installation's configured `service.identity` of this scope); absent, the
   * deterministic default `firstRunServiceId(scopeId)`. Unused by v4–v11. */
  readonly serviceId?: string;
  /** v13: the execution-environment registry ids the person may install (product data the engine pins, e.g. `docker`). Unused by v4–v12. */
  readonly executionEnvironmentIds: readonly string[];
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
/** The deterministic, non-secret default runtime service id of a first-run installation: derived from the installed scope only, within the
 * identity bound (one runtime service per installation; the policy and the service's ledger are both this installation's). */
export function firstRunServiceId(scopeId: string): string {
  const scope = identitySchema.parse(scopeId), suffix = '-runtime';
  return identitySchema.parse(`${scope.slice(0, IDENTITY_MAX_LENGTH - suffix.length)}${suffix}`);
}
function buildTemplate(input: FirstRunPolicyTemplateInput, version: 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15) {
  const scopeId = identitySchema.parse(input.scopeId);
  const principal = { issuer: identitySchema.parse(input.principal.issuer), subject: identitySchema.parse(input.principal.subject) };
  const revision = `${FIRST_RUN_POLICY_TEMPLATE_ID}-v${version}`;
  const actionsOf = { 'agent-tool': ['invoke'], operation: ['execute'], secret: ['set', 'delete'], 'secret-switch': ['switch'], 'provider-spend-account': [...PROVIDER_SPEND_ACCOUNT_ACTIONS], config: ['write'], 'mcp-server': ['invoke'], approval: ['inspect', 'decide'],
    'model-activation': [...MODEL_ACTIVATION_ACTIONS], 'model-invocation': [...MODEL_INVOCATION_ACTIONS], backup: ['create', 'verify', 'restore'] } as const;
  const grant = (id: string, effect: 'allow' | 'require-approval', kind: keyof typeof actionsOf, ids: readonly string[] | 'all', modeEligible?: boolean) =>
    Object.freeze({ id, effect, actions: [...actionsOf[kind]], scopes: [scopeId], principals: [principal],
      resource: { kind: kind === 'secret-switch' ? 'secret' : kind, ids: ids === 'all' ? ids : [...ids] }, ...(modeEligible === undefined ? {} : { modeEligible }) });
  const v5 = version >= 5, v6 = version >= 6, v7 = version >= 7, v8 = version >= 8;
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
      ...(v5 ? [{ ...grant('first-run-mcp-servers', 'allow', 'mcp-server', 'all'), scopes: 'all' }, grant('first-run-mcp-call-operation', 'allow', 'operation', [input.mcpCallOperationId]),
        // K1 option A: the governed chain (each change still asks on its card, is audited and stays inside I2) and the cards it asks.
        grant('first-run-policy-administer', 'allow', 'operation', [input.policyAdministerOperationId]), grant('first-run-approvals', 'allow', 'approval', 'all')] : []),
      // v6: switching the store moves every secret, so the rule covers every name (its own rule: v4/v5 additions add exactly this one).
      ...(v6 ? [grant(FIRST_RUN_UPGRADE_RULE_IDS.secretSwitch, 'allow', 'secret-switch', 'all')] : []),
      // v7: model activation over every scope (catalog facts are installation-wide), model calls and provider spend accounts in the installed scope.
      ...(v7 ? [{ ...grant(FIRST_RUN_UPGRADE_RULE_IDS.modelActivation, 'allow', 'model-activation', 'all'), scopes: 'all' },
        grant(FIRST_RUN_UPGRADE_RULE_IDS.modelInvocation, 'allow', 'model-invocation', 'all'),
        grant(FIRST_RUN_UPGRADE_RULE_IDS.spending, 'allow', 'provider-spend-account', 'all')] : []),
      // v8: backup over every scope (a recovery set covers the whole installation).
      ...(v8 ? [{ ...grant(FIRST_RUN_UPGRADE_RULE_IDS.backup, 'allow', 'backup', 'all'), scopes: 'all' as const }] : []),
      ...(version >= 9 ? mcpObservationRules(principal, [scopeId]) : []),
      ...(version >= 10 ? executionRules(principal, [scopeId]) : []),
      ...(version >= 11 ? deliveryRules(principal, [scopeId]) : []),
      ...(version >= 12 ? ownerServiceRules(principal, [scopeId], input.serviceId) : []),
      ...(version >= 13 ? v13Rules(principal, [scopeId], input.executionEnvironmentIds) : []),
      ...(version >= 14 ? v14Rules(principal, [scopeId]) : []),
      ...(version >= 15 ? v15Rules(principal, [scopeId]) : []),
    ],
  });
  const bindings = bindingsFileSchema.parse({ schemaVersion: 1, revision: `${revision}-bindings`, bindings: [] });
  return { policy, bindings };
}

/** Why an installation's policy cannot take the current template upgrade in place: it already is current, it is not exactly the v4 template this
 * installation's (scope, person) would get (hand-edited, administered since, another person's, or another version), or it is unreadable. */
export type FirstRunTemplateUpgrade = { readonly status: 'upgrade'; readonly from: 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14; readonly policy: PolicyFile }
  | { readonly status: 'current' } | { readonly status: 'unavailable'; readonly reason: 'not-v4-template' | 'invalid' };
/**
 * The first-run exact-template migration (v5 owner decision 2026-10-07): only a policy document that is exactly an older template of this (scope, person) — the
 * bytes `init policy` wrote, never touched since — is replaced by the v5 template, as `init policy` would install it today. Anything else is
 * not changed here: the caller shows the explicit step (the v5 rules to add) instead. Pure; the caller pins the bytes it read.
 */
export function upgradeFirstRunPolicy(current: unknown, input: FirstRunPolicyTemplateInput): FirstRunTemplateUpgrade {
  const parsed = policyFileSchema.safeParse(current);
  if (!parsed.success) return Object.freeze({ status: 'unavailable', reason: 'invalid' });
  const target = buildTemplate(input, FIRST_RUN_POLICY_TEMPLATE_VERSION).policy;
  if (canonicalJson(parsed.data) === canonicalJson(target)) return Object.freeze({ status: 'current' });
  // Exact older templates become the current one; edited policies take the explicit add-only plan.
  for (const from of [14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4] as const) {
    if (canonicalJson(parsed.data) === canonicalJson(buildTemplate(input, from).policy)) return Object.freeze({ status: 'upgrade', from, policy: target });
  }
  return Object.freeze({ status: 'unavailable', reason: 'not-v4-template' });
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

/** The current rule ids an upgrade adds (never replaces: the proposal tool gets its own rule so a hand-edited read rule stays as it is). */
export const FIRST_RUN_UPGRADE_RULE_IDS = Object.freeze({ servers: 'first-run-mcp-servers', operation: 'first-run-mcp-call-operation', propose: 'first-run-mcp-propose-tool',
  administer: 'first-run-policy-administer', approvals: 'first-run-approvals', secretSwitch: 'first-run-secret-switch',
  modelActivation: 'first-run-model-activation', modelInvocation: 'first-run-model-invocation', spending: 'first-run-provider-spending', backup: 'first-run-backup',
  observeRun: 'first-run-mcp-observe-run', observeScope: 'first-run-mcp-observe-scope', observeApproval: 'first-run-mcp-observe-approval',
  observeActivation: 'first-run-mcp-observe-model-activation', observeInvocation: 'first-run-mcp-observe-model-invocation', observeSpending: 'first-run-mcp-observe-provider-spend-account',
  runs: 'first-run-runs', pools: 'first-run-pools', attempts: 'first-run-attempts', workTargets: 'first-run-work-targets',
  quotaRelease: 'first-run-quota-release', integration: 'first-run-integration', workTargetAdopt: 'first-run-work-target-adopt',
  scopeInspect: 'first-run-scope-inspect', serviceShutdown: 'first-run-service-shutdown',
  environmentInstall: 'first-run-execution-environment-install', installationRepair: 'first-run-installation-repair', modelDeactivation: 'first-run-model-deactivation',
  decisionInspect: 'first-run-decision-inspect', scopeDiagnostics: 'first-run-monitor-scope-diagnostics', standingGrantsAll: 'first-run-standing-grants-all',
  observePool: 'first-run-mcp-observe-pool', memoryInspect: 'first-run-memory-inspect', observeMemory: 'first-run-mcp-observe-memory',
  memoryPropose: 'first-run-memory-propose', distillerMemory: 'first-run-memory-distiller', distillerRuns: 'first-run-memory-distiller-runs', distillerOutput: 'first-run-memory-distiller-output',
  agentCatalog: 'first-run-agent-catalog', observeAgentCatalog: 'first-run-mcp-observe-agent-catalog',
  memoryReview: 'first-run-memory-review', evaluatorMemory: 'first-run-memory-evaluator', evaluatorRuns: 'first-run-memory-evaluator-runs', evaluatorModel: 'first-run-memory-evaluator-model',
  memoryPurge: 'first-run-memory-purge', recoveryModel: 'first-run-recovery-model' });
/** The v15 delta (S4B-1 + S7, owner 2026-10-23): what `policy upgrade --template current --rollback` removes. It never removes earlier versions' rules: the
 * v14 memory reads stay once added, like every older version's administration or observation authority. */
export const FIRST_RUN_CURRENT_UPGRADE_RULE_IDS = Object.freeze([FIRST_RUN_UPGRADE_RULE_IDS.memoryPropose, FIRST_RUN_UPGRADE_RULE_IDS.distillerMemory, FIRST_RUN_UPGRADE_RULE_IDS.distillerRuns,
  FIRST_RUN_UPGRADE_RULE_IDS.distillerOutput, FIRST_RUN_UPGRADE_RULE_IDS.agentCatalog, FIRST_RUN_UPGRADE_RULE_IDS.observeAgentCatalog, FIRST_RUN_UPGRADE_RULE_IDS.memoryReview, FIRST_RUN_UPGRADE_RULE_IDS.evaluatorMemory,
  FIRST_RUN_UPGRADE_RULE_IDS.evaluatorRuns, FIRST_RUN_UPGRADE_RULE_IDS.evaluatorModel, FIRST_RUN_UPGRADE_RULE_IDS.memoryPurge, FIRST_RUN_UPGRADE_RULE_IDS.recoveryModel]);
/** v7 actions (K3): activation and its read; the model call and everything a terminal turn needs around it (inspect, content, cancel). */
const MODEL_ACTIVATION_ACTIONS = ['activate', 'inspect'] as const;
const MODEL_INVOCATION_ACTIONS = ['invoke', 'inspect', 'inspect-content', 'cancel-invocation'] as const;
/** v7 actions (SPEND-SETTLEMENT): read, audit and the two governed management commands (held reconcile, budget revision). */
const PROVIDER_SPEND_ACCOUNT_ACTIONS = ['inspect', 'audit', 'reconcile', 'budget-revision'] as const;
export type FirstRunTemplateAdditions = { readonly status: 'plan'; readonly change: PolicyChange; readonly rules: readonly PolicyGrant[]; readonly conflicts: readonly string[];
    /** Rules still missing after this batch (only when the plan exceeds POLICY_CHANGE_MAX); a second run plans them. */ readonly remaining?: number }
  | { readonly status: 'current'; readonly conflicts: readonly string[] } | { readonly status: 'unavailable'; readonly reason: 'not-first-run' | 'not-this-person' | 'invalid' };
type Selection = 'all' | readonly string[];
const coversAll = (held: Selection, wanted: Selection) => held === 'all' || (wanted !== 'all' && wanted.every(item => held.includes(item)));
const sameRule = (a: unknown, b: unknown) => JSON.stringify(policyGrantSchema.parse(a)) === JSON.stringify(policyGrantSchema.parse(b));
type Person = { readonly issuer: string; readonly subject: string };
/** `serviceId` (v12): the installation's configured runtime service id of this scope; absent, the deterministic default of the plan's first scope. */
type AdditionNames = { readonly proposeMcpToolName: string; readonly mcpCallOperationId: string; readonly policyAdministerOperationId: string; readonly serviceId?: string;
  /** v13: the execution-environment registry ids the install rule names. */
  readonly executionEnvironmentIds: readonly string[] };
/** Whether a rule NAMES this person: a rule for `all` principals names nobody (security, lead 2026-10-07: never proof of an owner). */
export const namesPerson = (grant: PolicyGrant, person: Person) => grant.principals !== 'all' && grant.principals.some(item => item.issuer === person.issuer && item.subject === person.subject);
/**
 * The first-run v4 → v5 additions (owner 2026-10-07): over any v2 policy that carries the template's `first-run-read-tools` rule naming this person
 * explicitly (a rule for `all` principals does not count)
 * (its scopes are the installation's), the `grant.add` changes for every v5 rule this person does not hold yet — `mcp-server` over every server in
 * every scope, the `mcp.tool.call` operation, `propose_mcp_server`, the `policy.administer` operation and approval inspect/decide (K1 option A).
 * A rule counts as held when its id exists or another `allow` rule of this person already covers it. Nothing is removed or replaced: hand-added
 * rules stay, and a rule whose id exists with other content is kept and named in `conflicts`. An empty plan is `current` (a second run changes
 * nothing). Pure; the caller writes it (installer upgrade) or submits it through `policy.administer@1` (governed upgrade).
 */
export function firstRunTemplateAdditions(current: unknown, input: { readonly person: Person } & AdditionNames): FirstRunTemplateAdditions {
  const parsed = policyFileSchema.safeParse(current);
  if (!parsed.success || parsed.data.schemaVersion !== 2) return Object.freeze({ status: 'unavailable', reason: 'invalid' });
  const grants = parsed.data.grants, read = grants.find(grant => grant.id === 'first-run-read-tools');
  if (!read || read.scopes === 'all') return Object.freeze({ status: 'unavailable', reason: 'not-first-run' });
  const person = { issuer: identitySchema.parse(input.person.issuer), subject: identitySchema.parse(input.person.subject) };
  // Security (lead 2026-10-07): the read rule must NAME this person; a rule for `all` principals proves no installation owner (fail closed).
  if (isMcpPrincipal(person) || !namesPerson(read, person)) return Object.freeze({ status: 'unavailable', reason: 'not-this-person' });
  return plannedAdditions(grants, person, read.scopes, input);
}
/** The v5 rules this person lacks over `grants` (shared by the first-run and the named-person upgrade, so both add exactly the same rules). */
function plannedAdditions(grants: readonly PolicyGrant[], person: Person, scopes: readonly string[], input: AdditionNames) {
  // Coverage may count a rule for `all` principals (it only means less is added); every added rule names this person alone (never another one).
  const mine = (grant: PolicyGrant) => grant.principals === 'all' || namesPerson(grant, person);
  const rule = (id: string, kind: string, actions: readonly string[], ids: Selection, ruleScopes: Selection): PolicyGrant => policyGrantSchema.parse({
    id, effect: 'allow', actions: [...actions], scopes: ruleScopes === 'all' ? 'all' : [...ruleScopes], principals: [person], resource: { kind, ids: ids === 'all' ? 'all' : [...ids] } });
  const ids = FIRST_RUN_UPGRADE_RULE_IDS;
  const wanted = [rule(ids.servers, 'mcp-server', ['invoke'], 'all', 'all'), rule(ids.operation, 'operation', ['execute'], [input.mcpCallOperationId], scopes),
    rule(ids.propose, 'agent-tool', ['invoke'], [input.proposeMcpToolName], scopes), rule(ids.administer, 'operation', ['execute'], [input.policyAdministerOperationId], scopes),
    rule(ids.approvals, 'approval', ['inspect', 'decide'], 'all', scopes),
    // v6 (owner 2026-10-08): the secret store switch, over every name (a switch moves them all); hand-built policies get it through the named-person upgrade.
    rule(ids.secretSwitch, 'secret', ['switch'], 'all', scopes),
    // v7 (owner 2026-10-08, K3 + SPEND-SETTLEMENT): models connect, terminal turns and spend management on a hand-built or older policy, through the same add-only plan.
    rule(ids.modelActivation, 'model-activation', MODEL_ACTIVATION_ACTIONS, 'all', 'all'), rule(ids.modelInvocation, 'model-invocation', MODEL_INVOCATION_ACTIONS, 'all', scopes),
    rule(ids.spending, 'provider-spend-account', PROVIDER_SPEND_ACCOUNT_ACTIONS, 'all', scopes),
    // v8 (BACKUP-COMMAND): installation-wide backup authority, added the same add-only way.
    rule(ids.backup, 'backup', ['create', 'verify', 'restore'], 'all', 'all'), ...mcpObservationRules(person, scopes), ...executionRules(person, scopes), ...deliveryRules(person, scopes),
    // v12 (owner 2026-10-16 option A): scope inspection and this installation's service stop, for the named person only, added the same add-only way.
    ...ownerServiceRules(person, scopes, input.serviceId),
    // v13 (owner A48-D3, MON-NAMES, CA-1, C3): the seven v13 rules, each its own id, added the same add-only way (named person; MCP pool observation).
    ...v13Rules(person, scopes, input.executionEnvironmentIds),
    // v14 (S4, lead 2026-10-23): memory journal reads for the named person and the MCP actor, added the same add-only way.
    ...v14Rules(person, scopes),
    // v15 (S4B-1 + S7, owner 2026-10-23): the memory distiller's D1–D4 and the agent catalog rules, added the same add-only way.
    ...v15Rules(person, scopes)];
  const conflicts: string[] = [], rules: PolicyGrant[] = [];
  for (const want of wanted) {
    const same = grants.find(grant => grant.id === want.id);
    if (same) { if (!sameRule(same, want)) conflicts.push(want.id); continue; }
    const target = want.principals === 'all' ? person : want.principals[0]!;
    // A rule for another principal (the MCP actor, a workload such as the memory distiller) counts as held only when a rule names that principal.
    const covered = grants.some(grant => grant.effect === 'allow' && (target.issuer !== person.issuer || target.subject !== person.subject ? namesPerson(grant, target) : mine(grant)) && grant.resource.kind === want.resource.kind && coversAll(grant.actions, want.actions)
      && coversAll(grant.resource.ids, want.resource.ids) && coversAll(grant.scopes, want.scopes));
    if (!covered) rules.push(want);
  }
  if (!rules.length) return Object.freeze({ status: 'current' as const, conflicts: Object.freeze(conflicts) });
  // One `policy.administer@1` change holds at most POLICY_CHANGE_MAX rules (v14 made a v4-era plan 33): the plan takes the first batch in version
  // order and names how many remain; the same add-only upgrade run again adds the rest (each run is idempotent).
  const batch = rules.slice(0, POLICY_CHANGE_MAX), remaining = rules.length - batch.length;
  return Object.freeze({ status: 'plan' as const, rules: Object.freeze(batch), conflicts: Object.freeze(conflicts), ...(remaining ? { remaining } : {}),
    change: policyChangeSchema.parse({ schemaVersion: 1, changes: batch.map(grant => ({ kind: 'grant.add', grant })) }) });
}

/** An allow rule that names this person explicitly in exactly this scope (its scopes list it; `all` scopes or `all` principals never count). */
export const anchorsPerson = (grant: PolicyGrant, person: Person, scopeId: string) => grant.effect === 'allow' && namesPerson(grant, person)
  && grant.scopes !== 'all' && grant.scopes.includes(scopeId);
/**
 * The people a v2 policy explicitly names on an allow rule of this scope (first appearance order, distinct, at most `limit`): the display hint
 * the installer's refusal gives its file owner, who may read these files anyway. Nothing here grants anything; `all` principals are skipped.
 */
export function policyNamedPeople(current: unknown, scopeId: string, limit: number): readonly Person[] {
  const parsed = policyFileSchema.safeParse(current);
  if (!parsed.success || parsed.data.schemaVersion !== 2) return Object.freeze([]);
  const people: Person[] = [];
  for (const grant of parsed.data.grants) {
    if (grant.effect !== 'allow' || grant.principals === 'all' || grant.scopes === 'all' || !grant.scopes.includes(scopeId)) continue;
    for (const item of grant.principals) {
      if (isWorkloadPrincipalRef(item)) continue;
      if (people.length >= limit) return Object.freeze(people);
      if (!people.some(held => held.issuer === item.issuer && held.subject === item.subject)) people.push(Object.freeze({ issuer: item.issuer, subject: item.subject }));
    }
  }
  return Object.freeze(people);
}
export type NamedPersonAdditions = Extract<FirstRunTemplateAdditions, { readonly status: 'plan' | 'current' }>
  | { readonly status: 'unavailable'; readonly reason: 'person-not-named' | 'invalid' };
/**
 * The v4 → v5 additions for a hand-built policy (POLICY-UPGRADE-HANDBUILT, lead 2026-10-08, Jev b6dba079): a v2 policy without the template's
 * read rule, for a person its file owner names explicitly. That person must already be named (never through `all` principals) on at least one
 * `allow` rule listing this scope; otherwise nothing is planned (`person-not-named`). The plan is exactly the first-run one, in this scope:
 * only the v5 rules the person lacks, each naming the person alone; nothing is removed or replaced, a same-id rule with other content is
 * a named conflict, and an empty plan is `current`. Pure; the installer's file-owner gate and conditional writer decide whether it is written.
 */
export function namedPersonPolicyAdditions(current: unknown, input: { readonly person: Person; readonly scopeId: string } & AdditionNames): NamedPersonAdditions {
  const parsed = policyFileSchema.safeParse(current), person = { issuer: identitySchema.safeParse(input.person.issuer), subject: identitySchema.safeParse(input.person.subject) };
  const scopeId = identitySchema.safeParse(input.scopeId);
  if (!parsed.success || parsed.data.schemaVersion !== 2 || !person.issuer.success || !person.subject.success || !scopeId.success) return Object.freeze({ status: 'unavailable', reason: 'invalid' });
  const who = { issuer: person.issuer.data, subject: person.subject.data };
  if (isMcpPrincipal(who) || !parsed.data.grants.some(grant => anchorsPerson(grant, who, scopeId.data))) return Object.freeze({ status: 'unavailable', reason: 'person-not-named' });
  return plannedAdditions(parsed.data.grants, who, [scopeId.data], input);
}

/** Add-only, named observation rules: existing owner and custom rules are untouched. */
function mcpObservationRules(owner: Person, scopes: readonly string[]): readonly PolicyGrant[] {
  const principal = mcpPrincipalRef(owner);
  const ids = FIRST_RUN_UPGRADE_RULE_IDS;
  return [[ids.observeRun, 'run'], [ids.observeScope, 'scope'], [ids.observeApproval, 'approval'], [ids.observeActivation, 'model-activation'],
    [ids.observeInvocation, 'model-invocation'], [ids.observeSpending, 'provider-spend-account']].map(([id, kind]) => policyGrantSchema.parse({
    id, effect: 'allow', actions: ['inspect'], scopes: [...scopes], principals: [principal], resource: { kind, ids: 'all' },
  }));
}

/** v10 execution authority is shared by fresh installs and both add-only upgrade paths; MCP retains v9 observation only. */
function executionRules(person: Person, scopes: readonly string[]): readonly PolicyGrant[] {
  if (isMcpPrincipal(person)) return [];
  const ids = FIRST_RUN_UPGRADE_RULE_IDS;
  return [
    { id: ids.runs, kind: 'run', actions: ['create', 'reserve', 'inspect', 'cancel'] },
    { id: ids.pools, kind: 'pool', actions: ['use', 'inspect'] },
    { id: ids.attempts, kind: 'attempt', actions: ['execute', 'evaluate', 'read-output', 'recover-output', 'cancel', 'reconcile', 'release'] },
    { id: ids.workTargets, kind: 'work-target', actions: ['use'] },
  ].map(({ id, kind, actions }) => policyGrantSchema.parse({ id, effect: 'allow', actions, scopes: [...scopes], principals: [person], resource: { kind, ids: 'all' } }));
}

/** v11 keeps quota release separate from pool management; integration uses the installation's existing scoped attempt/target gates. */
function deliveryRules(person: Person, scopes: readonly string[]): readonly PolicyGrant[] {
  if (isMcpPrincipal(person)) return [];
  const ids = FIRST_RUN_UPGRADE_RULE_IDS;
  return [
    { id: ids.quotaRelease, kind: 'pool', actions: ['release-quota'], scopes: 'all' as const },
    { id: ids.integration, kind: 'attempt', actions: ['prepare-integration', 'deliver-integration', 'adopt-integration', 'rollback-integration'], scopes: [...scopes] },
    { id: ids.workTargetAdopt, kind: 'work-target', actions: ['adopt'], scopes: [...scopes] },
  ].map(({ id, kind, actions, scopes: ruleScopes }) => policyGrantSchema.parse({ id, effect: 'allow', actions, scopes: ruleScopes,
    principals: [person], resource: { kind, ids: 'all' } }));
}

/** v12 (owner 2026-10-16): the named person inspects the installed scope(s) and shuts down exactly this installation's runtime service, in those
 * scopes only. Never for the MCP actor (it keeps v9 observation; `serviceActorSchema` admits its peer, so policy is its only shutdown gate). */
function ownerServiceRules(person: Person, scopes: readonly string[], serviceId: string | undefined): readonly PolicyGrant[] {
  if (isMcpPrincipal(person)) return [];
  const ids = FIRST_RUN_UPGRADE_RULE_IDS, service = identitySchema.parse(serviceId ?? firstRunServiceId(scopes[0]!));
  return [
    { id: ids.scopeInspect, kind: 'scope', actions: ['inspect'], resource: [...scopes] },
    { id: ids.serviceShutdown, kind: 'service', actions: ['shutdown'], resource: [service] },
  ].map(({ id, kind, actions, resource }) => policyGrantSchema.parse({ id, effect: 'allow', actions, scopes: [...scopes], principals: [person], resource: { kind, ids: resource } }));
}

/** v13 (owner A48-D3, MON-NAMES, CA-1, C3): the named person's six rules and the MCP actor's pool observation, shared by the fresh template, both add-only
 * plans and the rollback. A person rule never names the MCP actor (AI and MCP get no authority action); the MCP rule only reads. */
function v13Rules(person: Person, scopes: readonly string[], executionEnvironmentIds: readonly string[] | undefined): readonly PolicyGrant[] {
  const ids = FIRST_RUN_UPGRADE_RULE_IDS, vocabulary = policyResources;
  const observePool = policyGrantSchema.parse({ id: ids.observePool, effect: 'allow', actions: ['inspect'], scopes: [...scopes], principals: [mcpPrincipalRef(person)],
    resource: { kind: vocabulary.pool.kind, ids: 'all' } });
  if (isMcpPrincipal(person)) return [observePool];
  // Fail closed: a caller that names no environment (or an untyped one passing nothing) gets no install rule, never a wider one.
  const environments = (executionEnvironmentIds ?? []).map(id => identitySchema.parse(id));
  return [
    // Installation-wide (like backup): an execution environment and the installation folder are the host's, not one scope's.
    ...(environments.length ? [{ id: ids.environmentInstall, kind: vocabulary.executionEnvironment.kind, actions: ['install'], ids: environments, scopes: 'all' as const }] : []),
    { id: ids.installationRepair, kind: vocabulary.installation.kind, actions: ['repair'], ids: 'all' as const, scopes: 'all' as const },
    // The same reach as the v7 activation rule (the ledger catalog register is installation-wide).
    { id: ids.modelDeactivation, kind: vocabulary.modelActivation.kind, actions: ['deactivate'], ids: 'all' as const, scopes: 'all' as const },
    { id: ids.decisionInspect, kind: vocabulary.decision.kind, actions: ['inspect'], ids: 'all' as const, scopes: [...scopes] },
    // An installation-level view (owner 2026-10-19, PLAN §16): every scope's refused or failed check, named.
    { id: ids.scopeDiagnostics, kind: vocabulary.monitor.kind, actions: ['inspect-scope-diagnostics'], ids: 'all' as const, scopes: 'all' as const },
    { id: ids.standingGrantsAll, kind: vocabulary.policy.kind, actions: ['inspect-standing-grants'], ids: 'all' as const, scopes: [...scopes] },
  ].map(({ id, kind, actions, ids: resource, scopes: ruleScopes }) => policyGrantSchema.parse({ id, effect: 'allow', actions, scopes: ruleScopes === 'all' ? 'all' : ruleScopes,
    principals: [person], resource: { kind, ids: resource } })).concat(observePool);
}

/** v14 (S4): `memory`/`inspect` in the installed scope(s) for the named person and the MCP actor (observation; reading never verifies or changes an entry). */
function v14Rules(person: Person, scopes: readonly string[]): readonly PolicyGrant[] {
  const ids = FIRST_RUN_UPGRADE_RULE_IDS, kind = policyResources.memory.kind;
  const rule = (id: string, principal: Person) => policyGrantSchema.parse({ id, effect: 'allow', actions: ['inspect'], scopes: [...scopes], principals: [principal], resource: { kind, ids: 'all' } });
  const observe = rule(ids.observeMemory, mcpPrincipalRef(person));
  return isMcpPrincipal(person) ? [observe] : [rule(ids.memoryInspect, person), observe];
}

/**
 * v15 (S4B-1 + S7): the named person may propose memory candidates (their own card; the delegation bound needs it before they can grant the
 * distiller D2); the memory distiller (`<person>/memory-distiller`, a workload the composition root issues) gets D1+D2 (`memory` inspect, propose),
 * D4 (`run`/inspect) and, as its own rule, D3 (`attempt`/read-output: the raw sealed output of accepted Attempts, A2b); the named person inspects
 * and defines in the agent/skill catalog (`import` stays a separate decision behind the signed floor) and the MCP actor inspects it. The person's
 * retire and purge come from S4B-4. S4B-3 (owner S-M3/S-M5, A6/A7): the person may verify (human review, terminal
 * witness) and open a contest — the delegation bound needs both before they can grant the evaluator V2/V3 — and the memory evaluator
 * (`<person>/memory-evaluator`, composition root only) gets V1–V3 (`memory` inspect, verify, contest), V4 (`run`/inspect) and, as its own rule, V5
 * (`model-invocation`/invoke; the role registry restricts it to `memory-evaluator` rows). Its floor refuses every other pair. S4B-4 (owner S-M12,
 * A11): the named person retires and purges memory (their review card; both stay floored for every AI). The purge removes the stored content
 * of exactly the evaluator calls its entry's sealed evaluation records name, under that same memory/purge decision: no model-invocation grant.
 */
function v15Rules(person: Person, scopes: readonly string[]): readonly PolicyGrant[] {
  const ids = FIRST_RUN_UPGRADE_RULE_IDS, vocabulary = policyResources;
  const rule = (id: string, principal: Person, kind: string, actions: readonly string[]) => policyGrantSchema.parse({ id, effect: 'allow', actions: [...actions], scopes: [...scopes],
    principals: [principal], resource: { kind, ids: 'all' } });
  const observe = rule(ids.observeAgentCatalog, mcpPrincipalRef(person), vocabulary.agentCatalog.kind, ['inspect']);
  if (isMcpPrincipal(person)) return [observe];
  const distiller = memoryDistillerPrincipalRef(person);
  return [rule(ids.memoryPropose, person, vocabulary.memory.kind, ['propose']), rule(ids.distillerMemory, distiller, vocabulary.memory.kind, ['inspect', 'propose']), rule(ids.distillerRuns, distiller, vocabulary.run.kind, ['inspect']),
    rule(ids.distillerOutput, distiller, vocabulary.attempt.kind, ['read-output']), rule(ids.agentCatalog, person, vocabulary.agentCatalog.kind, ['inspect', 'define']), observe,
    rule(ids.memoryReview, person, vocabulary.memory.kind, ['verify', 'contest']), ...evaluatorRules(memoryEvaluatorPrincipalRef(person), rule),
    rule(ids.memoryPurge, person, vocabulary.memory.kind, ['retire', 'purge']),
    // S6R-5: the recovery principal (`<person>/recovery`, composition root only) invokes its `recovery-decision` role model; its floor refuses every
    // other pair, the role registry restricts which rows, and a continuation still needs the person's own standing grant (`recovery-action`).
    rule(ids.recoveryModel, recoveryPrincipalRef(person), vocabulary.modelInvocation.kind, ['invoke'])];
}
function evaluatorRules(evaluator: Person, rule: (id: string, principal: Person, kind: string, actions: readonly string[]) => PolicyGrant): readonly PolicyGrant[] {
  const ids = FIRST_RUN_UPGRADE_RULE_IDS, vocabulary = policyResources;
  return [rule(ids.evaluatorMemory, evaluator, vocabulary.memory.kind, ['inspect', 'verify', 'contest']), rule(ids.evaluatorRuns, evaluator, vocabulary.run.kind, ['inspect']),
    rule(ids.evaluatorModel, evaluator, vocabulary.modelInvocation.kind, ['invoke'])];
}

/** Latest add-only delta (v15) by content: a same-id customization is preserved and reported, never deleted as a template rule. */
export function firstRunTemplateRollback(current: unknown, person: Person, scopeId: string | undefined): { readonly rules: readonly PolicyGrant[]; readonly conflicts: readonly string[]; readonly missing?: readonly string[] } {
  const policy = policyFileSchema.parse(current);
  if (policy.schemaVersion !== 2) return { rules: [], conflicts: [] };
  const read = policy.grants.find(rule => rule.id === 'first-run-read-tools');
  if (isMcpPrincipal(person)) return { rules: [], conflicts: [] };
  const scopes = read && read.scopes !== 'all' && namesPerson(read, person) ? read.scopes : scopeId ? [identitySchema.parse(scopeId)] : null;
  if (!scopes) return { rules: [], conflicts: [] };
  const expected = v15Rules({ issuer: person.issuer, subject: person.subject }, scopes), rules: PolicyGrant[] = [], conflicts: string[] = [];
  const missing: string[] = [];
  for (const want of expected) {
    const held = policy.grants.find(rule => rule.id === want.id);
    if (held && canonicalJson(held) === canonicalJson(want)) rules.push(held);
    else if (held) conflicts.push(held.id);
    else missing.push(want.id);
  }
  // `missing`: expected delta rules not held (review 2672: a fresh install is the whole expected set, nothing removed).
  return { rules: Object.freeze(rules), conflicts: Object.freeze(conflicts), missing: Object.freeze(missing) };
}
