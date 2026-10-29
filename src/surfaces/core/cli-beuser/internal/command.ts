import { ErrorRegistry, emit, t, loadConfig, terminalSafeText, redactSensitive, type ConfigLoadOptions } from '#platform/index.js';
import { commandLocale, type CliBaseContext } from '#surfaces/core/cli-kit/index.js';
import { askCliCard, cliMode } from '#surfaces/core/cli-human/index.js';
import type { BeuserReport } from '#engine/index.js';
import { formatBeuserReport } from './report.js';
export interface BeuserCommandContext extends CliBaseContext {
  setupBeuser?: (root: string, input: { scopeId: string; profile: string; apply: boolean; expect?: string }, options: ConfigLoadOptions) => Promise<{ status: string; digest: string; admission: unknown }>;
  walkBeuser?: (root: string, input: { readonly scopeId: string; readonly journey: string; readonly candidate: string }, options: ConfigLoadOptions, signal?: AbortSignal) => Promise<BeuserReport>;
  readBeuserReport?: (root: string, scopeId: string, runId: string | undefined, options: ConfigLoadOptions) => Promise<BeuserReport>;
}
export function parseBeuserArguments(argv: readonly string[]) {
  const action = argv[1]; if (argv[0] !== 'beuser' || !['setup', 'walk', 'report'].includes(action ?? '')) throw ErrorRegistry.createError('CLI_USAGE');
  const values = new Map<string, string>(), flags = new Set<string>();
  for (let index = 2; index < argv.length; index++) {
    const key = argv[index]!; if (values.has(key) || flags.has(key)) throw ErrorRegistry.createError('CLI_USAGE');
    if (['--help', '-h', '--json', '--no-color', ...(action === 'setup' ? ['--apply'] : [])].includes(key)) flags.add(key);
    else if (['--scope', '--lang', ...(action === 'walk' ? ['--journey', '--candidate'] : action === 'setup' ? ['--profile'] : ['--run'])].includes(key)) {
      const value = argv[++index]; if (!value || value.startsWith('-')) throw ErrorRegistry.createError('CLI_USAGE'); values.set(key, value);
    } else throw ErrorRegistry.createError('CLI_USAGE');
  }
  const help = flags.has('--help') || flags.has('-h');
  if (!help && action === 'walk' && (!values.has('--journey') || !values.has('--candidate'))) throw ErrorRegistry.createError('CLI_USAGE');
  if (!help && action === 'setup' && !values.has('--profile')) throw ErrorRegistry.createError('CLI_USAGE');
  return { action: action as 'setup' | 'walk' | 'report', help, json: flags.has('--json'), apply: flags.has('--apply'), profile: values.get('--profile'), language: values.get('--lang'), scope: values.get('--scope'),
    journey: values.get('--journey'), candidate: values.get('--candidate'), runId: values.get('--run') };
}
/** Help and parsing have no host effects. Only the composition's typed callbacks can admit work or open a retained report. */
export async function beuserCommand(argv: readonly string[], context: BeuserCommandContext = {}) {
  const args = parseBeuserArguments(argv), locale = commandLocale(context, args.language);
  const sinks = { ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.stderr ? { stderr: context.stderr } : {}) };
  if (args.help) { emit(args.action === 'setup' ? t('beuser.help.setup', {}, locale) : args.action === 'walk' ? t('beuser.help.walk', {}, locale) : t('beuser.help.report', {}, locale), sinks); return; }
  if (args.action === 'setup' && cliMode(context).mode !== 'interactive') throw ErrorRegistry.createError('AUTHORITY_WITNESS_REQUIRED', { params: { operation: argv.slice(0, 2).join(' ') } });
  const root = context.root ?? process.cwd(), options = { env: context.env ?? process.env };
  const terminal = !args.scope ? (await loadConfig(root, options))['terminal'] as { scopeId?: string } | undefined : undefined;
  const scopeId = args.scope ?? terminal?.scopeId;
  if (!scopeId) throw ErrorRegistry.createError('CLI_SCOPE_REQUIRED', { params: { command: argv.slice(0, 2).join(' '), scopes: '' } });
  if (args.action === 'setup') {
    if (!context.setupBeuser) throw ErrorRegistry.createError('EXECUTION_NOT_CONFIGURED');
    const input = { scopeId, profile: args.profile!, apply: false }, preview = await context.setupBeuser(root, input, options);
    let result = preview;
    if (args.apply) {
      const config = await loadConfig(root, options);
      const answer = await askCliCard({ title: t('beuser.setup.card', {}, locale),
        body: [t('beuser.setup.change', { scope: terminalSafeText(scopeId), digest: preview.digest }, locale), terminalSafeText(redactSensitive(JSON.stringify(preview.admission)))],
        options: [{ id: 'apply', role: 'yes', label: t('beuser.setup.apply', {}, locale) }, { id: 'cancel', role: 'no', label: t('beuser.setup.cancel', {}, locale) }] },
      { locale, env: options.env, signal: AbortSignal.any([AbortSignal.timeout(config.approvals.sessionTtlMs), ...(context.signal ? [context.signal] : [])]),
        ...(context.stdin ? { stdin: context.stdin } : {}), ...(context.stdout ? { stdout: context.stdout } : {}) });
      if (answer === 'apply') result = await context.setupBeuser(root, { ...input, apply: true, expect: preview.digest }, options);
      else result = { ...preview, status: 'cancelled' };
    }
    emit(args.json ? JSON.stringify(result) : t('beuser.setup.result', { status: result.status, digest: result.digest }, locale), sinks); return;
  }
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
