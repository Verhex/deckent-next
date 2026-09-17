import { lstat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { CONFIG_FILE } from '../../common/index.js';
import { ErrorRegistry } from '../../errors/index.js';
import { resolveLocale, t, type Locale } from '../../i18n/index.js';
import { ENVIRONMENT_KEYS, envValue, type Environment } from '../../platform/index.js';
import { resolveGlobalConfigReadPath } from '../../platform/index.js';
import { resolveDeckentHome } from '../../platform/index.js';
import { getSystemProfile } from '../../platform/index.js';
import { digestText, deepMerge, isRecord, readJsonFile, type JsonRecord } from '../../utils/index.js';
import { createDefaultConfig } from './defaults.js';
import { CONFIG_ENVIRONMENT_KEYS } from './fields.js';
import { configSections, configRegistryGeneration, type DeckentConfig } from './schema.js';
import { versionedConfig } from './validate/version.js';
import { applyConfigEnvironment } from './validate/environment.js';
import { interpolateConfig, readDeckSecrets } from './validate/interpolate.js';
import { ConfigValidationError, type ConfigWarning } from './validate/issues.js';
import { validateConfig } from './validate/sections.js';
import { readProjectConfig } from './heal.js';

export interface ResolvedConfig extends DeckentConfig {
  readonly projectRoot: string;
  /** RFC 6901 pointers, including the flattened provider projections. */
  readonly secretPaths: readonly string[];
  readonly brain_provider: string | null;
  readonly worker_provider: string | null;
  readonly fallback_provider: string | null;
  readonly provider_overrides: Readonly<Record<string, string>>;
}
export interface ConfigLoadOptions {
  readonly force?: boolean;
  readonly env?: Environment;
  readonly platform?: string;
  readonly heal?: boolean;
  readonly globalOnly?: boolean;
  readonly onWarning?: (warning: ConfigWarning) => void;
}
interface Cached { value: ResolvedConfig; warnings: ConfigWarning[] }
const cache = new Map<string, Cached>();
export function clearConfigCache(): void { cache.clear(); }
async function stamp(path: string): Promise<string> {
  try { const s = await lstat(path, { bigint: true }); return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent'; throw ErrorRegistry.createError('CONFIG_READ_IO_HOLD', { cause: error }); }
}
export async function loadGlobalConfig(options: Pick<ConfigLoadOptions, 'env' | 'platform' | 'onWarning'> = {}): Promise<JsonRecord | null> {
  const path = await resolveGlobalConfigReadPath(options.env, options.platform);
  const result = await readJsonFile(path);
  if (result.kind === 'io') throw ErrorRegistry.createError('CONFIG_READ_IO_HOLD', { cause: result.error });
  if (result.kind === 'absent') return null;
  if (result.kind === 'corrupt' || !isRecord(result.value)) {
    options.onWarning?.({ code: 'CONFIG_GLOBAL_CORRUPT', path, message: t('config.globalCorrupt', {}, resolveLocale(undefined, options.env)) });
    return null;
  }
  return versionedConfig(result.value);
}
export async function loadConfig(projectRoot = process.cwd(), options: ConfigLoadOptions = {}): Promise<ResolvedConfig> {
  const root = resolve(projectRoot), env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const globalPath = await resolveGlobalConfigReadPath(env, platform);
  const projectPath = join(resolveDeckentHome(root, { env, platform }), CONFIG_FILE);
  const paths = options.globalOnly ? [globalPath, join(root, '.deck')] : [globalPath, projectPath, join(root, '.deck')];
  const stamps = await Promise.all(paths.map(stamp));
  // Only documented noncredential inputs participate; package auth validators run on cache hits too.
  const key = digestText(JSON.stringify([root, platform, [...new Set([...ENVIRONMENT_KEYS, ...CONFIG_ENVIRONMENT_KEYS])].map(name => [name, env[name]]), stamps, configRegistryGeneration(), options.globalOnly ?? false, options.heal ?? true]));
  const cached = options.force || envValue(env, 'DECKENT_CONFIG_RELOAD') === '1' ? undefined : cache.get(key);
  if (cached) {
    for (const section of configSections().values()) section.options.validateEffective?.(structuredClone(cached.value), env);
    cached.warnings.forEach(w => options.onWarning?.(w)); return structuredClone(cached.value); }
  const warnings: ConfigWarning[] = [];
  const global = await loadGlobalConfig({ env, platform, onWarning: w => warnings.push(w) }) ?? {};
  const project: unknown = options.globalOnly || projectPath === globalPath ? {} : await readProjectConfig(projectPath, {
    ...(options.heal === undefined ? {} : { heal: options.heal }),
    locale: resolveLocale(undefined, env),
    onWarning: warning => warnings.push(warning),
    onHeal: path => warnings.push({ code: 'CONFIG_HEALED', path, message: t('config.corrupt', { path }, resolveLocale(undefined, env)) }),
  });
  if (!isRecord(project)) throw new ConfigValidationError([{ path: projectPath, reason: 'OBJECT_REQUIRED' }]);
  const normalizedProject = versionedConfig(project);
  for (const [name, section] of configSections()) section.options.validateLayers?.(global[name], normalizedProject[name]);
  const layered = deepMerge(deepMerge(createDefaultConfig(), global), normalizedProject);
  const effective = applyConfigEnvironment(layered, env);
  const locale: Locale = resolveLocale(undefined, env, effective.language);
  const checked = validateConfig(effective, locale);
  warnings.push(...checked.warnings);
  const recommended = getSystemProfile().recommendedMaxWorkers;
  if (typeof effective.max_workers === 'number' && effective.max_workers > recommended) warnings.push({ code: 'CONFIG_WORKER_PRESSURE', path: 'max_workers', message: t('config.workers', { workers: effective.max_workers, recommended }, locale) });
  const secretPaths: string[] = [];
  const config = interpolateConfig(checked.config, await readDeckSecrets(root), name => warnings.push({ code: 'CONFIG_SECRET_UNRESOLVED', path: name, message: t('config.secretMissing', { key: name }, locale) }), path => secretPaths.push(path));
  for (const path of [...secretPaths]) {
    for (const [nested, flat] of [['brain', 'brain_provider'], ['worker', 'worker_provider'], ['fallback', 'fallback_provider'], ['overrides', 'provider_overrides']]) {
      const prefix = `/providers/${nested}`;
      if (path === prefix || path.startsWith(`${prefix}/`)) secretPaths.push(`/${flat}${path.slice(prefix.length)}`);
    }
  }
  const value: ResolvedConfig = { ...config, projectRoot: root, secretPaths, brain_provider: config.providers.brain,
    worker_provider: config.providers.worker, fallback_provider: config.providers.fallback, provider_overrides: { ...config.providers.overrides } };
  for (const section of configSections().values()) section.options.validateEffective?.(structuredClone(value), env);
  if ((await Promise.all(paths.map(stamp))).every((s, i) => s === stamps[i])) {
    if (cache.size >= 128) cache.delete(cache.keys().next().value!);
    cache.set(key, { value: structuredClone(value), warnings: structuredClone(warnings) });
  }
  warnings.forEach(w => options.onWarning?.(w));
  return value;
}
