import { z } from 'zod';
import { identitySchema, counterSchema } from '#domain/index.js';
import catalogData from './catalog.json' with { type: 'json' };

const version = z.string().regex(/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/);
const npmMechanism = z.object({ mechanism: z.literal('npm'), package: z.string().regex(/^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/),
  versionPattern: z.string().min(1), update: z.string().min(1), selfUpdateControl: z.string().min(1) }).strict();
const installerMechanism = z.object({ mechanism: z.literal('installer-script'), versionPattern: z.string().min(1), update: z.string().min(1), note: z.string().min(1) }).strict();
export const toolchainCatalogSchema = z.object({ schemaVersion: z.literal(1), note: z.string(),
  providers: z.record(identitySchema, z.discriminatedUnion('mechanism', [npmMechanism, installerMechanism])) }).strict().readonly();
export type ToolchainCatalog = z.infer<typeof toolchainCatalogSchema>;
export type ToolchainMechanism = ToolchainCatalog['providers'][string];
export const toolchainCatalog: ToolchainCatalog = toolchainCatalogSchema.parse(catalogData);

/** One admitted worker toolchain pin: the CLI version string a prepared profile requires at preflight. */
const profileReferenceSchema = z.object({ id: identitySchema, version: counterSchema.positive() }).strict();
export const admittedToolchainSchema = z.object({ profile: profileReferenceSchema,
  provider: identitySchema, cliVersion: z.string().min(1).max(128) }).strict().readonly();
export type AdmittedToolchain = z.infer<typeof admittedToolchainSchema>;

export const publishedVersionSchema = z.object({ version, source: z.string().min(1), observedAt: z.string().datetime() }).strict().readonly();
export type PublishedVersion = z.infer<typeof publishedVersionSchema>;
/** Latest-version lookup outcome per provider. `unavailable` carries a bounded reason code only. */
export type LatestLookup = Readonly<{ kind: 'published'; published: PublishedVersion } | { kind: 'unavailable'; reason: string } | { kind: 'disabled' } | { kind: 'unsupported' }>;

export const toolchainStatusSchema = z.enum(['fresh', 'stale', 'ahead', 'unparsed', 'unknown-offline', 'unsupported', 'disabled', 'not-admitted']);
export type ToolchainStatus = z.infer<typeof toolchainStatusSchema>;
export const toolchainCurrencyEntrySchema = z.object({
  provider: identitySchema, mechanism: z.enum(['npm', 'installer-script']), package: z.string().optional(),
  admitted: z.array(z.object({ profile: profileReferenceSchema, cliVersion: z.string(), version: version.nullable() }).strict()).readonly(),
  latest: publishedVersionSchema.nullable(), status: toolchainStatusSchema, reason: z.string().optional(),
  update: z.string(), selfUpdateControl: z.string().optional(),
}).strict().readonly();
export type ToolchainCurrencyEntry = z.infer<typeof toolchainCurrencyEntrySchema>;
export const toolchainCurrencyReportSchema = z.object({ schemaVersion: z.literal(1), measuredAt: z.string().datetime(),
  // The mode value is registry vocabulary (toolchains.currency.mode); it is carried, not redeclared, here.
  mode: z.string().min(1), registryEndpoint: z.string().nullable(), providers: z.array(toolchainCurrencyEntrySchema).readonly(),
  basis: z.string() }).strict().readonly();
export type ToolchainCurrencyReport = z.infer<typeof toolchainCurrencyReportSchema>;

