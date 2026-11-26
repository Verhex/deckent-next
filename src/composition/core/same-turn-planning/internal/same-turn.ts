import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { type BrainPlanCommand, type ModelInvocationCommand, type ModelInvocationProfile, type ModelInvocationReceipt } from '#domain/index.js';
import { headlessCapacityBinding, nativeCliAgent, type LocalPeerIdentity } from '#adapters/index.js';
import { agentToolArgumentsDigest, agentTurnResultDigest, type ModelInvocationResult, type RunPackageCardCheck, type RunProposalResult } from '#engine/index.js';
import type { NativeAgentToolResult, SameTurnPlanningCall, SameTurnPlanningPort } from '#capabilities/index.js';
import { ErrorRegistry, t, type ConfigLoadOptions, type Locale, type ResolvedConfig } from '#platform/index.js';
import { snapshotConfiguredConfig } from '#composition/core/config/index.js';
import type { loadPeerInvocationContext } from '#composition/core/model-invocation/index.js';
import { bindRetainedTurnResponse } from './same-turn-reader.js';

type Witness = Awaited<ReturnType<typeof loadPeerInvocationContext>>;
type TurnReader = ReturnType<typeof bindRetainedTurnResponse>;
type Setting = 'maxCompletionTokens' | 'reasoning';
export type CreateServiceSameTurnPlanning = (input: {
  root: string; options: ConfigLoadOptions; actor: Witness['principal']; config: ResolvedConfig; profile: ModelInvocationProfile; signal: AbortSignal;
  sharesLogin(profile: ModelInvocationProfile): boolean;
  randomBytes(size: number): Uint8Array;
  toolResultDigest(text: string): string;
  readResult(receipt: ModelInvocationReceipt, isCurrent: () => boolean): Promise<ModelInvocationResult>;
  inspect: TurnReader['inspect'];
  settingOrigins(): Promise<Record<Setting, 'project' | 'person' | 'brain-default'>>;
  publicText: string;
  recheck(): Promise<void>;
}) => {
  readonly planning: SameTurnPlanningPort;
  readonly chosenBrain: string | null;
  claim(invocation: ModelInvocationCommand, receipt: ModelInvocationReceipt): void;
  prepare(command: BrainPlanCommand, call: SameTurnPlanningCall,
    bounds: { preparationMaxBytes: number; draftMaxBytes: number }): Promise<NativeAgentToolResult>;
  finalize(result: ModelInvocationResult, signal: AbortSignal, checkPackageCard?: RunPackageCardCheck): Promise<RunProposalResult>;
  admit(): Promise<RunProposalResult>;
} | null;

/** Each eligible native turn has one K1 owner. Its private reader cannot exist until that owner finalizes a newly permitted claim. */
export function createChatSameTurnPlanning(input: {
  root: string; options: ConfigLoadOptions; actor: Witness; witness: Witness; peer: LocalPeerIdentity;
  profile: ModelInvocationProfile; signal: AbortSignal; locale: Locale; turnId: string; bridgeMaxBytes: number;
  create: CreateServiceSameTurnPlanning; recheck(): Promise<void>;
  observe?(receipt: ModelInvocationReceipt, policyRevision: string): void;
}) {
  const { root, options, actor, witness, peer, profile, signal, locale } = input;
  const entry = nativeCliAgent(profile.protocol.family);
  if (!entry) return null;
  const refuse = () => ErrorRegistry.createError('BRAIN_SAME_TURN_REFUSED');
  let reader: TurnReader | undefined;
  const service = input.create({ root, options, actor: actor.principal, config: actor.config, profile, signal,
    sharesLogin: other => isDeepStrictEqual(headlessCapacityBinding(other.adapter.definition), headlessCapacityBinding(profile.adapter.definition)),
    randomBytes, toolResultDigest: agentTurnResultDigest, publicText: t('brain.sameTurn.prepared', {}, locale),
    async readResult(receipt, isCurrent) {
      reader ??= bindRetainedTurnResponse(root, options, peer, profile.scopeId, witness, signal, input.observe);
      try { return await reader.read(receipt, isCurrent); }
      catch { throw ErrorRegistry.createError('BRAIN_SAME_TURN_REFUSED', { params: { reason: 'read-refused' } }); }
    },
    async inspect(receipt) { if (!reader) throw refuse(); return reader.inspect(receipt); },
    async settingOrigins() {
      const { global, project } = await snapshotConfiguredConfig(root, options);
      const origin = (key: Setting) => {
        for (const [layer, name] of [[project, 'project'], [global, 'person']] as const) {
          const section = layer['brain_planner'];
          if (section && typeof section === 'object' && Object.hasOwn(section, key)) return name;
        }
        return 'brain-default' as const;
      };
      return { maxCompletionTokens: origin('maxCompletionTokens'), reasoning: origin('reasoning') };
    },
    recheck: input.recheck,
  });
  if (!service) return null;
  let invocationId: string | undefined, retained: ModelInvocationResult | undefined, preparationCallId: string | undefined;
  const bounds = { preparationMaxBytes: Math.min(input.bridgeMaxBytes, entry.bridge.frameMaxBytes),
    draftMaxBytes: profile.limits.responseMaxBytes };
  return {
    planning: service.planning, chosenBrain: service.chosenBrain,
    claim(invocation: ModelInvocationCommand, receipt: ModelInvocationReceipt) {
      service.claim(invocation, receipt);
      invocationId = receipt.claim.invocationId;
    },
    keep(result: ModelInvocationResult) { retained = result; },
    async prepare(command: BrainPlanCommand, args: Record<string, unknown>, callId: string, name: string) {
      const call = { turnId: input.turnId, generation: 1, callId, argsDigest: agentToolArgumentsDigest(name, args) };
      const result = await service.prepare(command, call, bounds);
      preparationCallId = callId;
      return result.outcome;
    },
    finalize(parentSignal: AbortSignal, checkPackageCard?: RunPackageCardCheck) {
      if (!retained) throw refuse();
      return service.finalize(retained, parentSignal, checkPackageCard);
    },
    admit: service.admit,
    get callId() { return preparationCallId; },
    get invocationId() { return invocationId; },
  };
}
