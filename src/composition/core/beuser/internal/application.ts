import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';
import { userInfo } from 'node:os';
import { z } from 'zod';
import { beuserBindingSchema } from '#domain/index.js';
import { evaluateBeuserEvidence, beuserDigest, beuserEvidenceSchema,
  type BeuserReadback, type ArtifactStore } from '#capabilities/index.js';
import { FileArtifactStore, createBeuserSurface, BeuserSurfaceError,
  openSqliteApprovalStore, openLocalIntegrityAuthority, extractOpenAiChatTextFromInvocation, beuserPrivateRecord, readBeuserInstallationSummary, type HarnessEvent, type SqliteAttemptStore } from '#adapters/index.js';
import { BeuserApplication, beuserWalkSandboxResult, BeuserContractError, beuserSourceMakers, recordBeuserRefusal, NervousApplication, NERVOUS_RULES_SEED, sandboxResultSchema, BeuserExecutionBudget, BeuserCallBudget, BeuserExecutionSupervisor, BeuserDispatch,
  pinBeuserWalkerSummary, createBeuserTranscript, createBeuserEvidencePort, collectBeuserReadback,
  DispatchApplication, DispatchPolicyAuthorization, RunPolicyAuthorization, beuserReportSchema, assertBeuserAccess, beuserBindingDigest, selectReservedTaskProfile,
  readBeuserControllerAudit, verifyApproval, type BeuserControllerValidity, type BeuserContext, type BeuserReport, type SandboxRequest, type ExecutionSupervisor, type SupervisorProfile } from '#engine/index.js';
import { sha256, prepareProductDirectory, inspectProductDirectory, getConfigKnownSecrets,
  redactForRecord, type ConfigLoadOptions } from '#platform/index.js';
import { loadConfiguredScopeContext, withScopeAudit } from '#composition/core/scoped-request/index.js';
import { createLayoutPolicySource } from '#composition/core/policy/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { createBeuserChannel, retainBeuserJson } from '#adapters/index.js';
import { openConfiguredBeuserRealmOwner } from '#composition/core/supervisors/index.js';
import { configuredBeuserModels } from './models.js';
import { beuserJourneyLaunch } from './launch.js';

export { beuserJourneyProfileSchema } from '#composition/core/supervisors/index.js';
export type { BeuserJourneyProfile } from '#composition/core/supervisors/index.js';

