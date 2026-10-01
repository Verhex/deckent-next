import { userInfo } from 'node:os';
import { dirname } from 'node:path';
import { CONFIG_FIELDS, createDefaultConfig, envValue, inspectProductDirectory, inspectProductFile, loadGlobalConfig, productResourcePath, readJsonFile, resolveGlobalConfigReadPath,
  resolveProductLayout, type Environment, type ResolvedConfig } from '#platform/index.js';
import { executionRegistrySchema, workerEventSchema, type AttemptIdentity, type WorkerEvent } from '#domain/index.js';
import { readLocalOsIdentity } from '#adapters/core/local-principal/index.js';
import { extractFirstFailure, parseRetainedOutputEnvelope, summarizeMonitorEvent, type MonitorEvent, type MonitorLedgerReading, type MonitorMap } from '#engine/index.js';
import { FileArtifactStore } from '#adapters/core/file-artifacts/index.js';
import { FilePolicySource } from '#adapters/core/file-policy/index.js';
import { readWorkerEventTail } from '#adapters/core/worker-observation/index.js';
import { scanMonitorLedger, type MonitorAttemptFiles } from './reader.js';

/** MONITOR v1.1 bounds: recorded outputs larger than this are not parsed for a first failure; events kept per attempt; live tail bytes. */
export const MONITOR_OUTPUT_MAX_BYTES = 8 * 1024 * 1024, MONITOR_RECENT_EVENTS = 10, MONITOR_EVENT_TAIL_BYTES = 65_536;
// Content-addressed outputs never change, so a first failure is computed once per (scope, digest) and kept in a small bounded cache.
const failures = new Map<string, string | null>();
const code = (error: unknown) => error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'UNKNOWN';
const recent = (events: readonly { readonly atMs: number | null; readonly event: WorkerEvent }[]): readonly MonitorEvent[] =>
  Object.freeze(events.slice(-MONITOR_RECENT_EVENTS).map(({ atMs, event }) => Object.freeze({ atMs, ...summarizeMonitorEvent(event) })));

/**
 * MONITOR v1.1: everything the monitor reads about one installation from its resolved config, read-only. The ledger view, then — outside
 * its transaction — the first failing line of each failed attempt's recorded output, the last worker events of failed (sealed log) and
 * running (live tail) attempts, and the install map (config layers, registry, model catalog, policy summary, memory). Every secondary read
 * failure is a typed diagnostic; nothing is created or written.
 */
export async function readMonitorInstall(config: ResolvedConfig, env: Environment | undefined, readOutput: (identity: AttemptIdentity) => Promise<boolean>): Promise<MonitorLedgerReading> {
  const layout = config.productLayout;
  const scan = scanMonitorLedger(await inspectProductFile(layout, 'ledger', ['-wal', '-shm', '-journal']),
    { busyTimeoutMs: config.storage.sqlite.busyTimeoutMs, maxRuns: config.inspection.maxPageSize });
  const diagnostics = [...scan.reading.diagnostics];
  const artifacts = FileArtifactStore.reader(() => inspectProductDirectory(layout, 'artifacts'), config.artifacts.maxBytes);
  const extra = new Map<string, { firstFailure?: string | null; recentEvents?: readonly MonitorEvent[]; diagnostics?: readonly string[] }>();
  for (const files of scan.files) {
    const key = `${files.identity.scopeId}/${files.identity.attemptId}`;
    try {
      // Security: recorded output and worker events are content of the attempt — read only after its read-output decision (workers list/transcript).
      if ((files.failed || (files.open && files.workspace)) && !(await readOutput(files.identity))) { extra.set(key, { firstFailure: null, diagnostics: ['output-denied'] }); continue; }
      if (files.failed) extra.set(key, { firstFailure: await firstFailure(artifacts, files), ...(files.events ? { recentEvents: await sealedEvents(artifacts, files) } : {}) });
      else if (files.open && files.workspace) extra.set(key, { recentEvents: recent((await readWorkerEventTail(dirname(files.workspace), 'worker', MONITOR_EVENT_TAIL_BYTES))
        .map(line => ({ atMs: line.receivedAt, event: line.event }))) });
    } catch (error) { diagnostics.push(`attempt-files-unavailable:${key}:${code(error)}`); }
  }
  const runs = scan.reading.runs.map(run => Object.freeze({ ...run, attempts: Object.freeze(run.attempts.map(value => {
    const found = extra.get(`${run.snapshot.identity.scopeId}/${value.attemptId}`); return found ? Object.freeze({ ...value, ...found }) : value;
  })) }));
  const map = await installMap(config, env ?? process.env, scan.reading.map ?? null, diagnostics);
  return Object.freeze({ ...scan.reading, runs: Object.freeze(runs), map, diagnostics: Object.freeze(diagnostics) });
}

