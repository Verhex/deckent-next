/** Shared runtime asset: bounded filesystem history read by the builder and its adapter. */
export function retainedWorkerHistory(directory: string, daemonId: string, bounds: { files: number; bytes: number }): string[];
