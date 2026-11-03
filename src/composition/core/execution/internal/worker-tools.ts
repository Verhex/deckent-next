import { nativeWorkerToolFloor } from './worker-floor.js';
import type { ToolSessionPort } from '#capabilities/index.js';
import { ErrorRegistry, SystemTrustedClock, sha256, redactForRecord, type ConfigLoadOptions } from '#platform/index.js';
import { runDurableAgentTurn, agentToolCallApprovalGate, agentToolArgumentsDigest, requestAgentToolApproval, awaitAgentToolApproval,
  agentToolApprovalFacts, AgentToolPolicyAuthorization, type AgentToolCallAdmission, type AgentTurnPorts } from '#engine/index.js';
import { projectEditArea, WORKSPACE_EDIT_TOOL_SPECS, RUN_SHELL_TOOL_SPEC,
  isSelfSourceWriteFloored, agentProductStateDeny, agentGlobalStateRoots,
  sealedRootEntryRefused, sandboxWriteSetRoot, readTerminalShellConfig,
  LocalOsSessionAuthority, openSqliteAgentTurnStore, openSqliteApprovalStore, openLocalIntegrityAuthority, type NativeCliWorkerPorts } from '#adapters/index.js';
import { createAgentCallDecisions, createAgentFileEdits, createAgentShell } from '#composition/core/agent-turn/index.js';
import { recheckNativeWorkerUse } from '#composition/core/runs/index.js';

