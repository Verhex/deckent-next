import { policySchema, type Policy, type PolicyBinding } from '#domain/core/policy/index.js';
import { encodeIdentityProfile, IdentityProfileError, type IdentityPreviewInput, type IdentityProfileDefinition } from './schema.js';

const invalid = (): never => { throw new IdentityProfileError('IDENTITY_PREVIEW_INVALID'); };
function unique(values: readonly string[]) { if (new Set(values).size !== values.length) invalid(); }
export function validateIdentityDraft(input: IdentityPreviewInput, companyId: string, scopes: readonly string[]) {
  unique(input.members.map(m => m.id)); unique(input.members.map(m => JSON.stringify(m.principal)));
  unique(input.organization.map(n => n.id)); unique(input.assignments.map(a => a.id)); unique(input.removeBindingIds);
  unique(scopes);
  if (!scopes.includes(input.scopeId)) invalid();
  const nodes = new Map(input.organization.map(n => [n.id, n]));
  for (const node of input.organization) {
    const seen = new Set<string>(); let current: typeof node | undefined = node;
    while (current) {
      if (current.companyId !== companyId || seen.has(current.id)) invalid();
      seen.add(current.id);
      if (current.parentId === null) break;
      current = nodes.get(current.parentId); if (!current) invalid();
    }
  }
  for (const member of input.members) if (member.organizationNodeId && !nodes.has(member.organizationNodeId)) invalid();
  for (const assignment of input.assignments) {
    unique(assignment.scopeIds);
    if (assignment.scopeIds.some(scope => !scopes.includes(scope))) throw new IdentityProfileError('IDENTITY_PREVIEW_SCOPE_DENIED');
  }
}

/** Builds only an in-memory hypothetical policy. Nothing returned is an authority document or apply command. */
export function draftIdentityPolicy(input: IdentityPreviewInput, profile: IdentityProfileDefinition, current: Policy, scopes: readonly string[]) {
  if (current.schemaVersion === 1) {
    if (input.assignments.length || input.removeBindingIds.length) throw new IdentityProfileError('IDENTITY_PREVIEW_UNAVAILABLE');
    return { candidate: current, addedBindings: [], removedBindings: [], addedRoles: [] };
  }
  const members = new Map(input.members.map(m => [m.id, m]));
  const roles = new Map(current.roles.map(role => [role.id, role]));
  const templates = new Map(profile.roleTemplates.map(role => [role.id, role]));
  const removedBindings: PolicyBinding[] = [];
  for (const id of input.removeBindingIds) {
    const binding = current.bindings.entries.find(b => b.id === id);
    if (!binding) return invalid();
    if (binding.scopes === 'all' || binding.scopes.some(scope => !scopes.includes(scope))
      || binding.principals.some(p => !input.members.some(m => m.principal.issuer === p.issuer && m.principal.subject === p.subject))) {
      throw new IdentityProfileError('IDENTITY_PREVIEW_SCOPE_DENIED');
    }
    removedBindings.push(binding);
  }
  const existing = current.bindings.entries.filter(b => !input.removeBindingIds.includes(b.id));
  const addedRoles: typeof current.roles[number][] = [];
  const addedBindings = input.assignments.map(assignment => {
    const member = members.get(assignment.memberId); if (!member) return invalid();
    if (existing.some(b => b.id === assignment.id)) throw new IdentityProfileError('IDENTITY_PREVIEW_CONFLICT');
    const template = templates.get(assignment.roleId), prior = roles.get(assignment.roleId);
    if (template && prior && encodeIdentityProfile(template) !== encodeIdentityProfile(prior)) throw new IdentityProfileError('IDENTITY_PREVIEW_CONFLICT');
    if (!prior) {
      if (!template) return invalid();
      roles.set(template.id, template); addedRoles.push(template);
    }
    return Object.freeze({ id: assignment.id, principals: Object.freeze([member.principal]), roles: Object.freeze([assignment.roleId]), scopes: assignment.scopeIds });
  });
  const candidate = policySchema.parse({ ...current, roles: [...roles.values()], bindings: { ...current.bindings, entries: [...existing, ...addedBindings] } });
  return { candidate, addedBindings, removedBindings, addedRoles };
}
