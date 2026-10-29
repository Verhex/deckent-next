import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { beuserBindingSchema, executionProfileDefinitionSchema, executionRegistrySchema } from '#domain/index.js';
import { BEUSER_EVALUATOR, beuserDigest, beuserParametersSchema, evaluateBeuserEvidence } from '#capabilities/index.js';
import { openSqliteAttemptStore, FileArtifactStore, beuserPrivateRecord, canonicalRealmPath, readBeuserCandidate } from '#adapters/index.js';
import { BEUSER_LIMITS_REGISTRY, BeuserContractError, beuserEvaluatorFor, beuserPersonaDigest, readBeuserDispatchEvidence, createBeuserReport, beuserPersonaCoverage, type BeuserReport, type SandboxRequest } from '#engine/index.js';
import { sha256, prepareProductDirectory, type ConfigLoadOptions } from '#platform/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { withConfiguredRunAdmission } from '#composition/core/runs/index.js';
import { reserveConfiguredRunTasks } from '#composition/core/runs/index.js';
import { evaluateConfiguredBeuserTask } from './evaluate.js';
import { validateBeuserSupervisorProfile } from '#composition/core/supervisors/index.js';
import { beuserJourneyProfileSchema, executeConfiguredBeuserAttempt } from './application.js';

/** The CLI selects installed registry data. It supplies no profile, principal, Attempt id, probe or launch command. */
export async function walkConfiguredBeuser(root: string, input: { readonly scopeId: string; readonly journey: string; readonly candidate: string },
  options: ConfigLoadOptions = {}, signal: AbortSignal = new AbortController().signal): Promise<BeuserReport> {
  const started = performance.now();
  const { c, selected, runId, principal, profiles, definitions, candidateRoot } = await admitConfiguredBeuserWalk(root, input, options, signal);
  const store = await openSqliteAttemptStore(await c.path(), c.config.storage.sqlite, { now: Date.now, timeoutMs: c.config.runRuntime.parking.timeoutMs }, 'forbid', { validate: validateBeuserSupervisorProfile });
  const segments: BeuserReport['segments'] = [], unknown: BeuserReport['unknown'] = [], findings: NonNullable<BeuserReport['findings']> = [];
  const cleanup: NonNullable<BeuserReport['cleanup']> = [];
  let walked = 0, completed = 0, attempted = 0;
  const intervals: { start: number; end: number }[] = [];
  try {
    for (let wave = 0; wave < selected.length; wave++) {
      const run = await store.loadRun(input.scopeId, runId);
      if (!run || !run.progress.some(task => task.phase === 'pending')) break;
      if (signal.aborted) break;
      const reservation = await reserveConfiguredRunTasks(root, { schemaVersion: 1, commandId: randomUUID(), scopeId: input.scopeId, runId, expectedRevision: run.revision }, options,
        taskId => definitions.find(d => d.binding.identity.taskId === taskId)!.binding.identity.attemptId);
      const executions = await Promise.all(reservation.reservation.identities.map(async identity => {
        const profile = profiles.get(identity.taskId)!, data = beuserJourneyProfileSchema.parse(profile.parameters),
          limits = BEUSER_LIMITS_REGISTRY.profiles.find(row => row.revision === data.limitsRevision)!;
        const request: SandboxRequest = { protocolVersion: 1, identity, workspace: candidateRoot, argv: data.entry.args.length ? data.entry.args : [data.entry.mode] };
        const start = performance.now(); attempted++;
        try {
          const dispatch = await executeConfiguredBeuserAttempt(root, request, { schemaVersion: 1, adapterId: 'beuser', adapterVersion: 1, parameters: profile.parameters },
            { binding: data.binding, principal, limits, signal }, store, options);
          if (dispatch.walked) { walked++; intervals.push({ start, end: performance.now() }); }
          return { identity, data, limits, request, dispatch };
        } catch (error) { return { identity, error }; }
      }));
      // Effects use the pool-admitted wave; acceptance commits remain serialized under their existing owner.
      for (const execution of executions) {
        const { identity } = execution;
        try {
          if ('error' in execution) throw execution.error;
          const { dispatch, data, limits, request } = execution;
          cleanup.push({ branch: identity.taskId, state: dispatch.cleanup, filesystemProof: dispatch.filesystemProof });
          const finding = dispatch.diagnostic?.finding;
          if (finding) findings.push(finding);
          if (dispatch.reason && !finding) unknown.push({ branch: identity.taskId, reason: dispatch.reason });
          if (dispatch.kind !== 'terminal') { unknown.push({ branch: identity.taskId, reason: 'BEUSER_CLEANUP_UNPROVEN' }); continue; }
          await evaluateConfiguredBeuserTask(root, { binding: data.binding, principal, limits, signal: new AbortController().signal }, randomUUID(), options);
          const record = await store.readDispatch(request);
          const artifacts = new FileArtifactStore({ root: await prepareProductDirectory(c.layout, 'artifacts'), maxBytes: c.config.artifacts.maxBytes });
          const evidence = await readBeuserDispatchEvidence(record!, definitions.find(d => d.binding.identity.taskId === identity.taskId)!, artifacts,
            { maxEvidenceItems: 2, maxTotalBytes: c.config.artifacts.maxBytes });
          const verdict = evidence && evaluateBeuserEvidence(definitions.find(d => d.binding.identity.taskId === identity.taskId)!, evidence).result;
          if (verdict && verdict.outcome !== 'unknown' && verdict.validity === 'valid') completed++;
          segments.push({ segment: identity.taskId, verdict, broken: verdict?.outcome === 'RED' ? [identity.taskId] : [],
            friction: verdict?.outcome === 'FRICTION' ? [identity.taskId] : [], delight: [], evidenceRefs: [...(verdict?.evidenceRefs ?? [])], nextOwner: 'lead' });
        } catch (error) {
          const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'BEUSER_INPUT_INVALID';
          unknown.push({ branch: identity.taskId, reason: code });
        }
      }
    }
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'BEUSER_INPUT_INVALID';
    unknown.push({ branch: input.journey, reason: code });
  } finally { store.close(); }
  const report = createBeuserReport({ schemaVersion: 1, simulated: true, calibrationClaim: 'uncalibrated', cohort: selected[0]!.data.calibration.cohort,
    calibration: selected[0]!.data.calibration, counts: { defined: selected.length, selected: selected.length, walked, concurrent: Math.max(0, ...intervals.map(row => intervals.filter(other => other.start <= row.start && other.end > row.start).length)) }, segments, findings, cleanup,
    unwalked: selected.filter(row => !segments.some(s => s.segment === row.profile.id) && !unknown.some(u => u.branch === row.profile.id)).map(row => ({ branch: row.profile.id, reason: signal.aborted ? 'cancelled' : 'not-reserved' })),
    unknown, criticalCoverage: selected.map(({ profile }) => beuserPersonaCoverage(profile.id,
      segments.find(segment => segment.segment === profile.id)?.verdict)), reliability: { completed, attempted }, cost: null, currency: BEUSER_LIMITS_REGISTRY.profiles.find(row => row.revision === selected[0]!.data.limitsRevision)!.currency,
    elapsedMs: performance.now() - started });
  const directory = join(await prepareProductDirectory(c.layout, 'crashes'), 'beuser-reports');
  await beuserPrivateRecord(directory, sha256(JSON.stringify([input.scopeId, runId])), c.config.artifacts.maxBytes).write({ schemaVersion: 1, scopeId: input.scopeId, runId, report });
  await beuserPrivateRecord(directory, sha256(JSON.stringify([input.scopeId, c.principal.issuer, c.principal.subject])), c.config.artifacts.maxBytes).write({ schemaVersion: 1, scopeId: input.scopeId, runId });
  return report;
}

