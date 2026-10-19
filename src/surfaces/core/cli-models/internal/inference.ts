import { ErrorRegistry, emit, loadConfig, resolveLocale, t, formatValue, type ConfigLoadOptions, type Locale } from '#platform/index.js';
import { buildInferenceServingPlan, estimateReplicaCapacity, InferenceServingError, roleContextCeiling, InferenceTokenBudget, selectInferenceProfile } from '#engine/index.js';
import { commandLocale } from '#surfaces/core/cli-kit/index.js';
import type { ModelCommandContext } from './context.js';

interface Parsed {
  action: 'status' | 'plan' | 'budget' | 'metrics';
  json: boolean;
  help: boolean;
  language?: string;
  profileId?: string;
  reserveId?: string;
  reserveRole?: 'brain' | 'worker' | 'auditor';
  reserveTokens?: number;
}

function parse(argv: readonly string[]): Parsed {
  if (argv[0] !== 'inference') throw ErrorRegistry.createError('CLI_USAGE');
  // C-SETUP (review §inference): bare `deckent inference` (flags only) is the status read, never a usage error.
  const bare = argv[1] === undefined || argv[1].startsWith('-');
  const action = bare ? 'status' : argv[1];
  if (action !== 'status' && action !== 'plan' && action !== 'budget' && action !== 'metrics') throw ErrorRegistry.createError('CLI_USAGE');
  const parsed: Parsed = { action, json: false, help: false };
  const seen = new Set<string>();
  for (let index = bare ? 1 : 2; index < argv.length; index++) {
    const key = argv[index] === '-h' ? '--help' : argv[index]!;
    if (key === '--help') { parsed.help = true; continue; }
    if (key === '--json') { parsed.json = true; continue; }
    if (key === '--no-color') continue;
    if (key === '--lang') {
      const language = argv[++index];
      if (!language || language.startsWith('-')) throw ErrorRegistry.createError('CLI_USAGE');
      parsed.language = language;
      continue;
    }
    if (seen.has(key)) throw ErrorRegistry.createError('CLI_USAGE');
    seen.add(key);
    if (key === '--profile') {
      const value = argv[++index];
      if (!value || value.startsWith('-')) throw ErrorRegistry.createError('CLI_USAGE');
      parsed.profileId = value;
    } else if (key === '--reserve-id') {
      const value = argv[++index];
      if (!value) throw ErrorRegistry.createError('CLI_USAGE');
      parsed.reserveId = value;
    } else if (key === '--reserve-role') {
      const role = argv[++index];
      if (role !== 'brain' && role !== 'worker' && role !== 'auditor') throw ErrorRegistry.createError('CLI_USAGE');
      parsed.reserveRole = role;
    } else if (key === '--reserve-tokens') {
      const tokens = Number(argv[++index]);
      if (!Number.isSafeInteger(tokens) || tokens <= 0) throw ErrorRegistry.createError('CLI_USAGE');
      parsed.reserveTokens = tokens;
    } else throw ErrorRegistry.createError('CLI_USAGE');
  }
  if (parsed.help && parsed.json) throw ErrorRegistry.createError('CLI_USAGE');
  const reserve = [parsed.reserveId, parsed.reserveRole, parsed.reserveTokens].filter(value => value !== undefined).length;
  if (reserve !== 0 && (reserve !== 3 || parsed.action !== 'budget')) throw ErrorRegistry.createError('CLI_USAGE');
  return parsed;
}

function selectProfile(config: Record<string, unknown>, profileId: string | undefined, locale: Locale) {
  try { return selectInferenceProfile(config, profileId); }
  catch (error) {
    if (error instanceof InferenceServingError) throw ErrorRegistry.createError(error.code, { params: { profile: error.profileId }, locale, cause: error });
    throw error;
  }
}

function renderPlan(plan: ReturnType<typeof buildInferenceServingPlan>, locale: Locale): string {
  return [
    t('inference.plan.header', { profile: plan.profileId, backend: plan.backend }, locale),
    t('inference.plan.capacity', {
      replicas: plan.capacity.replicaCount,
      tokenBudget: plan.capacity.totalTokenBudget,
      maxSeqs: plan.capacity.maxNumSeqs,
      kvPoolGb: plan.capacity.kvPoolGb.toFixed(2),
    }, locale),
    t('inference.plan.launcher', { kind: plan.launcher.kind, argv: plan.launcher.argv.join(' ') }, locale),
    ...(plan.openaiBaseUrl ? [t('inference.plan.endpoint', { url: plan.openaiBaseUrl }, locale)] : []),
  ].join('\n');
}

