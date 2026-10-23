import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { ModelConnectCommand } from '#domain/index.js';
import { ModelConnectError, type ConnectedAdapter } from '#engine/index.js';
import { headlessConnectionAdapter, headlessConsent, prepareHeadlessConnection, readProviderConnectSeed, type ProviderConnectKind } from '#adapters/index.js';
import { normalizeGlobalScopePlatform, resolveGlobalScopePaths, type ConfigLoadOptions } from '#platform/index.js';
import { snapshotConfiguredConfig } from '#composition/core/config/index.js';

/**
 * S3-3: the CLI kind's connect ports. The preview switch is read from the user layer only (`models.headless.preview`, protected); the adapter part
 * is prepared once per command after the engine's person and preview checks (executable, login dir, uid, preflight; no model call), and the
 * consent is the person's own choice on each written layer. State lives under the person's global state dir, one fixed dir per connection.
 */
export function headlessConnectPorts(projectRoot: string, command: ModelConnectCommand, options: ConfigLoadOptions, person: () => Promise<Readonly<{ issuer: string; subject: string }>>) {
  const env = options.env ?? process.env;
  let prepared: Promise<Readonly<{ base: Awaited<ReturnType<typeof prepareHeadlessConnection>>; protocol: Readonly<{ family: string; version: string }> }>> | undefined;
  const prepare = (kind: ProviderConnectKind, nativeId: string) => prepared ??= (async () => {
    const seed = await readProviderConnectSeed(kind.connect!.seed!), model = seed.providers.flatMap(provider => provider.models).find(row => row.nativeId === nativeId);
    const protocol = model?.protocols.find(row => row.family === kind.connect!.protocolFamily), minCliVersion = (model as { minCliVersion?: string | null } | undefined)?.minCliVersion;
    if (!protocol || !minCliVersion) throw new ModelConnectError('MODEL_CONNECT_MODEL_UNKNOWN');
    const root = resolveGlobalScopePaths(normalizeGlobalScopePlatform(process.platform, env), env).stateDir;
    const stateDir = join(root, 'headless', createHash('sha256').update(JSON.stringify([kind.id, command.scopeId, nativeId])).digest('hex').slice(0, 16));
    return { protocol, base: await prepareHeadlessConnection({ protocol, minCliVersion, stateDir, executable: command.cli?.executable, configDir: command.cli?.configDir, env, now: Date.now }) };
  })();
  return {
    previewEnabled: async () => ((await snapshotConfiguredConfig(projectRoot, options)).global as { models?: { headless?: { preview?: unknown } } }).models?.headless?.preview === true,
    async adapter(kind: ProviderConnectKind, value: Readonly<{ nativeId: string; existing?: Record<string, unknown> | null }>): Promise<ConnectedAdapter> {
      const { base, protocol } = await prepare(kind, value.nativeId), consent = headlessConsent(value.existing as never, command.delegate, await person(), Date.now());
      return { ...headlessConnectionAdapter({ ...base, delegatedUse: consent }, protocol), cli: { configDir: base.configDir, delegate: consent?.classes ?? [] } };
    },
  };
}
