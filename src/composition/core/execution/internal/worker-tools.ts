import { nativeWorkerToolFloor } from './worker-floor.js';
import { nativeWorkerApprovalExpired, workerToolCardSummary, nativeWorkerToolLifetime, type ToolSessionPort } from '#capabilities/index.js';
import { ErrorRegistry, SystemTrustedClock, sha256, redactForRecord, resolveLocale, type ConfigLoadOptions } from '#platform/index.js';
import { runDurableAgentTurn, requestAgentToolApproval, awaitAgentToolApproval,
  prepareApprovalPreview, projectModelIngressField, agentToolApprovalFacts, AgentToolPolicyAuthorization, type AgentTurnPorts } from '#engine/index.js';
import { projectEditArea, WORKSPACE_EDIT_TOOL_SPECS, RUN_SHELL_TOOL_SPEC,
  isSelfSourceWriteFloored, agentProductStateDeny, agentGlobalStateRoots,
  sealedRootEntryRefused, sandboxWriteSetRoot, readTerminalShellConfig,
  keepFullPreview, dropFullPreview, LocalOsSessionAuthority, openSqliteAgentTurnStore, openSqliteApprovalStore, openLocalIntegrityAuthority, type NativeCliWorkerPorts } from '#adapters/index.js';
import { chatTurnApprovalPreview, describeAgentCall, createAgentCallApprovals, createAgentCallDecisions, createAgentFileEdits, createAgentShell } from '#composition/core/agent-turn/index.js';
import { recheckNativeWorkerUse } from '#composition/core/runs/index.js';

