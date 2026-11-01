import { persistedInteger, OWNER_BASELINE_FAMILY_REGISTRY, HUB_LIMITS, hubDigestSchema, hubPackageIdSchema, hubVersionSchema, hubRevocationFeedSchema, hubRevocationEntrySchema, hubFeedSignatureSchema, identitySchema, signerPublicKeySchema, HUB_TRUST_POLICIES } from '#domain/index.js';
import { z } from 'zod';
import { hubClientCommandSchema, type HubClientApplication, type HubSource } from '#engine/core/hub-client/index.js';
import type { Locale, KnownSecretSnapshot } from '#platform/index.js';

const scoped = z.strictObject({ get schemaVersion() { return z.literal(1); }, scopeId: identitySchema });
const source = scoped.extend({ hubId: hubDigestSchema });
const command = hubClientCommandSchema;
const packageQuery = source.extend({ packageId: hubPackageIdSchema, version: hubVersionSchema.optional() });
/** The hub's page cursor is its own `<packageId>@<version>` key (hub-mcp nextCursor); nothing else, so no free text rides it out of the scope. */
const searchCursor = z.string().max(HUB_LIMITS.packageMaxBytes).refine(value => {
  const at = value.lastIndexOf('@');
  return value === '' || (hubPackageIdSchema.safeParse(value.slice(0, at)).success && hubVersionSchema.safeParse(value.slice(at + 1)).success);
});
const bundle = z.string().min(1).max(HUB_LIMITS.httpMaxBytes);
const install = command.extend({ bundles: z.array(bundle).min(1).max(HUB_LIMITS.dependenciesMax + 1), feed: hubRevocationFeedSchema,
  feeds: z.record(hubDigestSchema, hubRevocationFeedSchema).prefault({}), workClassMapping: z.record(z.string(), identitySchema).prefault({}) });
const withdrawal = command.extend({ input: hubRevocationEntrySchema.unwrap().omit({ atMs: true, severity: true }).extend({ schemaVersion: z.literal(1), commandId: identitySchema,
  authority: z.enum(['publisher', 'operator']), keyId: hubDigestSchema.optional(), signature: hubFeedSignatureSchema.unwrap().shape.value.optional() }).strict() });
/** Wire-safe schemas shared by SDK, CLI, terminal and MCP. Bundles are canonical base64 of .deckentpkg bytes, never host paths. */
export const hubOperationSchemas = {
  'hub.sources.list': scoped,
  'hub.sources.add': command.extend({ expectedRevision: persistedInteger().positive().nullable(), publicKey: signerPublicKeySchema,
    endpoint: z.string().min(1).max(2048), local: z.boolean().prefault(false), label: z.string().min(1).max(256),
    trustPolicy: z.string().prefault(HUB_TRUST_POLICIES.addedSourceDefault) }),
  'hub.sources.remove': command.extend({ expectedRevision: persistedInteger().positive() }),
  'hub.search': source.extend({ after: searchCursor.prefault(''), limit: persistedInteger().min(1).max(HUB_LIMITS.searchPageMax).prefault(HUB_LIMITS.searchPageMax) }),
  'hub.inspect': packageQuery.extend({ location: z.enum(['installed', 'source']).prefault('installed') }).refine(value => value.location !== 'source' || value.version !== undefined),
  'hub.install': install,
  'hub.update': install,
  'hub.uninstall': command.extend({ packageId: hubPackageIdSchema, expectedRevision: persistedInteger().positive() }),
  'hub.verify': packageQuery,
  'hub.export': packageQuery,
  'hub.refresh': command.extend({ feed: hubRevocationFeedSchema }),
  'hub.cards': scoped.extend({ after: persistedInteger().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).nonnegative().prefault(0), limit: persistedInteger().min(1).max(HUB_LIMITS.searchPageMax).prefault(HUB_LIMITS.searchPageMax) }),
  'hub.publish': command.extend({ input: z.strictObject({ get bundle() { return z.unknown().optional(); } }) }),
  'hub.yank': withdrawal,
  'hub.revoke': withdrawal,
} as const;
export type HubOperationName = keyof typeof hubOperationSchemas;
export type HubOperation = { [K in HubOperationName]: Readonly<{ operation: K; input: z.input<typeof hubOperationSchemas[K]> }> }[HubOperationName];
export type ParsedHubOperation = { [K in HubOperationName]: Readonly<{ operation: K; input: z.output<typeof hubOperationSchemas[K]> }> }[HubOperationName];
const hubEnvelopes = Object.entries(hubOperationSchemas).map(([operation, input]) => z.strictObject({ get operation() { return z.literal(operation); }, input }));
export const hubOperationSchema = z.discriminatedUnion('operation', [hubEnvelopes[0]!, ...hubEnvelopes.slice(1)]);
export function parseHubOperation(input: unknown): ParsedHubOperation { return hubOperationSchema.parse(input) as ParsedHubOperation; }
export const hubOperationWrites = (name: HubOperationName): boolean => !['hub.sources.list', 'hub.search', 'hub.inspect', 'hub.verify', 'hub.export', 'hub.cards'].includes(name);
export const hubPersonOnlyOperation = (name: HubOperationName): boolean => name === 'hub.sources.add' || name === 'hub.sources.remove' || name === 'hub.cards';
/** The policy cell action a Hub operation is admitted under (the client's own admit: local reads `inspect`, a source read `search`). Wording only. */
export function hubPolicyAction(request: Readonly<{ operation: HubOperationName; input: unknown }>): string {
  const name = request.operation.slice(4), location = (request.input as { location?: unknown } | null)?.location;
  return ['sources.list', 'verify', 'cards'].includes(name) || name === 'inspect' && location !== 'source' ? 'inspect' : name === 'inspect' ? 'search' : name;
}
/** The founder-baseline families whose card grants this Hub action (writes also need the read family); null when no family holds it (publish, yank, revoke). */
export function hubFounderFamilies(action: string): string | null {
  const holds = OWNER_BASELINE_FAMILY_REGISTRY.filter(family => 'cells' in family && family.cells.some(cell => cell.kind === 'hub' && (cell.actions as readonly string[]).includes(action)));
  if (!holds.length) return null;
  const read = OWNER_BASELINE_FAMILY_REGISTRY.find(family => 'cells' in family && family.cells.some(cell => cell.kind === 'hub' && (cell.actions as readonly string[]).includes('inspect')));
  return [...new Set([...(read ? [read.id] : []), ...holds.map(family => family.id)])].join(',');
}
export type HubRemoteOperation = Extract<ParsedHubOperation, { operation: 'hub.inspect' | 'hub.search' | 'hub.publish' | 'hub.yank' | 'hub.revoke' }>;
/** Composition supplies only an H4 governed transport, never raw fetch. H3/H5 remain signature and transition owners. */
export interface HubOperationPorts {
  readonly client: HubClientApplication;
  readonly knownSecrets?: () => KnownSecretSnapshot;
  readonly remote?: (request: HubRemoteOperation, source: HubSource, signal: AbortSignal) => Promise<unknown>;
  readonly locale?: Locale;
}
export type HubOperationHandler = (request: HubOperation, signal?: AbortSignal) => Promise<unknown>;
