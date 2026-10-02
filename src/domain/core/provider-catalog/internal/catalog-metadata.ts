import { z } from 'zod';
import { exactModelIdSchema as exact, daySchema as day, cliVersionSchema as version, REASONING_EFFORTS, NATIVE_CLI_CHANNELS, CATALOG_BILLING_KINDS, CATALOG_PRICING_KINDS } from './catalog-values.js';
import { identitySchema } from '#domain/core/primitives/index.js';

// Metadata is channel evidence, never activation or an API-to-CLI capability inference. Kept independent of document parsing.
const text = z.string().trim().min(1).max(512);
const effort = z.enum(REASONING_EFFORTS);
export const catalogProvenanceSchema = z.object({ sourceUrl: z.string().url().startsWith('https://').max(512).optional(),
  localPath: text.optional(), fetchedOn: z.union([day, z.string().datetime({ offset: true })]), etag: text.optional(), clientVersion: version.optional(),
}).strict().refine(p => (p.sourceUrl !== undefined) !== (p.localPath !== undefined)).readonly();
export const channelMetadataSchema = z.object({ client: z.enum(NATIVE_CLI_CHANNELS).nullable(),
  billing: z.enum(CATALOG_BILLING_KINDS), protocolFamily: identitySchema,
  aliasesRefused: z.array(exact).max(64).readonly(), provenance: catalogProvenanceSchema });
const support = z.enum(['supported', 'unsupported', 'unknown']);
const decimal = z.string().regex(/^(0|[1-9]\d*)(\.\d+)?$/).max(64);
export const modelMetadataSchema = z.object({ channelModelId: exact, vendorId: identitySchema, canonicalModelId: exact,
  displayName: text, description: z.string().max(4096).optional(), family: identitySchema.optional(),
  modalities: z.object({ input: z.array(identitySchema).max(32).readonly(), output: z.array(identitySchema).max(32).readonly() }).strict().readonly(),
  contextWindow: z.number().int().positive().safe().nullable(), maxOutputTokens: z.number().int().positive().safe().nullable(),
  reasoning: z.object({ supportedEfforts: z.array(effort).max(REASONING_EFFORTS.length).readonly(), defaultEffort: effort.nullable() }).strict().readonly(),
  capabilities: z.object({ tools: support, vision: support, pdf: support, structuredOutput: support, promptCaching: support, streaming: support }).strict().readonly(),
  pricing: z.object({ kind: z.enum(CATALOG_PRICING_KINDS), source: catalogProvenanceSchema, asOf: day,
    inputPerMTok: decimal.optional(), outputPerMTok: decimal.optional(), cacheReadPerMTok: decimal.optional(), cacheWritePerMTok: decimal.optional(),
  }).strict().readonly(), minClientVersion: version.nullable(), visibility: identitySchema.optional(), priority: z.number().int().safe().optional(),
  provenance: catalogProvenanceSchema });
