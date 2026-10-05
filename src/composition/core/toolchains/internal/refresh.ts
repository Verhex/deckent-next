import { setTimeout as wait } from 'node:timers/promises';
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig, inspectProductDirectory, prepareProductDirectory, writeJsonAtomic, type ConfigLoadOptions } from '#platform/index.js';
import { refreshAuditName, refreshIntervalMs, refreshInProgress, refreshStatus, refreshTriggerAllowed, toolchainRefreshStateSchema, reviseRegistryForProposal, type ToolchainRefreshState, type ToolchainRefreshTrigger } from '#engine/index.js';
import { createConfiguredConfigApplication, resolveConfiguredConfigPrincipal } from '#composition/core/config/index.js';
import { updateConfiguredToolchains, writeArtifact, type ToolchainUpdateDependencies } from './update.js';

/** Typed event of one refresh: `started` when a build was admitted, then exactly one of `current` or `failed` (WORKER-AUTO-REFRESH). */
export type ToolchainRefreshEvent = Readonly<{ schemaVersion: 1; event: 'toolchain-refresh'; phase: 'started' | 'current' | 'failed'; trigger: ToolchainRefreshTrigger;
  imageVersion: string | null; imageId: string | null; appliedProfiles: number; code: string | null }>;
export interface ToolchainRefreshObserver { onToolchainRefresh?(event: ToolchainRefreshEvent): void | Promise<void> }
/** Grace added to the build timeout before an `updating` marker stops counting as in flight. */
const MARKER_GRACE_MS = 60_000;
const failureCode = (error: unknown) => (error && typeof error === 'object' && 'code' in error && typeof (error as { code: unknown }).code === 'string' ? (error as { code: string }).code : 'UNKNOWN').slice(0, 128);

