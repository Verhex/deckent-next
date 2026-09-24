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
/** A missing endpoint (or its never-created state directory on a fresh project) or a refused connection means no live
 * service; ownership/unsafe failures are never auto-repaired. */
const ABSENT = new Set(['LOCAL_RUNTIME_UNAVAILABLE', 'LOCAL_RUNTIME_TRANSPORT', 'RUNTIME_SERVICE_TRANSPORT', 'MANAGED_FILE_MISSING']);
const POLL_MS = 150;
const ENTRY = fileURLToPath(new URL('./entry.js', import.meta.url));

/**
 * Owner 2026-09-23: the interactive terminal starts the local runtime service when none is running, as a detached
 * `runtime serve` of the same executable that keeps running after the terminal exits. An existing service is reused.
 * Readiness is proven only by a successful describe on the configured endpoint within the configured deadline.
 */
export async function ensureConfiguredRuntimeService(projectRoot: string, options: ConfigLoadOptions = {},
  launch = launchDetachedRuntimeService, entry = ENTRY): Promise<RuntimeServiceReadiness> {
  const client = createConfiguredRuntimeClient(projectRoot, options);
  const describe = async () => {
    try { return { descriptor: await client.describeService(), code: null }; }
    catch (error) {
      const code = error instanceof DeckentError ? error.code : null;
      if (code !== null && ABSENT.has(code)) return { descriptor: null, code };
      throw error;
    }
  };
  const first = await describe();
  if (first.descriptor) return readiness('connected', first.descriptor, null, null);
  registerProviderConfig();
  const config = await loadConfig(projectRoot, { ...options, heal: false });
  const timeoutMs = readTerminalConfig(config as Record<string, unknown>).serviceStartTimeoutMs;
  const logPath = await prepareProductFile(config.productLayout, 'runtimeLog');
  try { await access(entry); } catch { throw ErrorRegistry.createError('RUNTIME_AUTOSTART_FAILED', { params: { log: logPath } }); }
  const env = Object.fromEntries(Object.entries(options.env ?? process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  const { pid } = await launch({ executable: process.execPath, entry, cwd: projectRoot, logPath, env })
    .catch(() => { throw ErrorRegistry.createError('RUNTIME_AUTOSTART_FAILED', { params: { log: logPath } }); });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await delay(POLL_MS);
    const next = await describe();
    // A concurrent terminal may have won the start race; any live service on the endpoint is the one to use.
    if (next.descriptor) return readiness('started', next.descriptor, pid, logPath);
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
  const deadline = Date.now() + readTerminalConfig(config as Record<string, unknown>).serviceStartTimeoutMs;
  while (Date.now() < deadline) {
    try { await client.describeService(); }
    catch (error) {
      if (error instanceof DeckentError && ABSENT.has(error.code)) return ensureConfiguredRuntimeService(projectRoot, options);
      throw error;
    }
    await delay(POLL_MS);
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
