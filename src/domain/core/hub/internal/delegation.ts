import { z } from 'zod';
import { HUB_LIMITS } from './registry.js';
import { hubDigestSchema, hubPublicKeySchema, hubSignatureValueSchema, hubTimeSchema } from './fields.js';

/** `hub-key-delegation:1` (S8 §9A): the offline root key (its fingerprint is the pinned `hubId`) delegates an online attestation or feed key for
 * a bounded window. A client accepts an online hub signature only through one of these, signed by the pinned root. */
export const hubKeyDelegationSchema = z.object({ schemaVersion: z.literal(1), hubId: hubDigestSchema, keyId: hubDigestSchema, publicKey: hubPublicKeySchema,
  purposes: z.array(z.enum(['attestation', 'feed'])).min(1).max(2).readonly(), notBefore: hubTimeSchema, notAfter: hubTimeSchema,
  signature: z.object({ keyId: hubDigestSchema, algorithm: z.literal('ed25519'), value: hubSignatureValueSchema }).strict().readonly() }).strict()
  .refine(row => row.keyId !== row.hubId && new Set(row.purposes).size === row.purposes.length && row.notAfter > row.notBefore
    && row.notAfter - row.notBefore <= HUB_LIMITS.delegationMaxMs).readonly();
export type HubKeyDelegation = z.infer<typeof hubKeyDelegationSchema>;
