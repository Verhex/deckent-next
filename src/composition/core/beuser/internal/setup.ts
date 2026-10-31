import { isDeepStrictEqual } from 'node:util';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import personas from '../../../../../assets/beuser/personas.json' with { type: 'json' };
import calibration from '../../../../../assets/beuser/calibration/manifest.json' with { type: 'json' };
import controllerData from '../../../../../assets/beuser/controller.json' with { type: 'json' };
import { executionRegistrySchema } from '#domain/index.js';
import { readInstallationProfileFile, readBeuserCandidate, openSqliteModelActivationReader, canonicalRealmPath, measureInstalledPackage, BEUSER_REALM_RECIPE } from '#adapters/index.js';
import { inspectRoleModelsInScope, roleModelInvocationReference, BEUSER_LIMITS_REGISTRY, BEUSER_ARRANGE_REGISTRY, beuserPersonaDigest } from '#engine/index.js';
import { beuserDigest } from '#capabilities/index.js';
import { CONFIG_FIELDS, ErrorRegistry, globalStateRoot, loadConfig, sha256, type ConfigLoadOptions } from '#platform/index.js';
import { configPersonWitness, createConfiguredConfigApplication, snapshotConfiguredConfig } from '#composition/core/config/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { installConfiguredExecutionPool } from '#composition/core/installation/index.js';
import { beuserJourneyProfileSchema } from '#composition/core/supervisors/index.js';

/** This package's own build: the default candidate of `deckent beuser walk` (owner S9). A source checkout has no staged manifest and is refused. */
export const BEUSER_PACKAGE_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
export interface BeuserSetupInput { readonly scopeId: string; readonly profile: string; readonly apply: boolean; readonly expect?: string }
/** One-command walk (owner S9): the controller is a private Deckent installation at `<global state root>/beuser-controller`; its person connects models there. */
export interface BeuserWalkSetupInput { readonly journey: string; readonly candidate?: string | undefined; readonly scopeId?: string | undefined;
  readonly choice?: { readonly channelId: string; readonly modelId: string } | undefined; readonly apply: boolean; readonly expect?: string | undefined }
/** Person-selected, bounded execution data. ConfigApplication remains the only config writer; no model or policy grants are created here. */
export async function setupConfiguredBeuser(root: string, input: BeuserSetupInput | BeuserWalkSetupInput, options: ConfigLoadOptions = {}) {
  await configPersonWitness()('beuser setup');
  if ('journey' in input) return walkSetup(input, options);
  return install(root, input, options, c => readInstallationProfileFile(input.profile, c.config.inspection.policyMaxBytes), false);
}

type Scope = Awaited<ReturnType<typeof loadConfiguredScopeContext>>;
type Journey = { journeyId: string; limitsProfile: string; branches: { id: string; personaIds: string[]; goal: Record<string, string> }[];
  rubric: { digest: string; parameters: { branches: { id: string; initialStates: string[]; probeSet: string }[]; probeSets: { id: string; probes: unknown[] }[] } } };
const invalid = () => ErrorRegistry.createError('BEUSER_INPUT_INVALID'), mismatch = () => ErrorRegistry.createError('BEUSER_CANDIDATE_MISMATCH');
async function modelSources<T>(c: Scope, work: (sources: Parameters<typeof inspectRoleModelsInScope>[0]) => Promise<T>) {
  const reader = await openSqliteModelActivationReader(await c.path(), { busyTimeoutMs: c.config.storage.sqlite.busyTimeoutMs });
  try { return await work({ modelRoles: c.config['model_roles'], providerCatalog: c.config['provider_catalog'], activation: (scopeId, reference) => reader.loadRecord(scopeId, reference) }); }
  finally { reader.close(); }
}

