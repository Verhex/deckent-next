export type { MonitorLedgerOptions } from './internal/reader.js';
/** MONITOR-DATA: read-only monitor view of an existing ledger; loads the native driver only when composition selects this reader. */
export async function readMonitorLedger(path: string, options: import('./internal/reader.js').MonitorLedgerOptions) {
  const { readMonitorLedger: read } = await import('./internal/reader.js');
  return read(path, options);
}
/** M-VIS: scope and pool ids of a ledger file (no Run, occupancy or holder is read). */
export async function indexMonitorLedger(path: string, options: { busyTimeoutMs: number }) {
  const { indexMonitorLedger: index } = await import('./internal/reader.js');
  return index(path, options);
}
/** Metadata-only monitor capture. Use prepareMonitorInstall.readShown for selected, policy-gated content. */
export async function readMonitorInstall(config: import('#platform/index.js').ResolvedConfig, env: import('#platform/index.js').Environment | undefined,
  readOutput: (identity: import('#domain/index.js').AttemptIdentity) => Promise<boolean>) {
  const { readMonitorInstall: read } = await import('./internal/install.js');
  return read(config, env, readOutput);
}

/** Capture one ledger snapshot; hydrate only the application's shown exact identities outside its transaction. */
export async function prepareMonitorInstall(config: import('#platform/index.js').ResolvedConfig, env: import('#platform/index.js').Environment | undefined,
  readOutput: (identity: import('#domain/index.js').AttemptIdentity) => Promise<boolean>, run?: { scopeId: string; runId: string }, scope?: import('#engine/index.js').MonitorReadScope) {
  const { prepareMonitorInstall: prepare } = await import('./internal/install.js');
  return prepare(config, env, readOutput, run, undefined, undefined, scope);
}
/** M-VIS: scope and pool ids of the install's ledger, for admission before the scoped read. */
export async function indexMonitorInstall(config: import('#platform/index.js').ResolvedConfig) {
  const { indexMonitorInstall: index } = await import('./internal/install.js');
  return index(config);
}
/** MON-CPU-FIX: the viewer and the stat identity of the install's ledger, policy, bindings and config layer files (nothing opened or read). */
export async function stampMonitorInstall(config: import('#platform/index.js').ResolvedConfig, options?: { readonly env?: import('#platform/index.js').Environment; readonly platform?: string }) {
  const { stampMonitorInstall: stamp } = await import('./internal/install.js');
  return stamp(config, options);
}

export { readMonitorRunResults } from './internal/run-brief.js';
export { listSurfaceRunIds, followLedgerSurface, type RuntimeSurfaceEvent } from './internal/surface-follow.js';
export { readMonitorWorkerContent } from './internal/worker-content.js';