/** Reopenable controller custody plus an existing granted dispatch. No in-memory table can authorize a realm. */
export async function createConfiguredBeuserHarness(root: string, context: BeuserContext, request: SandboxRequest, profile: SupervisorProfile,
  store: SqliteAttemptStore, artifacts: ArtifactStore, owner: string, options: ConfigLoadOptions = {}, created?: (id: string) => Promise<void>) {
  const c = await loadConfiguredScopeContext(root, context.binding.identity.scopeId, options, 'write'), config = c.config;
  const { data, custody, runtimeOptions, removal, realm } = await openConfiguredBeuserRealmOwner(c, context, request, profile, store, artifacts, owner, created);
  const launch = beuserJourneyLaunch(data);
  const channel = createBeuserChannel({ context, realm, custody, options: runtimeOptions, boot: { mode: data.entry.mode,
    entry: launch.entry, commands: launch.commands, maxBootBytes: context.limits.maxArtifactBytes, language: data.summary.language } });
  const known = getConfigKnownSecrets(config), recorder = createBeuserTranscript(context, known), readbacks: BeuserReadback[] = [];
  let lastEvent: HarnessEvent | null = null;
  const sink = async (ctx: BeuserContext, event: HarnessEvent) => {
    assertBeuserAccess(context, event.entry.binding, ctx.principal, { kind: 'beuser-transcript', id: context.binding.transcriptId }, 'inspect');
    const payload = JSON.stringify({ kind: event.entry.kind, screen: event.screen, action: event.action, process: event.process });
    if (sha256(payload) !== event.entry.digest) throw new BeuserContractError('BEUSER_INPUT_INVALID');
    const row = recorder.append(ctx, { binding: event.entry.binding, kind: event.entry.kind, atMs: event.entry.atMs,
      evidenceRef: event.entry.evidenceRef, text: payload });
    await retainBeuserJson(artifacts, ctx, row); lastEvent = event;
  };
  let capturedSurface: ReturnType<typeof createBeuserSurface> | undefined;
  const getSurface = () => capturedSurface ??= createBeuserSurface({ context, realm: channel, size: data.size, bounds: data.bounds, catalog: launch.catalog, sink });
  const safeScreen = async (work: () => Promise<import('#engine/index.js').BeuserScreen>) => {
    try { const value = await work(); const text = redactForRecord(value.text, known); return { ...value, text, digest: sha256(text) }; }
    catch (error) { if (error instanceof BeuserSurfaceError) throw new BeuserContractError(error.code); throw error; }
  };
  const surface: import('#engine/index.js').SurfacePort = {
    look: ctx => safeScreen(() => getSurface().look(ctx)), type: (ctx, text) => safeScreen(() => getSurface().type(ctx, text)),
    press: (ctx, key) => safeScreen(() => getSurface().press(ctx, key)), wait: (ctx, ms) => safeScreen(() => getSurface().wait(ctx, ms)),
    argv: (ctx, command) => safeScreen(() => getSurface().argv(ctx, command)),
  };
  const model = configuredBeuserModels(root, options, context, data.choices, data.contributorModels, new BeuserCallBudget(context.limits), data.completionTokens,
    () => ({ transcript: recorder.finalize(context), rubric: data.rubric }));
  const walkerMakers: (string | null)[] = [];
  const models = { ...model.models, async walker(...args: Parameters<typeof model.models.walker>) { const answer = await model.models.walker(...args);
    if (answer.state === 'invoked') walkerMakers.push(answer.receipt.maker); return answer; } };
  const started = performance.now();
  const probe = async (): Promise<BeuserReadback> => {
    const handle = (await custody.load(context))?.handle; if ((await realm.observe(context)).state !== 'admitted' || !handle) throw new BeuserContractError('BEUSER_TARGET_NOT_SANDBOX');
    // Values only. No ledger, key, backup, receipt bytes or arbitrary persona-authored command crosses this boundary.
    const summary = await readBeuserInstallationSummary(context, handle, runtimeOptions);
    const atMs = Math.floor(performance.now() - started), evidenceRef = data.probes[0]!.readbackRef;
    return collectBeuserReadback(context, async () => ({ schemaVersion: 1, binding: context.binding, summary, atMs, evidenceRef }));
  };
  let evidence: z.infer<typeof beuserEvidenceSchema> | null = null, controllerValidity: BeuserControllerValidity = 'unknown';
  const evidencePort = createBeuserEvidencePort(context, recorder, async ctx => {
    const lease = await custody.load(ctx), transcript = recorder.finalize(ctx);
    const evaluated = controllerValidity === 'valid' ? await models.evaluate(ctx, transcript.transcriptDigest) : null;
    let experience: { verdict: 'pass' | 'friction' | 'fail' | 'unknown'; evidenceRefs: string[] } = { verdict: 'unknown', evidenceRefs: [] };
    if (evaluated?.state === 'invoked' && evaluated.receipt.invocation.receipt.outcome?.state === 'responded') {
      const text = extractOpenAiChatTextFromInvocation(evaluated.receipt.invocation);
      const parsed = z.object({ verdict: z.enum(['pass', 'friction', 'fail', 'unknown']), evidenceRefs: z.array(z.string()) }).strict().safeParse(text ? JSON.parse(text) : null);
      if (parsed.success && parsed.data.evidenceRefs.every(ref => transcript.evidenceRefs.includes(ref))) experience = parsed.data;
    }
    evidence = beuserEvidenceSchema.parse({ schemaVersion: 1, binding: ctx.binding, transcript: transcript.transcript, readbacks,
      validity: controllerValidity, cleanup: { state: lease?.observation.state === 'destroyed' ? 'destroyed' : 'unknown', atMs: Math.floor(performance.now() - started),
        evidenceRef: lease?.observation.evidenceRefs.at(-1) ?? 'cleanup-unproven' },
      experience: { ...experience, maker: evaluated?.state === 'invoked' ? evaluated.receipt.maker : null,
        sourceMakers: [...beuserSourceMakers(data.contributorModels), ...walkerMakers] } });
    return evaluateBeuserEvidence({ binding: ctx.binding, producer: { owner, profileDigest: beuserDigest(profile) }, fileName: 'beuser-evidence',
      dimension: 'outcome', probes: data.probes, calibration: data.calibration }, evidence).result;
  });
  const refusal = async (ctx: BeuserContext) => withScopeAudit(c, async audit => {
    const nervous = new NervousApplication({ audit, now: Date.now }, NERVOUS_RULES_SEED, { live: false, approval: null, executors: {} });
    await recordBeuserRefusal(ctx, { audit, nervous, nervousContext: { owner: c.principal, policyRevision: c.document.revision }, policyRevision: c.document.revision, now: Date.now });
  });
  const withControllerAudit = <T>(work: (ports: Parameters<typeof readBeuserControllerAudit>[1]) => Promise<T>) => withScopeAudit(c, async audit => {
    const integrity = await openLocalIntegrityAuthority(c.layout, config.approvals.keyFile, false);
    const approvals = openSqliteApprovalStore(await c.path(), config.storage.sqlite);
    try { return await work({ audit, approvals: (after, limit) =>
      approvals.store.list(context.binding.identity.scopeId, after, limit).map(row => verifyApproval(row, integrity)) }); }
    finally { approvals.close(); }
  }, false, 'read');
  return { custody, realm, removal, refusal, async walk(budget: BeuserExecutionBudget) {
    const ports = { realm, surface, initialCommand: launch.initialCommand, models, decode: model.decode, evidence: evidencePort, refusal,
      async controllerAudit(ctx: BeuserContext) {
        try { controllerValidity = await withControllerAudit(ports => readBeuserControllerAudit(ctx, ports)); }
        catch { controllerValidity = 'unknown'; }
        return controllerValidity;
      },
      async record(screen: { readonly sequence: number }) { const row = recorder.inspect(context).find(item => item.entry.sequence === screen.sequence);
        if (!row) throw new BeuserContractError('BEUSER_INPUT_INVALID'); await evidencePort.append(context, row.entry); },
      async finished() {
        if (lastEvent?.process?.state !== 'eof') return false;
        const readback = await probe(); readbacks.push(readback);
        recorder.append(context, { binding: context.binding, kind: 'readback', evidenceRef: readback.evidenceRef, atMs: readback.atMs, text: JSON.stringify(readback.summary) });
        return true;
      } };
    const result = await new BeuserApplication(ports, budget).walk(context, pinBeuserWalkerSummary(data.summary));
    if (capturedSurface && !context.signal.aborted) await capturedSurface.close(context);
    return { result, evidence };
  } };
}

