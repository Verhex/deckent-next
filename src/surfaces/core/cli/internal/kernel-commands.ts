import {
  configDisplayView, inspectProductPaths, getConfigFieldDefault, ErrorRegistry, loadConfig, getConfigValue,
  resolveGlobalScopePaths, normalizeGlobalScopePlatform, getSystemProfile,
  detectHostMemory, detectEnvironment, resolveLocalOsPrincipal, resolveTenant, resolveCallerTenant,
  assertActorAssurance, principalToActor, resolveLocale, t, formatValue, emit,
  type ConfigLoadOptions, type OutputMode, type OutputSink, type Locale,
} from '#platform/index.js';

export interface CommandContext {
  initialize?: () => void;
  root?: string; env?: NodeJS.ProcessEnv; stdout?: OutputSink; stderr?: OutputSink;
  onLocale?: (locale: Locale) => void;
}
interface Parsed { positionals: string[]; json: boolean; global: boolean; dryRun: boolean; language?: string }
function parse(argv: readonly string[]): Parsed {
  const result: Parsed = { positionals: [], json: false, global: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--json') result.json = true;
    else if (arg === '--global') result.global = true;
    else if (arg === '--dry-run') result.dryRun = true;
    else if (arg === '--no-color') continue;
    else if (arg === '--lang') {
      const language = argv[++i];
      if (!language || language.startsWith('-')) throw ErrorRegistry.createError('CLI_USAGE');
      result.language = language;
    } else if (arg.startsWith('-')) throw ErrorRegistry.createError('CLI_USAGE');
    else result.positionals.push(arg);
  }
  return result;
}
export async function runKernelCommand(argv: readonly string[], context: CommandContext = {}): Promise<void> {
  const args = parse(argv), root = context.root ?? process.cwd(), env = context.env ?? process.env;
  const [command, action, key] = args.positionals;
  let locale = resolveLocale(args.language, env);
  context.onLocale?.(locale);
  let mode: OutputMode = getConfigFieldDefault('output_mode');
  function output<T>(data: T, render: (data: T) => string, level: 'info' | 'warning' = 'info') {
    emit(data, { json: args.json, mode, level, render, ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.stderr ? { stderr: context.stderr } : {}) });
  }
  const options: ConfigLoadOptions = { env, globalOnly: args.global,
    onWarning: warning => output(warning, value => value.message, 'warning') };
  if (command === 'paths') {
    if (args.dryRun || args.positionals.length !== 1) throw ErrorRegistry.createError('CLI_USAGE');
    output(await inspectProductPaths(root, { ...options, globalOnly: args.global }), data => formatValue(data));
    return;
  }
  if (command === 'config') {
    if (action === 'get') {
      if (args.dryRun || args.positionals.length > 3) throw ErrorRegistry.createError('CLI_USAGE');
      const config = await loadConfig(root, options);
      locale = resolveLocale(args.language, env, config.language); mode = config.output_mode;
      context.onLocale?.(locale);
      const display = configDisplayView(config);
      const value = key === undefined ? display : getConfigValue(display, key);
      output(value, data => formatValue(data));
      return;
    }
    throw ErrorRegistry.createError('CLI_USAGE');
  }
  if (command !== 'doctor' || args.positionals.length !== 1 || args.global || args.dryRun) throw ErrorRegistry.createError('CLI_USAGE');
  const config = await loadConfig(root, options);
  locale = resolveLocale(args.language, env, config.language); mode = config.output_mode;
  context.onLocale?.(locale);
  const platform = normalizeGlobalScopePlatform(process.platform, env), host = getSystemProfile();
  const tenant = resolveTenant(root, { env, layout: config.productLayout, tenantId: env['DECKENT_TENANT_ID'] || config.tenant_id });
  const osPrincipal = resolveLocalOsPrincipal('cli');
  const claim = env['DECKENT_TENANT_ID'] || (config.tenant_id === 'local' ? undefined : config.tenant_id);
  const principal = { ...osPrincipal, ...(claim ? { tenantId: claim } : {}) };
  assertActorAssurance(principalToActor(principal), 'doctor', config.enforce_principal_assurance);
  resolveCallerTenant(principal, config.strict_tenant_isolation);
  const data = { schemaVersion: 1, scope: 'kernel', platform, host, hostMemory: detectHostMemory(), environment: detectEnvironment(env),
    paths: resolveGlobalScopePaths(platform, env), principal, tenant: { tenantId: tenant.tenantId, isolationRoot: tenant.isolationRoot }, status: 'ready' };
  output(data, result => t('doctor.host', { platform: result.platform, cpu: result.host.cpuCores, memory: result.host.totalMemMB,
    workers: result.host.recommendedMaxWorkers, tenant: result.tenant.tenantId, principal: result.principal.id }, locale));
}
