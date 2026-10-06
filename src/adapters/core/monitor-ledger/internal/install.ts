import { userInfo } from 'node:os';
import { dirname } from 'node:path';
import { CONFIG_FIELDS, createDefaultConfig, envValue, inspectProductDirectory, inspectProductFile, loadGlobalConfig, productResourcePath, readJsonFile, resolveGlobalConfigReadPath,
  resolveProductLayout, type Environment, type ResolvedConfig } from '#platform/index.js';
import { sameAttemptIdentity, executionRegistrySchema, workerEventSchema, type AttemptIdentity, type WorkerEvent } from '#domain/index.js';
import { readLocalOsIdentity } from '#adapters/core/local-principal/index.js';
import { extractFirstFailure, extractFailedTests, parseRetainedOutputEnvelope, summarizeMonitorEvent, type MonitorWorkerContent, type MonitorEvent, type MonitorLedgerReading, type MonitorMap, type MonitorFailedTests } from '#engine/index.js';
import { FileArtifactStore } from '#adapters/core/file-artifacts/index.js';
import { FilePolicySource } from '#adapters/core/file-policy/index.js';
import { readWorkerEventTail, readWorkerSidecars } from '#adapters/core/worker-observation/index.js';
import { emptyWorkerContent, readMonitorWorkerContent } from './worker-content.js';
import { scanMonitorLedger, type MonitorAttemptFiles } from './reader.js';
import limits from './display-limits.json' with { type: 'json' };

/** MONITOR v1.1 bounds: recorded outputs larger than this are not parsed for a first failure; events kept per attempt; live tail bytes. */
export const MONITOR_OUTPUT_MAX_BYTES = 8 * 1024 * 1024, MONITOR_RECENT_EVENTS = 10, MONITOR_EVENT_TAIL_BYTES = 65_536, MONITOR_FAILED_TESTS = limits.maxFailedTests;
// Content-addressed outputs never change, so a first failure is computed once per (scope, digest) and kept in a small bounded cache.
const failures = new Map<string, { readonly line: string | null; readonly failedTests: MonitorFailedTests | null }>();
const code = (error: unknown) => error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'UNKNOWN';
const recent = (events: readonly { readonly atMs: number | null; readonly event: WorkerEvent }[]): readonly MonitorEvent[] =>
  Object.freeze(events.slice(-MONITOR_RECENT_EVENTS).map(({ atMs, event }) => Object.freeze({ atMs, ...summarizeMonitorEvent(event) })));

/** Capture one read-only ledger transaction and its file identities. Content is deferred until readShown:
 * only exact selected identities pass through read-output, then artifact/sidecar reads outside the transaction.
 * No product files, state or policy are created or healed. */
