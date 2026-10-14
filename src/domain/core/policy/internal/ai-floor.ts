import { isAiPrincipal } from '#domain/core/principal/index.js';
/** Y4 v1: security invariants, never policy-grant data. Read-only metadata stays available. */
export function aiAuthorityFloor(actor: { readonly issuer: string; readonly assurance?: string }, resource: { readonly kind: string; readonly id: string }, action: string): boolean {
  if (!isAiPrincipal(actor)) return false;
  if (resource.kind === 'operation' && resource.id === 'policy.administer' && ['execute', 'compensate'].includes(action)) return true;
  if (['authority-document', 'authenticator', 'approval-assurance'].includes(resource.kind) && !['inspect', 'list'].includes(action)) return true;
  if (resource.kind === 'backup' && action === 'restore') return true;
  if (resource.kind === 'permission-mode' && action === 'set') return true;
  if (resource.kind === 'secret' && ['read', 'get', 'resolve', 'switch'].includes(action)) return true;
  if (resource.kind === 'agent-tool-call' && ['edit-authority', 'edit-floor'].includes(resource.id)) return true;
  if (resource.kind === 'config' && action === 'write') {
    const key = resource.id.slice(resource.id.indexOf(':') + 1);
    return /^(?:policy|approvals|identity|security|storage|service|paths|shell|network|layout|execution|installation|company|enforce_principal_assurance|secrets)(?:\.|$)/u.test(key);
  }
  return false;
}
