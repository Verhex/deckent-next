import { compareToolchainVersions, prepareSubscriptionConsent } from '#engine/index.js';
import { readFile, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { DeckentError, headlessDiagnostic, isRecord, readHeadlessDiagnosticRecord } from '#platform/index.js';
import { headlessEgressSchema, headlessEgressReasons,  type JsonObject } from '#domain/index.js';
import { nativeCliHeadless } from '#adapters/core/native-cli-registry/index.js';
import { searchExecutable } from '#adapters/core/setup-detect-execution/index.js';
import { NATIVE_CLI_HEADLESS_ADAPTER, isNativeCliHeadlessAdapter, nativeCliHeadlessDefinitionSchema, refuse, type NativeCliHeadlessDefinition } from './contract.js';
import { headlessExecutableRevision, isIdentifiedOpenPreflight, headlessPreflight, verifiedCliVersion } from './preflight.js';
import { headlessExecutableRefusal, headlessSelectionRefusal, executableLookupReason, resolveHeadlessExecutable } from './executable.js';
import { HEADLESS_EGRESS_RECORD, headlessIsolationSeal, type HeadlessIsolation } from './realm.js';

type HeadlessConnectInput = Readonly<{ protocol: Readonly<{ family: string; version: string }>; minCliVersion: string; stateDir: string;
  executable?: string | undefined; configDir?: string | undefined; ownedConfigDir: string; env: Readonly<Record<string, string | undefined>>; now: () => number;
  isolation: HeadlessIsolation; signal?: AbortSignal }>;
/** The absolute executable the person gave, else the first of the registry's CLI name in the person's PATH (bounded search). S7 (owner 2026-10-31): that
 * path is kept, not its realpath (a self-updating CLI moves it); it must resolve to a file now, and every call resolves it again. */
export async function headlessExecutable(entry: NonNullable<ReturnType<typeof nativeCliHeadless>>, input: Readonly<{ executable?: string | undefined;
  env: Readonly<Record<string, string | undefined>>; signal?: AbortSignal | undefined }>): Promise<string> {
  const { connect } = entry.headless, controller = AbortSignal.timeout(connect.pathSearchTimeoutMs);
  let named = input.executable ?? undefined;
  if (named === undefined) {
    const result = await searchExecutable(entry.command.executable, input.env, connect.pathSearchDirectories, input.signal ? AbortSignal.any([input.signal, controller]) : controller);
    if (result.path === null) {
      if (!result.completed) refuse('HEADLESS_CLI_UNAVAILABLE', { check: 'path-search-incomplete', bound: connect.pathSearchDirectories });
      const check = result.executeUnverified ? 'path-search-execute-unverified' : result.unverified ? 'path-search-unverified'
        : result.executeDenied ? 'path-search-execute-denied' : result.notFile ? 'path-search-not-file' : 'path-search-empty';
      refuse('HEADLESS_CLI_UNAVAILABLE', { check, bound: connect.pathSearchDirectories });
    }
    named = result.path;
  }
  if (!isAbsolute(named)) headlessSelectionRefusal(named, 'relative-path');
  const executable = await realpath(named).catch((error: unknown) => {
    const reason = executableLookupReason(error);
    if (input.executable != null) headlessSelectionRefusal(named, reason);
    return headlessExecutableRefusal({ check: 'path-candidate-unverified', reason }, named);
  });
  // A path with `.`/`..` segments is kept by its realpath (a lexical normalization could name another file).
  return resolve(named) === named ? named : executable;
}
/**
 * S3-3 connect (no model call): the absolute executable and the login directory (given, else s3c the Brain's own Deckent-owned one, owner
 * 2026-10-24) by realpath, the uid of this process sealed as the owner floor, then
 * the preflight (version, flags, login kind). S3-5: the realm is the isolation proof — no usable bubblewrap here, no connection (typed, before any
 * path search or spawn); every preflight spawn already runs inside it. Returns the definition without consent; `withConsent` adds the person's choice.
 */
export async function prepareHeadlessConnection(input: HeadlessConnectInput): Promise<Omit<NativeCliHeadlessDefinition, 'delegatedUse'>> {
  const entry = nativeCliHeadless(input.protocol.family), uid = process.getuid?.();
  if (!entry) refuse('HEADLESS_REQUEST_INVALID', { reason: 'program-definition' });
  if (uid === undefined) refuse('HEADLESS_PREFLIGHT_FAILED', { check: 'program-owner-unverified' });
  await headlessIsolationSeal(input.isolation);
  const executable = await headlessExecutable(entry, input), asked = input.configDir ?? input.ownedConfigDir;
  if (!isAbsolute(asked)) refuse('HEADLESS_PREFLIGHT_FAILED', { check: 'config-dir', reason: 'relative-path' });
  const configDir = await realpath(asked).catch(() => null);
  if (!configDir) refuse('HEADLESS_PREFLIGHT_FAILED', { check: 'config-dir', reason: 'unresolved' });
  const base = { schemaVersion: 1 as const, executable, configDir, stateDir: input.stateDir, ownerUid: uid, minCliVersion: input.minCliVersion };
  const definition = nativeCliHeadlessDefinitionSchema.safeParse({ ...base, delegatedUse: null });
  if (!definition.success) refuse('HEADLESS_REQUEST_INVALID', { reason: 'prepared-definition' });
  await headlessPreflight(entry, definition.data, input.now, input.isolation, input.signal, undefined,
    input.executable == null ? 'path' : 'new');
  return base;
}
/** The person's consent choice (`classes` undefined: keep the existing one; empty: withdrawn); an unchanged choice keeps its record byte for byte.
 * @deprecated KG7 F7: a pass-through of `prepareSubscriptionConsent`, unused in Core; removed after the Enterprise check. */
export function headlessConsent(...args: Parameters<typeof prepareSubscriptionConsent>) { return prepareSubscriptionConsent(...args); }
/** B2-12: the slot bound is the registry's, never an adapter default; a family without a registry entry is refused. */
export function headlessConnectionAdapter(definition: NativeCliHeadlessDefinition, protocol: Readonly<{ family: string; version: string }>) {
  const entry = nativeCliHeadless(protocol.family);
  if (!entry) refuse('HEADLESS_REQUEST_INVALID', { reason: 'connect-definition' });
  // One run dir per connection that `send` empties: calls on one connection never overlap (registry bound).
  return Object.freeze({ maxInFlight: entry.headless.connect.maxInFlight,
    adapter: { id: NATIVE_CLI_HEADLESS_ADAPTER.id, version: NATIVE_CLI_HEADLESS_ADAPTER.version, definition: nativeCliHeadlessDefinitionSchema.parse(definition) as unknown as JsonObject },
    protocol: { family: protocol.family, version: protocol.version }, tariff: 'unmetered' as const, billingAxis: 'subscription' as const });
}
/** f5: the connection's cumulative gateway refusals (counts and host names, most refused first), or null when none was recorded. */
async function readEgress(stateDir: string) {
  const raw = await readFile(join(stateDir, HEADLESS_EGRESS_RECORD), 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (raw === null) return null;
  const value: unknown = JSON.parse(raw);
  const { schemaVersion, lastRefusedAtMs, ...summary } = isRecord(value) ? value : {};
  const parsed = (schemaVersion === 1 || schemaVersion === 2) && typeof lastRefusedAtMs === 'number' ? headlessEgressSchema.safeParse(summary) : null;
  if (!parsed?.success) return undefined;
  return parsed.data.refused > 0 ? Object.freeze({ refused: parsed.data.refused, lastRefusedAtMs: lastRefusedAtMs as number,
    ...headlessEgressReasons(parsed.data), hosts: Object.entries(parsed.data.hosts).sort(([a, x], [b, y]) => y - x || a.localeCompare(b)).map(([host]) => host), other: parsed.data.other }) : null;
}
type PreflightRecord = { state?: unknown; refusal?: unknown; check?: unknown; version?: unknown; updatedFrom?: unknown; executable?: unknown; revision?: unknown; size?: unknown; mtimeMs?: unknown;
  auth?: { authMethod?: unknown; subscriptionType?: unknown }; isolation?: { launcher?: unknown; version?: unknown } };
async function readPreflight(definition: NativeCliHeadlessDefinition) {
  const raw = await readFile(join(definition.stateDir, 'preflight.json'), 'utf8').then(text => ({ text }), (error: NodeJS.ErrnoException) => ({ missing: error.code === 'ENOENT' }));
  if ('missing' in raw) return { record: null, diagnostic: raw.missing ? null : preflightRecordDiagnostic() };
  try {
    const record: unknown = JSON.parse(raw.text);
    return isRecord(record) && (record['state'] === 'open' || record['state'] === 'closed')
      ? { record: record as PreflightRecord, diagnostic: null } : { record: null, diagnostic: preflightRecordDiagnostic() };
  }
  catch { return { record: null, diagnostic: preflightRecordDiagnostic() }; }
}
const preflightRecordDiagnostic = () => headlessDiagnostic('HEADLESS_PREFLIGHT_FAILED', { check: 'preflight-record-unreadable' });

async function currentPreflightRefusal(record: PreflightRecord, family: string, definition: NativeCliHeadlessDefinition): Promise<DeckentError | null> {
  const entry = nativeCliHeadless(family);
  if (!entry) return headlessDiagnostic('HEADLESS_REQUEST_INVALID', { reason: 'program-definition' });
  const uid = process.getuid?.();
  if (uid === undefined) return headlessDiagnostic('HEADLESS_PREFLIGHT_FAILED', { check: 'program-owner-unverified' });
  if (uid !== definition.ownerUid) return headlessDiagnostic('HEADLESS_PREFLIGHT_FAILED', { check: 'recorded-owner-mismatch' });
  let program: Awaited<ReturnType<typeof resolveHeadlessExecutable>>;
  try { program = await resolveHeadlessExecutable(entry, definition.executable, definition.ownerUid); }
  catch (error) { return error instanceof DeckentError ? error : headlessDiagnostic('HEADLESS_PREFLIGHT_FAILED', { check: 'recorded-program-unverified' }); }
  const matched = record.revision === headlessExecutableRevision(entry, program)
    || !program.packageRoot && record.executable === program.executable && record.revision === entry.headless.revision
      && record.size === program.size && typeof record.mtimeMs === 'number' && Math.trunc(record.mtimeMs) === program.mtimeMs;
  return matched ? null : headlessDiagnostic('HEADLESS_PREFLIGHT_FAILED', { check: 'recorded-program-mismatch' });
}
/** R8: verified version for this executable and registry revision, read without a spawn. */
export async function readHeadlessSealedVersion(definition: NativeCliHeadlessDefinition, family: string): Promise<string | null> {
  const { record } = await readPreflight(definition), version = verifiedCliVersion(record?.version);
  return record?.state === 'open' && version !== null && !await currentPreflightRefusal(record, family, definition)
    && compareToolchainVersions(version, definition.minCliVersion) >= 0 ? version : null;
}
/** Doctor (read-soft, no spawn): each subscription connection of the scope with its last preflight record's state, login kind and isolation (S3-5:
 * the launcher a passing check ran in, or `unavailable` when the realm closed the channel; `unknown`: no record yet), f5 its gateway refusals and s3c whether
 * its login dir is one of `ownedRoot` (the Brain's own login dirs, by realpath; null: none exists). */
export async function readHeadlessLogins(section: unknown, scopeId: string, ownedRoot: string | null = null) {
  const profiles = ((section as { profiles?: unknown } | undefined)?.profiles as
    { scopeId?: unknown; protocol?: { family?: string }; adapter?: { id: string; version: number; definition?: unknown } }[] | undefined) ?? [];
  const text = (value: unknown) => typeof value === 'string' ? value.slice(0, 64) : null;
  return Promise.all(profiles.flatMap(profile => { const definition = profile.scopeId === scopeId && profile.adapter && isNativeCliHeadlessAdapter(profile.adapter)
    ? nativeCliHeadlessDefinitionSchema.safeParse(profile.adapter.definition) : null;
  return definition?.success ? [{ definition: definition.data, family: profile.protocol?.family }] : []; }).map(async ({ definition, family }) => {
    const observed = await readPreflight(definition), prior = observed.record;
    const identified = isIdentifiedOpenPreflight(prior);
    const mismatch = prior?.state !== 'open' ? null : !identified ? preflightRecordDiagnostic()
      : family ? await currentPreflightRefusal(prior, family, definition) : headlessDiagnostic('HEADLESS_REQUEST_INVALID', { reason: 'program-definition' });
    const record = mismatch ? null : prior;
    const closed = record?.state === 'closed' ? readHeadlessDiagnosticRecord(record.refusal, record.check) : null;
    const diagnostic = observed.diagnostic ?? mismatch ?? closed;
    const egress = await readEgress(definition.stateDir).then(value => value === undefined ? { egress: null, egressUnreadable: true } : { egress: value },
      () => ({ egress: null, egressUnreadable: true }));
    const isolation = record?.state === 'open' && text(record.isolation?.version) ? { launcher: text(record.isolation?.launcher) ?? '-', version: text(record.isolation?.version)! }
      : closed?.code === 'HEADLESS_ISOLATION_UNAVAILABLE' ? 'unavailable' as const : null;
    return Object.freeze({ state: !record ? 'unknown' as const : record.state === 'open' ? 'open' as const : 'closed' as const, authMethod: text(record?.auth?.authMethod),
      // s3c: whether the connection uses the Brain's own login dir (a sealed older one keeps working; the doctor suggests the move).
      subscriptionType: text(record?.auth?.subscriptionType), configDir: definition.configDir,
      ...(ownedRoot !== null && { owned: dirname(definition.configDir) === ownedRoot }),
      consent: definition.delegatedUse?.classes ?? [], isolation,
      // S7: the CLI behind the connected path changed version since an earlier passing check (`doctor.headless.updated`).
      cliUpdated: record?.state === 'open' && text(record.updatedFrom) && text(record.version) ? { cli: basename(definition.executable), from: text(record.updatedFrom)!, to: text(record.version)! } : null,
      ...egress, ...(diagnostic && { diagnostic }) });
  }));
}
