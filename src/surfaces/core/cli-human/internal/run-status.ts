/** The part of a Run view the status reads (structural, so every surface's Run view fits). */
type StatusRun = Readonly<{ state?: Readonly<{ kind: string; outcome?: string }> | undefined; pool?: Readonly<{ waiting: readonly Readonly<{ reason: Readonly<{ code: string; poolId: string }> }>[] }> | undefined }>;

/**
 * BeUser DR3-02: the one state key of a Run for every person-facing surface (footer, /runs, run list, completion line, /run window). A running
 * Run whose ready tasks wait on a held pool is `pool-held`: it waits (never refused) and is never shown as running. Else the Run state itself.
 */
export function runStatusKey(run: StatusRun): string {
  if (run.state?.kind === 'running' && heldPoolId(run) !== null) return 'pool-held';
  return run.state?.kind === 'terminal' ? run.state.outcome ?? 'unknown' : run.state?.kind ?? 'unknown';
}
/** The held pool a running Run's ready tasks wait on (the inspection's pool observation), else null. */
export const heldPoolId = (run: StatusRun): string | null => run.pool?.waiting.find(row => row.reason.code === 'pool-held')?.reason.poolId ?? null;