type OpenTools = NativeCliWorkerPorts['openTools'];
/** The K1 coordinator owns proposals and durable settlement. The model CLI never receives this workspace. */
export async function openConfiguredNativeWorkerTools(root: string, request: Parameters<OpenTools>[0], binding: Parameters<OpenTools>[1],
  signal: AbortSignal, resources: Parameters<OpenTools>[3], options: ConfigLoadOptions): Promise<ToolSessionPort> {
  const { scopeId, generation } = request.identity, turnId = sha256(JSON.stringify(request.identity));
  const { current, context, env, known, workspace, inputs, authority, selfSource, writeFloor, sandbox, sandboxes } = await nativeWorkerToolFloor(root, request, binding, resources, options);
  const clock = new SystemTrustedClock();
  const sessions = () => LocalOsSessionAuthority.create(context.principal.scopeIds, context.config.approvals.sessionTtlMs, clock);
  const edits = createAgentFileEdits({ area: projectEditArea(workspace.scope), context, sessions, scopeId, turnId, authority,
    selfSource: selfSource ? isSelfSourceWriteFloored : () => false });
  const shell = createAgentShell({ scope: workspace.scope, context, sessions, scopeId, turnId, config: readTerminalShellConfig(context.config as unknown as Record<string, unknown>),
    channel: { signal, emit() {}, async drained() {}, room: () => context.config.service.responseMaxBytes }, scratch: null, sandboxes, profile: current.profile,
    globalStateRoots: agentGlobalStateRoots([env, process.env]), productState: agentProductStateDeny(request.workspace, context.layout, env), authority,
    selfSource, writeFloor, writeSetRoot: () => sandboxWriteSetRoot(request.workspace, context.layout, env), sealed: sealedRootEntryRefused(request.workspace, sandbox.hardFloor) });
  const tools = [...workspace.specs, ...WORKSPACE_EDIT_TOOL_SPECS, RUN_SHELL_TOOL_SPEC], subject = (execution: { round: number; index: number }, tool: { name: string; version: number }, target: string | null, argsDigest: string) =>
    ({ kind: 'agent-tool-call' as const, turnId, round: execution.round, index: execution.index, tool: tool.name, toolVersion: tool.version, resource: target ?? '(no target)', argsDigest });
  const describe: AgentTurnPorts['describe'] = (tool, args) => typeof args[tool.toolClass === 'shell' ? 'command' : 'path'] === 'string'
    ? String(args[tool.toolClass === 'shell' ? 'command' : 'path']).slice(0, 200) : null;
  const allowed = new Map<string, NonNullable<AgentToolCallAdmission['approval']>>(), consumed = new Map<string, string>();
  const approvals = { subject, allowed(execution: { round: number; index: number }, value: NonNullable<AgentToolCallAdmission['approval']>) { allowed.set(`${execution.round}:${execution.index}`, value); },
    gate(tool: Parameters<AgentTurnPorts['authorize']>[0], args: Record<string, unknown>, execution: { round: number; index: number }) {
      const key = `${execution.round}:${execution.index}`, approval = allowed.get(key) ?? null; allowed.delete(key);
      let opened: Promise<{ store: ReturnType<typeof openSqliteApprovalStore>['store']; integrity: Awaited<ReturnType<typeof openLocalIntegrityAuthority>>; close(): void }> | undefined;
      const records = () => opened ??= (async () => {
        const journal = openSqliteApprovalStore(await context.path(), context.config.storage.sqlite);
        try { return { store: journal.store, integrity: await openLocalIntegrityAuthority(context.layout, context.config.approvals.keyFile, false), close: journal.close }; }
        catch (error) { journal.close(); throw error; }
      })();
      const gate = agentToolCallApprovalGate(records, clock, { scopeId, subject: subject(execution, tool, describe(tool, args), agentToolArgumentsDigest(tool.name, args)), approval }, consumed);
      return { gate, approvalId: approval?.approvalId ?? null, async close() { (await opened?.catch(() => null))?.close(); } };
    } };
  const decisions = createAgentCallDecisions({ context, clock, scopeId, turnId, edits: () => edits, shell, approvals, fetch: null });
  const store = await openSqliteAgentTurnStore(await context.path(), context.config.storage.sqlite, 'forbid');
  let finish!: () => void, session!: ToolSessionPort;
  const finished = new Promise<void>(resolve => { finish = resolve; });
  let ready!: (port: ToolSessionPort) => void, failed!: (error: unknown) => void;
  const opened = new Promise<ToolSessionPort>((resolve, reject) => { ready = resolve; failed = reject; });
  const ports: AgentTurnPorts = {
    async invokeRound() { throw ErrorRegistry.createError('NATIVE_AGENT_BRIDGE_UNAVAILABLE'); },
    async invokeAgent(input) { session = input.session; ready(session); await finished;
      return { status: 'responded', content: '', reasoning: '', toolCalls: [], finish: 'stop', usage: null }; },
    authorize: (tool, args, call) => decisions.authorize(tool, args, call),
    prepare: async (tool, args) => tool.toolClass === 'shell' || tool.toolClass === 'edit' ? decisions.prepare(tool, args) : Promise.resolve({ ok: true }), describe,
    async requestApproval(input, callSignal) {
      const journal = openSqliteApprovalStore(await context.path(), context.config.storage.sqlite);
      try {
        const integrity = await openLocalIntegrityAuthority(context.layout, context.config.approvals.keyFile, true), policy = await context.policy.load() as { revision: string };
        const started = clock.sample(), { id, issuer, subject: actor } = context.principal;
        const record = requestAgentToolApproval(journal.store, integrity, { scopeId, requester: { id, issuer, subject: actor },
          subject: subject(input, input.tool, input.target, input.argsDigest), facts: agentToolApprovalFacts(policy, scopeId, decisions.cell(input.tool, input.args)),
          policyRevision: policy.revision, summary: redactForRecord(JSON.stringify({ tool: input.tool.name, arguments: input.args, argsDigest: input.argsDigest }), known),
          createdAt: started.wallMs, expiresAt: started.wallMs + context.config.approvals.requestTtlMs });
        const outcome = await awaitAgentToolApproval(journal.store, integrity, record, clock, callSignal, undefined, started);
        if (outcome === 'allow') {
          await recheckNativeWorkerUse(root, scopeId, binding, options);
          if (await new AgentToolPolicyAuthorization(context.policy).decide(input.tool, scopeId, context.principal) === 'deny') return 'policy-deny';
          approvals.allowed(input, { approvalId: record.request.approvalId, actionDigest: record.request.actionDigest, started });
        }
        return outcome;
      } finally { journal.close(); }
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
  void turn.catch(failed);
  // Cancellation before K1 reaches invokeAgent must not leave an unresolved openTools promise.
  void turn.then(() => failed(ErrorRegistry.createError('NATIVE_AGENT_BRIDGE_UNAVAILABLE')), failed);
  await opened;
  const close = async <K extends 'cancelled' | 'revoked'>(kind: K) => {
    await session.cancel(); finish(); await turn;
    const closure = await session.cancel(); return { ...closure, kind };
  };
  return { session: session.session, propose: (...args) => session.propose(...args), cancel: () => close('cancelled'), revoke: () => close('revoked') };
}
