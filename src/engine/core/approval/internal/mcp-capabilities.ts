import { authorityDocuments, delegationWithin, encodeCommandProjection, evaluatePolicy, isMcpPrincipal, mcpCapabilityGroupSchema, mcpCapabilityRules, mcpPrincipalRef, planPolicyChange, policyDeclaredScopes, policySchema, principalGrants,
  RegistryError, sameMcpCapabilityRule, type McpCapabilityGroup, type McpCapabilityPreview, type McpCapabilityRequest, type McpCapabilityView, type PolicyGrant, type VerifiedPrincipal } from '#domain/index.js';
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
export function registerMcpCapabilityGroup(group: McpCapabilityGroup): void { mcpCapabilityRegistry.register(group); }
export function mcpCapabilityScopeCandidates(document: unknown, actor: { readonly issuer: string; readonly subject: string }): readonly string[] {
  if (isMcpPrincipal(actor)) throw new Error('MCP_CAPABILITY_OWNER_REQUIRED');
  return policyDeclaredScopes(document);
}

/** Shared CLI/SDK/terminal application. Only policy.administer owns effects; digest binds the current snapshot, catalog and exact changes. */
export class McpCapabilities {
  constructor(private readonly deps: Pick<PersistentStandingDependencies, 'administration' | 'approve' | 'policy'>,
    private readonly registry: McpCapabilityRegistry = mcpCapabilityRegistry, private readonly workTargetId: string | null = null) {}
  private rules(group: McpCapabilityGroup, scopeId: string, principal: VerifiedPrincipal, policy: ReturnType<typeof policySchema.parse>) {
    const actor = mcpPrincipalRef(principal);
    const namespace = sha256(encodeCommandProjection('mcp-capability-id:1', { group: group.id, scopeId, actor })).slice(0, 20);
    const cells = group.cells.flatMap(cell => {
      if (cell.source === 'configured-target') return this.workTargetId ? [{ ...cell, resource: { ...cell.resource, ids: [this.workTargetId] } }] : [];
      if (cell.source !== 'owned-pools') return [cell];
      const grants = principalGrants(policy, principal).filter(rule => rule.effect === 'allow' && rule.resource.kind === cell.resource.kind
        && (rule.principals === 'all' || rule.principals.some(person => person.issuer === principal.issuer && person.subject === principal.subject))
        && (rule.scopes === 'all' || rule.scopes.includes(scopeId)) && cell.actions.every(action => rule.actions === 'all' || rule.actions.includes(action)));
      const ids = grants.some(rule => rule.resource.ids === 'all') ? 'all' as const : [...new Set(grants.flatMap(rule => rule.resource.ids === 'all' ? [] : rule.resource.ids))].sort();
      // No held pool authority: keep the required cell visible and let I2 refuse, rather than pretend the group works.
      return [{ ...cell, resource: { ...cell.resource, ids: ids.length ? ids : 'all' as const } }];
    });
    return mcpCapabilityRules({ ...group, cells }, scopeId, actor, namespace);
  }
  private async snapshot(principal: VerifiedPrincipal, scopeId: string) {
    if (isMcpPrincipal(principal)) throw new Error('MCP_CAPABILITY_OWNER_REQUIRED');
    if (!principal.scopeIds.includes(scopeId)) throw new Error('MCP_CAPABILITY_SCOPE_UNKNOWN');
    const policy = policySchema.parse(await this.deps.policy.load());
    if (policy.schemaVersion !== 2) throw new Error('MCP_CAPABILITY_UNSUPPORTED');
    return policy;
  }
  async inspect(scopeId: string, principal: VerifiedPrincipal): Promise<McpCapabilityView> {
    const policy = await this.snapshot(principal, scopeId), actor = { ...principal, ...mcpPrincipalRef(principal) };
    return { schemaVersion: 1, scopeId, revision: policy.revision, principal: mcpPrincipalRef(principal), groups: this.registry.list().map(group => {
      const rules = this.rules(group, scopeId, principal, policy), held = rules.map(rule => policy.grants.find(grant => grant.id === rule.id));
      const conflict = held.some((grant, index) => grant !== undefined && !sameMcpCapabilityRule(grant, rules[index]!));
      const managed = conflict ? 'conflict' : held.every(Boolean) ? 'granted' : held.some(Boolean) ? 'partial' : 'none';
      const allowed = rules.filter(rule => delegationWithin(policy, actor, [rule]).ok).length;
      return { group, managed, effective: allowed === rules.length ? 'allowed' : allowed ? 'partial' : 'denied' };
    }) };
  }
  async run(input: McpCapabilityRequest, principal: VerifiedPrincipal, reason: string): Promise<McpCapabilityPreview> {
    // Choices are validated before an administration or approval is opened.
    const group = this.registry.get(input.groupId), policy = await this.snapshot(principal, input.scopeId);
    if (!['grant', 'revoke'].includes(input.action) || !['preview', 'apply'].includes(input.mode)) throw new Error('MCP_CAPABILITY_INVALID');
    const current = this.rules(group, input.scopeId, principal, policy);
    // Revoke also finds an earlier configured target/pool selection. Its original exact rules are previewed, never reconstructed as new ids.
    const actor = mcpPrincipalRef(principal), namespace = sha256(encodeCommandProjection('mcp-capability-id:1', { group: group.id, scopeId: input.scopeId, actor })).slice(0, 20);
    const expected = input.action === 'revoke' ? mcpCapabilityRules(group, input.scopeId, actor, namespace) : current, rules: PolicyGrant[] = [];
    let conflict = false;
    const literal = mcpCapabilityRules(group, input.scopeId, actor, namespace);
    for (const rule of expected) {
      const held = policy.grants.find(grant => grant.id === rule.id);
      const cell = group.cells[literal.findIndex(candidate => candidate.id === rule.id)]!;
      const comparable = input.action === 'revoke' && cell.source !== 'literal' && held ? { ...rule, resource: { ...rule.resource, ids: held.resource.ids } } : rule;
      if (held && !sameMcpCapabilityRule(held, comparable)) conflict = true;
      if (input.action === 'grant' ? !held : held) rules.push(input.action === 'grant' ? rule : held!);
    }
    const change = rules.length ? { schemaVersion: 1 as const, changes: rules.map(rule => input.action === 'grant'
      ? { kind: 'grant.add' as const, grant: rule } : { kind: 'grant.remove' as const, id: rule.id }) } : null;
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
      scopeId: input.scopeId, groupId: input.groupId, action: input.action, principal: mcpPrincipalRef(principal), rules, change, missing });
    if (conflict || (input.mode === 'apply' && input.expect !== digest)) return result('conflict');
    if (!change) return result('current');
    if (input.mode === 'preview') return result('preview');
    if (missing.length) return result('refused');
    await administerOwnPolicyChange(this.deps, { scopeId: input.scopeId, principal, change, tag: digest, revision: policy.revision, reason, kind: 'policy-mcp-capability' });
    return result('applied');
  }
}
