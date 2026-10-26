import { hubOperationSchemas, hubOperationWrites, hubPersonOnlyOperation, parseHubOperation, type HubOperationHandler, type HubOperationName } from '#engine/index.js';
import type { ModelInvocationDelivery, RuntimeServiceDelivery } from '#engine/index.js';
import { t, type Locale } from '#platform/index.js';
/** Person trust/cards are absent from the AI inventory and refused again by composition if invoked directly. */
export function hubToolDefinitions(execute: HubOperationHandler | undefined, locale: Locale) {
  if (!execute) return [];
  return (Object.keys(hubOperationSchemas) as HubOperationName[]).filter(name => !hubPersonOnlyOperation(name)).map(operation => ({
    name: operation.replaceAll('.', '_'), description: t('hub.mcp.tool', { operation }, locale), schema: hubOperationSchemas[operation],
    readOnly: !hubOperationWrites(operation), destructive: hubOperationWrites(operation),
    idempotent: !['hub.inspect', 'hub.search', 'hub.publish', 'hub.yank', 'hub.revoke'].includes(operation),
    openWorld: ['hub.inspect', 'hub.search', 'hub.publish', 'hub.yank', 'hub.revoke'].includes(operation),
    invoke: (input: unknown, _delivery?: ModelInvocationDelivery | RuntimeServiceDelivery, signal?: AbortSignal) => execute(parseHubOperation({ operation, input }), signal),
  }));
}
