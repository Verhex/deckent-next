import { isAiPrincipal } from '#domain/core/principal/index.js';
/**
 * Approval cards whose decision widens authority: identity profile distribution, MCP capability grants and the first-run template
 * upgrade/rollback (each also needs `policy.administer`, floored below; deciding the card is a second, independent route).
 */
const AUTHORITY_APPROVAL_IDS = Object.freeze(['identity-profile', 'policy-mcp-capability', 'policy-template-upgrade', 'audit-rebaseline']);
/**
 * Y4 v1: security invariants, never policy-grant data. Read-only metadata stays available. Every route that can widen an AI actor's own
 * (or a controlled principal's) authority is here: policy administration (grants, role bindings, delegation cells, restrictions, SoD,
 * standing grants), authority/authenticator/assurance records, permission modes incl. full access, backup restore, every secret action,
 * authority approval cards, audit baselines and security configuration (incl. `execution.secretGate` exclusions). Owner 2026-10-19 (I-POL v13):
 * host changes outside the sandbox — installing an execution environment (Docker group membership is root-equivalent) and repairing the
 * installation itself — are never an AI's, whatever a policy grants; the person runs them at a terminal. S4: memory verify/retire likewise.
 */
export function aiAuthorityFloor(actor: { readonly issuer: string; readonly assurance?: string }, resource: { readonly kind: string; readonly id: string }, action: string): boolean {
  if (!isAiPrincipal(actor)) return false;
  if (resource.kind === 'operation' && resource.id === 'policy.administer' && ['execute', 'compensate'].includes(action)) return true;
  if (['authority-document', 'authenticator', 'approval-assurance'].includes(resource.kind) && !['inspect', 'list'].includes(action)) return true;
  if (resource.kind === 'backup' && action === 'restore') return true;
  if (resource.kind === 'execution-environment' && action === 'install' || resource.kind === 'installation' && action === 'repair') return true;
  if (resource.kind === 'permission-mode' && action === 'set') return true;
  // S4 (law-audit fold 6, lead 2026-10-23): verified memory needs a human or an independent evaluation record, never the AI itself; retiring is the
  // same knowledge change. Proposing a candidate and every read stay policy decisions.
  if (resource.kind === 'memory' && ['verify', 'retire'].includes(action)) return true;
  if (resource.kind === 'secret') return true;
  if (resource.kind === 'approval' && action === 'decide' && AUTHORITY_APPROVAL_IDS.includes(resource.id)) return true;
  if (resource.kind === 'audit' && !['inspect', 'verify'].includes(action)) return true;
  if (resource.kind === 'agent-tool-call' && ['edit-authority', 'edit-floor'].includes(resource.id)) return true;
  // S5b (Auditor owner decision 6): a safety hold (Nervous pause, Auditor park; any source but the public `operator` control) is a person's to lift.
  if (resource.kind === 'run-hold' && action === 'resume' && resource.id !== 'operator') return true;
  if (resource.kind === 'config' && action === 'write') return protectedConfigKey(resource.id.slice(resource.id.indexOf(':') + 1));
  return false;
}
/**
 * Config subtrees that set a security boundary (REVIEW2561 R1: the real keys, not look-alikes): authority, identity, storage, service and
 * paths; the whole `execution` tree (Docker isolation, `secretGate` exclusions, work targets); admission and operation registries; audit
 * monitoring; the agent shell's realm and environment pass-through; the agent fetch egress and host allowlist. A key is protected when it
 * is one of these, lies inside one, or is an ancestor whose whole-object write would replace one (`terminal`, `terminal.shell`, ...).
 */
const PROTECTED_CONFIG_PATHS = Object.freeze(['policy', 'approvals', 'identity', 'security', 'storage', 'service', 'paths', 'shell', 'network', 'layout', 'execution',
  'installation', 'company', 'enforce_principal_assurance', 'secrets', 'admission', 'operations', 'audit',
  'terminal.shell.realm', 'terminal.shell.environment', 'terminal.fetch.egress', 'terminal.fetch.allowedHosts']);
export function protectedConfigKey(keyPath: string): boolean {
  const key = keyPath.replace(/\[[^\]]*\]/gu, '.0').replace(/\.+$/u, '');
  return PROTECTED_CONFIG_PATHS.some(root => key === root || key.startsWith(`${root}.`) || root.startsWith(`${key}.`)) || key === '';
}
