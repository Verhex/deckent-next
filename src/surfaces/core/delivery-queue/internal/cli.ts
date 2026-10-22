import { resolve } from 'node:path';
import { emit, ErrorRegistry, loadConfig, resolveLocale, t, type Locale } from '#platform/index.js';
import { type QueueSubmitClient, type QueueQuery, type QueueConsent, type TargetBatchExecution, queueRollbackSchema, queueEnqueueSchema, queueQuerySchema, queueListSchema } from '#engine/index.js';
import { askQueueConfirmation } from '#surfaces/core/effect-confirmation/index.js';
import { readJsonInput } from '#surfaces/core/cli-kit/index.js';
import type { CliBaseContext } from '#surfaces/core/cli-kit/index.js';
import { askCliCard, cliMode, resolveCommandScope, scopeLister, scopeNotice } from '#surfaces/core/cli-human/index.js';
import { renderQueueList } from './list-table.js';
import { renderQueueExecution, renderQueueTicket } from './ticket-view.js';
const FLAG_OF: Readonly<Record<string, string>> = { scopeId: '--scope', commandId: '--command-id', sourceCommandId: '--source-command-id', limit: '--limit', after: '--after' };
/** A typed usage error naming the flag a value was refused for; a schema refusal never reaches the person as a raw validation array. */
function parseFlags<T>(command: string, locale: Locale, parse: () => T): T {
  try { return parse(); } catch (error) {
    const path = (error as { issues?: readonly { path: readonly unknown[] }[] } | null)?.issues?.[0]?.path[0];
    if (!Array.isArray((error as { issues?: unknown } | null)?.issues)) throw error;
    throw ErrorRegistry.createError('CLI_USAGE', { params: { command, usage: t('queue.cli.help', {}, locale), flag: typeof path === 'string' ? FLAG_OF[path] ?? path : '--input' } });
  }
}
export interface QueueCommandContext extends CliBaseContext, Pick<Parameters<typeof scopeLister>[0], 'configChoiceSources'> { deliveryQueue?: QueueSubmitClient; confirmDeliveryQueue?: (query: QueueQuery, ask: (view: Omit<QueueConsent, 'capability'>) => Promise<boolean>) => Promise<TargetBatchExecution> }
/** Queue admission is non-interactive; the exact publish and adoption batch each need the verified TTY. */
export async function queueCommand(argv: readonly string[], context: QueueCommandContext) {
  const action = argv[1], values = new Map<string, string>(); let json = false, verbose = false;
  // Each action accepts only its own flags: --source-command-id names the rollback's source ticket, nothing else.
  const allowed = action === 'integration-queue-enqueue' ? ['--input', '--lang'] : action === 'integration-queue-list' ? ['--scope', '--after', '--limit', '--lang']
    : ['--scope', '--command-id', '--lang', ...(action === 'integration-queue-rollback' ? ['--source-command-id'] : [])];
  for (let index = 2; index < argv.length; index++) {
    const flag = argv[index]!;
    if (flag === '--json' && !json) { json = true; continue; }
    // C-PRIO J1: the human list shows short ticket ids; --verbose (list only, once) prints the full ids.
    if (flag === '--verbose' && action === 'integration-queue-list' && !verbose) { verbose = true; continue; }
    if (!allowed.includes(flag) || values.has(flag)) throw ErrorRegistry.createError('CLI_USAGE');
    const value = argv[++index]; if (!value || value.startsWith('--')) throw ErrorRegistry.createError('CLI_USAGE'); values.set(flag, value);
  }
  const client = context.deliveryQueue, root = context.root ?? process.cwd(), env = context.env ?? process.env;
  if (!client) throw ErrorRegistry.createError('INVENTORY_UNAVAILABLE');
  let locale = resolveLocale(values.get('--lang'), env); context.onLocale?.(locale);
  const config = await loadConfig(root, { env }), sinks = { ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.stderr ? { stderr: context.stderr } : {}) };
  // The installation's configured language outranks LANG/LC_ALL (a C locale must not turn the owner's cards English); --lang wins.
  locale = resolveLocale(values.get('--lang'), env, config.language); context.onLocale?.(locale);
  const command = `deckent task ${action}`, missing = (flag: string) => ErrorRegistry.createError('CLI_ARGUMENT_MISSING', { params: { command,
    usage: [t('cli.help.bare.missing', { argument: flag }, locale), t('queue.cli.help', {}, locale)].join('\n') } });
  if (action === 'integration-queue-enqueue' && !values.has('--input')) throw missing('--input');
  if (action !== 'integration-queue-enqueue' && action !== 'integration-queue-list' && !values.has('--command-id')) throw missing('--command-id');
  if (action === 'integration-queue-rollback' && !values.has('--source-command-id')) throw missing('--source-command-id');
  let result: unknown, list: { scopeId: string; limit: number } | undefined, scopeId: string | undefined;
  if (action !== 'integration-queue-enqueue') {
    // Owner CLI review: a read says which scope answered (flag, else the configured default); a change never takes a silent default.
    const configured = (config as { terminal?: { scopeId?: unknown } }).terminal?.scopeId, mutating = action !== 'integration-queue-list' && action !== 'integration-queue-inspect';
    const interactive = cliMode(context, json).mode === 'interactive', ttlMs = config.approvals.sessionTtlMs;
    const resolved = await resolveCommandScope({ command, locale, explicit: values.get('--scope'), configured: typeof configured === 'string' ? configured : undefined,
      mutating, interactive, listScopes: () => scopeLister(context, root, { env })().catch(() => []),
      pick: request => askCliCard(request, { locale, env, signal: AbortSignal.any([AbortSignal.timeout(ttlMs), ...(context.signal ? [context.signal] : [])]),
        ...(context.stdin ? { stdin: context.stdin } : {}), ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.agentEnvironment ? { agentEnvironment: context.agentEnvironment } : {}) }) });
    if (!resolved) return;
    scopeId = resolved.scopeId; if (resolved.source !== 'flag' && !json) emit(scopeNotice(resolved, locale), sinks);
  }
  if (action === 'integration-queue-enqueue') {
    const source = values.get('--input')!;
    const input = await readJsonInput(source === '-' ? source : resolve(root, source), config.cli.invocationInputMaxBytes,
      { limit: 'CLI_INVOCATION_INPUT_LIMIT', invalid: 'CLI_INVOCATION_INPUT_INVALID', tty: 'CLI_INVOCATION_INPUT_TTY', unavailable: 'CLI_INVOCATION_INPUT_UNAVAILABLE' }, context.stdin);
    let enqueue: ReturnType<typeof queueEnqueueSchema.parse>;
    try { enqueue = queueEnqueueSchema.parse(input); } catch { throw ErrorRegistry.createError('CLI_INVOCATION_INPUT_INVALID'); }
    result = await client.enqueueTargetQueue(enqueue); scopeId = enqueue.identity.scopeId;
  } else if (action === 'integration-queue-rollback') {
    result = await client.enqueueTargetQueueRollback(parseFlags(command, locale, () => queueRollbackSchema.parse({ schemaVersion: 1, scopeId, commandId: values.get('--command-id'), sourceCommandId: values.get('--source-command-id') })));
  } else if (action === 'integration-queue-list') {
    const query = parseFlags(command, locale, () => queueListSchema.parse({ schemaVersion: 1, scopeId, after: values.get('--after') ?? null, limit: Number(values.get('--limit') ?? config.targetQueue.perTarget) }));
    result = await client.listTargetQueue(query); list = { scopeId: query.scopeId, limit: query.limit };
  } else {
    const query = parseFlags(command, locale, () => queueQuerySchema.parse({ schemaVersion: 1, scopeId, commandId: values.get('--command-id') }));
    if (action === 'integration-queue-inspect') result = await client.inspectTargetQueue(query);
    else if (action === 'integration-queue-confirm' && context.confirmDeliveryQueue) result = await context.confirmDeliveryQueue(query,
      view => askQueueConfirmation(view, locale, context.stdin ?? process.stdin, process.stderr, { timeoutMs: config.approvals.sessionTtlMs, ...(context.signal ? { signal: context.signal } : {}) }));
    else throw ErrorRegistry.createError('CLI_USAGE');
  }
  // The human list is a table (owner CLI review 2026-10-19); `--json` still prints the client's page unchanged.
  emit(result, { ...sinks, json, render: data => list ? renderQueueList(data as Awaited<ReturnType<QueueSubmitClient['listTargetQueue']>>, list.scopeId, list.limit, locale, { verbose })
    : action === 'integration-queue-confirm' ? renderQueueExecution(data as TargetBatchExecution, locale) : action === 'integration-queue-inspect'
      ? ((data as Awaited<ReturnType<QueueSubmitClient['inspectTargetQueue']>>).record ? renderQueueTicket((data as Awaited<ReturnType<QueueSubmitClient['inspectTargetQueue']>>).record!, scopeId!, locale)
        : t('queue.cli.ticket.none', { scope: scopeId!, ticket: values.get('--command-id')! }, locale))
      : renderQueueTicket(data as Awaited<ReturnType<QueueSubmitClient['enqueueTargetQueue']>>, scopeId!, locale) });
}