/** Models this installation calls on this machine: invocation profiles whose endpoint is a loopback address (no provider id is assumed). */
function localModels(config: Record<string, unknown>): { readonly model: string; readonly provider: string }[] {
  const profiles = (config['provider_invocation_profiles'] as { profiles?: readonly unknown[] } | undefined)?.profiles ?? [];
  const local = profiles.flatMap(entry => {
    const profile = entry as { reference?: { providerId?: unknown; modelId?: unknown }; adapter?: { definition?: { endpoint?: unknown } } };
    const endpoint = profile.adapter?.definition?.endpoint;
    let host: string;
    try { host = typeof endpoint === 'string' ? new URL(endpoint).hostname : ''; } catch { host = ''; }
    const loopback = host === 'localhost' || host === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(host);
    return loopback && typeof profile.reference?.modelId === 'string' && typeof profile.reference.providerId === 'string'
      ? [{ model: profile.reference.modelId, provider: profile.reference.providerId }] : [];
  });
  return [...new Map(local.map(item => [`${item.provider}/${item.model}`, item])).values()];
}
/** No serving profile: what it is for, the local model already connected (a different thing), and where to define one. */
function renderAbsent(local: readonly { readonly model: string; readonly provider: string }[], locale: Locale): string {
  return [t('clisetup.inference.absent', {}, locale),
    ...local.map(item => t('clisetup.inference.localModel', { model: item.model, provider: item.provider }, locale)),
    t('clisetup.inference.why', {}, locale), t('clisetup.inference.define', {}, locale)].join('\n');
}

export async function inferenceCommand(argv: readonly string[], context: ModelCommandContext = {}): Promise<void> {
  const parsed = parse(argv);
  const root = context.root ?? process.cwd();
  const env = context.env ?? process.env;
  let locale = commandLocale(context, parsed.language);
  const sinks = { ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.stderr ? { stderr: context.stderr } : {}) };
  if (parsed.help) {
    emit(t('cli.help.inference', {}, locale), sinks);
    return;
  }
  const options: ConfigLoadOptions = { env };
  const config = await loadConfig(root, { ...options, heal: false });
  if (!parsed.language && !context.locale) { locale = resolveLocale(undefined, env, config.language); context.onLocale?.(locale); }
  const profile = selectProfile(config as Record<string, unknown>, parsed.profileId, locale);
  if (parsed.action === 'status') {
    const local = localModels(config as Record<string, unknown>), plan = profile ? buildInferenceServingPlan(profile) : null;
    emit({ schemaVersion: 1 as const, profileId: plan?.profileId ?? null, plan, localModels: local }, { ...sinks, json: parsed.json,
      render: value => value.plan ? [renderPlan(value.plan, locale), t('clisetup.inference.next', {}, locale)].join('\n') : renderAbsent(value.localModels, locale) });
    return;
  }
  if (!profile) {
    emit(t('inference.notConfigured', {}, locale), { ...sinks, level: 'warning' });
    return;
  }
  if (parsed.action === 'metrics') {
    if (!context.readInferenceMetrics) throw ErrorRegistry.createError('CLI_USAGE');
    const reading = await context.readInferenceMetrics(root, parsed.profileId === undefined ? {} : { profileId: parsed.profileId }, options);
    // A metrics read that did not happen is a command failure (exit 1), never an empty success.
    if (!reading.ok) throw ErrorRegistry.createError('INFERENCE_METRICS_UNREAD', { params: { reason: reading.code, url: reading.url ?? '-' }, locale });
    emit(reading, { ...sinks, json: parsed.json, render: value => value.body });
    return;
  }
  if (parsed.action === 'plan') {
    const plan = buildInferenceServingPlan(profile);
    emit(plan, { ...sinks, json: parsed.json, render: value => parsed.json ? formatValue(value) : renderPlan(value, locale) });
    return;
  }
  const capacity = estimateReplicaCapacity(profile);
  const budget = new InferenceTokenBudget(capacity.totalTokenBudget, role => roleContextCeiling(profile, role));
  if (parsed.reserveId && parsed.reserveRole && parsed.reserveTokens) {
    const disposition = budget.tryReserve({ id: parsed.reserveId, role: parsed.reserveRole, estimatedTokens: parsed.reserveTokens });
    emit({ disposition, state: budget.snapshot() }, { ...sinks, json: parsed.json, render: value => formatValue(value) });
    return;
  }
  emit(budget.snapshot(), { ...sinks, json: parsed.json, render: value => formatValue(value) });
}
