import { realpath } from 'node:fs/promises';
import { agentGlobalStateRoots, type Environment } from '#platform/core/host/index.js';
import { pathWithin } from '#platform/core/utils/index.js';

/** K15: the tool realm needs custody of both paths, before and after resolving links. Reads path metadata only. */
export async function inspectNativeStateCustody(definition: Readonly<Record<string, unknown>>, env: Environment = process.env) {
  const roots = agentGlobalStateRoots([env, process.env]);
  for (const key of ['configDir', 'stateDir'] as const) {
    const path = definition[key], outside = key === 'configDir' ? 'outside-installation' : 'outside-run-state';
    if (typeof path !== 'string') return 'unverified' as const;
    const candidates = roots.filter(root => pathWithin(root, path));
    if (!candidates.length) return outside;
    const resolved = await realpath(path).catch(() => null);
    const canonical = await Promise.all(candidates.map(root => realpath(root).catch(() => null)));
    if (!resolved || canonical.every(root => root === null)) return 'unverified' as const;
    if (!canonical.some(root => root !== null && pathWithin(root, resolved))) return outside;
  }
  return 'inside-installation' as const;
}
