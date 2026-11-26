import { isDeepStrictEqual } from 'node:util';
import type { ToolErrorClass } from '#capabilities/index.js';
import { AI_PROPOSAL_REGISTRY, agentTurnStreamEventSchema, type AgentToolOutcome, type AgentToolSpec, type AgentTurnStreamEvent, type BrainPlanCommand, type BrainPlanObserver, type BrainPlanProgress } from '#domain/index.js';
import { AI_PROPOSAL_TOOL_SPECS, agentToolResult, aiProposalToolDecision, awaitAgentToolApproval, isRunIntentResult, planAiProposal, verifyApproval, type RunPackageCardCheck, type RunPlanningResult } from '#engine/index.js';
import { openLocalIntegrityAuthority, openSqliteApprovalStore, withMcpPrincipal, type LocalPeerIdentity } from '#adapters/index.js';
import { CodedError, ErrorRegistry, sha256, SystemTrustedClock, t, type ConfigLoadOptions, type Locale } from '#platform/index.js';
import { createConfiguredConfigApplication, resolveConfiguredConfigPrincipal } from '#composition/core/config/index.js';
import { loadPeerInvocationContext } from '#composition/core/model-invocation/index.js';
import type { createChatSameTurnPlanning } from './same-turn.js';

type ApprovalCard = Extract<AgentTurnStreamEvent, { kind: 'approval.requested' }>;
type Emit = (event: Extract<AgentTurnStreamEvent, { kind: 'approval.requested' | 'approval.settled' | 'work' | 'text' }>) => void;
type Plan = (command: BrainPlanCommand, signal: AbortSignal, observe: BrainPlanObserver, checkPackageCard: RunPackageCardCheck) => Promise<RunPlanningResult>;
type SameTurnProposal = Pick<NonNullable<ReturnType<typeof createChatSameTurnPlanning>>, 'prepare' | 'finalize' | 'admit' | 'callId' | 'invocationId' | 'chosenBrain'>;
/** The card and choice presentation the CLI host lends the service (composition never imports surfaces; the SDK entry stays surface-free). */
export interface AgentProposalViews {
  readonly cardLines: (result: RunPlanningResult, locale: Locale, pool?: undefined,
    sameTurn?: Readonly<{ invocationId: string; chosenBrain: string | null }>) => readonly string[];
  readonly schemaChoices: (schema: unknown) => readonly unknown[];
}
const said = { deny: 'the person declined; nothing was changed', expired: 'the card expired unanswered; nothing was changed', cancelled: 'the turn ended before the person answered; nothing was changed' } as const;
const codeOf = (error: unknown) => String((error as { code?: unknown } | null)?.code ?? 'failed');
const packageChatRefusal = (code: string) => code === 'CHAT_PACKAGE_APPROVAL_CARD_TOO_LARGE' || code === 'NATIVE_WORKER_PACKAGE_REVIEW_OVER_LIMIT';

/**
 * alpha.64 B + C (owner S4/S5/S6 2026-11-09): the chat turn's `propose_work`, `propose_setting` and `list_setting_choices`. Every decision and
 * application call of these tools runs as the AI actor (`withMcpPrincipal`), in the API loop too, whose turn principal is the person. The
 * proposal application requires the very card `/do` (Run create) or `/config` (config-change) opens, regardless of grants or mode; it goes to the
 * person on this turn's stream (the turn mints the decision capability for the person, never for the AI), and only the AI's same command
 * submitted again after the person's yes has an effect. A no, an expired card or an ended turn changes nothing; the model reads which.
 */
