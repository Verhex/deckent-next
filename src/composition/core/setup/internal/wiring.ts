import { observeFirstCommitRecovery } from '#adapters/index.js';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { WORKER_IMAGE_ESTIMATED_GB, attestLocalInteractiveTerminal, codingSetupFamily, detectCodingFacts, detectExecutionFacts, dockerInstallOffer, executionSetupFamily, localPrincipalChannel,
  nativeProviderSpec, observeWorkerImage, workerImagePresence, workerImageSetupPorts, type ExecutionFacts } from '#adapters/index.js';
import { affectedToolchainProfiles, WorkerImageSetupApplication, assertAuthorityWitness, type AuthorityWitness, type SetupStage, SETUP_PERMISSIONS_FAMILY, setupProfileRefSchema, hasWorkerKind } from '#engine/index.js';
import { ErrorRegistry, sha256, loadConfig, prepareProductDirectory, productResourcePath, type ConfigLoadOptions } from '#platform/index.js';
import { cliCardGate, doctorVerdict, loadSetupSurface, type CliCardIo, type KernelCommandContext } from '#surfaces/index.js';
import { applyPolicyTemplateInstallationWithSecretDefault, previewPolicyTemplateInstallation } from '#composition/core/installation/index.js';
import { assertConfiguredConfigWitness, createConfiguredConfigApplication, resolveConfiguredConfigPrincipal } from '#composition/core/config/index.js';
import { inspectConfiguredShellRealm } from '#composition/core/agent-turn/index.js';
import { inspectConfiguredWorkerImage } from '#composition/core/toolchains/index.js';
import { configuredOnboarding } from './onboarding.js';
import { executionRegistrySchema } from '#domain/index.js';
import { installExecutionEnvironment } from './install.js';
import { observeSetupPermissions, applySetupPermissions } from './permissions.js';

type Options = ConfigLoadOptions & Readonly<{ person?: boolean; language?: string; scopeId?: string; answers?: Readonly<Record<string, unknown>>; expectedConfig?: Readonly<{ projectDigest: string | null; globalDigest: string }>;
  /** alpha.60 B: ends an observation nobody waits for any more (the terminal closed): probes are killed, no further step starts, nothing is written. */ signal?: AbortSignal }>;
const reachableDocker = (facts: ExecutionFacts) => facts.runtimes.find(row => row.support === 'supported' && row.daemon === 'reachable')?.path ?? null;
const toolchainsHome = (config: Awaited<ReturnType<typeof loadConfig>>) => join(productResourcePath(config.productLayout, 'workspaces'), 'toolchains');
/** Second-provider profile add: the CLI host supplies the registry owner, so setup never reaches the coding template composition itself. */
export type AddCodingProfile = (root: string, input: unknown, options: ConfigLoadOptions, dependencies?: { readonly witness?: { attest(): Promise<boolean> } }) => Promise<{ readonly status: string; readonly digest: string; readonly expect: string; readonly profile: { readonly id: string; readonly version: number | string } }>;
type Status = 'applied' | 'refused' | 'not-wired';
const failure = (error: unknown) => { const code = (error as { code?: unknown } | null)?.code; return typeof code === 'string' ? code : 'SETUP_STAGE_FAILED'; };

/**
 * I-S3: bare `deckent init`'s observation and apply port over the CLI host (the same handlers every command gets). Observation: the Core
 * facts and the instructions family from the surface reader, I-S2's execution and coding detection (I-D2's install offer only when a person
 * answers in the window), and the final check from doctor's own measurement (heal:false; its grouped rows: error → errors, warning → warnings)
 * once permissions exist. Apply: each stage's existing owner; owners that take the terminal (Docker, bridges, model connect, upgrade, the
 * human doctor) run in the surface after the window closed, so here they are refused (TERMINAL_TTY_REQUIRED) and never half-run; the
 * surface reaches I-D2's foreground install through `installExecutionEnvironment`.
 */
