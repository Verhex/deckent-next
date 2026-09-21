export { authenticate, AuthenticationError } from './internal/verify.js';
export type { PrincipalVerifier } from './internal/verify.js';
export { authenticateSession, assertSessionActive, SessionAuthenticationError } from './internal/session.js';
export type { SessionAuthority, SessionVerifier, AuthenticatedSession } from './internal/session.js';