/** Real admission only: seals the same Run and profiles used by walk, without starting a realm or invoking a model. */
export async function admitConfiguredBeuserWalk(root: string, input: { readonly scopeId: string; readonly journey: string; readonly candidate: string },
  options: ConfigLoadOptions = {}, signal: AbortSignal = new AbortController().signal) {
  const c = await loadConfiguredScopeContext(root, input.scopeId, options, 'write');
  if (c.config.admission === null) throw new BeuserContractError('BEUSER_PROFILE_REQUIRED');
  const parsed = executionRegistrySchema.safeParse(c.config.admission?.registry);
  if (!parsed.success) throw new BeuserContractError('BEUSER_INPUT_INVALID');
  const registry = parsed.data;
  const selected = registry.kinds.flatMap(kind => {
    const profile = registry.profiles.find(p => p.id === kind.profile.id && p.version === kind.profile.version)!;
    if (profile.adapter.id !== 'beuser' || profile.adapter.version !== 1) return [];
    const parsed = beuserJourneyProfileSchema.safeParse(profile.parameters);
    if (!parsed.success) throw new BeuserContractError('BEUSER_INPUT_INVALID');
    const data = parsed.data;
    return data.summary.journeyId === input.journey ? [{ kind, profile, data }] : [];
  });
  if (!selected.length) throw new BeuserContractError('BEUSER_PROFILE_REQUIRED');
  if (selected.some(row => !isDeepStrictEqual(row.data.calibration, selected[0]!.data.calibration))) throw new BeuserContractError('BEUSER_INPUT_INVALID');
  const candidateRoot = await canonicalRealmPath(resolve(input.candidate), 'directory');
  const runId = randomUUID(), principal = beuserEvaluatorFor(c.principal, input.scopeId);
  const profiles = new Map<string, typeof registry.profiles[number]>();
  const definitions: ReturnType<typeof beuserParametersSchema.parse>[] = [];
  for (const { profile, data } of selected) {
    const limits = BEUSER_LIMITS_REGISTRY.profiles.find(row => row.revision === data.limitsRevision);
    if (!limits || data.candidateRoot !== candidateRoot) throw new BeuserContractError('BEUSER_INPUT_INVALID');
    await readBeuserCandidate(candidateRoot, data.candidateManifest, c.config.installation.packageMeasurement,
      data.packageDigest, data.binding.candidate.stateDigest);
    signal.throwIfAborted();
    const taskId = profile.id, binding = beuserBindingSchema.parse({ ...data.binding,
      identity: { scopeId: input.scopeId, runId, taskId, attemptId: randomUUID(), generation: 1, layoutRevision: c.layout.revision },
      nonce: randomUUID(), realmId: randomUUID(), transcriptId: randomUUID(), personaDigest: beuserPersonaDigest(data.summary) });
    const pinned = executionProfileDefinitionSchema.parse({ ...profile, parameters: { ...data, binding } });
    profiles.set(taskId, pinned);
    definitions.push(beuserParametersSchema.parse({ binding, producer: { owner: `beuser-${sha256(JSON.stringify(binding.identity))}`,
      profileDigest: beuserDigest({ schemaVersion: 1, adapterId: 'beuser', adapterVersion: 1, parameters: pinned.parameters }) }, fileName: 'beuser-evidence',
      dimension: 'outcome', probes: data.probes, calibration: data.calibration }));
  }
  if (profiles.size !== selected.length) throw new BeuserContractError('BEUSER_INPUT_INVALID');
  const pinnedRegistry = { ...registry, profiles: registry.profiles.map(p => profiles.get(p.id) ?? p) };
  const context = { ...c, config: { ...c.config, admission: { ...c.config.admission!, registry: pinnedRegistry } } };
  const graph = { schemaVersion: 4, revision: 1, tasks: selected.map(({ kind, profile }) => ({ id: profile.id, kind: kind.kind, dependencies: [], acceptanceCriteria: [profile.id] })),
    criterionDefinitions: definitions.map((parameters, index) => ({ id: selected[index]!.profile.id, version: 1, description: input.journey,
      evaluator: { id: BEUSER_EVALUATOR.id, version: BEUSER_EVALUATOR.version }, parameters })) };
  await withConfiguredRunAdmission(root, context, options, app => app.create({ schemaVersion: 1, commandId: randomUUID(), scopeId: input.scopeId, runId, graph }), profile => {
    if (!isDeepStrictEqual(profiles.get(profile.id), profile)) throw new BeuserContractError('BEUSER_INPUT_INVALID');
    beuserJourneyProfileSchema.parse(profile.parameters); return undefined;
  });
  return { c, selected, runId, principal, profiles, definitions, candidateRoot };
}
