/** Vitest prints neither the typed `code` nor the `diagnostic` of a ManagedFileError (CI-FLAKE 2026-10-18 showed only
 * "MANAGED_FILE_UNSAFE"). A store failure inside a process proof is rethrown with both in its message, the step that met it named,
 * and the original kept as `cause`, so a flake records why the companion or ledger was refused. */
export function describeStoreFailure(error: unknown, step: string): unknown {
  if (!error || typeof error !== 'object' || !('code' in error)) return error;
  const diagnostic = 'diagnostic' in error && error.diagnostic ? ` ${JSON.stringify(error.diagnostic)}` : '';
  return new Error(`${step}: ${String(error.code)}${diagnostic}`, { cause: error });
}

/** Run one step of a process proof; a typed store failure is rethrown through `describeStoreFailure`. */
export async function storeStep<T>(step: string, work: () => Promise<T>): Promise<T> {
  try { return await work(); } catch (error) { throw describeStoreFailure(error, step); }
}
