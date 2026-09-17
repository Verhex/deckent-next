import { userInfo, hostname } from 'node:os';
import { ErrorRegistry } from '#kernel/core/errors/index.js';
export type PrincipalAssurance = 'unverified' | 'os-user' | 'token-parsed' | 'token-verified';
export type PrincipalIdentityClass = 'local' | 'oidc' | 'workload' | 'connector' | 'service';
export interface VerifiedPrincipal {
  readonly id: string;
  readonly identityClass: PrincipalIdentityClass;
  readonly assurance: PrincipalAssurance;
  readonly provenance: string;
  readonly verifiedBy: string;
  readonly tenantId?: string;
  readonly role?: string;
}
export interface ActorContext {
  readonly id: string;
  readonly assurance?: PrincipalAssurance;
  readonly provenance?: string;
  readonly identityClass?: PrincipalIdentityClass;
  readonly tenantId?: string;
  readonly role?: string;
}
export function resolveLocalOsActorId(read: () => { username?: string } = userInfo): string | null {
  try { return read().username || null; } catch { return null; }
}
export function resolveLocalOsPrincipal(provenance: string, options: { user?: () => { username?: string }; host?: () => string; uid?: () => number | undefined } = {}): VerifiedPrincipal {
  const username = resolveLocalOsActorId(options.user);
  const host = (options.host ?? hostname)();
  const uid = (options.uid ?? (() => process.getuid?.()))();
  return { id: username ? `${username}@${host}` : `local-uid-${uid ?? 'unknown'}@${host}`,
    identityClass: 'local', assurance: username ? 'os-user' : 'unverified', provenance,
    verifiedBy: username ? 'os.userInfo' : 'os-user-unavailable' };
}
export function principalToActor(principal: VerifiedPrincipal): ActorContext {
  return { id: principal.id, identityClass: principal.identityClass, assurance: principal.assurance, provenance: principal.provenance, ...(principal.tenantId ? { tenantId: principal.tenantId } : {}), ...(principal.role ? { role: principal.role } : {}) };
}
export function assessActorAssurance(actor: ActorContext): { ok: boolean; code: 'ACTOR_ASSURANCE_OK' | 'ACTOR_ASSURANCE_MISSING' | 'ACTOR_UNVERIFIED' } {
  if (!actor.assurance) return { ok: false, code: 'ACTOR_ASSURANCE_MISSING' };
  if (actor.assurance === 'unverified') return { ok: false, code: 'ACTOR_UNVERIFIED' };
  return { ok: true, code: 'ACTOR_ASSURANCE_OK' };
}
export function assertActorAssurance(actor: ActorContext, _site: string, enforce = false): ReturnType<typeof assessActorAssurance> {
  const finding = assessActorAssurance(actor);
  if (enforce && !finding.ok) throw ErrorRegistry.createError('ACTOR_UNVERIFIED');
  return finding;
}
