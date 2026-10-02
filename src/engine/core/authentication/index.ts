export { authenticate, AuthenticationError } from './internal/verify.js';
export type { PrincipalVerifier } from './internal/verify.js';
export { authenticateSession, assertSessionActive, SessionAuthenticationError } from './internal/session.js';
export type { SessionAuthority, SessionVerifier, AuthenticatedSession } from './internal/session.js';
export { ApprovalAssuranceRegistry, DecisionCapabilityRing, DECISION_CAPABILITY_PATTERN } from './internal/assurance.js';
export type { ApprovalAssuranceEvidence, ApprovalAssuranceProducer, DerivedApprovalAssurance } from './internal/assurance.js';
