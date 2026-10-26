import { delegationOwner, executionProfileDefinitionSchema, INSTRUCTION_SURFACE_PATHS, modelInvocationProfileSchema, subscriptionDelegationRefusal, type ExecutionProfileDefinition } from '#domain/index.js';
import type { SandboxRequest, SandboxResult, SupervisorLaunchHooks } from '#engine/index.js';
import { DockerSupervisor, resolveDockerTaskProfile, validateDockerTaskProfile, type DockerSupervisorOptions } from '#adapters/core/docker-supervisor/index.js';
import { SIWC_INFERENCE, SIWC_WORKER_RELAY as R, siwcResponsesDefinitionSchema } from '#adapters/core/provider-siwc/index.js';
import { stopSiwcWorker, siwcWorkerResultError } from './launch.js';
import type { openSiwcWorkerRelay } from './relay.js';

type Person = Readonly<{ issuer: string; subject: string }>;
export type SiwcWorkerConnection = Readonly<{ scopeId: string; connectionId: string; owner: Person; modelId: string; consentAtMs: number }>;
/**
 * U9-7 producer facts: the person's Sign in with ChatGPT invocation profiles in the admitted scopes whose recorded consent lets Deckent's own
 * background work (class `system`, owner Q-H3 / Terms T5) spend the plan, and whose connection passes the caller's personal-custody check (the
 * U9-1 owner). Nothing while the registry holds worker activation, so a held installation keeps every Codex worker on its existing route.
 */
export async function siwcWorkerConnections(input: Readonly<{ profiles: unknown; scopeIds: readonly string[]; actor: Person; custody: (scopeId: string, connectionId: string) => Promise<boolean>;
  activation?: 'hold' | 'open' }>): Promise<readonly SiwcWorkerConnection[]> {
  if ((input.activation ?? R.activation) !== 'open') return [];
  const owner = delegationOwner(input.actor); // the person a workload or MCP identity acts for
  const rows: SiwcWorkerConnection[] = [], custody = new Map<string, Promise<boolean>>();
  for (const value of (input.profiles as { profiles?: unknown[] } | null | undefined)?.profiles ?? []) {
    const profile = modelInvocationProfileSchema.safeParse(value), adapter = profile.success ? profile.data.adapter : null;
    if (!profile.success || !input.scopeIds.includes(profile.data.scopeId) || adapter!.id !== SIWC_INFERENCE.adapter.id || adapter!.version !== SIWC_INFERENCE.adapter.version) continue;
    const definition = siwcResponsesDefinitionSchema.safeParse(adapter!.definition);
    if (!definition.success || definition.data.owner.issuer !== owner.issuer || definition.data.owner.subject !== owner.subject
      || subscriptionDelegationRefusal({ billing: 'subscription', principalClass: 'system', owner, consent: definition.data.delegatedUse }) !== null) continue;
    const key = JSON.stringify([profile.data.scopeId, definition.data.connectionId]);
    if (!custody.has(key)) custody.set(key, input.custody(profile.data.scopeId, definition.data.connectionId).catch(() => false));
    if (await custody.get(key)) rows.push(Object.freeze({ scopeId: profile.data.scopeId, connectionId: definition.data.connectionId, owner: Object.freeze({ issuer: owner.issuer, subject: owner.subject }),
      modelId: profile.data.reference.modelId, consentAtMs: definition.data.delegatedUse!.atMs }));
  }
  return Object.freeze(rows);
}
/**
 * U9-7 producer: a compiled worker of the CLI that embeds the app-server, pinned to a model the person's consented connection serves, runs on
 * that connection through the host relay (`siwcWorker` v1, frozen into the Run). Any other profile is returned unchanged; the exact model is the
 * catalog-admitted pin, never a substitute.
 */
export function bindSiwcWorker(profile: ExecutionProfileDefinition, connections: readonly SiwcWorkerConnection[], scopeId: string): ExecutionProfileDefinition {
  if (!connections.length) return profile;
  const { nativeSubscription: binding, siwcWorker } = resolveDockerTaskProfile(profile);
  const chosen = !siwcWorker && binding?.schemaVersion === 2 && binding.promptDelivery && !binding.checkout && binding.provider === R.appServerCli
    ? connections.find(row => row.scopeId === scopeId && row.modelId === binding.model?.modelId) : undefined;
  if (!chosen) return profile;
  const bound = executionProfileDefinitionSchema.parse({ ...profile, parameters: { ...profile.parameters,
    siwcWorker: { schemaVersion: 1, connectionId: chosen.connectionId, owner: chosen.owner, hiddenPaths: [...INSTRUCTION_SURFACE_PATHS] } } });
  validateDockerTaskProfile(bound);
  return bound;
}
/** The one turn's prompt: the compiled core and task segments plus the admitted predecessor context, in the native worker's order. */
export const siwcWorkerPrompt = (delivery: Readonly<{ core: string; task: string }>, context?: Readonly<{ text: string }> | null) =>
  `${delivery.core}\n\n${delivery.task}${context ? `\n\n${context.text}` : ''}`;

type Relay = Awaited<ReturnType<typeof openSiwcWorkerRelay>>;
/**
 * U9-7 launch: the Docker supervisor of one relay worker. The container runs only the pinned bootstrap (no task argv, no credential), the relay
 * learns the container id before start, a cancel revokes C first, and a settled run is stopped through the U9-7b order. A turn that did not
 * complete (lost, refused or cleanup unproven) is recorded `unknown` with its typed code, never as the bootstrap's exit: the existing
 * reconciliation owner decides, nothing is replayed.
 */
export class SiwcWorkerSupervisor extends DockerSupervisor {
  constructor(options: DockerSupervisorOptions, private readonly relay: Relay) { super({ ...options, relay: relay.descriptor }, undefined, { created: id => relay.bindContainer(id) }); }
  override async execute(request: SandboxRequest, signal?: AbortSignal, hooks?: SupervisorLaunchHooks): Promise<SandboxResult> {
    const result = await super.execute(request, signal, hooks);
    const stop = await stopSiwcWorker({ reason: result.interruptCause ?? 'settled', relay: this.relay, cancel: () => super.cancel(request) });
    const error = siwcWorkerResultError(stop.outcome, stop);
    return error ? Object.freeze({ ...result, result: { kind: 'unknown' as const, reasonCode: error.code } }) : result;
  }
  override async cancel(request: SandboxRequest) { this.relay.revoke('cancel'); return super.cancel(request); }
}
