import { ErrorRegistry, emit, t, loadConfig, type ConfigLoadOptions } from '#platform/index.js';
import { commandLocale, type CliBaseContext } from '#surfaces/core/cli-kit/index.js';
import type { BeuserReport } from '#engine/index.js';
import { formatBeuserReport } from './report.js';
export interface BeuserCommandContext extends CliBaseContext {
  walkBeuser?: (root: string, input: { readonly scopeId: string; readonly journey: string; readonly candidate: string }, options: ConfigLoadOptions, signal?: AbortSignal) => Promise<BeuserReport>;
  readBeuserReport?: (root: string, scopeId: string, runId: string | undefined, options: ConfigLoadOptions) => Promise<BeuserReport>;
}
export function parseBeuserArguments(argv: readonly string[]) {
  const action = argv[1]; if (argv[0] !== 'beuser' || !['walk', 'report'].includes(action ?? '')) throw ErrorRegistry.createError('CLI_USAGE');
  const values = new Map<string, string>(), flags = new Set<string>();
  for (let index = 2; index < argv.length; index++) {
    const key = argv[index]!; if (values.has(key) || flags.has(key)) throw ErrorRegistry.createError('CLI_USAGE');
    if (['--help', '-h', '--json', '--no-color'].includes(key)) flags.add(key);
    else if (['--scope', '--lang', ...(action === 'walk' ? ['--journey', '--candidate'] : ['--run'])].includes(key)) {
      const value = argv[++index]; if (!value || value.startsWith('-')) throw ErrorRegistry.createError('CLI_USAGE'); values.set(key, value);
    } else throw ErrorRegistry.createError('CLI_USAGE');
  }
  const help = flags.has('--help') || flags.has('-h');
  if (!help && action === 'walk' && (!values.has('--journey') || !values.has('--candidate'))) throw ErrorRegistry.createError('CLI_USAGE');
  return { action: action as 'walk' | 'report', help, json: flags.has('--json'), language: values.get('--lang'), scope: values.get('--scope'),
    journey: values.get('--journey'), candidate: values.get('--candidate'), runId: values.get('--run') };
}
/** Help and parsing have no host effects. Only the composition's typed callbacks can admit work or open a retained report. */
export async function beuserCommand(argv: readonly string[], context: BeuserCommandContext = {}) {
  const args = parseBeuserArguments(argv), locale = commandLocale(context, args.language);
  const sinks = { ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.stderr ? { stderr: context.stderr } : {}) };
  if (args.help) { emit(args.action === 'walk' ? t('beuser.help.walk', {}, locale) : t('beuser.help.report', {}, locale), sinks); return; }
  const root = context.root ?? process.cwd(), options = { env: context.env ?? process.env };
  const terminal = !args.scope ? (await loadConfig(root, options))['terminal'] as { scopeId?: string } | undefined : undefined;
  const scopeId = args.scope ?? terminal?.scopeId;
  if (!scopeId) throw ErrorRegistry.createError('CLI_SCOPE_REQUIRED', { params: { command: argv.slice(0, 2).join(' '), scopes: '' } });
  let report;
  if (args.action === 'walk') {
    if (!context.walkBeuser) throw ErrorRegistry.createError('EXECUTION_NOT_CONFIGURED');
    report = await context.walkBeuser(root, { scopeId, journey: args.journey!, candidate: args.candidate! }, options, context.signal);
  } else {
    if (!context.readBeuserReport) throw ErrorRegistry.createError('EXECUTION_NOT_CONFIGURED');
    report = await context.readBeuserReport(root, scopeId, args.runId, options);
  }
  emit(formatBeuserReport(report, { json: args.json, locale }), sinks);
}
