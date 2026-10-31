import limits from './input-limits.json' with { type: 'json' };
export const INPUT_VALIDATION_LIMITS = Object.freeze({ ...limits, mcp: Object.freeze(limits.mcp), ipc: Object.freeze(limits.ipc),
  hub: Object.freeze(limits.hub), hubService: Object.freeze(limits.hubService), revocations: Object.freeze(limits.revocations), graph: Object.freeze(limits.graph), worker: Object.freeze(limits.worker) });
/** Admission may narrow the measured graph envelope. Depth bounds DAG edges, never JSON nesting.
 * Per-task fields mirror graph v5/work-input v2; shared criteria/proposal metadata use envelopeNodes. */
export function graphInputValidationLimit(graph: Readonly<{ maxTasks: number; maxEdges: number; maxDepth: number }> = limits.graph): Readonly<{ maxNodes: number }> {
  const r = limits.graph, bound = (key: 'maxTasks' | 'maxEdges' | 'maxDepth') => Number.isSafeInteger(graph[key]) && graph[key] > 0 ? Math.min(graph[key], r[key]) : 0;
  const tasks = bound('maxTasks'), depth = Math.min(tasks, bound('maxDepth')), edges = Math.min(bound('maxEdges'), depth ? Math.floor(tasks * tasks * (depth - 1) / (2 * depth)) : 0);
  return { maxNodes: tasks && depth ? r.envelopeNodes + tasks * (r.taskFixedNodes + r.resourceNodes * r.resourcesPerTask + r.scopePathsPerTask + r.auxiliaryModelsPerTask) + r.edgeNodes * edges : 0 };
}
/** Walk JSON before schema validation, without copying a wide container or invoking getters. */
export function inputWithinValidationLimit(input: unknown, limit: Readonly<{ maxNodes: number }>): boolean {
  let nodes = 0; const seen = new WeakSet<object>();
  const visit = (value: unknown, depth: number): boolean => {
    if (++nodes >= limit.maxNodes || depth > INPUT_VALIDATION_LIMITS.maxDepth) return false;
    if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return true;
    if (typeof value !== 'object' || seen.has(value)) return false;
    const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
    if (!array && prototype !== Object.prototype && prototype !== null) return false;
    seen.add(value); if (array && value.length >= limit.maxNodes - nodes) return false;
    for (const key in value) {
      const property = Object.getOwnPropertyDescriptor(value, key);
      if (!property || !('value' in property) || !visit(property.value, depth + 1)) return false;
    }
    return true;
  };
  return Number.isSafeInteger(limit.maxNodes) && limit.maxNodes > 1 && visit(input, 0);
}
