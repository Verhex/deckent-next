import policy from './node-heap.json' with { type: 'json' };

/** PRE-2: the Node heap ceiling follows the container memory limit this adapter sets (node-heap.json), instead of Node's ~55 % default
 * that aborted verify-light (exit 134) with free cgroup memory left. Container environment, not task argv; empty below one whole unit. */
export function dockerNodeHeapEnvironment(memoryBytes: number): readonly string[] {
  const units = Math.floor(memoryBytes * policy.memoryFraction / policy.bytesPerUnit);
  return units > 0 ? ['--env', `${policy.environment}=${policy.flag}${units}`] : [];
}
/** PRE-7: the heap ceiling (bytes) that environment sets for this memory limit; null when none is set. */
export function dockerNodeHeapCeilingBytes(memoryBytes: number): number | null {
  const units = Math.floor(memoryBytes * policy.memoryFraction / policy.bytesPerUnit);
  return units > 0 ? units * policy.bytesPerUnit : null;
}
