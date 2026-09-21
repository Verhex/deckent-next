import { verifiedPrincipalSchema, verifiedSessionSchema, type VerifiedPrincipal, type VerifiedSession } from '#domain/index.js';
import type { TrustedClock } from '#platform/index.js';
import { AuthenticationError } from './verify.js';

/** Implementations own live evidence and revocation, not client-authored session objects. */
export interface SessionAuthority {
  isSessionActive(session: VerifiedSession): Promise<boolean>;
  revoke(sessionId: string): Promise<void>;
}
export interface SessionVerifier {
  verifySession(credential: unknown): Promise<Readonly<{ principal: unknown; session: unknown }>>;
}
export interface AuthenticatedSession { readonly principal: VerifiedPrincipal; readonly session: VerifiedSession }
export class SessionAuthenticationError extends Error {
  constructor(readonly code: 'SESSION_REQUIRED' | 'SESSION_EXPIRED' | 'SESSION_INACTIVE') { super(code); this.name = 'SessionAuthenticationError'; }
}
function checkTime(session: VerifiedSession, clock: TrustedClock) {
  const now = clock.sample();
  if (!Number.isSafeInteger(now.wallMs) || !Number.isFinite(now.monotonicMs) || now.monotonicMs < 0
    || session.authenticatedAt > now.wallMs || now.wallMs >= session.expiresAt) throw new SessionAuthenticationError('SESSION_EXPIRED');
}
/** Repeat immediately before the protected transition, after policy or interactive work awaits. */
export async function assertSessionActive(session: VerifiedSession, authority: SessionAuthority, clock: TrustedClock): Promise<void> {
  checkTime(session, clock);
  if (!await authority.isSessionActive(session)) throw new SessionAuthenticationError('SESSION_INACTIVE');
  checkTime(session, clock);
}
export async function authenticateSession(verifier: SessionVerifier, authority: SessionAuthority,
  clock: TrustedClock, credential: unknown, scopeId: string): Promise<AuthenticatedSession> {
  let principal: VerifiedPrincipal; let session: VerifiedSession;
  try {
    const evidence = await verifier.verifySession(credential);
    principal = verifiedPrincipalSchema.parse(evidence.principal); session = verifiedSessionSchema.parse(evidence.session);
  } catch { throw new SessionAuthenticationError('SESSION_REQUIRED'); }
  if (session.kind !== principal.assurance || ['id', 'issuer', 'subject'].some(key =>
    principal[key as 'id' | 'issuer' | 'subject'] !== session.principalRef[key as 'id' | 'issuer' | 'subject'])) throw new SessionAuthenticationError('SESSION_REQUIRED');
  if (!principal.scopeIds.includes(scopeId) || !session.scopeIds.includes(scopeId)) throw new AuthenticationError('AUTHENTICATION_SCOPE_DENIED');
  await assertSessionActive(session, authority, clock);
  return Object.freeze({ principal, session });
}
