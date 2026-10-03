export type { MonitorLedgerOptions } from './internal/reader.js';
/** MONITOR-DATA: read-only monitor view of an existing ledger; loads the native driver only when composition selects this reader. */
export async function readMonitorLedger(path: string, options: import('./internal/reader.js').MonitorLedgerOptions) {
  const { readMonitorLedger: read } = await import('./internal/reader.js');
  return read(path, options);
}
/** Metadata-only monitor capture. Use prepareMonitorInstall.readShown for selected, policy-gated content. */
export async function readMonitorInstall(config: import('#platform/index.js').ResolvedConfig, env: import('#platform/index.js').Environment | undefined,
  readOutput: (identity: import('#domain/index.js').AttemptIdentity) => Promise<boolean>) {
  const { readMonitorInstall: read } = await import('./internal/install.js');
  return read(config, env, readOutput);
}

/** Capture one ledger snapshot; hydrate only the application's shown exact identities outside its transaction. */
export async function prepareMonitorInstall(config: import('#platform/index.js').ResolvedConfig, env: import('#platform/index.js').Environment | undefined,
  readOutput: (identity: import('#domain/index.js').AttemptIdentity) => Promise<boolean>, run?: { scopeId: string; runId: string }) {
  const { prepareMonitorInstall: prepare } = await import('./internal/install.js');
  return prepare(config, env, readOutput, run);
}

export { readMonitorRunResults } from './internal/run-brief.js';
