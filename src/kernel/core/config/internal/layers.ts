import { lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ErrorRegistry } from '#kernel/core/errors/index.js';
import { resolveLocale, t, type Locale } from '#kernel/core/i18n/index.js';
import { ENVIRONMENT_KEYS, envValue, type Environment } from '#kernel/core/platform/index.js';
import { resolveGlobalConfigReadPath } from '#kernel/core/platform/index.js';
import { resolveProductPaths, productResourcePath } from '#kernel/core/platform/index.js';
import { getSystemProfile } from '#kernel/core/platform/index.js';
import { digestText, deepMerge, isRecord, readJsonFile, type JsonRecord } from '#kernel/core/utils/index.js';
import { createDefaultConfig } from './defaults.js';
import { CONFIG_ENVIRONMENT_KEYS } from '#kernel/core/config-fields/index.js';
import { configSections, configRegistryGeneration, type DeckentConfig } from './schema.js';
import { versionedConfig } from './validate/version.js';
import { applyConfigEnvironment } from './validate/environment.js';
import { resolveConfigSecrets, type SecretResolver } from './validate/interpolate.js';
import { ConfigValidationError, type ConfigWarning } from './validate/issues.js';
import { validateConfig } from './validate/sections.js';
import { readProjectConfig } from './heal.js';

export interface ResolvedConfig extends DeckentConfig {
  readonly projectRoot: string;
  /** RFC 6901 pointers, relative to the canonical nested config only. */
  readonly secretPaths: readonly string[];

}
export interface ConfigLoadOptions {
  readonly force?: boolean;
  readonly secretResolver?: SecretResolver;
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
  const layout = resolveProductPaths(root, { env, platform });
  const projectPath = productResourcePath(layout, 'config');
  const paths = options.globalOnly ? [globalPath] : [globalPath, projectPath];
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
  const resolver = options.secretResolver ?? (async (name: string) => Object.hasOwn(env, name) ? env[name] : undefined);
  const secrets = await resolveConfigSecrets(checked.config, resolver, name => warnings.push({ code: 'CONFIG_SECRET_UNRESOLVED', path: name, message: t('config.secretMissing', { key: name }, locale) }));
  const value: ResolvedConfig = { ...secrets.config, projectRoot: root, secretPaths: secrets.secretPaths };
  for (const section of configSections().values()) section.options.validateEffective?.(structuredClone(value), env);
  if (secrets.references.length === 0 && (await Promise.all(paths.map(stamp))).every((s, i) => s === stamps[i])) {
    if (cache.size >= 128) cache.delete(cache.keys().next().value!);
    cache.set(key, { value: structuredClone(value), warnings: structuredClone(warnings) });
  }
  warnings.forEach(w => options.onWarning?.(w));
  return value;
}
