import { resolve } from 'node:path';
import { ErrorRegistry, emit, loadConfig, resolveLocale, t } from '#platform/index.js';
import type { ExecutionProfileDefinition } from '#domain/index.js';
import { readJsonInput } from './json-input.js';
import type { CommandContext } from './kernel-commands.js';

export type CodingProfilePreparationHandler = (input: unknown) => Readonly<{
  schemaVersion: 1; profile: ExecutionProfileDefinition; activation: 'not-activated';
}>;

export async function codingCommand(argv: readonly string[], context: CommandContext): Promise<void> {
  let source: string | undefined; let language: string | undefined; let json = false;
  const help = argv.length === 2 && (argv[1] === '--help' || argv[1] === '-h');
  if (!help && argv[1] !== 'prepare') throw ErrorRegistry.createError('CLI_USAGE');
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--json' && !json) { json = true; continue; }
    if (flag !== '--input' && flag !== '--lang') throw ErrorRegistry.createError('CLI_USAGE');
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw ErrorRegistry.createError('CLI_USAGE');
    if (flag === '--input' && source === undefined) source = value;
    else if (flag === '--lang' && language === undefined) language = value;
    else throw ErrorRegistry.createError('CLI_USAGE');
  }
  const locale = resolveLocale(language, context.env); context.onLocale?.(locale);
  const sinks = { ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.stderr ? { stderr: context.stderr } : {}) };
  if (help) { emit(t('cli.coding.help', {}, locale), sinks); return; }
  if (!source || !context.prepareCodingProfile) throw ErrorRegistry.createError('CLI_USAGE');
  const root = context.root ?? process.cwd();
  const config = await loadConfig(root, { env: context.env ?? process.env });
  const input = await readJsonInput(source === '-' ? source : resolve(root, source), config.installation.profileMaxBytes,
    { limit: 'CLI_CODING_INPUT_LIMIT', invalid: 'CLI_CODING_INPUT_INVALID', tty: 'CLI_CODING_INPUT_TTY', unavailable: 'CLI_CODING_INPUT_UNAVAILABLE' }, context.stdin);
  const result = context.prepareCodingProfile(input);
  // The output is a preparation artifact, never evidence that a worker was started.
  emit(result, { ...sinks, json, render: value => JSON.stringify(value, null, 2) });
}
