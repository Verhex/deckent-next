import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { DeckentError, ErrorRegistry, loadConfig, prepareProductFile, type ConfigLoadOptions } from '#platform/index.js';
import { launchDetachedRuntimeService, openTerminalHistoryFile, readTerminalConfig, registerProviderConfig } from '#adapters/index.js';
import { randomUUID } from 'node:crypto';
import { createConfiguredRuntimeClient } from '#composition/core/runtime-service/index.js';
import type { RuntimeServiceDescriptor } from '#engine/index.js';

export interface RuntimeServiceReadiness {
  readonly mode: 'connected' | 'started';
  readonly instanceId: string;
  readonly pid: number | null;
  readonly logPath: string | null;
  readonly shutdownAvailable: boolean;
  readonly build: NonNullable<RuntimeServiceDescriptor['build']> | null;
}
const readiness = (mode: 'connected' | 'started', descriptor: RuntimeServiceDescriptor, pid: number | null, logPath: string | null): RuntimeServiceReadiness =>
  Object.freeze({ mode, instanceId: descriptor.instanceId, pid, logPath, shutdownAvailable: descriptor.shutdownAvailable, build: descriptor.build ?? null });
/** Only positive evidence of absence starts a service: no endpoint (or its never-created state directory) or a refused
 * connection (nothing listens). A peer that accepts but fails or stays silent may be a live incompatible or unhealthy
 * service, so it is reported, never replaced; ownership/unsafe failures are never auto-repaired (Astra 2054 R2). */
const ABSENT = new Set(['LOCAL_RUNTIME_UNAVAILABLE']);
const POLL_MS = 150;
const ENTRY = fileURLToPath(new URL('./entry.js', import.meta.url));

/** One monotonic deadline bounds every describe, including an accepting-but-silent peer (wall clock can step back). */
function monotonicDeadline(timeoutMs: number) {
  const until = performance.now() + timeoutMs;
  return { remaining: () => Math.max(0, until - performance.now()), expired: () => performance.now() >= until };
}
async function describeWithin(client: ReturnType<typeof createConfiguredRuntimeClient>, deadline: ReturnType<typeof monotonicDeadline>) {
  try { return { descriptor: await client.describeService(AbortSignal.timeout(Math.max(1, Math.ceil(deadline.remaining())))), code: null }; }
  catch (error) {
    const code = error instanceof DeckentError ? error.code : null;
    if (code !== null && ABSENT.has(code)) return { descriptor: null, code };
    throw error;
  }
}

/**
 * Owner 2026-09-23: the interactive terminal starts the local runtime service when none is running, as a detached
 * `runtime serve` of the same executable that keeps running after the terminal exits. An existing service is reused.
 * Readiness is proven only by a successful describe on the configured endpoint within the configured deadline; the
 * launch is reported as ours only when the answering service's process is the one launched.
 */