/** Steps: controller → connected models (none: the next step, nothing staged) → the person's model choice → profile from installed references and the measured candidate → setup. */
async function walkSetup(input: BeuserWalkSetupInput, options: ConfigLoadOptions) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(input.journey)) throw invalid();
  const journey = await readFile(join(BEUSER_PACKAGE_ROOT, 'assets', 'beuser', 'journeys', `${input.journey}.json`), 'utf8').then(text => JSON.parse(text) as Journey, () => { throw invalid(); });
  const state = globalStateRoot(options.env ?? process.env); if (!state) throw invalid();
  const root = join(state, controllerData.folder); await mkdir(root, { recursive: true, mode: 0o700 });
  const configured = (await loadConfig(root, { ...options, heal: false }).catch(() => null) as { terminal?: { scopeId?: unknown } } | null)?.terminal?.scopeId;
  const scopeId = input.scopeId ?? (typeof configured === 'string' ? configured : null), controller = { root, scopeId };
  if (!scopeId) return { status: 'model-required', controller, models: [] };
  const c = await loadConfiguredScopeContext(root, scopeId, { ...options, heal: false }, 'write');
  const models = await modelSources(c, async sources => (await inspectRoleModelsInScope(sources, 'beuser-walker', scopeId, Date.now())).models
    .filter(row => row.active && roleModelInvocationReference(sources, c.config['provider_invocation_profiles'], scopeId, row)).map(({ channelId, modelId }) => ({ channelId, modelId })));
  const choice = input.choice;
  if (!models.length || !choice) return { status: models.length ? 'choose-model' : 'model-required', controller, models };
  if (!models.some(row => row.channelId === choice.channelId && row.modelId === choice.modelId)) throw ErrorRegistry.createError('BEUSER_MODEL_UNAVAILABLE');
  const candidateRoot = await canonicalRealmPath(resolve(input.candidate ?? BEUSER_PACKAGE_ROOT), 'directory');
  const [measured, release] = await Promise.all([measureInstalledPackage(candidateRoot, c.config.installation.packageMeasurement),
    readFile(join(candidateRoot, 'release.json'), 'utf8').then(text => JSON.parse(text) as { sourceCommit: string; sourceTreeSha256: string })]).catch(() => { throw mismatch(); });
  const manifest = measured.files.find(file => file.path === 'manifest.json'), files = measured.files.map(({ path, sha256, size }) => ({ path, sha256, size }));
  if (measured.declaredMissing.length || !manifest) throw mismatch();
  // The packaged example's selection: the journey's first rubric branch, its first persona and that branch's own probe set.
  const branch = journey.rubric.parameters.branches[0], visible = journey.branches.find(row => row.id === branch?.id);
  const person = personas.personas.find(row => row.personaId === visible?.personaIds[0]), probeSet = journey.rubric.parameters.probeSets.find(row => row.id === branch?.probeSet);
  const limits = BEUSER_LIMITS_REGISTRY.profiles.find(row => row.revision === journey.limitsProfile);
  if (journey.journeyId !== input.journey || !branch || !visible || !person || !probeSet || !limits) throw invalid();
  const summary = { ...person, journeyId: input.journey, goal: visible.goal[person.language] }, id = `${person.personaId}-${input.journey}`, pending = 'pending-admission';
  const binding = { schemaVersion: 1, identity: { scopeId: pending, runId: pending, taskId: id, attemptId: pending, layoutRevision: pending, generation: 1 },
    // The environment reference names what it digests: the realm recipe and the controller's configured image (null when absent; the walk then reports it).
    candidate: { adapter: 'installed-package', version: measured.packageVersion, evidenceRef: 'controller-candidate', stateDigest: sha256(JSON.stringify(files)),
      environmentDigest: sha256(JSON.stringify({ realm: BEUSER_REALM_RECIPE.revision, image: c.config.execution?.docker?.imageId ?? null })) },
    candidateDigest: measured.measurementDigest, personaDigest: beuserPersonaDigest(summary), journeyDigest: beuserDigest(journey), rubricDigest: journey.rubric.digest,
    // Admission replaces every pending identity, including the nonce, so equal choices keep an equal document.
    realmId: pending, nonce: '00000000-0000-4000-8000-000000000000', transcriptId: pending };
  const parameters = { schemaVersion: 3, binding, summary, limitsRevision: limits.revision, candidateRoot, packageDigest: measured.measurementDigest,
    candidateManifest: { sha256: manifest.sha256, fileCount: measured.files.length, sourceCommit: release.sourceCommit, sourceTreeSha256: release.sourceTreeSha256, version: measured.packageVersion },
    startState: { schemaVersion: 2, catalogRevision: BEUSER_ARRANGE_REGISTRY.revision, states: branch.initialStates },
    size: controllerData.size, bounds: controllerData.bounds, completionTokens: controllerData.completionTokens, rubric: journey.rubric,
    choices: { 'beuser-walker': choice, 'beuser-evaluator': choice }, contributorModels: [{ maker: null, evidence: 'contributor-receipts-unavailable' }],
    entry: { mode: 'pty', nodeExecutable: BEUSER_REALM_RECIPE.nodeExecutable, args: [] }, probes: probeSet.probes, calibration: calibration.calibration };
  // The controller's own BeUser pool is kept; only its registry follows the chosen journey, candidate and model.
  const existing = c.config.admission;
  const admission = { ...(existing ?? controllerData.pool), registry: { schemaVersion: 1, revision: `beuser-controller-${input.journey}`,
    profiles: [{ id, version: 1, adapter: { id: 'beuser', version: 1 }, parameters }], kinds: [{ kind: input.journey, profile: { id, version: 1 }, workspaceDelivery: 'none' }],
    evaluators: [{ id: 'beuser', version: 1, implementation: { id: 'beuser', version: 1 } }] } };
  const result = await install(root, { scopeId, apply: input.apply, ...(input.expect ? { expect: input.expect } : {}) }, options, async () => admission, true);
  return { ...result, controller, models, candidate: { root: candidateRoot, version: measured.packageVersion, revision: release.sourceCommit }, limits };
}

