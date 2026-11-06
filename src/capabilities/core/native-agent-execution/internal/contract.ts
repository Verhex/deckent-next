import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { persistedString, counterSchema, delegatedUseConsentSchema, identitySchema } from '#domain/index.js';

const path = persistedString(z.string().min(1).max(4096)).refine(value => isAbsolute(value) && !value.includes('\0') && !/\/\.\.?(?:\/|$)/u.test(value));
/**
 * The sealed adapter definition (written by the connect path, S3-3): the executable's realpath, the person's uid and CLI config directory,
 * this connection's private state directory (run dir `<stateDir>/run`, preflight record), the catalog row's minimum CLI version, and the
 * delegated-use consent (enforced by S3-3; recorded here so the profile digest seals it). Deckent never reads credential/config contents;
 * the realm may privately copy bounded non-credential state named by the registry.
 */
export const nativeCliHeadlessDefinitionSchema = z.strictObject({ schemaVersion: z.literal(1), executable: path, configDir: path, stateDir: path,
  ownerUid: counterSchema, minCliVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  delegatedUse: delegatedUseConsentSchema.nullable(),
  sourceBinding: z.strictObject({ schemaVersion: z.literal(1), installationId: identitySchema, companyId: identitySchema, scopeId: identitySchema,
    principal: z.strictObject({ issuer: identitySchema, subject: identitySchema }).readonly(),
  }).readonly().optional(),
}).readonly();
export type NativeCliHeadlessDefinition = z.infer<typeof nativeCliHeadlessDefinitionSchema>;
/** A separate v1 capability, not consent or a grant. Issued only after the agent profile and actual CLI surface are verified. */
export const nativeAgentExecutionSchema = z.strictObject({ schemaVersion: z.literal(1), capability: z.literal('NativeAgentExecution'),
  executable: path, cliVersion: z.string().regex(/^\d+\.\d+\.\d+$/u), flagSetDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  profileDigest: z.string().regex(/^[a-f0-9]{64}$/u), ownerUid: counterSchema,
}).readonly();
export type NativeAgentExecution = z.infer<typeof nativeAgentExecutionSchema>;
/** Read-only readiness never admits work. A missing observation stays unknown; no automatic A/B or model substitution. */
export const nativeAgentReadinessReasonSchema = z.enum(['NATIVE_AGENT_CLI_UNAVAILABLE', 'NATIVE_AGENT_LOGIN_REQUIRED', 'NATIVE_AGENT_CAPABILITY_UNSEALED',
  'NATIVE_AGENT_TOOL_SURFACE_UNEXPECTED', 'NATIVE_AGENT_PLUGIN_UNEXPECTED', 'NATIVE_AGENT_BRIDGE_UNAVAILABLE', 'NATIVE_AGENT_ENVIRONMENT_REFUSED']);
export type NativeAgentReadinessReason = z.infer<typeof nativeAgentReadinessReasonSchema>;
export const nativeAgentReadinessSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('ready'), execution: nativeAgentExecutionSchema }).readonly(),
  z.strictObject({ state: z.enum(['unavailable', 'unknown']), reason: nativeAgentReadinessReasonSchema }).readonly(),
]);
export type NativeAgentReadiness = z.infer<typeof nativeAgentReadinessSchema>;
