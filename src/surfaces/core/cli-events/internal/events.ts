import { ErrorRegistry, loadConfig, resolveLocale, type ConfigLoadOptions } from '#platform/index.js';
import { runtimeEventsQuerySchema, type RuntimeEventsQuery, type RuntimeEventsItem } from '#engine/index.js';
import { readJsonInput } from '#surfaces/core/cli-kit/index.js';
import type { CliBaseContext } from '#surfaces/core/cli-kit/index.js';
export interface EventsCommandContext extends CliBaseContext { readonly subscribeEvents?: EventsHandler }
export type EventsHandler = (root: string, query: RuntimeEventsQuery, options: ConfigLoadOptions,
  observer: { readonly signal: AbortSignal; readonly onEvent: (item: RuntimeEventsItem) => Promise<void> }) => Promise<void>;
/** Fixed stdin/JSONL route. Aborting this view disconnects its subscription and never submits a Run cancellation. */
export async function eventsCommand(argv: readonly string[], context: EventsCommandContext): Promise<void> {
  const values = new Map<string, string>(); let follow = false, json = false;
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i]!;
    if (flag === '--follow' && !follow) { follow = true; continue; }
    if (flag === '--json' && !json) { json = true; continue; }
    if (!['--input', '--lang'].includes(flag) || values.has(flag)) throw ErrorRegistry.createError('CLI_USAGE');
    const value = argv[++i]; if (!value || value.startsWith('--')) throw ErrorRegistry.createError('CLI_USAGE'); values.set(flag, value);
  }
  if (!follow || !json || values.get('--input') !== '-' || !context.subscribeEvents) throw ErrorRegistry.createError('CLI_USAGE');
  const root = context.root ?? process.cwd(), options = { env: context.env ?? process.env };
  const config = await loadConfig(root, options);
  context.onLocale?.(resolveLocale(values.get('--lang'), options.env, config.language));
  if (context.signal?.aborted) return;
  const stdin = context.stdin ?? process.stdin, stopInput = () => { stdin.destroy(); };
  context.signal?.addEventListener('abort', stopInput, { once: true });
  let input: unknown;
  try { input = await readJsonInput('-', config.service.inputMaxBytes, { limit: 'CLI_INVOCATION_INPUT_LIMIT', invalid: 'RUNTIME_EVENTS_INVALID',
    tty: 'CLI_INVOCATION_INPUT_TTY', unavailable: 'CLI_INVOCATION_INPUT_UNAVAILABLE' }, stdin); }
  catch (error) { if (context.signal?.aborted) return; throw error; }
  finally { context.signal?.removeEventListener('abort', stopInput); }
  const query = runtimeEventsQuerySchema.safeParse(input);
  if (!query.success) throw ErrorRegistry.createError('RUNTIME_EVENTS_INVALID');
  const controller = new AbortController(), abort = () => controller.abort();
  context.signal?.addEventListener('abort', abort, { once: true }); if (context.signal?.aborted) abort();
  const sink = context.stdout ?? process.stdout;
  const stream = sink as typeof process.stdout;
  let failure: Error | null = null;
  const broken = (error: Error & { code?: string }) => { if (error.code !== 'EPIPE') failure = ErrorRegistry.createError('RUNTIME_EVENTS_UNAVAILABLE'); controller.abort(); }; stream.on?.('error', broken);
  try {
    await context.subscribeEvents(root, query.data, options, { signal: controller.signal, onEvent: item => new Promise<void>((resolve, reject) => {
      if (controller.signal.aborted) { resolve(); return; }
      const text = JSON.stringify(item) + '\n';
      try {
        if (sink.write(text) !== false) { resolve(); return; }
        // One line waits for stdout. The SDK pauses its socket while this callback is pending.
        const finish = () => { clearTimeout(timer); stream.off?.('drain', drain); controller.signal.removeEventListener('abort', finish); resolve(); };
        const drain = () => finish();
        const timer = setTimeout(() => { failure = ErrorRegistry.createError('RUNTIME_EVENTS_LIMIT'); abort(); finish(); }, config.service.events.drainTimeoutMs);
        stream.once?.('drain', drain); controller.signal.addEventListener('abort', finish, { once: true });
      } catch (error) { abort(); reject(error); }
    }) });
  } catch (error) { if (failure) throw failure; if (!controller.signal.aborted) throw error; }
  finally { abort(); context.signal?.removeEventListener('abort', abort); stream.off?.('error', broken); }
}
