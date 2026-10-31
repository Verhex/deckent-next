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
/** A model name exactly as one native CLI version reports it at session start (Cursor `system/init.model`), with where it was observed. It is
 * evidence for the `session-start-name` capability, compared byte-for-byte; it is not the UI `displayName` and never resolves an alias. */
/** At most 128 characters: a sealed `model.verification` event records the reported name in `observed`/`unexpected` (text(128)). */
export const reportedModelNameSchema = z.string().min(1).max(128).refine(value => value.trim() === value
  && ![...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127));
/** The bounded set of session-start names one channel may record (all models together); a frozen pin carries a subset of it. */
export const channelReportedNamesSchema = z.array(reportedModelNameSchema).max(512).readonly();
const reportedNameSchema = z.object({ name: reportedModelNameSchema, cliVersion: z.string().trim().min(1).max(128).regex(/^[\w .()+-]+$/),
  source: text, observedAt: z.union([day, z.string().datetime({ offset: true })]) }).strict().readonly();
const support = z.enum(['supported', 'unsupported', 'unknown']);
const connectTermSchema = z.record(z.string(), z.unknown()).refine(term => Object.keys(term).length > 0).readonly();
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
  provenance: catalogProvenanceSchema,
  /** Native CLI channels only (owner K1/K2 2026-10-22): the names the CLI reports for this model at session start; one name belongs to one model. */
  reportedNames: z.array(reportedNameSchema).min(1).max(16).readonly().optional(),
  /** `provider`: the entry leaves the model choice to the provider (Cursor `auto`); absent = an exact model. Never a match claim. */
  selection: z.literal('provider').optional(),
  /** HTTP API channels only (M4, owner 2026-10-23: a new model is a data update, never a code change): the invocation adapter's own terms for
   * this exact model — `tariff`, its published price document, and `route`, its wire route — checked by that adapter's schema when the model is
   * connected. The adapter's shipped tables stay first for every model they list; a missing or malformed term is a typed refusal, never a
   * guessed price. Bounded by the document envelope; never activation, tier or role. */
  connect: z.object({ tariff: connectTermSchema.optional(), route: connectTermSchema.optional() }).strict()
    .refine(terms => terms.tariff !== undefined || terms.route !== undefined).readonly().optional() });
/** The ledger row a connected profile's tariff was taken from (M4): the catalog channel and the row's revision, sealed into the tariff's source. */
export const catalogTariffSealSchema = z.object({ channelId: identitySchema, modelRevision: z.number().int().positive().safe() }).strict().readonly();
export type CatalogTariffSeal = z.infer<typeof catalogTariffSealSchema>;
/** The spend authority's re-read of a sealed tariff (security review M4): the registered row's own `connect.tariff` term when the ledger catalog
 * holds exactly that (channel, exact model id) at exactly the sealed revision, else null. A seal is never trusted on its own. */
export type CatalogTariffLookup = (seal: CatalogTariffSeal, modelId: string, scopeId: string) => Promise<unknown>;
/** Owner 2026-10-31 (BeUser option B): the tokens a transport without a counter (a subscription CLI, ChatGPT sign-in) adds around the bytes it
 * sends (identity, plugin and turn framing, hidden instructions). A prompt estimate is the UTF-8 bytes sent plus `tokens`; `measured` cites a retained
 * observation in `source`, `unmeasured` states a conservative value without one. Registry data of each such transport; never a count or a proven bound. */
export const promptFramingAllowanceSchema = z.object({ tokens: z.number().int().positive().safe(), basis: z.enum(['measured', 'unmeasured']),
  source: z.string().min(1).max(1024) }).strict().readonly();
