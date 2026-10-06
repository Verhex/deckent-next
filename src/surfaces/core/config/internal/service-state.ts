import { loadConfig, type ConfigLoadOptions } from '#platform/index.js';
import { runtimeConfigFreshness, type RuntimeServiceDescriptor } from '#engine/index.js';

export type ConfigServiceState = 'current' | 'stale' | 'unknown' | 'stopped';
export type DescribeService = (root: string, options: ConfigLoadOptions) => Promise<RuntimeServiceDescriptor>;
const timeoutAfter = (milliseconds: number) => new Promise<never>((_, reject) => { setTimeout(() => reject(new Error('timeout')), milliseconds).unref(); });
/**
 * Whether the running service already works with the configuration now on disk and in the environment (restart-apply sections only).
 * Read-only and soft: no service answering (or one that stays silent) never fails the write that was just saved; an older service that
 * reports no digest is `unknown`, never guessed stale.
 */
export async function configServiceState(root: string, options: ConfigLoadOptions, describe: DescribeService | undefined): Promise<ConfigServiceState | null> {
  if (!describe) return null;
  try {
    const config = await loadConfig(root, { ...options, heal: false, force: true });
    // The service answers a describe within its own response timeout by contract; a silent peer is not waited on longer.
    const descriptor = await Promise.race([describe(root, options), timeoutAfter(config.service.responseTimeoutMs)]);
    return runtimeConfigFreshness(descriptor.configDigest, config as unknown as Record<string, unknown>);
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? (error as { code: unknown }).code : null;
    return code === 'LOCAL_RUNTIME_UNAVAILABLE' ? 'stopped' : 'unknown';
  }
}