export function configuredSetup(host: object, witness: AuthorityWitness = { attest: () => attestLocalInteractiveTerminal() }) {
  // The doctor verdict (its grouped rows, read-only); in an observation a measurement that cannot run is "not run", never a guess.
  const verdict = (env: NodeJS.ProcessEnv, root: string) => doctorVerdict(root, { ...host, env } as KernelCommandContext, { env });
  const observeSetup = async (root: string, options: Options) => {
    const env = options.env ?? process.env, config = await loadConfig(root, { env, heal: false }).catch(() => null);
    const credential = (id: string) => { try { return nativeProviderSpec(id as Parameters<typeof nativeProviderSpec>[0]); } catch { return null; } };
    const signal = options.signal, [execution, coding] = await Promise.all([detectExecutionFacts({ env, ...(signal ? { signal } : {}) }),
      detectCodingFacts({ root, env, workTargets: config?.execution?.workTargets?.targets.map(target => target.path) ?? [], ports: { credential }, ...(signal ? { signal } : {}) })]);
    signal?.throwIfAborted();
    // BR1: the worker image (configured, else this installation's newest receipt; a read-only `image inspect`) and the Git the settings would name.
    const worker = config && await observeWorkerImage({ home: toolchainsHome(config), executable: config.execution?.docker?.executable ?? reachableDocker(execution), configured: config.execution?.docker?.imageId ?? null, git: coding.gitPath });
    const acquisition = config ? await inspectConfiguredWorkerImage(root, { env }) : null;
    const pins = config ? affectedToolchainProfiles(config) : [];
    const pending = config?.toolchains.image.consents.filter(record => record.providers.some(provider =>
      !pins.some(pin => pin.provider === provider && acquisition?.images.some(image => image.provider === provider && image.imageId === pin.imageId)))).at(-1);
    const provider = typeof options.answers?.['work:kind'] === 'string' ? options.answers['work:kind'] : pending?.providers[0];
    const executionFamily = executionSetupFamily({ install: dockerInstallOffer(options.person === true), person: options.person === true });
    const family = { ...executionFamily, stages: executionFamily.stages.map(stage => ({ ...stage, evaluate: (context: Parameters<typeof stage.evaluate>[0]) =>
      hasWorkerKind(context) ? stage.evaluate(context) : { state: 'skipped' as const, reason: { code: 'setup.execution.noWorkKind', params: {} } } })) };
    const recovery = coding.repository === 'present' ? await observeFirstCommitRecovery(root, env).catch(() => ({ state: 'unknown' as const })) : null;
    signal?.throwIfAborted();
    const observed = await (await loadSetupSurface()).observeCoreSetup({ ...host, env }, root, options.language, { packages: [family, codingSetupFamily(), SETUP_PERMISSIONS_FAMILY], facts: { permissions: null, execution: { ...execution, ...(worker ? { worker: { ...worker, ...(provider ? { provider, providerPending: !pins.some(pin => pin.provider === provider) } : {}), acquisition } } : {}) },
      coding: { ...coding, firstCommitRecovery: recovery?.state === 'prepared' ? 'none' : recovery?.state ?? 'none' } } });
    const installed = ['current', 'upgradable', 'hand-built'].includes(observed.observation.policy.state), firstJob = observed.firstJob && { ...observed.firstJob, execution: observed.firstJob.execution && worker?.image !== 'missing' };
    const registry = executionRegistrySchema.safeParse(config?.admission?.registry);
    const scope = observed.observation.folder.configuredScope;
    const permission = installed && scope ? await observeSetupPermissions(root, scope, options).catch(() => ({ state: 'blocked' as const, digest: '', profile: '-', mode: 'standart', effectiveMode: 'standart', principal: '-', selectedProfile: null })) : null;
    const permissionFacts = permission ? { state: permission.state, digest: permission.digest, profile: permission.profile, mode: permission.mode,
      effectiveMode: permission.effectiveMode, principal: permission.principal, selectedProfile: permission.selectedProfile } : null;
    const families: Readonly<Record<string, unknown>> = { ...observed.observation.families, permissions: permissionFacts, work: { ...observed.firstJob, ...(provider ? { pendingProvider: provider } : {}),
      providers: [...new Set(pins.map(pin => pin.provider))], kinds: registry.success ? registry.data.kinds.map(row => row.kind) : [],
      images: Object.fromEntries((acquisition?.images ?? []).map(image => [image.provider, image.imageId])) } };
    return { ...observed, ...(firstJob ? { firstJob } : {}), observation: { ...observed.observation, families, check: { state: installed ? await verdict(env, root).catch(() => 'not-run' as const) : 'not-run' as const } } };
  };
  const applySetupStage = async (root: string, stage: SetupStage, options: Options) => {
    const op = stage.operation?.id ?? '-', input = stage.operation?.input ?? {}, scopeId = String(input['scopeId'] ?? options.scopeId ?? '');
    const result = (status: Status, code?: string) => ({ stage: stage.id, operation: op, status, ...(code ? { code } : {}) });
    // alpha.55.1: a person's choice of a protected root (`execution`, `identity.profile`) needs the same terminal witness as `config set`.
    const config = async (keyPath: string, value: unknown, layer: 'project' | 'global') => {
      await assertConfiguredConfigWitness('set', keyPath, witness);
      return createConfiguredConfigApplication(root, options, current => {
        if (options.expectedConfig && sha256(JSON.stringify(current.global)) !== options.expectedConfig.globalDigest) throw ErrorRegistry.createError('CONFIG_CONCURRENT_REVISION_HOLD');
      }, witness).set({ keyPath, value, layer, principal: await resolveConfiguredConfigPrincipal(root, scopeId, options), scopeId, commandId: randomUUID(), ...(options.expectedConfig ? { expect: options.expectedConfig.projectDigest } : {}) });
    };
    try {
      if (op === 'installation.policy-template') {
        // The owner's own preview first (the same deterministic plan the apply journals), then the journaled first-run install.
        await previewPolicyTemplateInstallation(root, scopeId, options);
        // U1 S1: the store default's outcome rides on the stage result (the installation stands even when the default was refused).
        const installed = await applyPolicyTemplateInstallationWithSecretDefault(root, scopeId, options), secretStore = 'secretStore' in installed ? installed.secretStore : undefined;
        return installed.status === 'installed' || installed.status === 'replayed' ? { ...result('applied'), ...(secretStore ? { secretStore } : {}) } : result('refused', installed.status);
      }
      if (op === 'setup.permissions') {
        if (typeof input['digest'] !== 'string') throw ErrorRegistry.createError('PERMISSION_MODE_CONFLICT');
        const profile = input['profile'] === null ? undefined : setupProfileRefSchema.parse(input['profile']);
        await applySetupPermissions(root, scopeId, input['digest'], options, witness, profile);
        return result('applied');
      }
      if (op === 'config.set') { await config(String(input['keyPath']), input['value'], input['layer'] === 'global' ? 'global' : 'project'); return result('applied'); }
      if (op === 'work.profile-add') {
        const added = await (host as { addCodingProfile?: AddCodingProfile }).addCodingProfile!(root, { provider: input['provider'], kind: input['kind'], image: input['image'],
          expect: input['expect'], digest: input['digest'], apply: true }, options, { witness });
        return result(added.status === 'applied' || added.status === 'unchanged' ? 'applied' : 'refused');
      }
      // Every profile's selection, solo included (SOLO-PROFILE; template data, never authority; the `identity` section is global-layer only,
      // as `config set identity.profile --global`; the next observation reads it back); distribution stays `deckent identity distribute`.
      if (op === 'identity-profile.preview') { await config('identity.profile', input['profile'], 'global'); return result('applied'); }
      if (op === 'shell-realm.inspect') { await inspectConfiguredShellRealm(root, options); return result('applied'); }
      if (op === 'doctor.inspect') { await verdict(options.env ?? process.env, root); return result('applied'); }
      return result('refused', 'TERMINAL_TTY_REQUIRED');
    } catch (error) { return result('refused', failure(error)); }
  };
  // PRE-34: doctor's Docker row, the same read-only detection and family decision as the setup stage (no install offer, never a question).
  const inspectExecutionEnvironment = async (env: NodeJS.ProcessEnv) => {
    const decision = executionSetupFamily().stages[0]!.evaluate({ facts: await detectExecutionFacts({ env }), answer: undefined, scopeId: null, states: new Map() });
    return { state: decision.state, reason: { code: decision.reason.code, params: decision.reason.params ?? {} } };
  };
  // BR1 (owner Q2): the person's worker image (terminal + SEC-1 witness first; the engine owner, the adapters' build, the surface's card).
  const prepareWorkerImage = async (root: string, io: CliCardIo, request: Readonly<{ imageId?: string }> = {}) => {
    cliCardGate({ title: '-', options: [{ id: 'no', label: '-' }] }, io);
    await assertAuthorityWitness('workerImage', localPrincipalChannel(), { attest: () => attestLocalInteractiveTerminal() });
    const env = io.env ?? process.env, config = await loadConfig(root, { env, heal: false }), policy = config.toolchains.update, executable = reachableDocker(await detectExecutionFacts({ env }));
    if (!executable) throw ErrorRegistry.createError('SETUP_WORKER_DOCKER_UNAVAILABLE');
    const ports = workerImageSetupPorts({ home: join(await prepareProductDirectory(config.productLayout, 'workspaces'), 'toolchains'), executable, timeoutMs: policy.buildTimeoutMs, outputBytes: policy.outputBytes,
      failedContextsKept: policy.failedContextsKept, env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) });
    return new WorkerImageSetupApplication({ ...ports, confirm: (await loadSetupSurface()).workerImageConfirm(io, policy.buildTimeoutMs, WORKER_IMAGE_ESTIMATED_GB) }).prepare(request);
  };
  const openOnboarding = (root: string, scopeId: string, folder: string, options: ConfigLoadOptions) =>
    configuredOnboarding(host, { observeSetup, applySetupStage }, root, scopeId, folder, options);
  return { openOnboarding, observeSetup, applySetupStage, installExecutionEnvironment, inspectExecutionEnvironment, prepareWorkerImage, inspectWorkerImage: workerImagePresence };
}
