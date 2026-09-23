import { resolve } from 'node:path';
import { ErrorRegistry, emit, loadConfig, resolveLocale, t, type ConfigLoadOptions } from '#platform/index.js';
import type { EffectCommand, EffectRecord } from '#domain/index.js';
import type { EffectResult } from '#engine/index.js';
import { readJsonInput } from './json-input.js';
import type { CommandContext } from './kernel-commands.js';
export type OperationEffectHandler = (root: string, command: EffectCommand, options: ConfigLoadOptions) => Promise<EffectResult>;
export type OperationInspectHandler = (root: string, query: { readonly scopeId: string; readonly commandId: string }, options: ConfigLoadOptions)
  => Promise<Readonly<{ schemaVersion: 1; record: EffectRecord | null }>>;
/** `deckent operation execute|compensate --input <file|->` and `inspect --scope <id> --command-id <id>`. */
export async function operationCommand(argv: readonly string[], context: CommandContext): Promise<void> {
  const action = argv[1]; const values = new Map<string, string>(); let json = false;
  const help = argv.length === 2 && (action === '--help' || action === '-h');
  if (!help && action !== 'execute' && action !== 'compensate' && action !== 'inspect') throw ErrorRegistry.createError('CLI_USAGE');
  const allowed = action === 'inspect' ? ['--scope', '--command-id', '--lang'] : ['--input', '--lang'];
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i]!; if (flag === '--json' && !json) { json = true; continue; }
    if (!allowed.includes(flag) || values.has(flag)) throw ErrorRegistry.createError('CLI_USAGE');
    const value = argv[++i]; if (!value || value.startsWith('--')) throw ErrorRegistry.createError('CLI_USAGE');
    values.set(flag, value);
  }
  const locale = resolveLocale(values.get('--lang'), context.env); context.onLocale?.(locale);
  const sinks = { ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.stderr ? { stderr: context.stderr } : {}) };
  if (help) { emit(t('cli.operation.help', {}, locale), sinks); return; }
  const root = context.root ?? process.cwd(); const options = { env: context.env ?? process.env };
  if (action === 'inspect') {
    const scopeId = values.get('--scope'), commandId = values.get('--command-id');
    if (!scopeId || !commandId || !context.inspectOperation) throw ErrorRegistry.createError('CLI_USAGE');
    const result = await context.inspectOperation(root, { scopeId, commandId }, options);
    emit(result, { ...sinks, json, render: data => data.record
      ? t('cli.operation.inspect', { command: commandId, state: data.record.state, sequence: data.record.sequence }, locale)
      : t('cli.operation.absent', { command: commandId }, locale) });
    return;
  }
  const source = values.get('--input'); const handler = action === 'execute' ? context.executeOperation : context.compensateOperation;
  if (!source || !handler) throw ErrorRegistry.createError('CLI_USAGE');
  const config = await loadConfig(root, options);
  const input = await readJsonInput(source === '-' ? source : resolve(root, source), config.cli.invocationInputMaxBytes,
    { limit: 'CLI_INVOCATION_INPUT_LIMIT', invalid: 'CLI_INVOCATION_INPUT_INVALID', tty: 'CLI_INVOCATION_INPUT_TTY', unavailable: 'CLI_INVOCATION_INPUT_UNAVAILABLE' }, context.stdin);
  const result = await handler(root, input as EffectCommand, options);
  emit(result, { ...sinks, json, render: data => t('cli.operation.settled', { operation: data.operation.id, version: data.operation.version,
    kind: data.target.kind, id: data.target.id, sequence: data.sequence, recordVersion: data.version ?? t('cli.value.none', {}, locale) }, locale) });
}
