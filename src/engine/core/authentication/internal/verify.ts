import { verifiedPrincipalSchema, type VerifiedPrincipal } from '#domain/index.js';

/** Composition installs a trusted verifier appropriate to this transport. Credentials never enter receipts. */
export interface PrincipalVerifier { verify(credential: unknown): Promise<unknown> }
export class AuthenticationError extends Error {
  constructor(readonly code: 'AUTHENTICATION_REQUIRED' | 'AUTHENTICATION_SCOPE_DENIED') { super(code); this.name = 'AuthenticationError'; }
}
export async function authenticate(verifier: PrincipalVerifier, credential: unknown, scopeId: string): Promise<VerifiedPrincipal> {
  let principal: VerifiedPrincipal;
  try { principal = verifiedPrincipalSchema.parse(await verifier.verify(credential)); }
  catch { throw new AuthenticationError('AUTHENTICATION_REQUIRED'); }
  if (!principal.scopeIds.includes(scopeId)) throw new AuthenticationError('AUTHENTICATION_SCOPE_DENIED');
  return principal;
}
