import { effectCommandSchema, type EffectCommand, type OperationDescriptor } from '#domain/index.js';
import { runtimeOperationQuerySchema, type RuntimeOperationQuery, type RuntimeServiceDelivery } from '#engine/index.js';
import { t, type Locale } from '#platform/index.js';

export type OperationToolHints = Readonly<{ readOnly: boolean; destructive: boolean; idempotent: boolean; openWorld: boolean }>;
/** Hints of one catalog operation tool over the operations it can reach: read-only when every one only reads, destructive when any may
 * change or irreversibly act on its target, open-world when any exists (targets are external systems). Idempotent regardless of the
 * catalog: a recorded command resumes its durable record and a settled/refused one replays without a second effect
 * (engine/core/effect/internal/application.ts:128,150,176-177), and a pending one returns the same request for the same action digest
 * (engine/core/approval/internal/operation.ts:47-50). An empty set can change and reach nothing. */
function hints(reachable: readonly OperationDescriptor[]): OperationToolHints {
  return Object.freeze({ readOnly: reachable.every(entry => entry.effectClass === 'read'), destructive: reachable.some(entry => entry.effectClass !== 'read'),
    idempotent: true, openWorld: reachable.length > 0 });
}
/** MCP hints of the catalog operation tools, derived from the installation's reachable catalog descriptors (C12 G4), never fixed per tool.
 * Compensation is bounded by the whole reachable catalog, not by the current catalog's `compensation` references (Astra 2139 R2): the
 * compensating command's operation resolves from the current catalog, but the pairing is checked against the original intent's pinned
 * descriptor (engine/core/effect/internal/application.ts `run`; domain `assertCompensation`), so a settled effect whose operation has
 * left the catalog still reaches its compensation. Any reachable operation may be such a pinned compensation; nothing outside the
 * reachable catalog is. Hints are advisory and grant nothing. */
export function operationToolHints(catalog: readonly OperationDescriptor[]) {
  return Object.freeze({ execute: hints(catalog), compensate: hints(catalog),
    inspect: Object.freeze({ readOnly: true, destructive: false, idempotent: true, openWorld: false }) });
}

type Handler<T> = (input: T, delivery?: RuntimeServiceDelivery) => Promise<unknown>;
interface OperationHandlers { executeOperation?: Handler<EffectCommand>; compensateOperation?: Handler<EffectCommand>; inspectOperation?: Handler<RuntimeOperationQuery>;
  operationCatalog?: readonly OperationDescriptor[] }
/** The three catalog operation tools (C12 G4), each advertised only when composition supplies its handler; bounded delivery. */
export function operationToolDefinitions(applications: OperationHandlers, locale: Locale) {
  const derived = operationToolHints(applications.operationCatalog ?? []);
  const tool = <T>(name: string, description: string, hints: OperationToolHints, schema: typeof effectCommandSchema | typeof runtimeOperationQuerySchema, handler: Handler<T> | undefined) =>
    handler ? [{ ...hints, name, description, schema, boundedDelivery: true,
      invoke: (input: unknown, delivery?: RuntimeServiceDelivery) => handler.call(applications, schema.parse(input) as T, delivery) }] : [];
  return [...tool('execute_operation', t('mcp.tool.executeOperation', {}, locale), derived.execute, effectCommandSchema, applications.executeOperation),
    ...tool('compensate_operation', t('mcp.tool.compensateOperation', {}, locale), derived.compensate, effectCommandSchema, applications.compensateOperation),
    ...tool('inspect_operation', t('mcp.tool.inspectOperation', {}, locale), derived.inspect, runtimeOperationQuerySchema, applications.inspectOperation)];
}
