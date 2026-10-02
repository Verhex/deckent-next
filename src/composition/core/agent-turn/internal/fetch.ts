import { EffectError, type AgentToolOutcome, type EffectCommand } from '#domain/index.js';
import { EffectApplication, OperationPolicyAuthorization, agentToolArgumentsDigest, type AgentToolCallCell, type EffectApprovalGate } from '#engine/index.js';
import { SystemTrustedClock } from '#platform/index.js';
import { agentFetchEffectCommandId, createLocalPeerSession, describeFetchApproval, describeFetchRefusal, describeFetchResult, NETWORK_FETCH_OPERATION,
  NETWORK_FETCH_TARGET_KIND, NetworkFetchTarget, openSqliteAttemptStore, planFetchCall, type FetchPlan, type FetchRun, type HttpFetchTransport, type LocalPeerIdentity,
  type ScratchSession, type TerminalFetchConfig } from '#adapters/index.js';
import type { loadPeerInvocationContext } from '#composition/core/model-invocation/index.js';

/**
 * The agent's `fetch_url` in one turn (FETCH S7): wiring only — the plan, verdict, request and texts are the `http-fetch` adapter's. A call is
 * planned before anything is resolved (its cell: `fetch-listed` or `fetch-unlisted`); it runs as a C11 effect of Core `network.fetch` on the
 * `network-fetch` target (session, operation policy again right before the effect, intent before the request, the caller's approval gate),
 * and the body lands in the conversation's scratch area.
 */
export function createAgentFetch(input: { readonly settings: TerminalFetchConfig; readonly transport: HttpFetchTransport; readonly scratch: ScratchSession;
  readonly peer: LocalPeerIdentity; readonly context: Awaited<ReturnType<typeof loadPeerInvocationContext>>; readonly scopeId: string; readonly turnId: string }) {
  const { settings, context, scopeId, turnId } = input, plans = new Map<string, FetchPlan>();
  const key = (args: Record<string, unknown>) => agentToolArgumentsDigest('fetch_url', args);
  const plan = (args: Record<string, unknown>) => { const planned = planFetchCall(settings, args); plans.set(key(args), planned); return planned; };
  return {
    plan,
    cell(args: Record<string, unknown>): AgentToolCallCell | null { const planned = plans.get(key(args)); return planned?.ok ? planned.listed ? 'fetch-listed' : 'fetch-unlisted' : null; },
    preview(args: Record<string, unknown>): string | undefined { const planned = plans.get(key(args)); return planned?.ok ? describeFetchApproval(planned) : undefined; },
    async apply(args: Record<string, unknown>, signal: AbortSignal, execution: { readonly round: number; readonly index: number }, gate: EffectApprovalGate): Promise<AgentToolOutcome> {
      const planned = plans.get(key(args)) ?? plan(args);
      if (!planned.ok) return { status: 'error', text: `[deckent] fetch_url: error=${planned.error}` };
      const commandId = agentFetchEffectCommandId(scopeId, turnId, execution, key(args)), clock = new SystemTrustedClock();
      // Each fetch is its own record, so an uncertain one never makes the next busy.
      const command: EffectCommand = { schemaVersion: 1, commandId, scopeId, operation: NETWORK_FETCH_OPERATION.operation, idempotencyKey: commandId,
        target: { kind: NETWORK_FETCH_TARGET_KIND, id: `fetch-${commandId.slice(0, 32)}` }, input: { url: planned.url, maxBytes: planned.maxBytes }, expectedVersion: null };
      let ran: FetchRun | null = null;
      // A redirect stays inside the allowlist or the host the call named (and, when asked, the owner approved); anything else stops.
      const target = new NetworkFetchTarget({ settings, transport: input.transport, signal, deposit: (rel, data, wait) => input.scratch.deposit(rel, data, wait),
        redirectAllowed: host => host === planned.host || settings.allowedHosts.includes(host), onResult: value => { ran = value; } });
      const sessions = await createLocalPeerSession(input.peer, context.principal.scopeIds, context.config.approvals.sessionTtlMs, clock);
      const store = await openSqliteAttemptStore(await context.path(), context.config.storage.sqlite, { now: Date.now, timeoutMs: context.config.runRuntime.parking.timeoutMs }, 'forbid');
      try {
        await new EffectApplication({ async resolve(ref) { return ref.id === NETWORK_FETCH_OPERATION.operation.id && ref.version === 1 ? NETWORK_FETCH_OPERATION : null; } },
          { resolve: kind => kind === NETWORK_FETCH_TARGET_KIND ? target : null }, store, gate, sessions, new OperationPolicyAuthorization(context.policy), clock).execute(command);
        return ran ? describeFetchResult(ran) : describeFetchRefusal('no-result');
      } catch (error) {
        // A request that ran (refused before sending, or unknown after) reports itself; otherwise nothing was sent.
        return ran ? describeFetchResult(ran) : describeFetchRefusal(error instanceof EffectError ? error.code : (error as { code?: unknown })?.code);
      } finally { store.close(); }
    },
  };
}