export class ToolchainCurrencyError extends Error {
  constructor(readonly code: 'TOOLCHAIN_CATALOG_INVALID' | 'TOOLCHAIN_PROVIDER_UNKNOWN') { super(code); this.name = 'ToolchainCurrencyError'; }
}
export function toolchainMechanism(provider: string): ToolchainMechanism {
  const mechanism = toolchainCatalog.providers[provider];
  if (!mechanism) throw new ToolchainCurrencyError('TOOLCHAIN_PROVIDER_UNKNOWN');
  return mechanism;
}
/** Extracts the comparable version from a provider's `--version` output using the catalog pattern; null when it does not match. */
export function extractToolchainVersion(provider: string, cliVersion: string): string | null {
  const match = new RegExp(toolchainMechanism(provider).versionPattern, 'u').exec(cliVersion.trim());
  const candidate = match?.[1] ?? null;
  return candidate !== null && version.safeParse(candidate).success ? candidate : null;
}
/** Semver-like ordering: numeric core, then a prerelease sorts below its release; build metadata is ignored. */
export function compareToolchainVersions(left: string, right: string): -1 | 0 | 1 {
  const parse = (value: string) => { const [core, rest] = value.split('+')[0]!.split('-', 2) as [string, string | undefined];
    return { core: core.split('.').map(Number), pre: rest === undefined ? null : rest.split('.') }; };
  const a = parse(left), b = parse(right);
  for (let i = 0; i < 3; i++) { if (a.core[i]! !== b.core[i]!) return a.core[i]! < b.core[i]! ? -1 : 1; }
  if (a.pre === null && b.pre === null) return 0;
  if (a.pre === null) return 1; if (b.pre === null) return -1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i], y = b.pre[i];
    if (x === undefined) return -1; if (y === undefined) return 1;
    const nx = /^\d+$/.test(x) ? Number(x) : null, ny = /^\d+$/.test(y) ? Number(y) : null;
    if (nx !== null && ny !== null) { if (nx !== ny) return nx < ny ? -1 : 1; continue; }
    if (nx !== null) return -1; if (ny !== null) return 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}
/** Pure assessment of one provider; the lookup outcome is supplied by composition (network, policy) and never invented here. */
export function assessToolchain(provider: string, admittedInput: readonly AdmittedToolchain[], lookup: LatestLookup): ToolchainCurrencyEntry {
  const mechanism = toolchainMechanism(provider);
  const admitted = admittedInput.map(item => admittedToolchainSchema.parse(item)).filter(item => item.provider === provider)
    .map(item => ({ profile: item.profile, cliVersion: item.cliVersion, version: extractToolchainVersion(provider, item.cliVersion) }));
  const base = { provider, mechanism: mechanism.mechanism, ...(mechanism.mechanism === 'npm' ? { package: mechanism.package, selfUpdateControl: mechanism.selfUpdateControl } : {}),
    admitted, update: mechanism.update };
  const entry = (status: ToolchainStatus, latest: PublishedVersion | null = null, reason?: string): ToolchainCurrencyEntry =>
    toolchainCurrencyEntrySchema.parse({ ...base, latest, status, ...(reason ? { reason } : {}) });
  if (!admitted.length) return entry('not-admitted');
  if (mechanism.mechanism !== 'npm' || lookup.kind === 'unsupported') return entry('unsupported');
  if (lookup.kind === 'disabled') return entry('disabled');
  if (lookup.kind === 'unavailable') return entry('unknown-offline', null, lookup.reason);
  if (admitted.some(item => item.version === null)) return entry('unparsed', lookup.published);
  const comparisons = admitted.map(item => compareToolchainVersions(item.version!, lookup.published.version));
  if (comparisons.some(value => value < 0)) return entry('stale', lookup.published);
  if (comparisons.some(value => value > 0)) return entry('ahead', lookup.published);
  return entry('fresh', lookup.published);
}
export function buildToolchainCurrencyReport(input: Readonly<{ measuredAt: string; mode: string; registryEndpoint: string | null; entries: readonly ToolchainCurrencyEntry[] }>): ToolchainCurrencyReport {
  return toolchainCurrencyReportSchema.parse({ schemaVersion: 1, measuredAt: input.measuredAt, mode: input.mode, registryEndpoint: input.registryEndpoint,
    providers: [...input.entries].sort((a, b) => a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0),
    basis: 'admitted versions are preflight pins of prepared native profiles; latest is the published distribution tag read at measuredAt; comparison is advisory and never activates, rebuilds or updates a worker' });
}