async function toolchainHome(projectRoot: string, options: ConfigLoadOptions) {
  const config = await loadConfig(projectRoot, options);
  return { config, home: join(await prepareProductDirectory(config.productLayout, 'workspaces'), 'toolchains') };
}
/** The durable refresh marker (null when none was ever written or it is unreadable). Admission, doctor and monitor read it; only the refresh writes it. */
export async function readToolchainRefreshState(projectRoot: string, options: ConfigLoadOptions = {}): Promise<ToolchainRefreshState | null> {
  try {
    // Read-only (monitor, admission, doctor): never creates a directory.
    const home = join(await inspectProductDirectory((await loadConfig(projectRoot, options)).productLayout, 'workspaces'), 'toolchains');
    const parsed = toolchainRefreshStateSchema.safeParse(JSON.parse(await readFile(join(home, 'refresh-state.json'), 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}
/** The operator view of the marker (doctor, monitor): status, typed reason and the image version it concerns. */
export async function inspectToolchainRefresh(projectRoot: string, options: ConfigLoadOptions = {}) {
  const state = await readToolchainRefreshState(projectRoot, options);
  return { ...refreshStatus(state, Date.now()), imageVersion: state?.imageVersion ?? null };
}
/** True while a refresh is in flight and inside its own bound (admission carries a warning instead of refusing a stale pin). */
export async function isToolchainRefreshInProgress(projectRoot: string, options: ConfigLoadOptions = {}): Promise<boolean> {
  return refreshInProgress(await readToolchainRefreshState(projectRoot, options), Date.now());
}
async function writeState(home: string, state: ToolchainRefreshState) { await mkdir(home, { recursive: true, mode: 0o700 }); await writeJsonAtomic(join(home, 'refresh-state.json'), state); }

export type ToolchainRefreshOutcome = Readonly<{ outcome: 'skipped' | 'current' | 'failed'; event: ToolchainRefreshEvent | null }>;
export interface ToolchainRefreshDependencies extends ToolchainUpdateDependencies { readonly signal?: AbortSignal; readonly now?: () => string }
/**
 * One refresh: policy gate, durable `updating` marker, the existing update path with apply (plan, daemon preflight, build, receipt, proposal),
 * then the proposal applied as a governed `admission.registry` config write (new profile versions only; old versions and every admitted Run
 * stay as they were). Every attempt leaves an audit record under `toolchains/refreshes`; a failure keeps the previous registry and image.
 */
export async function refreshConfiguredToolchains(projectRoot: string, trigger: ToolchainRefreshTrigger, options: ConfigLoadOptions = {},
  dependencies: ToolchainRefreshDependencies = {}, observer: ToolchainRefreshObserver = {}): Promise<ToolchainRefreshOutcome> {
  const { config, home } = await toolchainHome(projectRoot, options);
  const policy = config.toolchains.update;
  if (!refreshTriggerAllowed(policy, trigger)) return Object.freeze({ outcome: 'skipped', event: null });
  const now = dependencies.now ?? (() => new Date().toISOString()); const startedAt = now();
  const base = { schemaVersion: 1 as const, trigger, startedAt, expiresAt: new Date(Date.parse(startedAt) + policy.buildTimeoutMs + MARKER_GRACE_MS).toISOString() };
  const emit = async (phase: ToolchainRefreshEvent['phase'], extra: Partial<ToolchainRefreshEvent> = {}) => {
    const event: ToolchainRefreshEvent = Object.freeze({ schemaVersion: 1, event: 'toolchain-refresh', phase, trigger, imageVersion: null, imageId: null, appliedProfiles: 0, code: null, ...extra });
    try { await observer.onToolchainRefresh?.(event); } catch { /* an observer never settles or fails a refresh */ }
    return event;
  };
  await writeState(home, { ...base, phase: 'updating', finishedAt: null, imageVersion: null, imageId: null, staleProviders: [], appliedProfiles: 0, reason: null });
  let result: Awaited<ReturnType<typeof updateConfiguredToolchains>> | null = null; let applied = 0; let configWrite: unknown = null; let code: string | null = null;
  try {
    await emit('started');
    result = await updateConfiguredToolchains(projectRoot, { apply: true }, options, dependencies);
    if (result.decision === 'built' && result.proposal) {
      if (dependencies.signal?.aborted) throw Object.assign(new Error('REFRESH_STOPPED'), { code: 'REFRESH_STOPPED' });
      // The registry is re-read after the long build, so an edit made meanwhile is revised, never overwritten by the pre-build copy.
      const fresh = await loadConfig(projectRoot, { ...options, force: true });
      const revision = reviseRegistryForProposal(fresh.admission?.registry, result.proposal);
      if (revision) {
        const scopeId = (config as unknown as { terminal?: { scopeId?: string } }).terminal?.scopeId;
        if (!scopeId) throw Object.assign(new Error('TERMINAL_SCOPE_REQUIRED'), { code: 'TERMINAL_SCOPE_REQUIRED' });
        const principal = await resolveConfiguredConfigPrincipal(projectRoot, scopeId, options);
        configWrite = await createConfiguredConfigApplication(projectRoot, options).set({ keyPath: 'admission.registry', value: revision.registry, layer: 'project',
          principal, scopeId, commandId: `toolchain-refresh-${startedAt}` });
        applied = revision.applied.length;
      }
    }
  } catch (error) { code = failureCode(error); }
  const finishedAt = now();
  const imageId = result?.build?.imageId ?? null, imageVersion = result?.plan?.next?.imageVersion ?? null;
  const state: ToolchainRefreshState = { ...base, phase: code ? 'failed' : 'current', finishedAt, imageVersion, imageId, staleProviders: result?.plan?.staleProviders ?? [], appliedProfiles: applied, reason: code };
  try { await writeState(home, state); } catch { /* the audit record below still states the outcome */ }
  try { await writeArtifact(join(home, 'refreshes'), refreshAuditName(startedAt, trigger), { schemaVersion: 1, kind: 'toolchain-refresh-audit', state, decision: result?.decision ?? null,
    planPath: result?.planPath ?? null, receiptPath: result?.build?.receiptPath ?? null, proposalPath: result?.proposalPath ?? null, configWrite }); } catch { /* idempotent per millisecond; never fails the refresh */ }
  const event = await emit(code ? 'failed' : 'current', { imageVersion, imageId, appliedProfiles: applied, code });
  return Object.freeze({ outcome: code ? 'failed' : 'current', event });
}

export interface ToolchainRefreshHandle { readonly done: Promise<void> }
/**
 * The service's refresh schedule: one start refresh and, when `intervalMs` is positive, one per interval. Never awaited by readiness,
 * single-flight (a trigger that arrives while a refresh runs joins it), and the interval timer is cancelled by `signal`. Failures reach the
 * observer as a typed event, never as an unhandled rejection.
 */
export function startToolchainRefresh(projectRoot: string, options: ConfigLoadOptions, observer: ToolchainRefreshObserver, signal: AbortSignal,
  dependencies: ToolchainRefreshDependencies = {}): ToolchainRefreshHandle {
  let inflight: Promise<unknown> | null = null;
  const run = (trigger: ToolchainRefreshTrigger) => {
    if (inflight) return inflight;
    inflight = refreshConfiguredToolchains(projectRoot, trigger, options, { ...dependencies, signal }, observer)
      .catch(() => undefined).finally(() => { inflight = null; });
    return inflight;
  };
  const done = (async () => {
    let intervalMs = 0;
    try { intervalMs = refreshIntervalMs((await loadConfig(projectRoot, options)).toolchains.update); } catch { return; }
    if (!signal.aborted) await run('startup');
    while (intervalMs > 0 && !signal.aborted) {
      try { await wait(intervalMs, undefined, { signal }); } catch { return; }
      if (!signal.aborted) await run('interval');
    }
  })();
  void done.catch(() => undefined);
  return Object.freeze({ done });
}
