import { userInfo } from 'node:os';
import { AuditApplication, ExecutionEnvironmentInstallApplication, assertAuthorityWitness, policyExecutionInstallAuthorization, type AuthorityWitness } from '#engine/index.js';
import { DOCKER_APT, attestLocalInteractiveTerminal, detectExecutionFacts, dockerCardBody, dockerPrintLines, dockerResultLines, dockerSource, executionSetupFamily, installedDockerVersion,
  localPrincipalChannel, observeDockerHost, openLocalIntegrityAuthority, openSqliteAuditStore, planDockerInstall, readLocalOsIdentity, resolveSudo, runDockerInstall, spawnForeground,
  stageDockerFiles, type DockerHostPorts, type DockerInstallPorts, type ExecutionDetectPorts } from '#adapters/index.js';
import { ErrorRegistry, emit, prepareProductFile, t } from '#platform/index.js';
import { askCliCard, cliCardGate, type CliCardIo } from '#surfaces/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
import { loadComposedConfig } from '#composition/core/root/index.js';

/** `preview`: the dry run: detect and plan, print the exact card (or the print-only next step), stage and run nothing, ask nothing. */
export type ExecutionInstallDeps = Readonly<{ witness?: AuthorityWitness; detect?: ExecutionDetectPorts; host?: DockerHostPorts; install?: Partial<DockerInstallPorts>; preview?: boolean }>;
export type ExecutionInstallStatus = 'present' | 'printed' | 'declined' | 'succeeded' | 'failed' | 'uncertain';
/**
 * The person's foreground install of the registry's execution environment (INIT-D2), outside any window: terminal gate + SEC-1 witness first
 * (the MCP actor, SDK, agent shells, pipes and CI never reach anything else) → detect (found: nothing to do; unknown: refuse) → plan or print
 * the next step → the engine owner (policy, card, audit, effect) → re-detection is the next state. Enterprise may pass a stronger witness.
 */
export async function installExecutionEnvironment(root: string, scopeId: string, io: CliCardIo, deps: ExecutionInstallDeps = {}): Promise<ExecutionInstallStatus> {
  const { locale } = io, env = io.env ?? process.env, out = (lines: readonly string[]) => emit(lines.join('\n'), io.stdout ? { stdout: io.stdout as { write(text: string): unknown } } : {});
  if (!deps.preview) cliCardGate({ title: '-', options: [{ id: 'no', label: '-' }] }, io);
  if (!deps.preview) await assertAuthorityWitness('executionEnvironmentInstall', localPrincipalChannel(), deps.witness ?? { attest: () => attestLocalInteractiveTerminal() });
  const detect = () => detectExecutionFacts({ env, ...(deps.detect ? { ports: deps.detect } : {}) }), row = (await detect()).runtimes.find(entry => entry.id === DOCKER_APT.environment);
  if (row?.cli === 'found') { out([t('setup.docker.present', { runtime: row.label }, locale)]); return 'present'; }
  if (row?.cli !== 'absent') throw ErrorRegistry.createError('SETUP_INSTALL_STATE_UNKNOWN', { params: { runtime: row?.label ?? DOCKER_APT.environment } });
  const host = await observeDockerHost(env, row.kind === 'desktop', deps.host), source = dockerSource(host.osRelease, host.architecture);
  const plan = planDockerInstall(host, host.platform === 'other' || !source ? null : deps.preview ? '<staging>' : await stageDockerFiles(source)), sudo = deps.install?.sudo ?? await resolveSudo();
  if (deps.preview || plan.kind === 'print' || !sudo) {
    out(plan.kind === 'print' ? dockerPrintLines(plan, locale) : deps.preview ? [t('setup.docker.preview', {}, locale), ...dockerCardBody(plan, locale)] : [t('setup.docker.print.sudo', { docs: DOCKER_APT.docs }, locale)]);
    return 'printed';
  }
  const config = await loadComposedConfig(root, { env, heal: false }), layout = config.productLayout;
  const owner = new ExecutionEnvironmentInstallApplication(policyExecutionInstallAuthorization(await createLayoutPolicySource(layout, userInfo().uid, config.inspection.policyMaxBytes).load()),
    async event => {
      const store = await openSqliteAuditStore(await prepareProductFile(layout, 'ledger', ['-wal', '-shm', '-journal']), config.storage.sqlite, 'allow');
      try { new AuditApplication(store, await openLocalIntegrityAuthority(layout, config.approvals.keyFile, true)).record(event); } finally { store.close(); }
    });
  const outcome = await owner.install({ environment: DOCKER_APT.environment, scopeId, principal: readLocalOsIdentity(),
    source: { distribution: plan.source.distribution, codename: plan.source.codename, fingerprint: DOCKER_APT.key.fingerprint } }, {
    confirm: async () => await askCliCard({ title: t('setup.docker.card.title', {}, locale), body: dockerCardBody(plan, locale),
      options: [{ id: 'install', label: t('setup.docker.card.install', {}, locale), role: 'yes' }, { id: 'no', label: t('setup.docker.card.no', {}, locale), role: 'no' }] }, io) === 'install',
    apply: () => runDockerInstall(plan, env, { spawn: spawnForeground, version: installedDockerVersion(env), ...deps.install, sudo }) });
  if (outcome === 'declined') { out([t('setup.docker.declined', {}, locale)]); return 'declined'; }
  const next = executionSetupFamily().stages[0]!.evaluate({ facts: await detect(), answer: undefined, scopeId, states: new Map() });
  out(dockerResultLines(outcome, plan.steps.length, next.reason, locale));
  return outcome.status;
}
