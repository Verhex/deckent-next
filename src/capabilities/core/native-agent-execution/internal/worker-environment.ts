import type { EnvironmentRequirement, ShellRealm, ShellRealmRequest } from '#domain/index.js';
import { ErrorRegistry } from '#platform/index.js';
import { isAbsolute, relative } from 'node:path';
import policy from './worker-environment.json' with { type: 'json' };

type ProbeResult = 'met' | 'unmet' | 'timed-out' | Readonly<{ uncertain: string }>;
export type NativeWorkerProbeRunner = (argv: readonly string[], timeoutMs: number, signal?: AbortSignal) => Promise<ProbeResult>;
type ProbeRegistry = { timeoutMs: number; kinds: Readonly<Record<string, { argv: readonly string[] }>> };
export function nativeWorkerEnvironmentProbes(registry: ProbeRegistry, run: NativeWorkerProbeRunner) {
  return new Map(Object.entries(registry.kinds).map(([kind, { argv }]) => [kind, async (requirement: EnvironmentRequirement, signal?: AbortSignal) => {
    const values: Readonly<Record<string, string | undefined>> = { '{target}': requirement.target, '{expect}': requirement.expect };
    const resolved = argv.map(part => Object.hasOwn(values, part) ? values[part] : part);
    return resolved.every((part): part is string => part !== undefined) ? run(resolved, registry.timeoutMs, signal) : 'unmet';
  }]));
}
export function nativeWorkerTemplateEnvironment(defaults: { requirements: readonly EnvironmentRequirement[];
  whenMounted: readonly { target: string; requirement: EnvironmentRequirement }[]; nodeHeap: Omit<EnvironmentRequirement, 'expect'> },
  settings: { readOnlyMounts?: unknown }, heap: number | null) {
  const mounted = new Set((Array.isArray(settings.readOnlyMounts) ? settings.readOnlyMounts : []).map(mount => (mount as { target?: unknown })?.target));
  return { schemaVersion: 1, requirements: [...defaults.requirements, ...defaults.whenMounted.filter(row => mounted.has(row.target)).map(row => row.requirement),
    ...(heap ? [{ ...defaults.nodeHeap, expect: String(heap) }] : [])] };
}
/** Explicit result type: the published declaration never references the JSON policy module. */
type NativeWorkerToolBounds = Readonly<{ limiter: string; dataBytes: number; heapBytes: number; fixedEnv: Readonly<Record<string, string>> }>;
export function nativeWorkerToolBounds(limits: { limiter: string; dataBytes: number } | undefined): NativeWorkerToolBounds {
  if (!limits) throw ErrorRegistry.createError('NATIVE_AGENT_ENVIRONMENT_REFUSED');
  const units = Math.floor(limits.dataBytes * policy.memoryFraction / policy.bytesPerUnit);
  if (!Number.isSafeInteger(units) || units <= 0 || policy.memoryFraction <= 0 || policy.memoryFraction >= 1 || !limits.limiter.startsWith('/'))
    throw ErrorRegistry.createError('NATIVE_AGENT_ENVIRONMENT_REFUSED');
  return { ...limits, heapBytes: units * policy.bytesPerUnit, fixedEnv: { [policy.environment]: `${policy.flag}${units}` } };
}
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
/** Only a composition-owned Attempt subtree may reopen a part of the hidden installation root. */
export function nativeWorkerContainedLayout<L extends { project: { root: string } }>(layout: L, stateRoot: string, workspaces: string) {
  const path = relative(workspaces, layout.project.root);
  return path && path !== '..' && !path.startsWith('../') && !isAbsolute(path) ? { ...layout, containedWorkspaceRoot: stateRoot } : layout;
}
/** Both preflight and governed tool calls inherit the same hard data limit; no open view or long-lived launch is offered. */
export function nativeWorkerBoundSandboxes<C, R extends { ok: true; realm: ShellRealm }>(
  providers: readonly { kind: Exclude<ShellRealm['kind'], 'host'>; usable(capabilities: C): R | { ok: false; reason: string } }[], bounds: NativeWorkerToolBounds) {
  return providers.filter(provider => provider.kind === 'bubblewrap').map(provider => ({ ...provider, usable(capabilities: C) {
    const ready = provider.usable(capabilities); if (!ready.ok) return ready;
    const { launch: _launch, ...closed } = ready as R & { launch?: unknown }; void _launch;
    return { ...closed, opens: false, realm: { kind: 'bubblewrap' as const, run(request: ShellRealmRequest) {
      if (request.open) throw ErrorRegistry.createError('NATIVE_AGENT_ENVIRONMENT_REFUSED');
      const command = [bounds.limiter, `--data=${bounds.dataBytes}:${bounds.dataBytes}`, '--core=0:0', '--', 'bash', '--noprofile', '--norc', '-c', request.command].map(quote).join(' ');
      return ready.realm.run({ ...request, command, fixedEnv: { ...request.fixedEnv, ...bounds.fixedEnv } });
    } } };
  } }));
}
