import { resolve } from 'node:path';
import { ErrorRegistry, emit, loadConfig, loadConfigLanguage, resolveLocale, t, type ConfigLoadOptions } from '#platform/index.js';
import type { ExecutionProfileDefinition } from '#domain/index.js';
import { readJsonInput } from '#surfaces/core/cli-kit/index.js';
import type { AdminCommandContext } from './context.js';

export type CodingProfilePreparationHandler = (input: unknown) => Readonly<{
  schemaVersion: 1; profile: ExecutionProfileDefinition; activation: 'not-activated';
}>;

export async function codingCommand(argv: readonly string[], context: AdminCommandContext): Promise<void> {
  if (argv[1] === 'template') return codingTemplateCommand(argv, context);
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

export type CodingTemplateHandler = (root: string, input: { provider: string; kind: string; image?: string; apply: boolean },
  options: ConfigLoadOptions) => Promise<{ status: 'preview' | 'applied' | 'unchanged'; profile: ExecutionProfileDefinition; kind: unknown;
    registry: { revision: string }; expect: string | null; write: unknown }>;
async function codingTemplateCommand(argv: readonly string[], context: AdminCommandContext) {
  const values = new Map<string, string>(); const flags = new Set<string>();
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i]!;
    if (['--preview', '--apply', '--json'].includes(flag) && !flags.has(flag)) { flags.add(flag); continue; }
    if (!['--provider', '--kind', '--image', '--lang'].includes(flag) || values.has(flag)) throw ErrorRegistry.createError('CLI_USAGE');
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw ErrorRegistry.createError('CLI_USAGE');
    values.set(flag, value);
  }
  if (!values.has('--provider') || !values.has('--kind') || flags.has('--preview') === flags.has('--apply') || !context.configureCodingTemplate) throw ErrorRegistry.createError('CLI_USAGE');
  const root = context.root ?? process.cwd(), env = context.env ?? process.env;
  const locale = resolveLocale(values.get('--lang'), env, await loadConfigLanguage(root, { env })); context.onLocale?.(locale);
  const result = await context.configureCodingTemplate(root, { provider: values.get('--provider')!, kind: values.get('--kind')!,
    ...(values.has('--image') ? { image: values.get('--image')! } : {}), apply: flags.has('--apply') }, { env, heal: false });
  const output = { schemaVersion: 1, status: result.status, profile: result.profile, kind: result.kind,
    registryRevision: result.registry.revision, expect: result.expect, write: result.write };
  emit(output, { json: flags.has('--json'), ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.stderr ? { stderr: context.stderr } : {}),
    render: value => `${value.status === 'preview' ? t('cli.coding.template.preview', {}, locale)
      : value.status === 'applied' ? t('cli.coding.template.applied', {}, locale) : t('cli.coding.template.unchanged', {}, locale)}\n${JSON.stringify(value, null, 2)}` });
}
