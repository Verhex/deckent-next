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
 * `mcp.tool.call` operation side, and the read tool `propose_mcp_server` (a proposal opens a human window in every mode and carries no secret).
 * With it (owner 2026-10-07, K1 option A, Jev 3e7c5b38) the owner may run the governed `policy.administer@1` operation and inspect/decide approvals in
 * the installed scope: the trust grant and every other policy change still pass the card, the audit and the delegation bound (I2). */
// No template bump for assurance: Core's assurance minimum is a code constant; policy data can only raise it.
/** v7 (T4-B K3 + SPEND-SETTLEMENT, owner 2026-10-08, Jev 125e4435): the installing owner may activate and inspect models (`model-activation`,
 * every scope: the ledger catalog register is installation-wide), invoke, inspect and cancel model calls in the installed scope (`model-invocation`),
 * and inspect, audit, reconcile and revise the provider spend accounts of the installed scope (`provider-spend-account`), so `models connect`,
 * terminal turns and the governed budget revision work on a fresh installation; every activation, call and spend is still decided, budgeted and
 * recorded per call. */
export const FIRST_RUN_POLICY_TEMPLATE_VERSION = 7;
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
function buildTemplate(input: FirstRunPolicyTemplateInput, version: 4 | 5 | 6 | 7) {
  const scopeId = identitySchema.parse(input.scopeId);
  const principal = { issuer: identitySchema.parse(input.principal.issuer), subject: identitySchema.parse(input.principal.subject) };
  const revision = `${FIRST_RUN_POLICY_TEMPLATE_ID}-v${version}`;
  const actionsOf = { 'agent-tool': ['invoke'], operation: ['execute'], secret: ['set', 'delete'], 'secret-switch': ['switch'], 'provider-spend-account': [...PROVIDER_SPEND_ACCOUNT_ACTIONS], config: ['write'], 'mcp-server': ['invoke'], approval: ['inspect', 'decide'],
    'model-activation': [...MODEL_ACTIVATION_ACTIONS], 'model-invocation': [...MODEL_INVOCATION_ACTIONS] } as const;
  const grant = (id: string, effect: 'allow' | 'require-approval', kind: keyof typeof actionsOf, ids: readonly string[] | 'all', modeEligible?: boolean) =>
    Object.freeze({ id, effect, actions: [...actionsOf[kind]], scopes: [scopeId], principals: [principal],
      resource: { kind: kind === 'secret-switch' ? 'secret' : kind, ids: ids === 'all' ? ids : [...ids] }, ...(modeEligible === undefined ? {} : { modeEligible }) });
  const v5 = version >= 5, v6 = version >= 6, v7 = version >= 7;
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
    ],
  });
  const bindings = bindingsFileSchema.parse({ schemaVersion: 1, revision: `${revision}-bindings`, bindings: [] });
  return { policy, bindings };
}

/** Why an installation's policy cannot take the v4 → v5 upgrade in place: it already is v5, it is not exactly the v4 template this
 * installation's (scope, person) would get (hand-edited, administered since, another person's, or another version), or it is unreadable. */
export type FirstRunTemplateUpgrade = { readonly status: 'upgrade'; readonly from: 4 | 5 | 6; readonly policy: PolicyFile }
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
  // v6: an exact v4 or v5 template (never touched since) is replaced by the current one; anything else takes the explicit additions.
  for (const from of [6, 5, 4] as const) {
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

/** The v5 rule ids an upgrade adds (never replaces: the proposal tool gets its own rule so a hand-edited read rule stays as it is). */
export const FIRST_RUN_UPGRADE_RULE_IDS = Object.freeze({ servers: 'first-run-mcp-servers', operation: 'first-run-mcp-call-operation', propose: 'first-run-mcp-propose-tool',
  administer: 'first-run-policy-administer', approvals: 'first-run-approvals', secretSwitch: 'first-run-secret-switch',
  modelActivation: 'first-run-model-activation', modelInvocation: 'first-run-model-invocation', spending: 'first-run-provider-spending' });
/** v7 actions (K3): activation and its read; the model call and everything a terminal turn needs around it (inspect, content, cancel). */
const MODEL_ACTIVATION_ACTIONS = ['activate', 'inspect'] as const;
const MODEL_INVOCATION_ACTIONS = ['invoke', 'inspect', 'inspect-content', 'cancel-invocation'] as const;
/** v7 actions (SPEND-SETTLEMENT): read, audit and the two governed management commands (held reconcile, budget revision). */
const PROVIDER_SPEND_ACCOUNT_ACTIONS = ['inspect', 'audit', 'reconcile', 'budget-revision'] as const;
export type FirstRunTemplateAdditions = { readonly status: 'plan'; readonly change: PolicyChange; readonly rules: readonly PolicyGrant[]; readonly conflicts: readonly string[] }
  | { readonly status: 'current'; readonly conflicts: readonly string[] } | { readonly status: 'unavailable'; readonly reason: 'not-first-run' | 'not-this-person' | 'invalid' };
type Selection = 'all' | readonly string[];
const coversAll = (held: Selection, wanted: Selection) => held === 'all' || (wanted !== 'all' && wanted.every(item => held.includes(item)));
const sameRule = (a: unknown, b: unknown) => JSON.stringify(policyGrantSchema.parse(a)) === JSON.stringify(policyGrantSchema.parse(b));
type Person = { readonly issuer: string; readonly subject: string };
type AdditionNames = { readonly proposeMcpToolName: string; readonly mcpCallOperationId: string; readonly policyAdministerOperationId: string };
/** Whether a rule NAMES this person: a rule for `all` principals names nobody (security, lead 2026-10-07: never proof of an owner). */
const namesPerson = (grant: PolicyGrant, person: Person) => grant.principals !== 'all' && grant.principals.some(item => item.issuer === person.issuer && item.subject === person.subject);
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
  if (!namesPerson(read, person)) return Object.freeze({ status: 'unavailable', reason: 'not-this-person' });
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
    rule(ids.spending, 'provider-spend-account', PROVIDER_SPEND_ACCOUNT_ACTIONS, 'all', scopes)];
  const conflicts: string[] = [], rules: PolicyGrant[] = [];
  for (const want of wanted) {
    const same = grants.find(grant => grant.id === want.id);
    if (same) { if (!sameRule(same, want)) conflicts.push(want.id); continue; }
    const covered = grants.some(grant => grant.effect === 'allow' && mine(grant) && grant.resource.kind === want.resource.kind && coversAll(grant.actions, want.actions)
      && coversAll(grant.resource.ids, want.resource.ids) && coversAll(grant.scopes, want.scopes));
    if (!covered) rules.push(want);
  }
  if (!rules.length) return Object.freeze({ status: 'current' as const, conflicts: Object.freeze(conflicts) });
  return Object.freeze({ status: 'plan' as const, rules: Object.freeze(rules), conflicts: Object.freeze(conflicts),
    change: policyChangeSchema.parse({ schemaVersion: 1, changes: rules.map(grant => ({ kind: 'grant.add', grant })) }) });
}

/** An allow rule that names this person explicitly in exactly this scope (its scopes list it; `all` scopes or `all` principals never count). */
const anchorsPerson = (grant: PolicyGrant, person: Person, scopeId: string) => grant.effect === 'allow' && namesPerson(grant, person)
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
  if (!parsed.data.grants.some(grant => anchorsPerson(grant, who, scopeId.data))) return Object.freeze({ status: 'unavailable', reason: 'person-not-named' });
  return plannedAdditions(parsed.data.grants, who, [scopeId.data], input);
}
