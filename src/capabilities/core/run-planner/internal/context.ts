import { ErrorRegistry } from '#platform/index.js';
import type { BrainPlannerConfig } from '../index.js';
/** S4B-6 (§7.2): one verified memory entry as the Brain reads it (data; redacted and projected by the memory engine). */
export interface BrainMemoryEntry { readonly entryId: string; readonly revision: number; readonly kind: 'fact' | 'lesson'; readonly title: string; readonly body: string }
/** The memory block of context v3: the selected entries and how many eligible entries the memory registry bounds left out. */
export interface BrainMemoryContext { readonly entries: readonly BrainMemoryEntry[]; readonly omitted: number }
interface BrainRegistryContextBase {
  readonly registryRevision: string;
  readonly kinds: readonly Readonly<{ kind: string; profile: { id: string; version: number }; type: 'template' | 'prepared'; provider?: string; turnLimit?: 'supported' | 'unsupported' }>[];
  readonly evaluators: readonly Readonly<{ id: string; version: number; parameters: unknown }>[];
  readonly workerModels: readonly Readonly<{ profile: { id: string; version: number }; channelId: string; modelId: string;
    auxiliaryModelIds: readonly string[]; availableAuxiliaryModelIds: readonly string[]; billing: string | null; efforts: readonly string[] }>[];
  readonly permissions: unknown;
  readonly budget: unknown;
  readonly scopePaths: { state: 'not-inspected' };
}
/** v2: templates v1–v3 (their bytes never change). v3 (template v4): adds `memory` (null: none supplied). */
export type BrainRegistryContext = BrainRegistryContextBase & ({ readonly schemaVersion: 2 } | { readonly schemaVersion: 3; readonly memory: BrainMemoryContext | null });
type Truncation = { reason: 'none' | 'count' | 'bytes'; omittedKinds: number; omittedEvaluators: number; omittedModels: number; omittedMemory?: number };
/** Counts and byte limit apply to the complete context envelope. No raw JSON substring cuts. Under the byte limit memory entries leave first
 * (advisory data; kinds, evaluators and models make the plan valid), counted in `truncation.omittedMemory`; then the largest list loses its last row,
 * but a list keeps its first row: a context without any kind or evaluator it was offered can plan nothing valid, so that is a typed refusal instead. */
export function boundBrainContext(scopeId: string, workClasses: unknown, input: BrainRegistryContext, limits: BrainPlannerConfig['context']) {
  const memory = input.schemaVersion === 3 && input.memory ? { entries: [...input.memory.entries], omitted: input.memory.omitted } : null;
  const truncation: Truncation = { reason: 'none', omittedKinds: 0, omittedEvaluators: 0, omittedModels: 0, ...(input.schemaVersion === 3 ? { omittedMemory: 0 } : {}) };
  const context = { ...input, kinds: input.kinds.slice(0, limits.maxKinds), evaluators: input.evaluators.slice(0, limits.maxEvaluators),
    workerModels: input.workerModels.slice(0, limits.maxModels), ...(input.schemaVersion === 3 ? { memory } : {}), truncation };
  const update = () => {
    truncation.omittedKinds = input.kinds.length - context.kinds.length;
    truncation.omittedEvaluators = input.evaluators.length - context.evaluators.length;
    truncation.omittedModels = input.workerModels.length - context.workerModels.length;
    if (memory && input.schemaVersion === 3 && input.memory) truncation.omittedMemory = input.memory.entries.length - memory.entries.length;
  };
  update();
  if (Object.values(truncation).some(value => typeof value === 'number' && value > 0)) truncation.reason = 'count';
  const bytes = () => new TextEncoder().encode(JSON.stringify({ scopeId, workClasses, context })).length;
  while (bytes() > limits.maxBytes) {
    truncation.reason = 'bytes';
    if (memory?.entries.length) { memory.entries.pop(); update(); continue; }
    const rows = [context.workerModels, context.evaluators, context.kinds].filter(list => list.length > 1);
    if (!rows.length) throw ErrorRegistry.createError('BRAIN_CONTEXT_TOO_LARGE', { params: { limit: limits.maxBytes, observed: bytes(), unit: 'bytes' } });
    rows.sort((a, b) => JSON.stringify(b).length - JSON.stringify(a).length)[0]!.pop();
    update();
  }
  return context;
}
