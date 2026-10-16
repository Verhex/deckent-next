import { ErrorRegistry } from '#platform/index.js';
import type { BrainPlannerConfig } from '../index.js';
export interface BrainRegistryContext {
  readonly schemaVersion: 2;
  readonly registryRevision: string;
  readonly kinds: readonly Readonly<{ kind: string; profile: { id: string; version: number }; type: 'template' | 'prepared'; provider?: string; turnLimit?: 'supported' | 'unsupported' }>[];
  readonly evaluators: readonly Readonly<{ id: string; version: number; parameters: unknown }>[];
  readonly workerModels: readonly Readonly<{ profile: { id: string; version: number }; channelId: string; modelId: string;
    auxiliaryModelIds: readonly string[]; availableAuxiliaryModelIds: readonly string[]; billing: string | null; efforts: readonly string[] }>[];
  readonly permissions: unknown;
  readonly budget: unknown;
  readonly scopePaths: { state: 'not-inspected' };
}
/** Counts and byte limit apply to the complete context envelope. No raw JSON substring cuts. */
export function boundBrainContext(scopeId: string, workClasses: unknown, input: BrainRegistryContext, limits: BrainPlannerConfig['context']) {
  const context = { ...input, kinds: input.kinds.slice(0, limits.maxKinds), evaluators: input.evaluators.slice(0, limits.maxEvaluators),
    workerModels: input.workerModels.slice(0, limits.maxModels),
    truncation: { reason: 'none' as 'none' | 'count' | 'bytes', omittedKinds: 0, omittedEvaluators: 0, omittedModels: 0 } };
  const update = () => {
    context.truncation.omittedKinds = input.kinds.length - context.kinds.length;
    context.truncation.omittedEvaluators = input.evaluators.length - context.evaluators.length;
    context.truncation.omittedModels = input.workerModels.length - context.workerModels.length;
  };
  update();
  if (Object.values(context.truncation).some(value => typeof value === 'number' && value > 0)) context.truncation.reason = 'count';
  const bytes = () => new TextEncoder().encode(JSON.stringify({ scopeId, workClasses, context })).length;
  while (bytes() > limits.maxBytes) {
    context.truncation.reason = 'bytes';
    const rows = [context.workerModels, context.evaluators, context.kinds].filter(list => list.length);
    if (!rows.length) throw ErrorRegistry.createError('BRAIN_CONTEXT_TOO_LARGE', { params: { limit: limits.maxBytes, observed: bytes(), unit: 'bytes' } });
    rows.sort((a, b) => JSON.stringify(b).length - JSON.stringify(a).length)[0]!.pop();
    update();
  }
  return context;
}