export function createAgentProposals(input: { readonly projectRoot: string; readonly options: ConfigLoadOptions; readonly peer: LocalPeerIdentity; readonly scopeId: string;
  readonly turnId: string; readonly signal: AbortSignal; readonly emit: Emit; readonly locale: Locale; /** Absent (no service plan port): `propose_work` is not offered. */ readonly plan?: Plan;
  readonly sameTurn?: SameTurnProposal | null; /** Absent: the proposal tools answer unavailable. */ readonly views?: () => Promise<AgentProposalViews> }) {
  const { projectRoot, options, peer, scopeId, signal } = input;
  const ai = () => withMcpPrincipal(() => loadPeerInvocationContext(projectRoot, scopeId, options, peer, 'write'));
  const tag = (tool: string, text: string, kind: ToolErrorClass = 'ordinary'): AgentToolOutcome => agentToolResult({ status: 'error' as const, text: `[deckent] ${tool}: ${text}` }, kind);
  const origin = t('agent.proposal.origin', {}, input.locale);
  const refusal = (code: string) => ErrorRegistry.createError(code, { locale: input.locale });
  const showRefusal = (name: string, code: string) => {
    const { message } = refusal(code);
    input.emit({ kind: 'text', text: message });
    return tag(name, message);
  };
  function assertPackageCard(event: ApprovalCard) {
    const parsed = agentTurnStreamEventSchema.safeParse(event);
    if (parsed.success) return;
    if (parsed.error.issues.some(issue => issue.code === 'too_big' && issue.path[0] === 'preview'))
      throw refusal('CHAT_PACKAGE_APPROVAL_CARD_TOO_LARGE');
    throw refusal('NATIVE_WORKER_DEPENDENCIES_REFUSED');
  }
  function planCard(callId: string, views: AgentProposalViews, sameTurn?: Readonly<{ invocationId: string; chosenBrain: string | null }>) {
    const render = (result: RunPlanningResult) => [origin, ...views.cardLines(result, input.locale, undefined, sameTurn)].join('\n');
    let checked: string | undefined;
    return {
      check(result: RunPlanningResult, { summary, review }: Parameters<RunPackageCardCheck>[1]) {
        signal.throwIfAborted();
        const preview = checked ?? render(result);
        // The broker supplies a UUID, non-negative revision and expiry. Check the actual call id and text now.
        assertPackageCard({ kind: 'approval.requested', callId, approvalId: 'pending', revision: 0, expiresAt: 0,
          summary, preview: `${preview}\n${review}` });
        checked = preview;
      },
      preview(result: RunPlanningResult) { return checked ?? render(result); },
    };
  }
  /** One pending approval the AI's request opened: on this turn's stream, awaited, always settled once requested. */
  async function card(callId: string, approvalId: string, preview: string) {
    const context = await ai(), integrity = await openLocalIntegrityAuthority(context.layout, context.config.approvals.keyFile, true);
    const journal = openSqliteApprovalStore(await context.path(), context.config.storage.sqlite);
    let outcome: 'allow' | 'deny' | 'expired' | 'cancelled' | 'unsettled' = 'unsettled', requested = false;
    try {
      const loaded = journal.store.load(scopeId, approvalId);
      if (!loaded) return { answer: 'expired' as const, kind: 'uncertain' as const };
      const record = verifyApproval(loaded, integrity);
      const { request } = record;
      const packages = request.schemaVersion === 3 && request.subject.kind === 'run-create' ? request.preview : undefined;
      const event = { kind: 'approval.requested' as const, callId, approvalId, revision: record.revision, summary: request.summary,
        preview: packages ? `${preview}\n${packages.text}` : preview, expiresAt: request.expiresAt };
      // A previously stored record still needs verification before the person's decision capability is minted.
      if (packages?.cut) throw refusal('NATIVE_WORKER_DEPENDENCIES_REFUSED');
      if (packages) assertPackageCard(event);
      input.emit(event);
      requested = true;
      let kind: ToolErrorClass = 'uncertain';
      outcome = await awaitAgentToolApproval(journal.store, integrity, record, new SystemTrustedClock(), signal, 250, undefined, terminal => {
        if (terminal.request.approvalId === approvalId && terminal.request.actionDigest === record.request.actionDigest
          && terminal.request.scopeId === scopeId) kind = 'ordinary';
      });
      return { answer: outcome, kind: outcome === 'cancelled' ? 'cancelled' as const : kind };
    } finally { journal.close(); if (requested) input.emit({ kind: 'approval.settled', callId, approvalId, outcome }); }
  }
  async function choices(keyPath: string, layer: 'project' | 'global') {
    const views = await input.views?.(); if (!views) throw new CodedError('AGENT_PROPOSAL_VIEWS_UNAVAILABLE');
    const field = (await createConfiguredConfigApplication(projectRoot, options).inspect({ keyPath, layer })).fields[0]!;
    return { keyPath, layer, current: field.value ?? null, choices: views.schemaChoices(field.schema) };
  }
  const workCommandId = (callId: string) => `propose-work-${sha256(`propose-work:1\0${scopeId}\0${input.turnId}\0${callId}`).slice(0, 40)}`;
  async function work(name: string, request: string, callId: string, args: Record<string, unknown>): Promise<AgentToolOutcome> {
    const command: BrainPlanCommand = { schemaVersion: 1, commandId: workCommandId(callId), scopeId, intent: request };
    // v31 (/do parity): the plan's progress reaches the person's terminal as `/do` shows it (planning, a Brain quota wait, the admitted Run for /tasks).
    const progress = (value: BrainPlanProgress) => { if (value.kind === 'planning') input.emit({ kind: 'work', callId, phase: 'planning', attempt: value.attempt });
      else if (value.kind === 'quota-wait') input.emit({ kind: 'work', callId, phase: 'quota-wait', untilMs: value.untilMs, attempt: value.attempt, maxAttempts: value.maxAttempts }); };
    const views = await input.views?.(); if (!views) return tag('propose_work', 'unavailable');
    if (input.sameTurn) {
      progress({ kind: 'planning', attempt: 1 });
      return input.sameTurn.prepare(command, args, callId, name);
    }
    const presentation = planCard(callId, views);
    const plan = () => withMcpPrincipal(() => input.plan!(command, signal, progress, presentation.check));
    progress({ kind: 'planning', attempt: 1 });
    let result = await plan();
    for (let round = 0; round < AI_PROPOSAL_REGISTRY.maxCardRounds && !isRunIntentResult(result) && result.proposal.status === 'pending' && result.proposal.approval; round++) {
      const settled = await card(callId, result.proposal.approval.approvalId, presentation.preview(result));
      if (settled.answer !== 'allow') return tag(name, said[settled.answer], settled.kind);
      result = await plan();
    }
    if (result.run) {
      input.emit({ kind: 'work', callId, phase: 'admitted', runId: result.run.runId });
      return { status: 'ok', text: `[deckent] ${name}: Run ${result.run.runId} was admitted and is listed in /tasks.` };
    }
    // The durable proposal can contain any registered failure. Only known business refusal codes are ordinary.
    const reason = isRunIntentResult(result) ? 'work-parked' : result.proposal.reason ?? result.proposal.status;
    if (packageChatRefusal(reason)) return showRefusal(name, reason);
    let kind: ToolErrorClass = 'uncertain';
    switch (reason) {
      case 'RUN_PROPOSAL_BUDGET_EXCEEDED': kind = 'limit'; break;
      case 'RUN_PROPOSAL_SOURCE_INVALID': case 'RUN_PROPOSAL_ACTOR_MISMATCH': case 'RUN_PROPOSAL_BUDGET_SCOPE':
      case 'APPROVAL_CONFLICT': case 'APPROVAL_STALE': kind = 'session'; break;
      case 'work-parked': case 'RUN_PROPOSAL_GRAPH_INVALID': case 'RUN_PROPOSAL_WORK_CLASS_REQUIRED':
      case 'RUN_PROPOSAL_BASIS_STALE': case 'RUN_PROPOSAL_BUDGET_MISSING': case 'RUN_PROPOSAL_BUDGET_CURRENCY':
      case 'RUN_PROPOSAL_PERMISSION_UNKNOWN': case 'RUN_APPROVAL_REQUIRED': kind = 'ordinary'; break;
    }
    return tag(name, `error=${reason}; no Run was admitted (the person can start the work with /do)`, kind);
  }
  async function completeSameTurn(parentSignal: AbortSignal) {
    const turn = input.sameTurn!;
    const { callId, invocationId, chosenBrain } = turn;
    if (!callId || !invocationId) throw new CodedError('BRAIN_SAME_TURN_REFUSED');
    const views = await input.views?.();
    const presentation = views && planCard(callId, views, { invocationId, chosenBrain });
    let result = await turn.finalize(parentSignal, presentation?.check);
    if (!result.run) {
      parentSignal.throwIfAborted();
      if (result.proposal.reason && packageChatRefusal(result.proposal.reason)) throw refusal(result.proposal.reason);
      if (!presentation || result.proposal.status !== 'pending' || !result.proposal.approval) throw new CodedError('BRAIN_SAME_TURN_REFUSED');
      const { answer: decision } = await card(callId, result.proposal.approval.approvalId, presentation.preview(result));
      if (decision === 'deny') return t('brain.sameTurn.declined', {}, input.locale);
      if (decision !== 'allow') throw new CodedError('BRAIN_SAME_TURN_REFUSED');
      parentSignal.throwIfAborted();
      result = await turn.admit();
      if (!result.run) throw new CodedError('BRAIN_SAME_TURN_REFUSED');
    }
    input.emit({ kind: 'work', callId, phase: 'admitted', runId: result.run.runId });
    return t('brain.sameTurn.admitted', {}, input.locale);
  }
  async function finishSameTurn(parentSignal: AbortSignal) {
    try { return await completeSameTurn(parentSignal); }
    catch (error) {
      const callId = input.sameTurn?.callId;
      if (callId && codeOf(error) === 'RUN_PROPOSAL_OUTCOME_UNKNOWN')
        throw new CodedError('RUN_PROPOSAL_OUTCOME_UNKNOWN', { params: { commandId: workCommandId(callId) } });
      throw error;
    }
  }
  async function setting(name: string, keyPath: string, choice: unknown, layer: 'project' | 'global', callId: string): Promise<AgentToolOutcome> {
    const listed = await choices(keyPath, layer);
    if (!listed.choices.some(value => isDeepStrictEqual(value, choice))) return tag(name, `error=choice-not-listed; choose one of ${JSON.stringify(listed.choices)}; nothing was proposed`);
    const app = createConfiguredConfigApplication(projectRoot, options), principal = await withMcpPrincipal(() => resolveConfiguredConfigPrincipal(projectRoot, scopeId, options));
    const write = { keyPath, value: choice, layer, principal, scopeId, commandId: `propose-setting-${sha256(`propose-setting:1\0${scopeId}\0${input.turnId}\0${callId}`).slice(0, 40)}` };
    let outcome = await withMcpPrincipal(() => app.propose(write));
    if (outcome.status === 'approval-pending') {
      const settled = await card(callId, outcome.approval.approvalId, origin);
      if (settled.answer !== 'allow') return tag(name, said[settled.answer], settled.kind);
      const expect = outcome.expect;
      outcome = await withMcpPrincipal(() => app.propose({ ...write, ...(expect === null ? {} : { expect }) }));
    }
    return outcome.status === 'applied' ? { status: 'ok', text: `[deckent] ${name}: ${keyPath} is now ${JSON.stringify(choice)} on the ${outcome.result.layer} layer.` }
      : tag(name, 'error=approval-pending; nothing was changed');
  }
  return {
    finishSameTurn,
    owns: (name: string) => AI_PROPOSAL_TOOL_SPECS.some(spec => spec.name === name) && (!!(input.plan || input.sameTurn) || name !== AI_PROPOSAL_REGISTRY.tools.work),
    /** Offered, and each call authorized, for the AI actor while its v20 rule holds: revoking or denying it stops the proposals (fail closed). */
    async authorize(tool: AgentToolSpec): Promise<{ readonly decision: 'allow' | 'deny'; readonly revision: string }> {
      const context = await ai().catch(() => null), policy = context ? await context.policy.load().catch(() => null) : null;
      return context && policy ? aiProposalToolDecision(policy, context.principal, scopeId, tool.name) : { decision: 'deny', revision: 'unknown' };
    },
    async offered(): Promise<readonly AgentToolSpec[]> {
      const offered: AgentToolSpec[] = [];
      for (const spec of AI_PROPOSAL_TOOL_SPECS) if (this.owns(spec.name) && (await this.authorize(spec)).decision === 'allow') offered.push(spec);
      return offered;
    },
    async apply(name: string, args: Record<string, unknown>, callId: string): Promise<AgentToolOutcome> {
      const planned = planAiProposal(name, args);
      if (!planned.ok) return agentToolResult({ status: 'error' as const, text: planned.text }, planned);
      try {
        if (planned.tool === 'choices') return { status: 'ok', text: JSON.stringify(await choices(planned.keyPath, 'project')) };
        return planned.tool === 'work' ? await work(name, planned.request, callId, args) : await setting(name, planned.keyPath, planned.choice, planned.layer, callId);
      } catch (error) {
        const code = codeOf(error);
        if (planned.tool === 'work') {
          if (packageChatRefusal(code)) return showRefusal(name, code);
          const detail = code === 'RUN_PROPOSAL_OUTCOME_UNKNOWN' ? t('error.RUN_PROPOSAL_OUTCOME_UNKNOWN', {}, input.locale) : '';
          return tag(name, [`error=${code}`, detail, t('cli.do.command', { command: workCommandId(callId) }, input.locale)].filter(Boolean).join(' '), 'uncertain');
        }
        return tag(name, `error=${code}; nothing was changed`, 'uncertain');
      }
    },
  };
}
