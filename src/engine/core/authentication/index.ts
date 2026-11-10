export { authenticate, verifiedPrincipal, AuthenticationError } from './internal/verify.js';
export type { PrincipalVerifier } from './internal/verify.js';
export { authenticateSession, assertSessionActive, SessionAuthenticationError } from './internal/session.js';
export type { SessionAuthority, SessionVerifier, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ AuthenticatedSession } from './internal/session.js';
export { ApprovalAssuranceRegistry, DecisionCapabilityRing, DECISION_CAPABILITY_PATTERN } from './internal/assurance.js';
export type { ApprovalAssuranceEvidence, ApprovalAssuranceProducer, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ DerivedApprovalAssurance } from './internal/assurance.js';