/** C6 binds the C4 supervisor to the actual realm owner and retained C5 bytes. A restart reads the same private terminal receipt. */
export async function executeConfiguredBeuserAttempt(root: string, request: SandboxRequest, profile: SupervisorProfile,
  context: BeuserContext, store: SqliteAttemptStore, options: ConfigLoadOptions = {}) {
  const c = await loadConfiguredScopeContext(root, request.identity.scopeId, options, 'write');
  const policy = new DispatchPolicyAuthorization(createLayoutPolicySource(c.layout, userInfo().uid, c.config.inspection.policyMaxBytes));
  await policy.authorizeIdentity('execute', request.identity, c.principal);
  const selected = selectReservedTaskProfile(await store.loadRun(request.identity.scopeId, request.identity.runId),
    await store.load(request.identity.scopeId, request.identity.attemptId), request.identity);
  if (!isDeepStrictEqual(profile, { schemaVersion: 1, adapterId: selected.adapter.id, adapterVersion: selected.adapter.version, parameters: selected.parameters })) throw new BeuserContractError('BEUSER_INPUT_INVALID');
  const artifacts = new FileArtifactStore({ root: await prepareProductDirectory(c.layout, 'artifacts'), maxBytes: c.config.artifacts.maxBytes });
  const directory = join(await prepareProductDirectory(c.layout, 'crashes'), 'beuser-custody'), name = sha256(JSON.stringify(request.identity));
  const terminal = beuserPrivateRecord(directory, `terminal-${name}`, context.limits.maxArtifactBytes), owner = `beuser-${name}`;
  const budget = new BeuserExecutionBudget(context.limits), noHandle = new BeuserContractError('BEUSER_TARGET_NOT_SANDBOX');
  let harness: Awaited<ReturnType<typeof createConfiguredBeuserHarness>>;
  try { harness = await createConfiguredBeuserHarness(root, context, request, profile, store, artifacts, owner, options); }
  catch (error) { budget.close(); throw error; }
  const handle = async () => { const lease = await harness.custody.load({ ...context, signal: new AbortController().signal });
    if (!lease?.handle) throw new BeuserContractError('BEUSER_TARGET_NOT_SANDBOX'); return `beuser-${lease.handle.incarnation}`; };
  const readTerminal = async () => {
    const read = await terminal.read(); if (read.kind !== 'ready') return null;
    const record = z.object({ binding: beuserBindingSchema, result: sandboxResultSchema.nullable(), reason: z.string().nullable().optional(), cleanup: z.enum(['destroyed', 'quarantined', 'unknown']).optional(), evidence: z.unknown().nullable() }).strict().parse(read.value);
    if (beuserBindingDigest(record.binding) !== beuserBindingDigest(context.binding)) throw new BeuserContractError('BEUSER_TARGET_NOT_SANDBOX');
    return record;
  };
  const delegate: ExecutionSupervisor & { captureProfile(): Promise<SupervisorProfile> } = {
    captureProfile: async () => profile,
    async execute(_request, signal, hooks) {
      // The dispatch grant was committed before this call. Publish actual container custody before start.
      const admitted = { ...context, signal: AbortSignal.any([context.signal, ...(signal ? [signal] : [])]) };
      harness = await createConfiguredBeuserHarness(root, admitted, request, profile, store, artifacts, owner, options, id => hooks?.created(id) ?? Promise.resolve());
      const { result, evidence } = await harness.walk(budget);
      const lease = await harness.custody.load({ ...context, signal: new AbortController().signal });
      const observed = lease?.handle ? beuserWalkSandboxResult(`beuser-${lease.handle.incarnation}`, result) : null;
      await terminal.write({ binding: context.binding, result: observed, reason: result.reason, cleanup: result.cleanup, evidence });
      // A pre-publish refusal has custody but no process result. Keep dispatch unresolved without inventing a handle.
      if (!observed) throw noHandle;
      return observed;
    },
    async observe() { const held = await readTerminal(); if (held?.result) {
      const result = sandboxResultSchema.parse(held.result);
      return { handle: result.handle, result: result.result, ...(result.worker ? { worker: result.worker } : {}), ...(result.container ? { container: result.container } : {}) };
    }
      return { handle: await handle(), result: { kind: 'unknown', reasonCode: 'BEUSER_EXECUTION_UNRESOLVED' } }; },
    async cancel() { await harness.realm.destroy({ ...context, signal: AbortSignal.timeout(context.limits.cleanupDeadlineMs) }); return this.observe(request); },
    async recoverOutput() { if (!(await readTerminal())?.result) throw new BeuserContractError('BEUSER_INPUT_INVALID'); return { stdout: '', stderr: '', completeness: 'partial' }; },
    async release() { const observation = await harness.custody.load({ ...context, signal: new AbortController().signal });
      if (observation?.observation.state !== 'destroyed') throw new BeuserContractError('BEUSER_TARGET_NOT_SANDBOX'); return 'absent'; },
  };
  const supervisor = new BeuserExecutionSupervisor(delegate, {
    async context(supplied) { if (beuserDigest(supplied) !== beuserDigest(request)) throw new BeuserContractError('BEUSER_TARGET_NOT_SANDBOX'); return context; },
    request: async () => request,
    async attributed(_ctx, observed) { return observed.handle === await handle(); },
    async collect(ctx) { const held = await readTerminal(); if (!held?.evidence) return [];
      const evidence = beuserEvidenceSchema.parse(held.evidence);
      assertBeuserAccess(ctx, evidence.binding, ctx.principal, { kind: 'attempt', id: ctx.binding.identity.attemptId }, 'evaluate');
      return [{ name: 'beuser-evidence', status: 'collected', bytes: Buffer.from(JSON.stringify(evidence)) }]; },
    refusal: harness.refusal,
  });
  const dispatch = new BeuserDispatch(new DispatchApplication(store, supervisor, { verify: async () => c.principal }, policy, owner, artifacts), harness.refusal, async () => request);
  try {
    let outcome;
    try { outcome = await dispatch.execute(context, request, undefined); }
    catch (error) {
      const record = error === noHandle ? await store.readDispatch(request) : null;
      if (!record) throw error;
      outcome = { kind: 'unresolved' as const, record };
    }
    const held = await readTerminal();
    const evidence = held?.evidence ? beuserEvidenceSchema.parse(held.evidence) : null;
    return { ...outcome, reason: held?.reason ?? null, cleanup: held?.cleanup ?? 'unknown', walked: evidence?.transcript.some(row => row.entry.kind === 'screen') ?? false };
  } finally { budget.close(); }
}

