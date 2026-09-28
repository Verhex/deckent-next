import { loadConfig, type ConfigLoadOptions } from '#platform/index.js';
import { admittedToolchains, assessToolchain, buildToolchainCurrencyReport, toolchainCatalog,
  type LatestLookup, type ToolchainCurrencyReport } from '#engine/index.js';
import { fetchNpmLatestVersion, NpmRegistryError, type NpmLatestVersion, type NpmLatestVersionInput } from '#adapters/index.js';

export type NpmLatestVersionFetcher = (input: NpmLatestVersionInput) => Promise<NpmLatestVersion>;
/** Read-only currency report. Network is used only when `toolchains.currency.mode` is `report`, one bounded request per npm package;
 * failures become `unknown-offline` with a reason code. Nothing is activated, rebuilt or updated. */
export async function inspectConfiguredToolchainCurrency(projectRoot: string, options: ConfigLoadOptions = {},
  fetcher: NpmLatestVersionFetcher = fetchNpmLatestVersion): Promise<ToolchainCurrencyReport> {
  const config = await loadConfig(projectRoot, options);
  const policy = config.toolchains.currency;
  const admitted = admittedToolchains(config);
  const lookups = new Map<string, Promise<LatestLookup>>();
  const lookup = (pkg: string): Promise<LatestLookup> => {
    const cached = lookups.get(pkg); if (cached) return cached;
    const pending: Promise<LatestLookup> = policy.mode !== 'report' ? Promise.resolve({ kind: 'disabled' })
      : fetcher({ endpoint: policy.registryEndpoint, package: pkg, timeoutMs: policy.timeoutMs, responseMaxBytes: policy.responseMaxBytes })
        .then((published): LatestLookup => ({ kind: 'published', published }),
          (error: unknown): LatestLookup => ({ kind: 'unavailable', reason: error instanceof NpmRegistryError ? error.code : 'NPM_REGISTRY_UNAVAILABLE' }));
    lookups.set(pkg, pending); return pending;
  };
  const entries = await Promise.all(Object.entries(toolchainCatalog.providers).map(async ([provider, mechanism]) => {
    const own = admitted.filter(item => item.provider === provider);
    const outcome: LatestLookup = mechanism.mechanism === 'npm' && own.length ? await lookup(mechanism.package) : mechanism.mechanism === 'npm' ? { kind: 'disabled' } : { kind: 'unsupported' };
    return assessToolchain(provider, own, outcome);
  }));
  return buildToolchainCurrencyReport({ measuredAt: new Date().toISOString(), mode: policy.mode,
    registryEndpoint: policy.mode !== 'report' ? null : policy.registryEndpoint, entries });
}
