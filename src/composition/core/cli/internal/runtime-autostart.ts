import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { DeckentError, ErrorRegistry, loadConfig, prepareProductFile, type ConfigLoadOptions } from '#platform/index.js';
import { launchDetachedRuntimeService, readTerminalConfig, registerProviderConfig } from '#adapters/index.js';
import { createConfiguredRuntimeClient } from '#composition/core/runtime-service/index.js';

export interface RuntimeServiceReadiness {
  readonly mode: 'connected' | 'started';
  readonly instanceId: string;
  readonly pid: number | null;
  readonly logPath: string | null;
}
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
  if (first.descriptor) return Object.freeze({ mode: 'connected', instanceId: first.descriptor.instanceId, pid: null, logPath: null });
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
    if (next.descriptor) return Object.freeze({ mode: 'started', instanceId: next.descriptor.instanceId, pid, logPath });
  }
  throw ErrorRegistry.createError('RUNTIME_AUTOSTART_FAILED', { params: { log: logPath } });
}
