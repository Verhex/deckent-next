import { resolvedMcpCapabilityRules, ownedMcpCapabilityRules } from '#engine/core/policy/index.js';
import { authorityDocuments, delegationWithin, encodeCommandProjection, evaluatePolicy, isMcpPrincipal, mcpCapabilityGroupSchema, mcpPrincipalRef, planPolicyChange, POLICY_CHANGE_MAX, policySchema,
  RegistryError, sameMcpCapabilityRule, type McpCapabilityGroup, type McpCapabilityGroupInput, type McpCapabilityState, type McpCapabilityPreview, type McpCapabilityRequest, type McpCapabilityView, type PolicyGrant, type VerifiedPrincipal } from '#domain/index.js';
import { sha256 } from '#platform/index.js';
import catalog from './mcp-capabilities.json' with { type: 'json' };
import { administerOwnPolicyChange, type PersistentStandingDependencies } from './standing.js';

/** Add-only, versioned catalog. Enterprise/custom distributions register dotted ids before composeCore seals; registration grants nothing. */
export class McpCapabilityRegistry {
  private readonly groups = new Map<string, McpCapabilityGroup>();
  private sealed = false;
  constructor(core: readonly unknown[]) { for (const input of core) this.admit(input, true); }
  private admit(input: unknown, core: boolean) {
    const parsed = mcpCapabilityGroupSchema.safeParse(input);
    if (!parsed.success) throw new RegistryError('REGISTRY_MANIFEST_INVALID');
    const group = parsed.data;
    if (core === group.id.includes('.')) throw new RegistryError('REGISTRY_NAMESPACE_RESERVED');
    if (this.groups.has(group.id)) throw new RegistryError('REGISTRY_ADAPTER_DUPLICATE');
    this.groups.set(group.id, group);
  }
  register(input: unknown): void { if (this.sealed) throw new RegistryError('REGISTRY_SEALED'); this.admit(input, false); }
  seal(): void { this.sealed = true; }
  list(): readonly McpCapabilityGroup[] { return Object.freeze([...this.groups.values()]); }
  get(id: string): McpCapabilityGroup { const group = this.groups.get(id); if (!group) throw new Error('MCP_CAPABILITY_GROUP_UNKNOWN'); return group; }
}
export const mcpCapabilityRegistry = new McpCapabilityRegistry(catalog.groups);
export function registerMcpCapabilityGroup(group: McpCapabilityGroupInput): void { mcpCapabilityRegistry.register(group); }