type OpenTools = NativeCliWorkerPorts['openTools'];
/** The K1 coordinator owns proposals and durable settlement. The model CLI never receives this workspace. */
export async function openConfiguredNativeWorkerTools(root: string, request: Parameters<OpenTools>[0], binding: Parameters<OpenTools>[1],
  signal: AbortSignal, resources: Parameters<OpenTools>[3], options: ConfigLoadOptions, plan: import('#domain/index.js').RunExecutionSnapshot['workerMode'] | null = null): Promise<ToolSessionPort> {
  const { scopeId, generation } = request.identity, turnId = sha256(JSON.stringify(request.identity));
  const { current, context, person, env, known, workspace, inputs, authority, selfSource, writeFloor, sandbox, sandboxes } = await nativeWorkerToolFloor(root, request, binding, resources, options);
  const clock = new SystemTrustedClock();
  const sessions = () => LocalOsSessionAuthority.create(context.principal.scopeIds, context.config.approvals.sessionTtlMs, clock);
  const edits = createAgentFileEdits({ area: projectEditArea(workspace.scope), context, sessions, scopeId, turnId, authority, locale: resolveLocale(undefined, options.env ?? process.env, context.config.language),
    selfSource: selfSource ? isSelfSourceWriteFloored : () => false });
  const shell = createAgentShell({ worker: true, scope: workspace.scope, context, sessions, scopeId, turnId, config: readTerminalShellConfig(context.config as unknown as Record<string, unknown>),
    channel: { signal, emit() {}, async drained() {}, room: () => context.config.service.responseMaxBytes }, scratch: null, sandboxes, profile: current.profile,
    globalStateRoots: agentGlobalStateRoots([env, process.env]), productState: agentProductStateDeny(request.workspace, context.layout, env), authority,
    selfSource, writeFloor, writeSetRoot: () => sandboxWriteSetRoot(request.workspace, context.layout, env), sealed: sealedRootEntryRefused(request.workspace, sandbox.hardFloor) });
  const tools = [...workspace.specs, ...WORKSPACE_EDIT_TOOL_SPECS, RUN_SHELL_TOOL_SPEC], describe = describeAgentCall;
  const approvals = createAgentCallApprovals({ context, clock, scopeId, turnId, describe });
  const decisions = createAgentCallDecisions({ context, clock, scopeId, turnId, edits: () => edits, shell, approvals, fetch: null, person, origin: { kind: 'run', ceiling: plan } });
  const store = await openSqliteAgentTurnStore(await context.path(), context.config.storage.sqlite, 'forbid');
  const lifetime = nativeWorkerToolLifetime();
  let failure: 'approval-expired' | null = null;
  const ports: AgentTurnPorts = {
    async invokeRound() { throw ErrorRegistry.createError('NATIVE_AGENT_BRIDGE_UNAVAILABLE'); },
    async invokeAgent(input) { lifetime.ready(input.session); await lifetime.finished;
      return { status: 'responded', content: '', reasoning: '', toolCalls: [], finish: 'stop', usage: null }; },
    authorize: (tool, args, call) => decisions.authorize(tool, args, call),
    prepare: async (tool, args) => tool.toolClass === 'shell' || tool.toolClass === 'edit' ? decisions.prepare(tool, args) : Promise.resolve({ ok: true }), describe,
    async requestApproval(input, callSignal) {
      const journal = openSqliteApprovalStore(await context.path(), context.config.storage.sqlite);
      let kept: string | null = null;
      try {
        const integrity = await openLocalIntegrityAuthority(context.layout, context.config.approvals.keyFile, true), policy = await context.policy.load() as { revision: string };
        const started = clock.sample(), { id, issuer, subject: actor } = context.principal;
        const raw = edits.preview(input.tool.name, input.args) ?? shell.previewText(input.tool.name, input.args) ?? chatTurnApprovalPreview(input.tool.name, input.args);
        const preview = await prepareApprovalPreview(redactForRecord(raw, known), async text => kept = await keepFullPreview(context.layout, sha256(`${turnId}\0${input.round}\0${input.index}`), text));
        const record = requestAgentToolApproval(journal.store, integrity, { scopeId, requester: { id, issuer, subject: actor },
          preview: { schemaVersion: 1, argsDigest: input.argsDigest, text: projectModelIngressField(preview.text).modelText, cut: preview.cut },
          subject: approvals.subject(input, input.tool, input.target, input.argsDigest), facts: agentToolApprovalFacts(policy, scopeId, decisions.cell(input.tool, input.args)),
          policyRevision: policy.revision, summary: workerToolCardSummary({ identity: request.identity, turnId, tool: input.tool.name, resource: redactForRecord(input.target ?? '(no target)', known), resourceDigest: sha256(input.target ?? '(no target)'), argsDigest: input.argsDigest }),
          createdAt: started.wallMs, expiresAt: started.wallMs + context.config.approvals.requestTtlMs });
        const outcome = await awaitAgentToolApproval(journal.store, integrity, record, clock, callSignal, undefined, started);
        if (outcome === 'expired' || outcome === 'cancelled' && (!signal.aborted && callSignal.reason?.name === 'TimeoutError' || nativeWorkerApprovalExpired(record.request.expiresAt, started, clock.sample()))) failure = 'approval-expired';
        if (outcome === 'allow') {
          await recheckNativeWorkerUse(root, scopeId, binding, options);
          if (await new AgentToolPolicyAuthorization(context.policy).decide(input.tool, scopeId, context.principal) === 'deny') return 'policy-deny';
          if (nativeWorkerApprovalExpired(record.request.expiresAt, started, clock.sample())) { failure = 'approval-expired'; return 'expired'; }
          approvals.allowed(input, { approvalId: record.request.approvalId, actionDigest: record.request.actionDigest, started });
        }
        return outcome;
      } finally { journal.close(); if (kept) await dropFullPreview(kept); }
    },
    async execute(tool, args, callSignal, callId, execution) {
      await recheckNativeWorkerUse(root, scopeId, binding, options);
      const result = tool.toolClass === 'edit' || tool.toolClass === 'shell'
        ? await decisions.execute(tool, args, execution, callId, (gate, authority, writes, track) => tool.toolClass === 'edit'
          ? edits.apply(tool.name, args, execution, gate) : shell.apply(tool.name, args, callSignal, callId, execution, gate, authority, writes, track))
        : await inputs.read(tool.name, args, callSignal) ?? await workspace.execute(tool.name, args, callSignal);
      return { ...result, text: redactForRecord(result.text, known) };
    }, now: Date.now,
  };
  const turn = runDurableAgentTurn({ claim: { scopeId, turnId, principalKey: `${context.principal.issuer}\0${context.principal.subject}`,
    requestDigest: sha256(JSON.stringify({ identity: request.identity, workspace: workspace.scope.root, binding, tools })), claimedAtMs: Date.now() },
    messages: [], tools, nativeSession: { schemaVersion: 1, turnId, generation, tools, approvalTtlMs: context.config.approvals.requestTtlMs }, signal,
    admission: { outputReserveTokens: 0, safetyReserveTokens: 0, requestMaxBytes: context.config.service.inputMaxBytes }, emit() {} }, store, ports)
    .then(result => { if (!result.recorded || result.replayed) throw ErrorRegistry.createError('NATIVE_WORKER_EFFECTS_UNKNOWN'); return result; })
    .finally(async () => { try { if (!await decisions.flush()) throw ErrorRegistry.createError('NATIVE_WORKER_EFFECTS_UNKNOWN'); } finally { store.close(); } });
  // Cancellation before K1 reaches invokeAgent must not leave an unresolved openTools promise.
  void turn.then(() => lifetime.failed(ErrorRegistry.createError('NATIVE_AGENT_BRIDGE_UNAVAILABLE')), lifetime.failed);
  const session = await lifetime.opened;
  return { session: session.session, terminalFailure: () => failure, propose: async (...args) => {
    if (failure) throw ErrorRegistry.createError('APPROVAL_EXPIRED'); return session.propose(...args); }, cancel: () => lifetime.close(session, turn, 'cancelled'), revoke: () => lifetime.close(session, turn, 'revoked') };
}
