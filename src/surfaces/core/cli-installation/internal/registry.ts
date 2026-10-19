import { ErrorRegistry, emit, loadConfigLanguage, resolveLocale, t } from '#platform/index.js';
import type { InitialRegistryRequest } from '#engine/index.js';
import type { InstallationCommandContext } from './context.js';

export async function initRegistryCommand(argv: readonly string[], context: InstallationCommandContext) {
  const values = new Map<string, string>(), flags = new Set<string>();
  const allowed = ['--provider', '--kind', '--scope', '--pool', '--execution-slots', '--in-flight-slots', '--discovery', '--lang'];
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i]!;
    if (['--preview', '--apply', '--json'].includes(flag) && !flags.has(flag)) { flags.add(flag); continue; }
    if (!allowed.includes(flag) || values.has(flag)) throw ErrorRegistry.createError('CLI_USAGE');
    const value = argv[++i];
    if (!value || value.startsWith('-')) throw ErrorRegistry.createError('CLI_USAGE');
    values.set(flag, value);
  }
  if (allowed.slice(0, -1).some(flag => !values.has(flag)) || flags.has('--preview') === flags.has('--apply') || !context.initializeNativeCodingRegistry) throw ErrorRegistry.createError('CLI_USAGE');
  const root = context.root ?? process.cwd(), env = context.env ?? process.env;
  const locale = resolveLocale(values.get('--lang'), env, await loadConfigLanguage(root, { env })); context.onLocale?.(locale);
  const input = { schemaVersion: 1 as const, scopeId: values.get('--scope')!, provider: values.get('--provider')!, kind: values.get('--kind')!,
    poolId: values.get('--pool')!, executionSlots: Number(values.get('--execution-slots')), inFlightSlots: Number(values.get('--in-flight-slots')),
    discovery: values.get('--discovery')! as InitialRegistryRequest['discovery'], apply: flags.has('--apply') };
  const result = await context.initializeNativeCodingRegistry(root, input, { env, heal: false });
  emit({ schemaVersion: result.schemaVersion, status: result.status, profile: result.profile, kind: result.kind,
    registry: result.registry, expect: result.expect, write: result.write }, { json: flags.has('--json'),
    ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.stderr ? { stderr: context.stderr } : {}),
    render: value => `${value.status === 'preview' ? t('cli.init.registry.preview', {}, locale) : value.status === 'current' ? t('cli.init.registry.current', {}, locale) : t('cli.init.registry.applied', {}, locale)}\n${JSON.stringify(value, null, 2)}` });
}