/** Shared CLI/SDK/terminal application. Only policy.administer owns effects; digest binds the current snapshot, catalog and exact changes. */
export class McpCapabilities {
  constructor(private readonly deps: Pick<PersistentStandingDependencies, 'administration' | 'approve' | 'policy'>,
    private readonly registry: McpCapabilityRegistry = mcpCapabilityRegistry, private readonly workTargetId: string | null = null, private readonly optInGroups: readonly string[] = [], private readonly operationIds: readonly string[] = []) {}
  private async snapshot(principal: VerifiedPrincipal, scopeId: string) {
    if (isMcpPrincipal(principal)) throw new Error('MCP_CAPABILITY_OWNER_REQUIRED');
    if (!principal.scopeIds.includes(scopeId)) throw new Error('MCP_CAPABILITY_SCOPE_UNKNOWN');
    const policy = policySchema.parse(await this.deps.policy.load());
    if (policy.schemaVersion !== 2) throw new Error('MCP_CAPABILITY_UNSUPPORTED');
    return policy;
  }
  async inspect(scopeId: string, principal: VerifiedPrincipal): Promise<McpCapabilityView> {
    const policy = await this.snapshot(principal, scopeId), actor = { ...principal, ...mcpPrincipalRef(principal) };
    return { schemaVersion: 1, scopeId, revision: policy.revision, principal: mcpPrincipalRef(principal), groups: this.registry.list().map<McpCapabilityState>(group => {
      const rules = resolvedMcpCapabilityRules(group, scopeId, principal, policy, this.workTargetId, this.operationIds), owned = ownedMcpCapabilityRules(group, scopeId, principal, policy, rules);
      const count = rules.filter(rule => owned.held.some(held => sameMcpCapabilityRule(held, rule))).length;
      const managed = owned.conflict ? 'conflict' : owned.earlier ? 'wider-earlier' : rules.length && count === rules.length ? 'granted' : count ? 'partial' : 'none';
      const allowed = rules.filter(rule => delegationWithin(policy, actor, [rule]).ok).length;
      return { group, managed, effective: rules.length && allowed === rules.length ? 'allowed' : allowed ? 'partial' : 'denied' };
    }).filter(state => state.group.availability === 'default' || state.managed !== 'none' || this.optInGroups.includes(state.group.id)) };
  }
  async run(input: McpCapabilityRequest, principal: VerifiedPrincipal, reason: string): Promise<McpCapabilityPreview> {
    const group = this.registry.get(input.groupId), policy = await this.snapshot(principal, input.scopeId);
    if (!['grant', 'revoke', 'narrow'].includes(input.action) || !['preview', 'apply'].includes(input.mode)) throw new Error('MCP_CAPABILITY_INVALID');
    const current = resolvedMcpCapabilityRules(group, input.scopeId, principal, policy, this.workTargetId, this.operationIds), owned = ownedMcpCapabilityRules(group, input.scopeId, principal, policy, current);
    const conflict = owned.conflict || (input.action === 'grant' && owned.earlier);
    const removed = input.action === 'revoke' ? owned.held : input.action === 'narrow'
      ? owned.held.filter(held => !current.some(want => sameMcpCapabilityRule(held, want))) : [];
    const added = input.action === 'revoke' ? [] : current.filter(want => !owned.held.some(held => sameMcpCapabilityRule(held, want)));
    const changes = [...removed.map(rule => ({ kind: 'grant.remove' as const, id: rule.id })), ...added.map(grant => ({ kind: 'grant.add' as const, grant }))];
    const remaining = Math.max(0, changes.length - POLICY_CHANGE_MAX);
    const bounded = changes.slice(0, POLICY_CHANGE_MAX);
    const rules: PolicyGrant[] = bounded.map(change => change.kind === 'grant.add' ? change.grant : removed.find(rule => rule.id === change.id)!);
    const change = bounded.length ? { schemaVersion: 1 as const, changes: bounded } : null;
    const digest = sha256(encodeCommandProjection('mcp-capability-preview:1', { schemaVersion: 1, revision: policy.revision, scopeId: input.scopeId, action: input.action, group,
      principal: mcpPrincipalRef(principal), rules, change }));
    const missing: string[] = [];
    if (change && !conflict) {
      const files = authorityDocuments(policy), touched = planPolicyChange(files.policy, files.bindings, change).touched;
      if (evaluatePolicy(policy, { principal, scopeId: input.scopeId, action: 'execute', resource: { kind: 'operation', id: 'policy.administer' } }).decision === 'deny') missing.push('policy-administer');
      if (evaluatePolicy(policy, { principal, scopeId: input.scopeId, action: 'decide', resource: { kind: 'approval', id: 'policy-mcp-capability' } }).decision !== 'allow') missing.push('approval-decide');
      if (!delegationWithin(policy, principal, touched).ok) missing.push('delegation');
    }
    const result = (status: McpCapabilityPreview['status']): McpCapabilityPreview => ({ schemaVersion: 1, status, revision: policy.revision, digest,
      scopeId: input.scopeId, groupId: input.groupId, action: input.action, principal: mcpPrincipalRef(principal), rules, change, missing, remaining });
    if (conflict || (input.mode === 'apply' && input.expect !== digest)) return result('conflict');
    if (!change) return result('current');
    if (input.mode === 'preview') return result('preview');
    if (missing.length) return result('refused');
    await administerOwnPolicyChange(this.deps, { scopeId: input.scopeId, principal, change, tag: digest, revision: policy.revision, reason, kind: 'policy-mcp-capability' });
    return result('applied');
  }
}
