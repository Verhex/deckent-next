import { z } from 'zod';
import { identitySchema } from '#domain/core/primitives/index.js';
import { policyResources } from './vocabulary.js';

/** Decision-step inventory, shared with operator surfaces and the floor report. Inclusion grants nothing. */
const steps = Object.freeze([
  ...policyResources.runDecision.actions.map(action => Object.freeze({ id: `run-${action}`, kind: policyResources.runDecision.kind, action })),
  ...policyResources.taskDecision.actions.map(action => Object.freeze({ id: `task-${action}`, kind: policyResources.taskDecision.kind, action })),
  Object.freeze({ id: 'approval-decide', kind: policyResources.approval.kind, action: 'decide' }),
]);
export const getDecisionSteps = () => steps;
export type DecisionStep = typeof steps[number];
const queryFields = z.object({ schemaVersion: z.literal(1), scopeId: identitySchema,
  actor: z.literal('mcp').default('mcp'), resourceId: identitySchema.optional() }).strict();
export const delegationQuerySchema = queryFields.readonly();
export const delegationCommandSchema = queryFields.extend({ step: identitySchema, action: z.enum(['grant', 'revoke']), expectedRevision: identitySchema }).strict().readonly();
export type DelegationQuery = z.input<typeof delegationQuerySchema>;
export type DelegationCommand = z.input<typeof delegationCommandSchema>;
export interface DecisionDelegationView {
  readonly schemaVersion: 1; readonly scopeId: string; readonly revision: string; readonly resourceId: string | null;
  readonly principal: { readonly issuer: string; readonly subject: string };
  readonly steps: readonly { readonly step: DecisionStep; readonly managed: 'none' | 'granted' | 'conflict'; readonly effective: 'allowed' | 'denied' }[];
}

export class DecisionDelegationError extends Error {
  constructor(readonly code: 'AI_AUTHORITY_NON_DELEGABLE' | 'APPROVAL_INTERACTIVE_REQUIRED' | 'POLICY_DELEGATION_STEP_INVALID' | 'POLICY_DELEGATION_CONFLICT' | 'POLICY_DENIED') { super(code); }
}
