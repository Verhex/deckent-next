import { readFile, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { BUBBLEWRAP_BUNDLED, BUBBLEWRAP_BUNDLED_MAX_BYTES } from '#adapters/core/shell-sandbox-bwrap/index.js';
import { LocalRuntimeSocketError, runtimeSocketLocation, prepareRuntimeSocket } from '#adapters/core/local-runtime-socket/index.js';
import { openSqliteLedgerReadOnly, requireLedgerVersion, CURRENT_LEDGER_VERSION } from '#adapters/core/sqlite-ledger/index.js';
import { ErrorRegistry, inspectProductFile, productResourcePath, resolveLocale, type ConfigLoadOptions, type loadConfig } from '#platform/index.js';
import { FilePolicySource } from '#adapters/core/file-policy/index.js';


export interface InstallationStartability {
  readonly status: 'ready' | 'blocked'; readonly endpoint: string | null;
  readonly checks: readonly { readonly code: string; readonly message: string }[];
}
/** Network-free read only: no config healing, migrations, socket directories, service starts or sandbox copies. */
export async function inspectInstallationStartabilityFiles(config: Awaited<ReturnType<typeof loadConfig>>, options: ConfigLoadOptions = {}): Promise<InstallationStartability> {
  const locale = resolveLocale(undefined, options.env, config.language);
  const checks: { code: string; message: string }[] = [];
  const add = (code: string, detail: string) => {
    const error = ErrorRegistry.createError(code, { locale, params: { detail } });
    checks.push({ code, message: error.message });
  };
  const terminal = config.terminal as { scopeId?: string; chat?: unknown } | undefined;
  const missing = [...(!config.cancellation ? ['cancellation'] : []), ...(!config.cancellationRuntime ? ['cancellationRuntime'] : []),
    ...(!terminal?.scopeId ? ['terminal.scopeId'] : []), ...(!terminal?.chat ? ['terminal.chat'] : [])];
  if (missing.length) add('DOCTOR_CONFIG_INCOMPLETE', missing.join(', '));
  try {
    const path = await inspectProductFile(config.productLayout, 'ledger', ['-wal', '-shm', '-journal']);
    const db = openSqliteLedgerReadOnly(path, config.storage.sqlite);
    try { requireLedgerVersion(db, CURRENT_LEDGER_VERSION); } finally { db.close(); }
  } catch (error) { add('DOCTOR_LEDGER_UNAVAILABLE', (error as { code?: string }).code ?? 'unreadable'); }
  let endpoint: string | null = null;
  try {
    endpoint = runtimeSocketLocation(config.productLayout);
    try { await prepareRuntimeSocket(config.productLayout, false); }
    catch (error) { if (!(error instanceof LocalRuntimeSocketError) || error.code !== 'LOCAL_RUNTIME_UNAVAILABLE') throw error; }
  } catch (error) { add('DOCTOR_SOCKET_UNAVAILABLE', (error as { path?: string; code?: string }).path ?? (error as { code?: string }).code ?? 'unreadable'); }
  try {
    if (!process.getuid) throw new LocalRuntimeSocketError('LOCAL_RUNTIME_UNSUPPORTED');
    await new FilePolicySource({ path: productResourcePath(config.productLayout, 'policy'), bindingsPath: productResourcePath(config.productLayout, 'bindings'), ownerUid: process.getuid(), maxBytes: config.inspection.policyMaxBytes }).load();
  } catch (error) { add('DOCTOR_POLICY_UNREADABLE', (error as { code?: string }).code ?? 'unreadable'); }
  const path = fileURLToPath(new URL(`../../shell-sandbox-bwrap/bundled/linux-${process.arch}/bwrap`, import.meta.url));
  try {
    const expected = BUBBLEWRAP_BUNDLED.sha256[process.arch], stat = await lstat(path);
    if (process.platform !== 'linux' || !expected || !stat.isFile() || stat.isSymbolicLink() || stat.size > BUBBLEWRAP_BUNDLED_MAX_BYTES
      || createHash('sha256').update(await readFile(path)).digest('hex') !== expected) throw new Error('digest/type/platform');
  } catch { add('DOCTOR_BUBBLEWRAP_NOT_STAGED', path); }
  return Object.freeze({ status: checks.length ? 'blocked' : 'ready', endpoint, checks: Object.freeze(checks) });
}
