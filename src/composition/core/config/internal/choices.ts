import { basename, dirname } from 'node:path';
import { userInfo } from 'node:os';
import { loadComposedConfig } from '#composition/core/root/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
import { resolveConfiguredScopeMembership, loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { inspectConfiguredInvocableModels } from '#composition/core/model-invocation/index.js';
import { modelInvocabilityText, IdentityProfileRegistry, installationOwnScopes, PoolControlPolicyAuthorization } from '#engine/index.js';
import { executionRegistrySchema, policySchema } from '#domain/index.js';
import { readLocalOsIdentity } from '#adapters/index.js';
import { discoverConfigRecordFiles, readConfigRecordFile, discoverConfigExecutables, discoverConfigBranches, discoverConfigImages, discoverConfigFiles, discoverConfigPools } from '#adapters/index.js';
import { ErrorRegistry, inspectProductDirectory, type ConfigLoadOptions } from '#platform/index.js';
import type { ConfigChoiceSourcePort, ConfigValueChoice } from '#surfaces/index.js';
/** Each inspection gets a fresh snapshot. No source grants write authority; ConfigApplication still admits the chosen value. */
export function configuredConfigChoiceSources(root: string, options: ConfigLoadOptions): ConfigChoiceSourcePort {
  const reading = loadComposedConfig(root, { ...options, heal: false });
  const values = (entries: readonly string[], label: (value: string) => string = value => value): readonly ConfigValueChoice[] => entries.map((value, i) => ({ id: `r${i}`, label: label(value), value, detail: value }));
  const files = new Set<string>();
  return {
    async browse(directory) {
      const config = await reading;
      const entries = await discoverConfigRecordFiles(directory, { timeoutMs: config.toolchains.currency.timeoutMs, outputBytes: config.toolchains.currency.responseMaxBytes, maxEntries: config.inspection.maxPageSize });
      files.clear(); for (const entry of entries) if (entry.kind === 'file') files.add(entry.path);
      return entries;
    },
    async readDocument(path) {
      if (!files.has(path)) throw ErrorRegistry.createError('CONFIG_RECORD_INVALID');
      const config = await reading; return readConfigRecordFile(path, config.cli.graphInputMaxBytes);
    },
    async list(source, keyPath, selection) {
    const config = await reading, env = options.env ?? process.env;
    const limits = { timeoutMs: config.toolchains.currency.timeoutMs, outputBytes: config.toolchains.currency.responseMaxBytes, maxEntries: config.inspection.maxPageSize };
    const scopeId = (config['terminal'] as { scopeId?: string } | undefined)?.scopeId;
    if (source === 'environment') return values(Object.keys(env).filter(key => env[key] !== undefined).sort());
    if (source === 'docker-executables' || source === 'git-executables') return values(await discoverConfigExecutables(source === 'docker-executables' ? 'docker' : 'git', env, limits), basename);
    if (source === 'paths') return values([...new Set([root, dirname(root), config.productLayout.root])], basename);
    if (source === 'machine-files') return values((await discoverConfigFiles('/etc', limits)).filter(path => basename(path) === 'machine-id'), basename);
    if (source === 'key-files') return values((await discoverConfigFiles(await inspectProductDirectory(config.productLayout, 'approvals'), limits)).filter(path => /\.key$/u.test(path) && basename(path) !== 'prefix-cache-salt.key').map(path => basename(path)));
    if (source === 'branches') {
      const git = (await discoverConfigExecutables('git', env, limits))[0]; if (!git) return [];
      const index = /\.targets\.(\d+)\.baseRef$/u.exec(keyPath)?.[1];
      const target = selection?.path ?? (index === undefined ? root : config.execution?.workTargets?.targets[Number(index)]?.path);
      return target ? values(await discoverConfigBranches(git, target, env, limits), value => value.replace(/^refs\/heads\//u, '')) : [];
    }
    if (source === 'images') { const docker = (await discoverConfigExecutables('docker', env, limits))[0]; return docker ? values(await discoverConfigImages(docker, limits), id => `Docker · ${id.slice(7, 19)}`) : []; }
    if (source === 'task-kinds') { const registry = executionRegistrySchema.safeParse(config.admission?.registry); return registry.success ? values(registry.data.kinds.map(kind => kind.kind)) : []; }
    if (source === 'identity-profiles') {
      const selection = config['identity'] as { packages?: readonly unknown[] } | undefined;
      return new IdentityProfileRegistry(selection?.packages).list().map((entry, i) => ({ id: `r${i}`, label: entry.labels?.[config.language] ?? entry.definition.id, value: { id: entry.definition.id, version: entry.definition.version }, detail: `${entry.definition.id} · v${entry.definition.version}` }));
    }
    if (source === 'serving-profiles') { const serving = config['inference_serving'] as { profiles?: readonly { id: string }[] } | undefined; return values(serving?.profiles?.map(profile => profile.id) ?? []); }
    if (source === 'scopes') {
      const document = policySchema.parse(await createLayoutPolicySource(config.productLayout, userInfo().uid, config.inspection.policyMaxBytes).load());
      const candidates = installationOwnScopes(document, [scopeId, config.service.identity?.scopeId, ...(config.cancellationRuntime?.scopeIds ?? []), ...(config.reconciliationRuntime?.scopeIds ?? [])].filter((value): value is string => !!value));
      const identity = readLocalOsIdentity(), admitted: string[] = [];
      for (const scope of candidates) { try { admitted.push(...await resolveConfiguredScopeMembership(config, document, identity, [scope], 'read')); } catch { /* Foreign/unregistered scopes are not displayed. */ } }
      return values([...new Set(admitted)]);
    }
    if (!scopeId) return [];
    if (source === 'models') {
      const reading = await inspectConfiguredInvocableModels(root, scopeId, options);
      return reading.models.map(model => ({ id: JSON.stringify(model.reference), label: model.label, value: model.reference,
        detail: `${model.reference.providerId} · ${modelInvocabilityText(model.availability, config.language)}`,
        ...(!model.availability.invocable ? { blocked: modelInvocabilityText(model.availability, config.language) } : {}) }));
    }
    const context = await loadConfiguredScopeContext(root, scopeId, options, 'read');
    if (source === 'companies') return values([context.config.company.id]); // Policy/membership pins this installation to one company; no foreign enumeration.
    if (source === 'pools') {
      const authorizer = new PoolControlPolicyAuthorization({ load: async () => context.document }), admitted: string[] = [];
      for (const id of discoverConfigPools(await context.path(), config.storage.sqlite.busyTimeoutMs, limits.maxEntries)) if ((await authorizer.decide('inspect', id, scopeId, context.principal)).effect === 'allow') admitted.push(id);
      return values(admitted);
    }
    return [];
  } };
}
