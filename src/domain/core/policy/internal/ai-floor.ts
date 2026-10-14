import { isAiPrincipal } from '#domain/core/principal/index.js';
/**
 * Approval cards whose decision widens authority: identity profile distribution, MCP capability grants and the first-run template
 * upgrade/rollback (each also needs `policy.administer`, floored below; deciding the card is a second, independent route).
 */
const AUTHORITY_APPROVAL_IDS = Object.freeze(['identity-profile', 'policy-mcp-capability', 'policy-template-upgrade']);
/**
 * Y4 v1: security invariants, never policy-grant data. Read-only metadata stays available. Every route that can widen an AI actor's own
 * (or a controlled principal's) authority is here: policy administration (grants, role bindings, delegation cells, restrictions, SoD,
 * standing grants), authority/authenticator/assurance records, permission modes incl. full access, backup restore, every secret action,
 * authority approval cards, audit baselines and security configuration (incl. `execution.secretGate` exclusions).
 */
export function aiAuthorityFloor(actor: { readonly issuer: string; readonly assurance?: string }, resource: { readonly kind: string; readonly id: string }, action: string): boolean {
  if (!isAiPrincipal(actor)) return false;
  if (resource.kind === 'operation' && resource.id === 'policy.administer' && ['execute', 'compensate'].includes(action)) return true;
  if (['authority-document', 'authenticator', 'approval-assurance'].includes(resource.kind) && !['inspect', 'list'].includes(action)) return true;
  if (resource.kind === 'backup' && action === 'restore') return true;
  if (resource.kind === 'permission-mode' && action === 'set') return true;
  if (resource.kind === 'secret') return true;
  if (resource.kind === 'approval' && action === 'decide' && AUTHORITY_APPROVAL_IDS.includes(resource.id)) return true;
  if (resource.kind === 'audit' && !['inspect', 'verify'].includes(action)) return true;
  if (resource.kind === 'agent-tool-call' && ['edit-authority', 'edit-floor'].includes(resource.id)) return true;
  if (resource.kind === 'config' && action === 'write') {
    const key = resource.id.slice(resource.id.indexOf(':') + 1);
    return /^(?:policy|approvals|identity|security|storage|service|paths|shell|network|layout|execution|installation|company|enforce_principal_assurance|secrets)(?:\.|$)/u.test(key);
  }
  return false;
}
