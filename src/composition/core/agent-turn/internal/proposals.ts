import { isDeepStrictEqual } from 'node:util';
import { AI_PROPOSAL_REGISTRY, type AgentToolOutcome, type AgentToolSpec, type AgentTurnStreamEvent, type BrainPlanCommand, type BrainPlanObserver, type BrainPlanProgress } from '#domain/index.js';
import { AI_PROPOSAL_TOOL_SPECS, aiProposalToolDecision, awaitAgentToolApproval, isRunIntentResult, planAiProposal, verifyApproval, type RunPlanningResult } from '#engine/index.js';
import { openLocalIntegrityAuthority, openSqliteApprovalStore, withMcpPrincipal, type LocalPeerIdentity } from '#adapters/index.js';
import { CodedError, sha256, SystemTrustedClock, t, type ConfigLoadOptions, type Locale } from '#platform/index.js';
import { createConfiguredConfigApplication, resolveConfiguredConfigPrincipal } from '#composition/core/config/index.js';
import { loadPeerInvocationContext } from '#composition/core/model-invocation/index.js';

type Emit = (event: Extract<AgentTurnStreamEvent, { kind: 'approval.requested' | 'approval.settled' | 'work' }>) => void;
type Plan = (command: BrainPlanCommand, signal: AbortSignal, observe: BrainPlanObserver) => Promise<RunPlanningResult>;
/** The card and choice presentation the CLI host lends the service (composition never imports surfaces; the SDK entry stays surface-free). */
export interface AgentProposalViews { readonly cardLines: (result: RunPlanningResult, locale: Locale) => readonly string[]; readonly schemaChoices: (schema: unknown) => readonly unknown[] }
const CARD_ROUNDS = 3; // L1c, as /do: a plan whose basis changed while its card was open comes back with a fresh card, at most this often.
const said = { deny: 'the person declined; nothing was changed', expired: 'the card expired unanswered; nothing was changed', cancelled: 'the turn ended before the person answered; nothing was changed' } as const;
const codeOf = (error: unknown) => String((error as { code?: unknown } | null)?.code ?? 'failed');

/**
 * alpha.64 B + C (owner S4/S5/S6 2026-11-09): the chat turn's `propose_work`, `propose_setting` and `list_setting_choices`. Every decision and
 * application call of these tools runs as the AI actor (`withMcpPrincipal`), in the API loop too, whose turn principal is the person: the v20
 * `require-approval` rules then open the very card `/do` (Run create) or `/config` (config-change) opens, in every mode; the card goes to the
 * person on this turn's stream (the turn mints the decision capability for the person, never for the AI), and only the AI's same command
 * submitted again after the person's yes has an effect. A no, an expired card or an ended turn changes nothing; the model reads which.
 */
