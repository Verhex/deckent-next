import { configuredHeadlessLoginRoot } from '#composition/core/model-connect/index.js';
import { join } from 'node:path';
import { ENCRYPTED_FILE_SECRET_STORE_ID, ENCRYPTED_FILE_SECRET_STORE_KEY, ENCRYPTED_FILE_SECRET_STORE_NAME, FILE_SECRET_STORE_ID, FILE_SECRET_STORE_NAME, mcpGlobalRoot,
  mcpRegistryPaths, readSecretsConfig, runtimeSocketLocation } from '#adapters/index.js';
import { loadConfig, normalizeGlobalScopePlatform, resolveGlobalScopePaths, type ConfigLoadOptions } from '#platform/index.js';
/** C-ADMIN (`paths`, `runtime`), read-only: the socket really used (short `/tmp/dk-<uid>-<sha256>/s`: a Unix socket path holds at most 108 bytes),
 * the MCP definition files and the selected Core secret store's files (an extension store names none). */
export async function inspectConfiguredAdminPaths(projectRoot: string, options: ConfigLoadOptions = {}) {
  const config = await loadConfig(projectRoot, { ...options, heal: false }), env = options.env ?? process.env, store = readSecretsConfig(config).store;
  const attempt = <T>(read: () => T): T | null => { try { return read(); } catch { return null; } };
  const state = attempt(() => resolveGlobalScopePaths(normalizeGlobalScopePlatform(options.platform ?? process.platform, env), env).stateDir);
  const files = !state ? [] : store === FILE_SECRET_STORE_ID ? [join(state, FILE_SECRET_STORE_NAME)]
    : store === ENCRYPTED_FILE_SECRET_STORE_ID ? [join(state, ENCRYPTED_FILE_SECRET_STORE_NAME), join(state, ENCRYPTED_FILE_SECRET_STORE_KEY)] : [];
  return { schemaVersion: 1 as const, runtimeSocket: attempt(() => runtimeSocketLocation(config.productLayout)), mcp: attempt(() => mcpRegistryPaths(config.projectRoot, mcpGlobalRoot(env))),
    headlessLogins: attempt(() => configuredHeadlessLoginRoot(options)), secretStore: { store, files, keyFile: store === ENCRYPTED_FILE_SECRET_STORE_ID && state ? join(state, ENCRYPTED_FILE_SECRET_STORE_KEY) : null } };
}
