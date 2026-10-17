import { resolve } from 'node:path';
import { emit, ErrorRegistry, loadConfig, resolveLocale, t } from '#platform/index.js';
import { type QueueSubmitClient, type QueueQuery, type QueueConsent, type TargetBatchExecution, queueRollbackSchema, queueEnqueueSchema, queueQuerySchema, queueListSchema } from '#engine/index.js';
import { askQueueConfirmation } from '#surfaces/core/effect-confirmation/index.js';
import { readJsonInput } from '#surfaces/core/cli-kit/index.js';
import type { CliBaseContext } from '#surfaces/core/cli-kit/index.js';
export interface QueueCommandContext extends CliBaseContext { deliveryQueue?: QueueSubmitClient; confirmDeliveryQueue?: (query: QueueQuery, ask: (view: Omit<QueueConsent, 'capability'>) => Promise<boolean>) => Promise<TargetBatchExecution> }
/** Queue admission is non-interactive; the exact publish and adoption batch each need the verified TTY. */
export async function queueCommand(argv: readonly string[], context: QueueCommandContext) {
  const action = argv[1], values = new Map<string, string>(); let json = false;
  // Each action accepts only its own flags: --source-command-id names the rollback's source ticket, nothing else.
  const allowed = action === 'integration-queue-enqueue' ? ['--input', '--lang'] : action === 'integration-queue-list' ? ['--scope', '--after', '--limit', '--lang']
    : ['--scope', '--command-id', '--lang', ...(action === 'integration-queue-rollback' ? ['--source-command-id'] : [])];
  for (let index = 2; index < argv.length; index++) {
    const flag = argv[index]!;
    if (flag === '--json' && !json) { json = true; continue; }
    if (!allowed.includes(flag) || values.has(flag)) throw ErrorRegistry.createError('CLI_USAGE');
    const value = argv[++index]; if (!value || value.startsWith('--')) throw ErrorRegistry.createError('CLI_USAGE'); values.set(flag, value);
  }
  const client = context.deliveryQueue, root = context.root ?? process.cwd(), env = context.env ?? process.env;
  if (!client) throw ErrorRegistry.createError('INVENTORY_UNAVAILABLE');
  let locale = resolveLocale(values.get('--lang'), env); context.onLocale?.(locale);
  const config = await loadConfig(root, { env }), sinks = { ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.stderr ? { stderr: context.stderr } : {}) };
  // The installation's configured language outranks LANG/LC_ALL (a C locale must not turn the owner's cards English); --lang wins.
  locale = resolveLocale(values.get('--lang'), env, config.language); context.onLocale?.(locale);
  let result: unknown;
  if (action === 'integration-queue-enqueue') {
    const source = values.get('--input'); if (!source) throw ErrorRegistry.createError('CLI_USAGE');
    const input = await readJsonInput(source === '-' ? source : resolve(root, source), config.cli.invocationInputMaxBytes,
      { limit: 'CLI_INVOCATION_INPUT_LIMIT', invalid: 'CLI_INVOCATION_INPUT_INVALID', tty: 'CLI_INVOCATION_INPUT_TTY', unavailable: 'CLI_INVOCATION_INPUT_UNAVAILABLE' }, context.stdin);
    result = await client.enqueueTargetQueue(queueEnqueueSchema.parse(input));
  } else if (action === 'integration-queue-rollback') {
    result = await client.enqueueTargetQueueRollback(queueRollbackSchema.parse({ schemaVersion: 1, scopeId: values.get('--scope'), commandId: values.get('--command-id'), sourceCommandId: values.get('--source-command-id') }));
  } else if (action === 'integration-queue-list') {
    result = await client.listTargetQueue(queueListSchema.parse({ schemaVersion: 1, scopeId: values.get('--scope'), after: values.get('--after') ?? null, limit: Number(values.get('--limit') ?? config.targetQueue.perTarget) }));
  } else {
    const query = queueQuerySchema.parse({ schemaVersion: 1, scopeId: values.get('--scope'), commandId: values.get('--command-id') });
    if (action === 'integration-queue-inspect') result = await client.inspectTargetQueue(query);
    else if (action === 'integration-queue-confirm' && context.confirmDeliveryQueue) result = await context.confirmDeliveryQueue(query,
      view => askQueueConfirmation(view, locale, context.stdin ?? process.stdin, process.stderr, { timeoutMs: config.approvals.sessionTtlMs, ...(context.signal ? { signal: context.signal } : {}) }));
    else throw ErrorRegistry.createError('CLI_USAGE');
  }
  emit(result, { ...sinks, json, render: data => t('queue.cli.result', { result: JSON.stringify(data) }, locale) });
}
