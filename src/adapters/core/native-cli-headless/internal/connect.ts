import { readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { delegatedUseConsentSchema, type DelegatedUseConsent, type JsonObject } from '#domain/index.js';
import { nativeCliHeadless } from '#adapters/core/native-cli-registry/index.js';
import { findExecutable } from '#adapters/core/setup-detect-execution/index.js';
import { NATIVE_CLI_HEADLESS_ADAPTER, isNativeCliHeadlessAdapter, nativeCliHeadlessDefinitionSchema, refuse, type NativeCliHeadlessDefinition } from './contract.js';
import { headlessPreflight } from './preflight.js';
import { headlessIsolationSeal, type HeadlessIsolation } from './realm.js';

export type HeadlessConnectInput = Readonly<{ protocol: Readonly<{ family: string; version: string }>; minCliVersion: string; stateDir: string;
  executable?: string | undefined; configDir?: string | undefined; env: Readonly<Record<string, string | undefined>>; now: () => number; isolation: HeadlessIsolation;
  signal?: AbortSignal }>;
/**
 * S3-3 connect (no model call): the absolute executable (given, else the first in PATH of the registry's CLI name) and the login directory
 * (given, else the registry default under the person's home, owner Q-H1) by realpath, the uid of this process sealed as the owner floor, then
 * the preflight (version, flags, login kind). S3-5: the realm is the isolation proof — no usable bubblewrap here, no connection (typed, before any
 * path search or spawn); every preflight spawn already runs inside it. Returns the definition without consent; `withConsent` adds the person's choice.
 */
export async function prepareHeadlessConnection(input: HeadlessConnectInput): Promise<Omit<NativeCliHeadlessDefinition, 'delegatedUse'>> {
  const entry = nativeCliHeadless(input.protocol.family), uid = process.getuid?.();
  if (!entry || uid === undefined) refuse('HEADLESS_REQUEST_INVALID', { reason: 'definition' });
  await headlessIsolationSeal(input.isolation);
  const { connect } = entry.headless, controller = AbortSignal.timeout(connect.pathSearchTimeoutMs);
  const named = input.executable ?? await findExecutable(entry.command.executable, input.env, connect.pathSearchDirectories, input.signal ? AbortSignal.any([input.signal, controller]) : controller);
  const executable = named && isAbsolute(named) ? await realpath(named).catch(() => null) : null;
  if (!executable) refuse('HEADLESS_CLI_UNAVAILABLE');
  const asked = input.configDir ?? join(input.env['HOME'] ?? homedir(), connect.configDirDefault);
  const configDir = isAbsolute(asked) ? await realpath(asked).catch(() => null) : null;
  if (!configDir) refuse('HEADLESS_PREFLIGHT_FAILED', { check: 'config-dir' });
  const base = { schemaVersion: 1 as const, executable, configDir, stateDir: input.stateDir, ownerUid: uid, minCliVersion: input.minCliVersion };
  await headlessPreflight(entry, nativeCliHeadlessDefinitionSchema.parse({ ...base, delegatedUse: null }), input.now, input.isolation, input.signal);
  return base;
}
/** The person's consent choice (`classes` undefined: keep the existing one; empty: withdrawn). An unchanged choice keeps its record byte for byte. */
export function headlessConsent(existing: JsonObject | null | undefined, classes: readonly ('ai' | 'system')[] | undefined, by: Readonly<{ issuer: string; subject: string }>,
  atMs: number): DelegatedUseConsent | null {
  const kept = delegatedUseConsentSchema.safeParse(existing?.['delegatedUse']), current = kept.success ? kept.data : null;
  if (classes === undefined) return current;
  const wanted = [...new Set(classes)].sort();
  if (!wanted.length) return null;
  return current && current.consentedBy.issuer === by.issuer && current.consentedBy.subject === by.subject && JSON.stringify([...current.classes].sort()) === JSON.stringify(wanted)
    ? current : { consentedBy: { issuer: by.issuer, subject: by.subject }, atMs, classes: wanted };
}
/** The adapter part of a subscription profile (profile v2, `billingAxis: subscription`, no tariff, no key). */
export const headlessConnectionAdapter = (definition: NativeCliHeadlessDefinition, protocol: Readonly<{ family: string; version: string }>) => Object.freeze({
  // One run dir per connection that `send` empties: calls on one connection never overlap (registry bound).
  maxInFlight: nativeCliHeadless(protocol.family)?.headless.connect.maxInFlight ?? 1,
  adapter: { id: NATIVE_CLI_HEADLESS_ADAPTER.id, version: NATIVE_CLI_HEADLESS_ADAPTER.version, definition: nativeCliHeadlessDefinitionSchema.parse(definition) as unknown as JsonObject },
  protocol: { family: protocol.family, version: protocol.version }, tariff: 'unmetered' as const, billingAxis: 'subscription' as const });
/** Doctor (read-soft, no spawn): each subscription connection of the scope with its last preflight record's state and login kind (`unknown`: none yet). */
export async function readHeadlessLogins(section: unknown, scopeId: string) {
  const profiles = ((section as { profiles?: unknown } | undefined)?.profiles as { scopeId?: unknown; adapter?: { id: string; version: number; definition?: unknown } }[] | undefined) ?? [];
  const text = (value: unknown) => typeof value === 'string' ? value.slice(0, 64) : null;
  return Promise.all(profiles.flatMap(profile => { const definition = profile.scopeId === scopeId && profile.adapter && isNativeCliHeadlessAdapter(profile.adapter)
    ? nativeCliHeadlessDefinitionSchema.safeParse(profile.adapter.definition) : null; return definition?.success ? [definition.data] : []; }).map(async definition => {
    const record = await readFile(join(definition.stateDir, 'preflight.json'), 'utf8').then(raw => JSON.parse(raw) as { state?: unknown; auth?: { authMethod?: unknown; subscriptionType?: unknown } }, () => null);
    return Object.freeze({ state: !record ? 'unknown' as const : record.state === 'open' ? 'open' as const : 'closed' as const, authMethod: text(record?.auth?.authMethod),
      subscriptionType: text(record?.auth?.subscriptionType), configDir: definition.configDir, consent: definition.delegatedUse?.classes ?? [] });
  }));
}