export async function prepareMonitorInstall(config: ResolvedConfig, env: Environment | undefined, readOutput: (identity: AttemptIdentity) => Promise<boolean>, run?: { scopeId: string; runId: string }) {
  const layout = config.productLayout;
  const scan = scanMonitorLedger(await inspectProductFile(layout, 'ledger', ['-wal', '-shm', '-journal']),
    { busyTimeoutMs: config.storage.sqlite.busyTimeoutMs, maxRuns: config.inspection.maxPageSize, ...(run ? { run } : {}) });
  const diagnostics = [...scan.reading.diagnostics];
  const artifacts = FileArtifactStore.reader(() => inspectProductDirectory(layout, 'artifacts'), config.artifacts.maxBytes);
  const map = run ? scan.reading.map ?? null : await installMap(config, env ?? process.env, scan.reading.map ?? null, diagnostics);
  const reading = Object.freeze({ ...scan.reading, map, diagnostics: Object.freeze([...diagnostics]) });
  return { reading, async readShown(identities: readonly AttemptIdentity[]): Promise<MonitorLedgerReading> {
    const selected = scan.files.filter(files => identities.some(identity => sameAttemptIdentity(identity, files.identity)));
    const extra = new Map<string, { content?: MonitorWorkerContent; firstFailure?: string | null; failedTests?: MonitorFailedTests; recentEvents?: readonly MonitorEvent[]; diagnostics?: readonly string[]; observedEndAtMs?: number | null }>();
    for (const files of selected) {
      const key = `${files.identity.scopeId}/${files.identity.attemptId}`;
      try {
        // Security: recorded output and worker events are content of the attempt — read only after its read-output decision (workers list/transcript).
        const needsEnd = files.finished && !files.sealed && !!files.workspace;
        if (!(await readOutput(files.identity))) { extra.set(key, { content: emptyWorkerContent('denied'), firstFailure: null, diagnostics: ['output-denied'] }); continue; }
        const found: { content?: MonitorWorkerContent; firstFailure?: string | null; failedTests?: MonitorFailedTests; recentEvents?: readonly MonitorEvent[]; observedEndAtMs?: number | null } = { content: await readMonitorWorkerContent(artifacts, files) };
        if (files.failed) {
          const failure = await failureEvidence(artifacts, files);
          Object.assign(found, { firstFailure: failure.line, ...(failure.failedTests ? { failedTests: failure.failedTests } : {}), ...(files.events ? { recentEvents: await sealedEvents(artifacts, files) } : {}) });
        }
        else if (files.open && files.workspace) found.recentEvents = recent((await readWorkerEventTail(dirname(files.workspace), 'worker', MONITOR_EVENT_TAIL_BYTES))
          .map(line => ({ atMs: line.receivedAt, event: line.event })));
        if (needsEnd) found.observedEndAtMs = await observedEnd(config, files);
        if (Object.keys(found).length) extra.set(key, found);
      } catch (error) { extra.set(key, { content: emptyWorkerContent('unavailable') }); diagnostics.push(`attempt-files-unavailable:${key}:${code(error)}`); }
    }
    const runs = reading.runs.map(run => Object.freeze({ ...run, attempts: Object.freeze(run.attempts.map(value => {
      const found = extra.get(`${run.snapshot.identity.scopeId}/${value.attemptId}`); return found ? Object.freeze({ ...value, ...found }) : value;
    })) }));
    return Object.freeze({ ...reading, runs: Object.freeze(runs), map: reading.map, diagnostics: Object.freeze(diagnostics) });
  } };
}
/** Metadata only. Artifact reads are explicitly deferred until the application selects its visible worker set. */
export async function readMonitorInstall(config: ResolvedConfig, env: Environment | undefined, readOutput: (identity: AttemptIdentity) => Promise<boolean>) {
  return (await prepareMonitorInstall(config, env, readOutput)).reading;
}

// An exited attempt's sidecar log no longer changes: its observed end is kept once found.
const ends = new Map<string, number>();
/** The host's own exit observation (`worker.log` `exited` event, host clock) in the attempt's sidecar directory, identity-bound through the
 * sidecar result; null when the sidecars are gone (custody released), unreadable or bound to another attempt. */
async function observedEnd(config: ResolvedConfig, files: MonitorAttemptFiles): Promise<number | null> {
  // Keyed by the sidecar directory too: equal scope/attempt ids of another installation never share an end.
  const key = `${files.workspace}\0${files.identity.scopeId}/${files.identity.attemptId}`; if (ends.has(key)) return ends.get(key)!;
  const sidecars = await readWorkerSidecars(dirname(files.workspace!), 'worker', config.inspection.workers, undefined, files.identity).catch(() => null);
  if (!sidecars || sidecars.result.state !== 'available') return null;
  const exit = sidecars.log.events.filter(event => event.process === 'exited').at(-1)?.observedAt ?? null;
  if (exit !== null) { if (ends.size >= 1024) ends.delete(ends.keys().next().value!); ends.set(key, exit); }
  return exit;
}
/** First failing line and failed tests of one recorded output: computed once per (scope, digest) (content-addressed, never changes), bounded by MONITOR_OUTPUT_MAX_BYTES. */
async function failureEvidence(artifacts: ReturnType<typeof FileArtifactStore.reader>, files: MonitorAttemptFiles) {
  const output = files.output; if (!output || output.byteLength > MONITOR_OUTPUT_MAX_BYTES) return { line: null, failedTests: null };
  const key = `${output.scopeId}/${output.digest}`;
  const known = failures.get(key); if (known) return known;
  const envelope = parseRetainedOutputEnvelope(await artifacts.read(files.identity.scopeId, output), files.identity);
  const found = { line: extractFirstFailure(envelope.stdout, envelope.stderr), failedTests: extractFailedTests(envelope.stdout, MONITOR_FAILED_TESTS, envelope.completeness === 'complete') };
  if (failures.size >= 256) failures.delete(failures.keys().next().value!);
  failures.set(key, found); return found;
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