export async function ensureConfiguredRuntimeService(projectRoot: string, options: ConfigLoadOptions = {},
  launch = launchDetachedRuntimeService, entry = ENTRY): Promise<RuntimeServiceReadiness> {
  const client = createConfiguredRuntimeClient(projectRoot, options);
  registerProviderConfig();
  const config = await loadConfig(projectRoot, { ...options, heal: false });
  const timeoutMs = readTerminalConfig(config as Record<string, unknown>).serviceStartTimeoutMs;
  const first = await describeWithin(client, monotonicDeadline(timeoutMs));
  if (first.descriptor) return readiness('connected', first.descriptor, null, null);
  const logPath = await prepareProductFile(config.productLayout, 'runtimeLog');
  try { await access(entry); } catch { throw ErrorRegistry.createError('RUNTIME_AUTOSTART_FAILED', { params: { log: logPath } }); }
  const env = Object.fromEntries(Object.entries(options.env ?? process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  const { pid } = await launch({ executable: process.execPath, entry, cwd: projectRoot, logPath, env })
    .catch(() => { throw ErrorRegistry.createError('RUNTIME_AUTOSTART_FAILED', { params: { log: logPath } }); });
  const deadline = monotonicDeadline(timeoutMs);
  while (!deadline.expired()) {
    await delay(Math.min(POLL_MS, deadline.remaining()));
    if (deadline.expired()) break;
    const next = await describeWithin(client, deadline).catch(error => {
      // While our process starts, the endpoint may briefly accept before it answers; only the deadline ends the wait.
      if (error instanceof DeckentError && (error.code === 'LOCAL_RUNTIME_TRANSPORT' || error.code === 'RUNTIME_SERVICE_TRANSPORT')) return { descriptor: null, code: error.code };
      throw error;
    });
    // A concurrent terminal may have won the start race: its service is used, but it is not reported as our launch.
    if (next.descriptor) return next.descriptor.processId === pid ? readiness('started', next.descriptor, pid, logPath)
      : readiness('connected', next.descriptor, null, logPath);
  }
  throw ErrorRegistry.createError('RUNTIME_AUTOSTART_FAILED', { params: { log: logPath } });
}

/** Governed stop of this project's service without hand-written command fields: the durable command is built from the
 * live descriptor with a fresh command id. A service without a configured identity cannot be stopped this way. */
export async function stopConfiguredRuntimeService(projectRoot: string, options: ConfigLoadOptions = {}, reason = 'operator stop') {
  const client = createConfiguredRuntimeClient(projectRoot, options);
  const descriptor = await client.describeService();
  if (!descriptor.shutdownAvailable) throw ErrorRegistry.createError('RUNTIME_SHUTDOWN_UNAVAILABLE');
  const command = { schemaVersion: 1 as const, commandId: randomUUID(), serviceId: descriptor.identity.serviceId,
    instanceId: descriptor.instanceId, reason };
  return { command, result: await client.shutdownService(command) };
}

/** Stop the running service through governed shutdown, wait until its endpoint no longer answers, then start the current build. */
export async function restartConfiguredRuntimeService(projectRoot: string, options: ConfigLoadOptions = {}): Promise<RuntimeServiceReadiness> {
  await stopConfiguredRuntimeService(projectRoot, options, 'terminal restart onto the current build');
  const client = createConfiguredRuntimeClient(projectRoot, options);
  registerProviderConfig();
  const config = await loadConfig(projectRoot, { ...options, heal: false });
  const deadline = monotonicDeadline(readTerminalConfig(config as Record<string, unknown>).serviceStartTimeoutMs);
  while (!deadline.expired()) {
    try { await client.describeService(AbortSignal.timeout(Math.max(1, Math.ceil(deadline.remaining())))); }
    catch (error) {
      if (error instanceof DeckentError && ABSENT.has(error.code)) return ensureConfiguredRuntimeService(projectRoot, options);
      // The stopping service may close connections while it drains; keep waiting for absence until the deadline.
      if (!(error instanceof DeckentError && (error.code === 'LOCAL_RUNTIME_TRANSPORT' || error.code === 'RUNTIME_SERVICE_TRANSPORT'))) throw error;
    }
    await delay(Math.min(POLL_MS, deadline.remaining()));
  }
  throw ErrorRegistry.createError('RUNTIME_AUTOSTART_FAILED', { params: { log: '-' } });
}

/** The interactive terminal's composer history for this project, or null when disabled in `terminal.persistHistory`.
 * Entries that carried pasted content are not stored (only the visible line would survive, as a chip label). */
export async function openConfiguredTerminalHistory(projectRoot: string, options: ConfigLoadOptions = {}) {
  registerProviderConfig();
  const config = await loadConfig(projectRoot, { ...options, heal: false });
  if (!readTerminalConfig(config as Record<string, unknown>).persistHistory) return null;
  const file = openTerminalHistoryFile(await prepareProductFile(config.productLayout, 'terminalHistory'));
  return Object.freeze({
    load: () => file.load(),
    append: async (entry: { readonly text: string; readonly pastes: readonly unknown[] }) => { if (entry.pastes.length === 0) await file.append(entry); },
  });
}
