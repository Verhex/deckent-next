import { assertNoUninstallHold } from './uninstall-hold.js';
import { bindConfigKnownSecrets } from './redaction-context.js';
import { lstat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { ErrorRegistry } from '#platform/core/errors/index.js';
import { resolveLocale, t, type Locale } from '#platform/core/i18n/index.js';
import { ENVIRONMENT_KEYS, envValue, type Environment } from '#platform/core/host/index.js';
import { resolveGlobalConfigReadPath } from '#platform/core/host/index.js';
import { resolveProductLayout, productResourcePath, type ProductLayout, LayoutError } from '#platform/core/host/index.js';
import { getSystemProfile } from '#platform/core/host/index.js';
import { digestText, isRecord, readJsonFile, type JsonRecord } from '#platform/core/utils/index.js';
import { mergeConfigLayers } from './defaults.js';
import { CONFIG_ENVIRONMENT_KEYS } from '#platform/core/config-fields/index.js';
import { CORE_SCHEMA, configSections, configRegistryGeneration, type DeckentConfig } from './schema.js';
import { versionedConfig } from './validate/version.js';
import { applyConfigEnvironment } from './validate/environment.js';
import { resolveConfigSecrets, type SecretResolver } from './validate/interpolate.js';
import { configuredSecretResolver } from './secret-resolver.js';
import { ConfigValidationError, type ConfigWarning } from './validate/issues.js';
import { validateConfig } from './validate/sections.js';
import { assertConfigSecretPolicies, assertProjectLayerSecretReferences } from './validate/secret-policy.js';
import { readProjectConfig } from './heal.js';
import { inspectInstallationBootstrap, assertInstallationBootstrap, type RestoreHoldAdmission } from './bootstrap.js';
import type { BootstrapPendingAdmission } from '#platform/core/bootstrap-state/index.js';

export interface ResolvedConfig extends DeckentConfig {
  readonly projectRoot: string;
  readonly productLayout: ProductLayout;
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
  /** Observe-only readers (owned init identity check) under a pending transaction that publishes no project config; requires `heal: false`.
   * Changes nothing for UNSAFE/INVALID/CHANGED/UNAVAILABLE/UNSUPPORTED journals or a pending transaction that publishes config. */
  readonly pendingBootstrap?: BootstrapPendingAdmission;
  /** Astra 2471 R1: only the backup restore that completes an interrupted restore passes `admit`; every other reader refuses the hold. */
  readonly restoreHold?: RestoreHoldAdmission;
  /** Trusted uninstall recovery only, with healing disabled. Every other configured admission honors the durable fence. */
  readonly uninstallHold?: 'admit';
}
/** Resolved configs and effective validators are read-only; freeze once, including children of already-frozen layout objects. */
function freezeResolved(value: unknown, seen = new WeakSet<object>()): void {
  if (value === null || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  for (const child of Object.values(value)) freezeResolved(child, seen);
  Object.freeze(value);
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
  try { return versionedConfig(result.value, options.onWarning, resolveLocale(undefined, options.env)); }
  catch (error) {
    if (error instanceof ConfigValidationError) throw new ConfigValidationError(error.issues, resolveLocale(undefined, options.env), Object.fromEntries(error.issues.map(issue => [issue.path, path])));
    throw error;
  }
}
/** Presentation-only projection through the same layer readers. No provider registration, secrets, healing or locks.
 * Absent language stays absent so the caller can use the system locale; this is not execution config validation. */
async function presentationLayers(projectRoot: string, options: Pick<ConfigLoadOptions, 'env' | 'platform'>, path: string) {
  const platform = options.platform ?? process.platform;
  const layout = resolveProductLayout({ projectRoot: resolve(projectRoot), platform: platform === 'win32' ? 'win32' : 'posix' });
  const global = await loadGlobalConfig(options);
  const project = await readProjectConfig(productResourcePath(layout, 'config'), { heal: false });
  if (!isRecord(project)) throw new ConfigValidationError([{ path, reason: 'OBJECT_REQUIRED' }]);
  return { global, project: versionedConfig(project) };
}
export async function loadConfigLanguage(projectRoot = process.cwd(), options: Pick<ConfigLoadOptions, 'env' | 'platform'> = {}): Promise<Locale | undefined> {
  const { global, project } = await presentationLayers(projectRoot, options, 'language');
  const language = Object.hasOwn(project, 'language') ? project['language'] : global?.['language'];
  return language === undefined ? undefined : CORE_SCHEMA.shape.language.parse(language);
}
/** INIT-D7, presentation only like the language: the configured `cli.agentEnvironment` (project over installation), through the same layer
 * readers without healing, secrets or locks; absent stays absent so the caller uses the registry default. An invalid value throws. */
export async function loadConfigAgentEnvironment(projectRoot = process.cwd(), options: Pick<ConfigLoadOptions, 'env' | 'platform'> = {}): Promise<readonly string[] | undefined> {
  const { global, project } = await presentationLayers(projectRoot, options, 'cli');
  const pick = (layer: JsonRecord | null) => isRecord(layer?.['cli']) && Object.hasOwn(layer['cli'], 'agentEnvironment') ? layer['cli']['agentEnvironment'] : undefined;
  const value = pick(project) ?? pick(global);
  return value === undefined ? undefined : CORE_SCHEMA.shape.cli.parse({ agentEnvironment: value }).agentEnvironment;
}
/** alpha.60 C, presentation only like the language: the `terminal` section (project keys over installation keys), the configured language and
 * the data root, for the launch shell's decision to draw before the host loads. No registration, secrets, healing or locks: never execution
 * config (the terminal itself still loads and validates the whole configuration). */
export async function loadConfigTerminalLaunch(projectRoot = process.cwd(), options: Pick<ConfigLoadOptions, 'env' | 'platform'> = {}) {
  const { global, project } = await presentationLayers(projectRoot, options, 'terminal'), pick = (key: string) => Object.hasOwn(project, key) ? project[key] : global?.[key];
  const section = (layer: JsonRecord | null) => isRecord(layer?.['terminal']) ? layer['terminal'] : {}, layout = pick('layout');
  const root = isRecord(layout) && typeof layout['root'] === 'string' ? layout['root'] : undefined, language = pick('language');
  return { terminal: { ...section(global), ...section(project) } as JsonRecord, language: typeof language === 'string' ? language : undefined,
    dataRoot: resolveProductLayout({ projectRoot: resolve(projectRoot), ...(root ? { root } : {}), platform: (options.platform ?? process.platform) === 'win32' ? 'win32' : 'posix' }).root };
}
export async function loadConfig(projectRoot = process.cwd(), options: ConfigLoadOptions = {}): Promise<ResolvedConfig> {
  const root = resolve(projectRoot), env = { ...(options.env ?? process.env) };
  const platform = options.platform ?? process.platform;
  const admission = options.pendingBootstrap === 'config-settled' && options.heal === false ? 'config-settled' : 'none', hold = options.restoreHold ?? 'refuse';
  const bootstrap = options.globalOnly ? undefined : await inspectInstallationBootstrap(root, admission, hold);
  const globalPath = await resolveGlobalConfigReadPath(env, platform);
  const checkHold = async (dataRoot: string) => { if (options.uninstallHold !== 'admit' || options.heal !== false) await assertNoUninstallHold(dataRoot); };
  await checkHold(dirname(globalPath));
  const layout = resolveProductLayout({ projectRoot: root, platform: platform === 'win32' ? 'win32' : 'posix' });
  const projectPath = productResourcePath(layout, 'config');
  const paths = options.globalOnly ? [globalPath] : [globalPath, projectPath];
  const stamps = await Promise.all(paths.map(stamp));
  // Only documented noncredential inputs participate; package auth validators run on cache hits too.
  const key = digestText(JSON.stringify([root, platform, [...new Set([...ENVIRONMENT_KEYS, ...CONFIG_ENVIRONMENT_KEYS])].map(name => [name, env[name]]), stamps, bootstrap?.generation ?? null, configRegistryGeneration(), options.globalOnly ?? false, options.heal ?? true]));
  const cached = options.force || envValue(env, 'DECKENT_CONFIG_RELOAD') === '1' ? undefined : cache.get(key);
  if (cached) {
    for (const section of configSections().values()) section.options.validateEffective?.(cached.value, env);
    cached.warnings.forEach(w => options.onWarning?.(w));
    if (bootstrap) await assertInstallationBootstrap(root, bootstrap, admission, hold);
    await checkHold(cached.value.productLayout.root);
    return cached.value; }
  const warnings: ConfigWarning[] = [];
  const global = await loadGlobalConfig({ env, platform, onWarning: w => warnings.push(w) }) ?? {};
  const project: unknown = options.globalOnly || projectPath === globalPath ? {} : await readProjectConfig(projectPath, {
    ...(options.heal === undefined ? {} : { heal: options.heal }),
    ...(bootstrap ? { beforeHeal: () => assertInstallationBootstrap(root, bootstrap, admission, hold) } : {}),
    locale: resolveLocale(undefined, env),
    onWarning: warning => warnings.push(warning),
    onHeal: path => warnings.push({ code: 'CONFIG_HEALED', path, message: t('config.corrupt', { path }, resolveLocale(undefined, env)) }),
  });
  if (!isRecord(project)) throw new ConfigValidationError([{ path: projectPath, reason: 'OBJECT_REQUIRED' }]);
  const normalizedProject = versionedConfig(project, warning => warnings.push(warning), resolveLocale(undefined, env));
  // Check each authored layer even if a clean later layer would hide its forbidden reference.
  assertConfigSecretPolicies(global, resolveLocale(undefined, env));
  assertConfigSecretPolicies(normalizedProject, resolveLocale(undefined, env));
  // SEC-3 (F33): only the installation layer may name an installation secret; a project file is someone else's commit.
  assertProjectLayerSecretReferences(normalizedProject, resolveLocale(undefined, env));
  for (const [name, section] of configSections()) section.options.validateLayers?.(global[name], normalizedProject[name]);
  const layered = mergeConfigLayers(global, normalizedProject);
  const effective = applyConfigEnvironment(layered, env);
  const locale: Locale = resolveLocale(undefined, env, effective.language);
  let checked;
  try { checked = validateConfig(effective, locale); }
  catch (error) {
    if (error instanceof ConfigValidationError) throw new ConfigValidationError(error.issues, locale, Object.fromEntries(error.issues.map(issue => [issue.path,
      Object.hasOwn(normalizedProject, issue.path.split('.')[0]!) ? projectPath : Object.hasOwn(global, issue.path.split('.')[0]!) ? globalPath : projectPath])));
    throw error;
  }
  warnings.push(...checked.warnings);
  const recommended = getSystemProfile().recommendedMaxWorkers;
  if (typeof effective.max_workers === 'number' && effective.max_workers > recommended) warnings.push({ code: 'CONFIG_WORKER_PRESSURE', path: 'max_workers', message: t('config.workers', { workers: effective.max_workers, recommended }, locale) });
  // SECRET-K1: the one production resolver (explicit resolver > configured backend > environment), chosen from the validated, unresolved config.
  const resolver = configuredSecretResolver(checked.config, { secretResolver: options.secretResolver, env, platform });
  const secrets = await resolveConfigSecrets(checked.config, resolver, name => warnings.push({ code: 'CONFIG_SECRET_UNRESOLVED', path: name, message: t('config.secretMissing', { key: name }, locale) }));
  let productLayout: ProductLayout;
  try {
    const bootstrapConfigPath = options.globalOnly ? globalPath : projectPath;
    productLayout = resolveProductLayout({ projectRoot: root, root: checked.config.layout.root ?? (options.globalOnly ? dirname(globalPath) : layout.root),
      platform: platform === 'win32' ? 'win32' : 'posix', bootstrapConfigPath, resources: checked.config.layout.resources });
  } catch (error) {
    if (error instanceof LayoutError) throw new ConfigValidationError([{ path: 'layout', reason: error.code }], locale);
    throw error;
  }
  await checkHold(productLayout.root);
  const value: ResolvedConfig = { ...secrets.config, projectRoot: root, productLayout, secretPaths: secrets.secretPaths };
  bindConfigKnownSecrets(value, secrets.knownSecrets);
  freezeResolved(value);
  for (const section of configSections().values()) section.options.validateEffective?.(value, env);
  warnings.forEach(w => options.onWarning?.(w));
  const cacheable = secrets.references.length === 0 && (await Promise.all(paths.map(stamp))).every((s, i) => s === stamps[i]);
  if (bootstrap) await assertInstallationBootstrap(root, bootstrap, admission, hold);
  if (cacheable) {
    if (cache.size >= 128) cache.delete(cache.keys().next().value!);
    cache.set(key, { value, warnings: structuredClone(warnings) });
  }
  return value;
}
