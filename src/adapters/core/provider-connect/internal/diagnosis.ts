import { modelInvocationProfileSchema } from '#domain/index.js';
import { PROVIDER_CONNECT_KINDS, providerEndpoint } from './registry.js';
import { providerProfileProtocolOffer } from './protocol.js';
/** Exact registry route identity, never a provider id or host suffix guess. */
export function providerRequestDiagnosis(profile: unknown): Readonly<{ labelKey: string | null; migration: boolean; rejectionCodes: Readonly<Record<string, 'spend-limit' | 'rate-limit'>> }> {
  const parsed = modelInvocationProfileSchema.safeParse(profile);
  const endpoint = parsed.success ? parsed.data.adapter.definition['endpoint'] : null;
  const kind = PROVIDER_CONNECT_KINDS.find(row => row.endpoint.default !== null && row.connect &&
    [`${providerEndpoint(row.endpoint.default).ok ? (providerEndpoint(row.endpoint.default) as { base: string }).base : ''}${row.connect.chatPath}`, ...(row.connect.protocolRoutes?.map(route => new URL(route.path, row.endpoint.default!).href) ?? [])].includes(String(endpoint)));
  return { labelKey: kind?.labelKey ?? null, migration: providerProfileProtocolOffer(profile) !== null,
    rejectionCodes: kind?.connect?.rejectionCodes ?? {} };
}
