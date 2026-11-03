import { prepareNativeWorkerInputs, nativeWorkerViewSandboxes } from './worker-inputs.js';
import { ErrorRegistry, getConfigKnownSecrets, globalStateRoot, productResourcePath, type ConfigLoadOptions } from '#platform/index.js';
import { agentWorkspaceDeny, createWorkspaceReadTools, agentAuthorityPaths, agentTurnWriteFloor, isSelfSourceProject,
  agentShellSandboxLayout, shippedShellSandboxes, nativeCodingEnvironmentProbes, nativeCliAgent, resolveShellRealm, shellSandboxCapabilities,
  type NativeCliWorkerPorts, type ShellCapabilities, type ShellSandbox } from '#adapters/index.js';
import { nativeWorkerEnvironmentProbe, nativeWorkerBoundSandboxes, nativeWorkerContainedLayout, nativeWorkerToolBounds } from '#capabilities/index.js';
import { assertTaskEnvironment, environmentProbeRegistry } from '#engine/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
import { loadComposedConfig } from '#composition/core/root/index.js';
import { recheckNativeWorkerUse } from '#composition/core/runs/index.js';
import { userInfo } from 'node:os';
type OpenTools = NativeCliWorkerPorts['openTools'];
export async function nativeWorkerToolFloor(root: string, request: Parameters<OpenTools>[0], binding: Parameters<OpenTools>[1],
  resources: Parameters<OpenTools>[3], options: ConfigLoadOptions) {
  const { scopeId } = request.identity;
  const current = await recheckNativeWorkerUse(root, scopeId, binding, options), loaded = await loadConfiguredScopeContext(root, scopeId, options, 'write');
  const context = { ...loaded, policy: createLayoutPolicySource(loaded.layout, userInfo().uid, loaded.config.inspection.policyMaxBytes),
    async freshConfig() { const config = await loadComposedConfig(root, { ...options, heal: false });
      if (JSON.stringify(config.productLayout) !== JSON.stringify(loaded.layout)) throw ErrorRegistry.createError('PROJECT_ATTACHMENT_CHANGED'); return config; } };
  const env = options.env ?? process.env, known = getConfigKnownSecrets(context.config);
  const workspace = await createWorkspaceReadTools(request.workspace, { deny: agentWorkspaceDeny(request.workspace, context.layout, false, env),
    limits: { maxResultBytes: context.config.service.responseMaxBytes } });
  const inputs = await prepareNativeWorkerInputs(resources, scopeId, root, request.workspace, context.layout, context.config.execution?.secretGate, context.config.artifacts.maxBytes, context.config.service.responseMaxBytes);
  const authority = agentAuthorityPaths(request.workspace, context.layout);
  const selfSource = await isSelfSourceProject(root), writeFloor = agentTurnWriteFloor(authority, false, selfSource);
  const sandbox = nativeWorkerContainedLayout(agentShellSandboxLayout(request.workspace, context.layout, workspace.scope, writeFloor, false, null, env), context.layout.root, productResourcePath(context.layout, 'workspaces'));
  return { current, context, env, known, workspace, inputs, authority, selfSource, writeFloor, sandbox,
    sandboxes: nativeWorkerBoundSandboxes<ShellCapabilities, Extract<ReturnType<ShellSandbox['usable']>, { ok: true }>>(nativeWorkerViewSandboxes(sandbox, inputs, shippedShellSandboxes(sandbox)), nativeWorkerToolBounds(nativeCliAgent(current.profile.protocol.family)?.headless.isolation.limits)) };
}

export function nativeWorkerEnvironment(root: string, options: ConfigLoadOptions): NonNullable<NativeCliWorkerPorts['checkEnvironment']> {
  return async (request, binding, requirements, resources, signal) => {
    if (signal.aborted) throw ErrorRegistry.createError('DISPATCH_FENCED');
    const floor = await nativeWorkerToolFloor(root, request, binding, resources, options);
    const realm = resolveShellRealm('require-sandbox', await shellSandboxCapabilities(globalStateRoot(options.env ?? process.env)), floor.sandboxes);
    if (!realm.ok || realm.containment !== 'sandbox') throw ErrorRegistry.createError('NATIVE_AGENT_ENVIRONMENT_REFUSED');
    await assertTaskEnvironment(requirements, environmentProbeRegistry.with(nativeCodingEnvironmentProbes(nativeWorkerEnvironmentProbe(realm.realm,
      { cwd: request.workspace, environment: options.env ?? process.env, signal, resultMaxBytes: floor.context.config.service.responseMaxBytes }))), signal);
  };
}
