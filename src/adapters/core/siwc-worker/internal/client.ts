import { SIWC_WORKER_RELAY as R } from '#adapters/core/provider-siwc/index.js';

/** One native approval the app-server asks for before an effect (command or file change), bound to the live thread/turn/item. */
export type SiwcNativeApproval = Readonly<{ kind: 'command' | 'file-change'; threadId: string; turnId: string; itemId: string; cwd: string | null }>;
/** U9-6c: a turn's settled result. Only `completed` is success; a capability or upstream auth failure is never replayed here. */
export type SiwcTurnOutcome = Readonly<{ status: 'completed' | 'failed' | 'interrupted' | 'refused' | 'lost';
  reason: 'capability' | 'upstream' | 'protocol' | 'cancelled' | null; approvals: Readonly<{ accepted: number; declined: number }>; refusedRequests: number }>;
type Message = Record<string, unknown> & { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: unknown };
const object = (value: unknown) => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : null;

/**
 * U9-6c: the host-side JSON-RPC client of the worker's app-server (over the bootstrap's control channel). It sends only the registry's
 * client methods (initialize → thread/start → turn/start, turn/interrupt), maps command/file approvals to `approve` (the current Deckent
 * decision, asked per item, before the effect) and refuses every other server request (permission expansion, user input, dynamic tools,
 * elicitation). Never `thread/shellCommand`, process or account methods.
 */
export function createAppServerTurn(input: { readonly send: (message: Message) => void; readonly prompt: string; readonly model: string; readonly version: string;
  readonly approve: (request: SiwcNativeApproval) => Promise<boolean> }) {
  let next = 0, threadId: string | null = null, turnId: string | null = null, settled = false, interruptRequested = false;
  const approvals = { accepted: 0, declined: 0 }; let refusedRequests = 0;
  const pending = new Map<number, (message: Message) => void>();
  let settle!: (outcome: SiwcTurnOutcome) => void;
  const outcome = new Promise<SiwcTurnOutcome>(resolve => { settle = resolve; });
  const finish = (status: SiwcTurnOutcome['status'], reason: SiwcTurnOutcome['reason']) => {
    if (settled) return; settled = true; settle(Object.freeze({ status, reason, approvals: Object.freeze({ ...approvals }), refusedRequests }));
  };
  const call = (method: string, params: Record<string, unknown>, then: (message: Message) => void) => {
    if (!R.methods.client.includes(method)) throw new Error('SIWC_APP_SERVER_METHOD_REFUSED');
    const id = ++next; pending.set(id, then); input.send({ jsonrpc: '2.0', id, method, params });
  };
  const failed = (message: Message) => { if (message.error !== undefined) { finish('failed', 'protocol'); return true; } return false; };
  const authFailure = (error: unknown) => { const info = object(object(error)['codexErrorInfo']); const status = Object.values(info).map(object).find(row => 'httpStatusCode' in row)?.['httpStatusCode'];
    return 'Unauthorized' in info || info['type'] === 'Unauthorized' || status === 401 || status === 403; };
  const start = () => call('initialize', { clientInfo: { name: R.appName, title: R.appName, version: input.version } }, message => {
    if (failed(message)) return;
    input.send({ jsonrpc: '2.0', method: 'initialized', params: {} });
    call('thread/start', { model: input.model, cwd: '/workspace', approvalPolicy: R.approvalPolicy, sandbox: R.sandbox }, started => {
      if (failed(started)) return;
      threadId = text(object(object(started.result)['thread'])['id']);
      if (!threadId) { finish('failed', 'protocol'); return; }
      call('turn/start', { threadId, input: [{ type: 'text', text: input.prompt }] }, turned => { if (failed(turned)) return; turnId ??= text(object(object(turned.result)['turn'])['id']); });
    });
  });
  const answer = async (message: Message) => {
    const params = object(message.params), method = message.method as string;
    const bound = threadId !== null && params['threadId'] === threadId && (turnId === null || params['turnId'] === turnId) && text(params['itemId']) !== null;
    if (!R.methods.approvals.includes(method) || !bound || settled || interruptRequested) {
      refusedRequests++; input.send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'refused' } }); return;
    }
    let accepted: boolean;
    try { accepted = await input.approve(Object.freeze({ kind: method.includes('fileChange') ? 'file-change' : 'command', threadId: threadId!, turnId: String(params['turnId']),
      itemId: String(params['itemId']), cwd: text(params['cwd']) })); } catch { accepted = false; }
    if (accepted && !settled && !interruptRequested) approvals.accepted++; else { accepted = false; approvals.declined++; }
    input.send({ jsonrpc: '2.0', id: message.id, result: { decision: accepted ? 'accept' : 'decline' } });
  };
  return Object.freeze({
    outcome, start,
    /** One parsed app-server line. Unknown notifications are ignored; their content is never retained. */
    receive(message: Message) {
      if (typeof message.method === 'string' && message.id !== undefined) { void answer(message); return; }
      if (typeof message.id === 'number' && !message.method) { const then = pending.get(message.id); pending.delete(message.id); then?.(message); return; }
      const params = object(message.params);
      if (message.method === 'turn/started') turnId ??= text(object(params['turn'])['id']);
      else if (message.method === 'turn/completed') {
        const turn = object(params['turn']), status = turn['status'];
        if (status === 'completed') finish('completed', null);
        else if (status === 'interrupted') finish('interrupted', 'cancelled');
        else finish('failed', authFailure(turn['error']) ? 'capability' : 'upstream');
      }
    },
    /** Revocation path: ask for `turn/interrupt` once (when a turn is known); the caller bounds the drain and then kills the worker. */
    interrupt() { if (settled || interruptRequested) return; interruptRequested = true;
      if (threadId && turnId) call('turn/interrupt', { threadId, turnId }, () => undefined); },
    /** The control channel ended: an unsettled turn is lost (never success). */
    lost() { finish('lost', interruptRequested ? 'cancelled' : 'protocol'); },
  });
}