/** Validates a complete admission document and installs it through ConfigApplication. `replace` (the controller only) swaps a BeUser-only registry and keeps its pool. */
async function install(root: string, input: { readonly scopeId: string; readonly apply: boolean; readonly expect?: string }, options: ConfigLoadOptions,
  document: (c: Scope) => Promise<unknown>, replace: boolean) {
  const read = await snapshotConfiguredConfig(root, { ...options, heal: false });
  const c = await loadConfiguredScopeContext(root, input.scopeId, { ...options, heal: false }, 'write');
  const admission = CONFIG_FIELDS.admission.schema.safeParse(await document(c));
  if (!admission.success || !admission.data) throw invalid();
  const parsed = executionRegistrySchema.safeParse(admission.data.registry);
  if (!parsed.success || !parsed.data.profiles.length) throw invalid();
  const registry = parsed.data;
  await modelSources(c, async sources => {
    for (const profile of registry.profiles) {
      if (profile.adapter.id !== 'beuser' || profile.adapter.version !== 1) throw invalid();
      const data = beuserJourneyProfileSchema.safeParse(profile.parameters);
      if (!data.success) throw invalid();
      const p = data.data;
      if (!BEUSER_LIMITS_REGISTRY.profiles.some(limit => limit.revision === p.limitsRevision)) throw ErrorRegistry.createError('BEUSER_LIMITS_UNAVAILABLE');
      if (await canonicalRealmPath(p.candidateRoot, 'directory') !== p.candidateRoot) throw invalid();
      await readBeuserCandidate(p.candidateRoot, p.candidateManifest, c.config.installation.packageMeasurement,
        p.packageDigest, p.binding.candidate.stateDigest);
      for (const role of ['beuser-walker', 'beuser-evaluator'] as const) {
        const target = p.choices[role], held = await inspectRoleModelsInScope(sources, role, input.scopeId, Date.now());
        if (!held.models.some(row => row.channelId === target.channelId && row.modelId === target.modelId && row.active)
          || !roleModelInvocationReference(sources, c.config['provider_invocation_profiles'], input.scopeId, target)) throw ErrorRegistry.createError('BEUSER_MODEL_UNAVAILABLE');
      }
    }
  });
  const existing = read.effective.admission;
  // This installer never replaces an unrelated registry or widens an existing pool implicitly.
  // The config loader uses null-prototype JSON objects; prototypes do not change the selected data.
  const same = existing && isDeepStrictEqual(existing, admission.data, { skipPrototype: true });
  const swap = replace && existing && isDeepStrictEqual({ ...existing, registry: null }, { ...admission.data, registry: null }, { skipPrototype: true })
    && executionRegistrySchema.safeParse(existing.registry).data?.profiles.every(profile => profile.adapter.id === 'beuser');
  if (existing && !same && !swap) throw ErrorRegistry.createError('BEUSER_SETUP_CONFLICT');
  const digest = sha256(JSON.stringify({ project: read.digest, global: read.global, admission: admission.data }));
  const result = { schemaVersion: 1 as const, status: same ? 'current' : 'preview', digest, admission: admission.data };
  if (!input.apply) return result;
  if (input.expect !== digest) throw ErrorRegistry.createError('CONFIG_CONCURRENT_REVISION_HOLD');
  let status = 'current';
  if (!same) {
    const app = createConfiguredConfigApplication(root, options, current => {
      if (!isDeepStrictEqual(current.global, read.global)) throw ErrorRegistry.createError('CONFIG_CONCURRENT_REVISION_HOLD');
    });
    const written = await app.submit('set', { keyPath: 'admission', value: admission.data, layer: 'project', expect: read.digest,
      scopeId: input.scopeId, principal: c.principal, commandId: `beuser-setup-${digest}` });
    if (written.status !== 'applied') return { ...result, status: 'approval-pending', approval: written };
    status = 'applied';
  }
  const pool = await installConfiguredExecutionPool(root, input.scopeId, true, options);
  return { ...result, status: pool.status === 'created' || pool.status === 'current' ? status : 'pool-unavailable', pool };
}
