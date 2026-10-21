import { userInfo } from 'node:os';
import { existsSync } from 'node:fs';
import { loadConfig, prepareProductDirectory, prepareProductFile, productResourcePath, type ConfigLoadOptions } from '#platform/index.js';
import { DockerSupervisor, openSqliteAttemptStore } from '#adapters/index.js';
/** REVISE 2691: the service-start consumer of environment probes. No probe is live at a start, so every labelled probe container of this
 * installation (workspace root) is removed and observed absent; unproven ones are returned, never assumed gone. Null without execution
 * or before any workspace exists. */
export async function releaseConfiguredPreflightProbes(projectRoot: string, options: ConfigLoadOptions = {}) {
  const context = await probeContext(projectRoot, options);
  if (!context) return null;
  const swept = await DockerSupervisor.sweepPreflightProbes(context.settings).catch(() => ({ removed: 0, unsettled: [], unlisted: true as const }));
  return { ...swept, ...await settleProbeHolds(context, undefined) };
}
/** REVISE 2693: the reconcile of uncertain-probe holds (one Run, or all at start): each recorded probe proven removed releases its task's slot
 * exactly once through the ledger; an unprovable one keeps the hold (listed in `held`). Never a release without that proof. */
export async function settleConfiguredEnvironmentProbes(projectRoot: string, filter: Readonly<{ scopeId: string; runId: string }>, options: ConfigLoadOptions = {}) {
  const context = await probeContext(projectRoot, options);
  return context ? settleProbeHolds(context, filter) : null;
}
async function probeContext(projectRoot: string, options: ConfigLoadOptions) {
  const config = await loadConfig(projectRoot, { ...options, heal: false }), os = userInfo();
  // No workspaces directory: no probe ever ran here, and a start never creates it (the refresh gate precedes every write).
  if (!config.execution || os.uid <= 0 || os.gid < 0 || !existsSync(productResourcePath(config.productLayout, 'workspaces'))) return null;
  const workspaceRoot = await prepareProductDirectory(config.productLayout, 'workspaces');
  return { config, settings: { ...config.execution.docker, workspaceRoot, uid: os.uid, gid: os.gid } };
}
async function settleProbeHolds({ config, settings }: NonNullable<Awaited<ReturnType<typeof probeContext>>>, filter: Readonly<{ scopeId: string; runId: string }> | undefined) {
  const store = await openSqliteAttemptStore(await prepareProductFile(config.productLayout, 'ledger', ['-wal', '-shm', '-journal']), config.storage.sqlite,
    { now: Date.now, timeoutMs: config.runRuntime.parking.timeoutMs }, 'forbid');
  try {
    let released = 0; const held: string[] = [], settlementFailed: { probes: readonly string[]; code?: string }[] = [];
    for (const hold of await store.environmentProbeHolds(filter)) {
      // REVISE 2695: a custody hold (start only) covers several probes; it releases once every one of them is proven removed.
      const unproven: string[] = []; for (const probe of hold.probes) if (!await DockerSupervisor.removePreflightProbe(settings, probe)) unproven.push(probe);
      // REVISE 2698 / PRE7FU: a hold whose ledger release fails (conflict, store error) is reported with that cause and its typed code, never as
      // an unproven removal; it never stops the other holds or later Runs.
      if (unproven.length) { held.push(...unproven); continue; }
      const failure = await store.settleEnvironmentProbe(hold).then(() => null, (error: unknown) => ({ probes: hold.probes, ...(typeof (error as { code?: unknown })?.code === 'string' ? { code: (error as { code: string }).code } : {}) }));
      if (failure) settlementFailed.push(failure); else released++;
    }
    return { released, held, ...(settlementFailed.length ? { settlementFailed } : {}) };
  } finally { store.close(); }
}
