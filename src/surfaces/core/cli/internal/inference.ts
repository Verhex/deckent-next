import { ErrorRegistry, emit, loadConfig, resolveLocale, t, formatValue, type ConfigLoadOptions, type Locale } from '#platform/index.js';
import { parseInferenceServingConfig, resolveActiveInferenceProfile } from '#domain/index.js';
import { spawn } from 'node:child_process';
import { buildInferenceServingPlan, estimateReplicaCapacity, parseInferencePrometheus, readInferenceServingConfig, roleContextCeiling, InferenceTokenBudget } from '#engine/index.js';
import type { CommandContext } from './kernel-commands.js';

interface Parsed {
  action: 'plan' | 'metrics' | 'budget' | 'serve';
  json: boolean;
  help: boolean;
  dryRun: boolean;
  language?: string;
  profileId?: string;
  metricsUrl?: string;
  reserveId?: string;
  reserveRole?: 'brain' | 'worker' | 'auditor';
  reserveTokens?: number;
}

function parse(argv: readonly string[]): Parsed {
  if (argv[0] !== 'inference') throw ErrorRegistry.createError('CLI_USAGE');
  const action = argv[1];
  if (action !== 'plan' && action !== 'metrics' && action !== 'budget' && action !== 'serve') throw ErrorRegistry.createError('CLI_USAGE');
  const parsed: Parsed = { action, json: false, help: false, dryRun: false };
  const seen = new Set<string>();
  for (let index = 2; index < argv.length; index++) {
    const key = argv[index] === '-h' ? '--help' : argv[index]!;
    if (key === '--help') { parsed.help = true; continue; }
    if (key === '--dry-run') { parsed.dryRun = true; continue; }
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
    } else if (key === '--metrics-url') {
      const value = argv[++index];
      if (!value || value.startsWith('-')) throw ErrorRegistry.createError('CLI_USAGE');
      parsed.metricsUrl = value;
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
  return parsed;
}

function resolveProfile(config: ReturnType<typeof parseInferenceServingConfig>, profileId?: string) {
  if (!profileId) return resolveActiveInferenceProfile(config);
  const profile = config.profiles.find(entry => entry.id === profileId);
  if (!profile) throw ErrorRegistry.createError('CLI_USAGE');
  return profile;
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

export async function inferenceCommand(argv: readonly string[], context: CommandContext = {}): Promise<void> {
  const parsed = parse(argv);
  const root = context.root ?? process.cwd();
  const env = context.env ?? process.env;
  let locale = resolveLocale(parsed.language, env);
  context.onLocale?.(locale);
  const sinks = { ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.stderr ? { stderr: context.stderr } : {}) };
  if (parsed.help) {
    emit(t('cli.help.inference', {}, locale), sinks);
    return;
  }
  const options: ConfigLoadOptions = { env };
  const config = await loadConfig(root, options);
  locale = resolveLocale(parsed.language, env, config.language);
  context.onLocale?.(locale);
  const serving = readInferenceServingConfig(config as Record<string, unknown>);
  if (!serving) {
    emit(t('inference.notConfigured', {}, locale), { ...sinks, level: 'warning' });
    return;
  }
  const profile = resolveProfile(serving, parsed.profileId);
  if (parsed.action === 'plan' || parsed.action === 'serve') {
    const plan = buildInferenceServingPlan(profile);
    if (parsed.action === 'serve') {
      if (parsed.dryRun || plan.launcher.argv.length === 0) {
        emit(plan, { ...sinks, json: parsed.json, render: value => parsed.json ? formatValue(value) : renderPlan(value, locale) });
        return;
      }
      const child = spawn(plan.launcher.argv[0]!, plan.launcher.argv.slice(1), { stdio: 'inherit', env: { ...env, ...plan.launcher.env } });
      await new Promise<void>((resolvePromise, reject) => {
        child.on('error', reject);
        child.on('exit', code => { if (code === 0) resolvePromise(); else reject(ErrorRegistry.createError('CLI_USAGE')); });
      });
      return;
    }
    emit(plan, { ...sinks, json: parsed.json, render: value => parsed.json ? formatValue(value) : renderPlan(value, locale) });
    return;
  }
  if (parsed.action === 'metrics') {
    if (!parsed.metricsUrl) throw ErrorRegistry.createError('CLI_USAGE');
    const response = await fetch(parsed.metricsUrl, context.signal ? { signal: context.signal } : {});
    if (!response.ok) throw ErrorRegistry.createError('CLI_USAGE');
    const body = await response.text();
    const snapshot = parseInferencePrometheus(body);
    emit(snapshot, { ...sinks, json: parsed.json, render: value => parsed.json ? formatValue(value) : formatValue(value) });
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