export function createAgentProposals(input: { readonly projectRoot: string; readonly options: ConfigLoadOptions; readonly peer: LocalPeerIdentity; readonly scopeId: string;
  readonly turnId: string; readonly signal: AbortSignal; readonly emit: Emit; readonly locale: Locale; /** Absent (no service plan port): `propose_work` is not offered. */ readonly plan?: Plan; /** Absent: the proposal tools answer unavailable. */ readonly views?: () => Promise<AgentProposalViews> }) {
  const { projectRoot, options, peer, scopeId, signal } = input;
  const ai = () => withMcpPrincipal(() => loadPeerInvocationContext(projectRoot, scopeId, options, peer, 'write'));
  const tag = (tool: string, text: string): AgentToolOutcome => ({ status: 'error', text: `[deckent] ${tool}: ${text}` });
  const origin = t('agent.proposal.origin', {}, input.locale);
  /** One pending approval the AI's request opened: on this turn's stream, awaited, always settled once requested. */
  async function card(callId: string, approvalId: string, preview: string): Promise<'allow' | 'deny' | 'expired' | 'cancelled'> {
    const context = await ai(), integrity = await openLocalIntegrityAuthority(context.layout, context.config.approvals.keyFile, true);
    const journal = openSqliteApprovalStore(await context.path(), context.config.storage.sqlite);
    let outcome: 'allow' | 'deny' | 'expired' | 'cancelled' | 'unsettled' = 'unsettled', requested = false;
    try {
      const loaded = journal.store.load(scopeId, approvalId);
      if (!loaded) return 'expired';
      const record = verifyApproval(loaded, integrity);
      input.emit({ kind: 'approval.requested', callId, approvalId, revision: record.revision, summary: record.request.summary, preview, expiresAt: record.request.expiresAt });
      requested = true;
      return outcome = await awaitAgentToolApproval(journal.store, integrity, record, new SystemTrustedClock(), signal, 250);
    } finally { journal.close(); if (requested) input.emit({ kind: 'approval.settled', callId, approvalId, outcome }); }
  }
  async function choices(keyPath: string, layer: 'project' | 'global') {
    const views = await input.views?.(); if (!views) throw new CodedError('AGENT_PROPOSAL_VIEWS_UNAVAILABLE');
    const field = (await createConfiguredConfigApplication(projectRoot, options).inspect({ keyPath, layer })).fields[0]!;
    return { keyPath, layer, current: field.value ?? null, choices: views.schemaChoices(field.schema) };
  }
  async function work(name: string, request: string, callId: string): Promise<AgentToolOutcome> {
    const command: BrainPlanCommand = { schemaVersion: 1, commandId: `propose-work-${sha256(`propose-work:1\0${scopeId}\0${input.turnId}\0${callId}`).slice(0, 40)}`, scopeId, intent: request };
    // v31 (/do parity): the plan's progress reaches the person's terminal as `/do` shows it (planning, a Brain quota wait, the admitted Run for /tasks).
    const progress = (value: BrainPlanProgress) => { if (value.kind === 'planning') input.emit({ kind: 'work', callId, phase: 'planning', attempt: value.attempt });
      else if (value.kind === 'quota-wait') input.emit({ kind: 'work', callId, phase: 'quota-wait', untilMs: value.untilMs, attempt: value.attempt, maxAttempts: value.maxAttempts }); };
    const views = await input.views?.(); if (!views) return tag('propose_work', 'unavailable');
    const plan = () => withMcpPrincipal(() => input.plan!(command, signal, progress));
    progress({ kind: 'planning', attempt: 1 });
    let result = await plan();
    for (let round = 0; round < CARD_ROUNDS && !isRunIntentResult(result) && result.proposal.status === 'pending' && result.proposal.approval; round++) {
      const settled = await card(callId, result.proposal.approval.approvalId, [origin, ...views.cardLines(result, input.locale)].join('\n'));
      if (settled !== 'allow') return tag(name, said[settled]);
      result = await plan();
    }
    if (result.run) {
      input.emit({ kind: 'work', callId, phase: 'admitted', runId: result.run.runId });
      return { status: 'ok', text: `[deckent] ${name}: the person approved; Run ${result.run.runId} was admitted and is listed in /tasks.` };
    }
    const reason = isRunIntentResult(result) ? 'work-parked' : result.proposal.reason ?? result.proposal.status;
    return tag(name, `error=${reason}; no Run was admitted (the person can start the work with /do)`);
  }
  async function setting(name: string, keyPath: string, choice: unknown, layer: 'project' | 'global', callId: string): Promise<AgentToolOutcome> {
    const listed = await choices(keyPath, layer);
    if (!listed.choices.some(value => isDeepStrictEqual(value, choice))) return tag(name, `error=choice-not-listed; choose one of ${JSON.stringify(listed.choices)}; nothing was proposed`);
    const app = createConfiguredConfigApplication(projectRoot, options), principal = await withMcpPrincipal(() => resolveConfiguredConfigPrincipal(projectRoot, scopeId, options));
    const write = { keyPath, value: choice, layer, principal, scopeId, commandId: `propose-setting-${sha256(`propose-setting:1\0${scopeId}\0${input.turnId}\0${callId}`).slice(0, 40)}` };
    let outcome = await withMcpPrincipal(() => app.submit('set', write));
    if (outcome.status === 'approval-pending') {
      const settled = await card(callId, outcome.approval.approvalId, origin);
      if (settled !== 'allow') return tag(name, said[settled]);
      const expect = outcome.expect;
      outcome = await withMcpPrincipal(() => app.submit('set', { ...write, ...(expect === null ? {} : { expect }) }));
    }
    return outcome.status === 'applied' ? { status: 'ok', text: `[deckent] ${name}: the person approved; ${keyPath} is now ${JSON.stringify(choice)} on the ${outcome.result.layer} layer.` }
      : tag(name, 'error=approval-pending; nothing was changed');
  }
  return {
    owns: (name: string) => AI_PROPOSAL_TOOL_SPECS.some(spec => spec.name === name) && (input.plan !== undefined || name !== AI_PROPOSAL_REGISTRY.tools.work),
    /** Offered, and each call authorized, for the AI actor while its v20 rule holds: revoking or denying it stops the proposals (fail closed). */
    async authorize(tool: AgentToolSpec): Promise<{ readonly decision: 'allow' | 'deny'; readonly revision: string }> {
      const context = await ai().catch(() => null), policy = context ? await context.policy.load().catch(() => null) : null;
      return context && policy ? aiProposalToolDecision(policy, context.principal, scopeId, tool.name) : { decision: 'deny', revision: 'unknown' };
    },
    async offered(): Promise<readonly AgentToolSpec[]> {
      const offered: AgentToolSpec[] = [];
      for (const spec of AI_PROPOSAL_TOOL_SPECS) if ((input.plan || spec.name !== AI_PROPOSAL_REGISTRY.tools.work) && (await this.authorize(spec)).decision === 'allow') offered.push(spec);
      return offered;
    },
    async apply(name: string, args: Record<string, unknown>, callId: string): Promise<AgentToolOutcome> {
      const planned = planAiProposal(name, args);
      if (!planned.ok) return { status: 'error', text: planned.text };
      try {
        if (planned.tool === 'choices') return { status: 'ok', text: JSON.stringify(await choices(planned.keyPath, 'project')) };
        return planned.tool === 'work' ? await work(name, planned.request, callId) : await setting(name, planned.keyPath, planned.choice, planned.layer, callId);
      } catch (error) { return tag(name, `error=${codeOf(error)}; nothing was changed`); }
    },
  };
}
