import { z } from 'zod';
import { identitySchema } from '#domain/core/primitives/index.js';

/** A verifier result, never an accepted client-authored identity claim. */
export const verifiedPrincipalSchema = z.object({
  id: identitySchema, issuer: identitySchema, subject: identitySchema,
  assurance: z.enum(['os-user', 'token-verified', 'workload-verified']),
  scopeIds: z.array(identitySchema).min(1).readonly(),
}).strict().readonly();
export type VerifiedPrincipal = z.infer<typeof verifiedPrincipalSchema>;

/** MCP is a separate local actor, never an alias for the terminal owner. */
export const mcpPrincipalRef = (owner: { readonly issuer: string; readonly subject: string }) =>
  Object.freeze({ issuer: identitySchema.parse(`${owner.issuer}/mcp`), subject: identitySchema.parse(owner.subject) });
export const isMcpPrincipal = (actor: { readonly issuer: string }) => actor.issuer.endsWith('/mcp');
