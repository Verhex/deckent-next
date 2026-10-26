import { z } from 'zod';
import { HUB_LIMITS, hubDigestSchema, hubPackageIdSchema, hubVersionSchema, hubRevocationFeedSchema, hubRevocationEntrySchema, hubFeedSignatureSchema, identitySchema, signerPublicKeySchema, HUB_TRUST_POLICIES } from '#domain/index.js';
import { hubClientCommandSchema, type HubClientApplication, type HubSource } from '#engine/core/hub-client/index.js';
import type { Locale, KnownSecretSnapshot } from '#platform/index.js';

const scoped = z.object({ schemaVersion: z.literal(1), scopeId: identitySchema }).strict();
const source = scoped.extend({ hubId: hubDigestSchema });
const command = hubClientCommandSchema;
const packageQuery = source.extend({ packageId: hubPackageIdSchema, version: hubVersionSchema.optional() });
const bundle = z.string().min(1).max(HUB_LIMITS.httpMaxBytes);
const install = command.extend({ bundles: z.array(bundle).min(1).max(HUB_LIMITS.dependenciesMax + 1), feed: hubRevocationFeedSchema,
  feeds: z.record(hubDigestSchema, hubRevocationFeedSchema).default({}), workClassMapping: z.record(z.string(), identitySchema).default({}) });
const withdrawal = command.extend({ input: hubRevocationEntrySchema.unwrap().omit({ atMs: true, severity: true }).extend({ schemaVersion: z.literal(1), commandId: identitySchema,
  authority: z.enum(['publisher', 'operator']), keyId: hubDigestSchema.optional(), signature: hubFeedSignatureSchema.unwrap().shape.value.optional() }).strict() });
/** Wire-safe schemas shared by SDK, CLI, terminal and MCP. Bundles are canonical base64 of .deckentpkg bytes, never host paths. */
export const hubOperationSchemas = {
  'hub.sources.list': scoped,
  'hub.sources.add': command.extend({ expectedRevision: z.number().int().positive().nullable(), publicKey: signerPublicKeySchema,
    endpoint: z.string().min(1).max(2048), local: z.boolean().default(false), label: z.string().min(1).max(256),
    trustPolicy: z.string().default(HUB_TRUST_POLICIES.addedSourceDefault) }),
  'hub.sources.remove': command.extend({ expectedRevision: z.number().int().positive() }),
  'hub.search': source.extend({ after: z.string().max(HUB_LIMITS.packageMaxBytes).default(''), limit: z.number().int().min(1).max(HUB_LIMITS.searchPageMax).default(HUB_LIMITS.searchPageMax) }),
  'hub.inspect': packageQuery.extend({ location: z.enum(['installed', 'source']).default('installed') }).refine(value => value.location !== 'source' || value.version !== undefined),
  'hub.install': install,
  'hub.update': install,
  'hub.uninstall': command.extend({ packageId: hubPackageIdSchema, expectedRevision: z.number().int().positive() }),
  'hub.verify': packageQuery,
  'hub.export': packageQuery,
  'hub.refresh': command.extend({ feed: hubRevocationFeedSchema }),
  'hub.cards': scoped.extend({ after: z.number().int().safe().nonnegative().default(0), limit: z.number().int().min(1).max(HUB_LIMITS.searchPageMax).default(HUB_LIMITS.searchPageMax) }),
  'hub.publish': command.extend({ input: z.object({ bundle: z.unknown() }).strict() }),
  'hub.yank': withdrawal,
  'hub.revoke': withdrawal,
} as const;
export type HubOperationName = keyof typeof hubOperationSchemas;
export type HubOperation = { [K in HubOperationName]: Readonly<{ operation: K; input: z.input<typeof hubOperationSchemas[K]> }> }[HubOperationName];
export type ParsedHubOperation = { [K in HubOperationName]: Readonly<{ operation: K; input: z.output<typeof hubOperationSchemas[K]> }> }[HubOperationName];
export const hubOperationSchema = z.discriminatedUnion('operation', Object.entries(hubOperationSchemas).map(([operation, input]) =>
  z.object({ operation: z.literal(operation), input }).strict()) as unknown as [z.ZodDiscriminatedUnionOption<'operation'>, z.ZodDiscriminatedUnionOption<'operation'>, ...z.ZodDiscriminatedUnionOption<'operation'>[]]);
export function parseHubOperation(input: unknown): ParsedHubOperation { return hubOperationSchema.parse(input) as ParsedHubOperation; }
export const hubOperationWrites = (name: HubOperationName): boolean => !['hub.sources.list', 'hub.search', 'hub.inspect', 'hub.verify', 'hub.export', 'hub.cards'].includes(name);
export const hubPersonOnlyOperation = (name: HubOperationName): boolean => name === 'hub.sources.add' || name === 'hub.sources.remove' || name === 'hub.cards';
export type HubRemoteOperation = Extract<ParsedHubOperation, { operation: 'hub.inspect' | 'hub.search' | 'hub.publish' | 'hub.yank' | 'hub.revoke' }>;
/** Composition supplies only an H4 governed transport, never raw fetch. H3/H5 remain signature and transition owners. */
export interface HubOperationPorts {
  readonly client: HubClientApplication;
  readonly knownSecrets?: () => KnownSecretSnapshot;
  readonly remote?: (request: HubRemoteOperation, source: HubSource, signal: AbortSignal) => Promise<unknown>;
  readonly locale?: Locale;
}
export type HubOperationHandler = (request: HubOperation, signal?: AbortSignal) => Promise<unknown>;
