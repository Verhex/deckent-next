import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { WORKER_IMAGE_ESTIMATED_GB, attestLocalInteractiveTerminal, codingSetupFamily, detectCodingFacts, detectExecutionFacts, dockerInstallOffer, executionSetupFamily, localPrincipalChannel,
  nativeProviderSpec, observeWorkerImage, workerImagePresence, workerImageSetupPorts, type ExecutionFacts } from '#adapters/index.js';
import { WorkerImageSetupApplication, assertAuthorityWitness, type AuthorityWitness, type SetupStage } from '#engine/index.js';
import { ErrorRegistry, loadConfig, prepareProductDirectory, productResourcePath, type ConfigLoadOptions } from '#platform/index.js';
import { cliCardGate, doctorVerdict, loadSetupSurface, type CliCardIo, type KernelCommandContext } from '#surfaces/index.js';
import { applyPolicyTemplateInstallationWithSecretDefault, previewPolicyTemplateInstallation } from '#composition/core/installation/index.js';
import { assertConfiguredConfigWitness, createConfiguredConfigApplication, resolveConfiguredConfigPrincipal } from '#composition/core/config/index.js';
import { inspectConfiguredShellRealm } from '#composition/core/agent-turn/index.js';
import { installExecutionEnvironment } from './install.js';

type Options = ConfigLoadOptions & Readonly<{ person?: boolean; language?: string; scopeId?: string }>;
const reachableDocker = (facts: ExecutionFacts) => facts.runtimes.find(row => row.support === 'supported' && row.daemon === 'reachable')?.path ?? null;
const toolchainsHome = (config: Awaited<ReturnType<typeof loadConfig>>) => join(productResourcePath(config.productLayout, 'workspaces'), 'toolchains');
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
    const [execution, coding] = await Promise.all([detectExecutionFacts({ env }),
      detectCodingFacts({ root, env, workTargets: config?.execution?.workTargets?.targets.map(target => target.path) ?? [], ports: { credential } })]);
    // BR1: the worker image (configured, else this installation's newest receipt; a read-only `image inspect`) and the Git the settings would name.
    const worker = config && await observeWorkerImage({ home: toolchainsHome(config), executable: config.execution?.docker?.executable ?? reachableDocker(execution), configured: config.execution?.docker?.imageId ?? null, git: coding.gitPath });
    const observed = await (await loadSetupSurface()).observeCoreSetup({ ...host, env }, root, options.language, { packages: [executionSetupFamily({ install: dockerInstallOffer(options.person === true),
      person: options.person === true }), codingSetupFamily()], facts: { execution: { ...execution, ...(worker ? { worker } : {}) }, coding } });
    const installed = ['current', 'upgradable', 'hand-built'].includes(observed.observation.policy.state), firstJob = observed.firstJob && { ...observed.firstJob, execution: observed.firstJob.execution && worker?.image !== 'missing' };
    return { ...observed, ...(firstJob ? { firstJob } : {}), observation: { ...observed.observation, check: { state: installed ? await verdict(env, root).catch(() => 'not-run' as const) : 'not-run' as const } } };
  };
  const applySetupStage = async (root: string, stage: SetupStage, options: Options) => {
    const op = stage.operation?.id ?? '-', input = stage.operation?.input ?? {}, scopeId = String(input['scopeId'] ?? options.scopeId ?? '');
    const result = (status: Status, code?: string) => ({ stage: stage.id, operation: op, status, ...(code ? { code } : {}) });
    // alpha.55.1: a person's choice of a protected root (`execution`, `identity.profile`) needs the same terminal witness as `config set`.
    const config = async (keyPath: string, value: unknown, layer: 'project' | 'global') => {
      await assertConfiguredConfigWitness('set', keyPath, witness);
      return createConfiguredConfigApplication(root, options).set({ keyPath, value, layer, principal: await resolveConfiguredConfigPrincipal(root, scopeId, options), scopeId, commandId: randomUUID() });
    };
    try {
      if (op === 'installation.policy-template') {
        // The owner's own preview first (the same deterministic plan the apply journals), then the journaled first-run install.
        await previewPolicyTemplateInstallation(root, scopeId, options);
        const { status } = await applyPolicyTemplateInstallationWithSecretDefault(root, scopeId, options);
        return status === 'installed' || status === 'replayed' ? result('applied') : result('refused', status);
      }
      if (op === 'config.set') { await config(String(input['keyPath']), input['value'], input['layer'] === 'global' ? 'global' : 'project'); return result('applied'); }
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
  return { observeSetup, applySetupStage, installExecutionEnvironment, inspectExecutionEnvironment, prepareWorkerImage, inspectWorkerImage: workerImagePresence };
}
