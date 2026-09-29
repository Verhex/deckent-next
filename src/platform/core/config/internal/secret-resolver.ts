import type { Environment } from '#platform/core/host/index.js';
import { ErrorRegistry } from '#platform/core/errors/index.js';
import type { SecretResolver } from './validate/interpolate.js';

/**
 * SECRET-K1: what the installation's secret backend is chosen from — the validated configuration (read before any reference is
 * resolved: the backend selection is never itself a secret reference), the caller's environment and platform.
 */
export interface SecretResolverContext { readonly config: Readonly<Record<string, unknown>>; readonly env: Environment; readonly platform: string }
/** Builds the resolver of the backend the configuration selects. Installed once by composition (`registerProviderConfig`). */
export type SecretResolverFactory = (context: SecretResolverContext) => SecretResolver;

let installed: SecretResolverFactory | null = null;

/** Composition installs the one production factory; a second, different factory is refused (the backend choice has one owner). */
export function installSecretResolverFactory(factory: SecretResolverFactory): void {
  if (installed !== null && installed !== factory) throw ErrorRegistry.createError('CONFIG_SECTION_DUPLICATE', { params: { section: 'secrets' } });
  installed = factory;
}
/** The environment backend's lookup: own properties only (the behaviour every read site had before SECRET-K1). */
export function environmentSecretResolver(env: Environment): SecretResolver {
  return async (name: string) => Object.hasOwn(env, name) ? env[name] : undefined;
}
/**
 * The one secret resolver every credential read uses (config interpolation, model invocation, MCP): an explicit `secretResolver`
 * (tests, SDK callers that bring their own backend) wins; otherwise the installed factory builds the configured backend's resolver;
 * without composition (a bare platform caller) the environment is read as before. The resolver never caches values.
 */
export function configuredSecretResolver(config: Readonly<Record<string, unknown>>,
  options: { readonly secretResolver?: SecretResolver | undefined; readonly env?: Environment | undefined; readonly platform?: string | undefined }): SecretResolver {
  if (options.secretResolver) return options.secretResolver;
  const env = options.env ?? process.env;
  return installed ? installed({ config, env, platform: options.platform ?? process.platform }) : environmentSecretResolver(env);
}
