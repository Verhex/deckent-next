import { digestText, isRecord } from '#platform/index.js';
import { configDefinitions } from './registry.js';

const sorted = (value: unknown): unknown => Array.isArray(value) ? value.map(sorted)
  : isRecord(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
const MASK = '[SECRET]';
function mask(value: unknown, pointer: string, secrets: ReadonlySet<string>): unknown {
  if (secrets.has(pointer)) return MASK;
  if (Array.isArray(value)) return value.map((item, index) => mask(item, `${pointer}/${index}`, secrets));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mask(item, `${pointer}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`, secrets)]));
  return value;
}
/**
 * Fingerprint of the effective values a running service only reads at start: every section whose declared apply mode is `restart`.
 * A `live` section never changes it, so a language change never asks for a restart. Resolved secret values are masked (their pointers come from
 * the loader's provenance), so the digest never fingerprints a credential; the cost is that a rotated secret value alone is not detected.
 * Service and observers compute it from the same loader, so equal digests mean the service started with the configuration seen now.
 */
export function restartConfigDigest(effective: Readonly<Record<string, unknown>>): string {
  const provenance = effective['secretPaths'];
  const secrets = new Set<string>(Array.isArray(provenance) ? provenance.filter((item): item is string => typeof item === 'string') : []);
  const picked: Record<string, unknown> = {};
  for (const [key, definition] of configDefinitions()) if (definition.apply === 'restart') picked[key] = mask(effective[key] ?? null, `/${key}`, secrets);
  return digestText(JSON.stringify(sorted(picked)));
}
/** `unknown`: an older service that reports no digest (never guessed stale). */
export function runtimeConfigFreshness(serviceDigest: string | undefined, effective: Readonly<Record<string, unknown>>): 'current' | 'stale' | 'unknown' {
  return serviceDigest === undefined ? 'unknown' : serviceDigest === restartConfigDigest(effective) ? 'current' : 'stale';
}