async function firstFailure(artifacts: ReturnType<typeof FileArtifactStore.reader>, files: MonitorAttemptFiles): Promise<string | null> {
  const output = files.output; if (!output || output.byteLength > MONITOR_OUTPUT_MAX_BYTES) return null;
  const key = `${output.scopeId}/${output.digest}`;
  if (failures.has(key)) return failures.get(key)!;
  const envelope = parseRetainedOutputEnvelope(await artifacts.read(files.identity.scopeId, output), files.identity);
  const line = extractFirstFailure(envelope.stdout, envelope.stderr);
  if (failures.size >= 256) failures.delete(failures.keys().next().value!);
  failures.set(key, line); return line;
}
/** The sealed (host-redacted) event log's last events; `atMs` is the worker's own clock there (untrusted, like the events). */
async function sealedEvents(artifacts: ReturnType<typeof FileArtifactStore.reader>, files: MonitorAttemptFiles) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(await artifacts.read(files.identity.scopeId, files.events!));
  return recent(text.split('\n').filter(Boolean).map(line => { const event = workerEventSchema.parse(JSON.parse(line)); return { atMs: event.atMs, event }; }));
}

/** Install map: config layers (top-level section names only, never values), execution registry, model catalog, policy summary, memory. */
async function installMap(config: ResolvedConfig, env: Environment, ledger: MonitorMap | null, diagnostics: string[]): Promise<MonitorMap> {
  const keys = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).sort() : [];
  const projectPath = productResourcePath(resolveProductLayout({ projectRoot: config.projectRoot, platform: 'posix' }), 'config');
  const project = await readJsonFile(projectPath); const globalPath = await resolveGlobalConfigReadPath(env);
  const global = await loadGlobalConfig({ env }).catch(() => { diagnostics.push('map-config-global-unavailable'); return null; });
  const environment = Object.entries(CONFIG_FIELDS).filter(([, field]) => field.environment.some(binding => binding.names.some(name => envValue(env, name) !== undefined)))
    .map(([key]) => key).sort();
  const registry = executionRegistrySchema.safeParse((config as unknown as { admission?: { registry?: unknown } | null }).admission?.registry);
  let policy: MonitorMap['policy'] = null;
  try {
    const document = await new FilePolicySource({ path: productResourcePath(config.productLayout, 'policy'), bindingsPath: productResourcePath(config.productLayout, 'bindings'),
      ownerUid: userInfo().uid, maxBytes: config.inspection.policyMaxBytes }).load();
    const byResourceKind: Record<string, number> = {};
    for (const grant of document.grants) byResourceKind[grant.resource.kind] = (byResourceKind[grant.resource.kind] ?? 0) + 1;
    // Like `inspectPermissionMode`, only the caller's own modes are shown; other persons' modes stay in the authority document.
    const self = readLocalOsIdentity();
    const modes = (document.schemaVersion === 2 ? document.bindings.modes ?? [] : []).filter(entry => entry.principal.issuer === self.issuer && entry.principal.subject === self.subject);
    policy = Object.freeze({ grants: document.grants.length, byResourceKind: Object.freeze(byResourceKind), separationOfDuties: document.schemaVersion === 2 ? document.separationOfDuties.length : 0,
      permissionModes: Object.freeze(modes.map(entry => Object.freeze({ principal: `${entry.principal.issuer}/${entry.principal.subject}`, mode: entry.mode }))) });
  } catch (error) { diagnostics.push('map-policy-unavailable:' + code(error)); }
  return Object.freeze({ models: ledger?.models ?? [], memory: { available: false },
    config: Object.freeze([{ layer: 'default' as const, path: null, sections: keys(createDefaultConfig()) },
      { layer: 'global' as const, path: globalPath, sections: keys(global) },
      { layer: 'project' as const, path: projectPath, sections: project.kind === 'ready' ? keys(project.value) : [] },
      { layer: 'environment' as const, path: null, sections: environment }]),
    registry: registry.success ? Object.freeze({ profiles: registry.data.profiles.map(value => ({ id: value.id, version: value.version, adapter: `${value.adapter.id}@${value.adapter.version}` })),
      kinds: registry.data.kinds.map(value => ({ kind: value.kind, profile: `${value.profile.id}@${value.profile.version}` })) }) : { profiles: [], kinds: [] },
    policy });
}