/** Read-only report query, bound to the existing Run policy before opening any retained report. */
export async function readConfiguredBeuserReport(root: string, scopeId: string, runId: string | undefined, options: ConfigLoadOptions = {}): Promise<BeuserReport> {
  try {
    const c = await loadConfiguredScopeContext(root, scopeId, { ...options, heal: false }, 'read');
    const crashes = await inspectProductDirectory(c.layout, 'crashes').catch((error: unknown) => {
      if ((error as { code?: string }).code === 'MANAGED_FILE_MISSING') throw new BeuserContractError('BEUSER_REPORT_NOT_FOUND');
      throw error;
    }), directory = (name: string) => beuserPrivateRecord(join(crashes, 'beuser-reports'), name, c.config.artifacts.maxBytes);
    if (runId === undefined) {
      const latest = await directory(sha256(JSON.stringify([scopeId, c.principal.issuer, c.principal.subject]))).read();
      if (latest.kind === 'absent') throw new BeuserContractError('BEUSER_REPORT_NOT_FOUND');
      if (latest.kind !== 'ready') throw new BeuserContractError('BEUSER_INPUT_INVALID');
      runId = z.object({ schemaVersion: z.literal(1), scopeId: z.literal(scopeId), runId: z.string().min(1) }).strict().parse(latest.value).runId;
    }
    await new RunPolicyAuthorization(createLayoutPolicySource(c.layout, userInfo().uid, c.config.inspection.policyMaxBytes)).authorize('inspect', { scopeId, runId }, c.principal);
    const read = await directory(sha256(JSON.stringify([scopeId, runId]))).read();
    if (read.kind === 'absent') throw new BeuserContractError('BEUSER_REPORT_NOT_FOUND');
    if (read.kind !== 'ready') throw new BeuserContractError('BEUSER_INPUT_INVALID');
    const envelope = z.object({ schemaVersion: z.literal(1), scopeId: z.literal(scopeId), runId: z.literal(runId), report: beuserReportSchema }).strict().parse(read.value);
    const report = envelope.report;
    if (report.segments.some(segment => segment.verdict && (segment.verdict.binding.identity.scopeId !== scopeId || segment.verdict.binding.identity.runId !== runId))) throw new BeuserContractError('BEUSER_TARGET_NOT_SANDBOX');
    return report;
  } catch (error) { throw queryFailure(error); }
}
