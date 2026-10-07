import { agentToolApprovalFacts } from '#engine/index.js';
import { SystemTrustedClock, t, type ConfigLoadOptions, type Locale } from '#platform/index.js';
import { mcpCardApprovalAsker, openLocalIntegrityAuthority, planMcpProposal, PROPOSE_MCP_SERVER_TOOL, type McpCardAskerInput, type McpProposal } from '#adapters/index.js';
import type { AgentToolOutcome } from '#domain/index.js';
import type { loadPeerInvocationContext } from '#composition/core/model-invocation/index.js';
import { runConfiguredMcpCommand } from './mcp.js';

/** The proposal window's text (L1 item 5): who proposes, name, transport, command or URL, arguments, env and header NAMES, realm and the reason. */
export function describeMcpProposal(proposal: McpProposal, proposer: string, locale: Locale): string {
  const none = t('mcp.proposal.none', {}, locale), names = (values: Readonly<Record<string, string>> | undefined) => Object.keys(values ?? {}).join(', ') || none;
  return [t('mcp.proposal.title', {}, locale), t('mcp.proposal.proposer', { proposer }, locale), t('mcp.proposal.name', { name: proposal.name }, locale),
    t('mcp.proposal.transport', { transport: proposal.transport }, locale),
    ...(proposal.transport === 'http' ? [t('mcp.proposal.url', { url: proposal.url ?? '' }, locale), t('mcp.proposal.headers', { names: names(proposal.headers) }, locale)]
      : [t('mcp.proposal.command', { command: proposal.command ?? '' }, locale), t('mcp.proposal.args', { args: (proposal.args ?? []).join(' ') || none }, locale),
        t('mcp.proposal.env', { names: names(proposal.env) }, locale), t('mcp.proposal.realm', { realm: proposal.realm ?? 'sandbox-net' }, locale)]),
    t('mcp.proposal.reason', { reason: proposal.reason }, locale), t('mcp.proposal.next', {}, locale)].join('\n');
}

/**
 * The turn's `propose_mcp_server` (owner 2026-10-07): the model's proposal is checked, shown in its own approval window — asked in every mode, no
 * permission mode or full access lowers it — and only after the person's yes Deckent adds the server to this project's local registry, untrusted
 * (its trust cards follow on the next message). A no, an expired window or an ended turn writes nothing. The model's result says which.
 */
export function createMcpProposals(input: { readonly projectRoot: string; readonly options: ConfigLoadOptions; readonly context: Awaited<ReturnType<typeof loadPeerInvocationContext>>;
  readonly scopeId: string; readonly turnId: string; readonly signal: AbortSignal; readonly emit: McpCardAskerInput['emit']; readonly proposer: string; readonly locale: Locale;
  /** Tests only: the window's answer (the turn's approval journal otherwise). */ readonly ask?: (text: string, name: string) => Promise<boolean | null> }) {
  const { context, scopeId } = input, tag = (text: string): AgentToolOutcome => ({ status: 'error', text: `[deckent] ${PROPOSE_MCP_SERVER_TOOL}: ${text}` });
  const ask = input.ask ?? (async (text: string, name: string) => {
    const policy = await context.policy.load().catch(() => null);
    return mcpCardApprovalAsker({ ledgerPath: () => context.path(), sqlite: context.config.storage.sqlite, integrity: () => openLocalIntegrityAuthority(context.layout, context.config.approvals.keyFile, true),
      clock: new SystemTrustedClock(), scopeId, turnId: input.turnId, requester: { id: context.principal.id, issuer: context.principal.issuer, subject: context.principal.subject },
      policyRevision: String((policy as { revision?: unknown } | null)?.revision ?? 'unknown'), facts: agentToolApprovalFacts(policy, scopeId, null), ttlMs: context.config.approvals.requestTtlMs,
      signal: input.signal, emit: input.emit }, 2_000_000)({ tool: PROPOSE_MCP_SERVER_TOOL, name, phase: 'proposal', text });
  });
  return {
    owns: (name: string) => name === PROPOSE_MCP_SERVER_TOOL,
    async apply(args: Record<string, unknown>): Promise<AgentToolOutcome> {
      const plan = planMcpProposal(args);
      if (!plan.ok) return tag(`error=${plan.reason}; nothing was proposed`);
      const answer = await ask(describeMcpProposal(plan.proposal, input.proposer, input.locale), plan.proposal.name).catch(() => null);
      if (answer === null) return tag('no answer came; nothing was written');
      if (!answer) return tag('the person declined; nothing was written');
      try {
        await runConfiguredMcpCommand(input.projectRoot, { verb: 'add', scope: 'local', name: plan.proposal.name, entry: plan.entry, approve: false }, input.options, async () => null, input.locale);
      } catch (error) { return tag(`error=${String((error as { code?: unknown })?.code ?? 'failed')}; the person approved, but the server was not added`); }
      return { status: 'ok', text: `[deckent] ${PROPOSE_MCP_SERVER_TOOL}: the person approved; ${plan.proposal.name} was added to this project's local MCP registry, untrusted. `
        + 'Its trust is asked separately on the next message; its tools are offered only after that.' };
    },
  };
}
