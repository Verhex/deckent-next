import { posix } from 'node:path';
import { SIWC_WORKER_RELAY as R } from '#adapters/core/provider-siwc/index.js';

/** One native approval the app-server asks for before an effect (command or file change), bound to the live thread/turn/item. */
export type SiwcNativeApproval = Readonly<{ kind: 'command' | 'file-change'; threadId: string; turnId: string; itemId: string; cwd: string;
  /** Exact command text (command approvals), bounded by registry `approvalCommandBytes`. */
  command: string | null;
  /** Exact file-change targets (normalized, inside /workspace) and diffs (file-change approvals), bounded by registry counts/bytes. */
  changes: readonly Readonly<{ path: string; kind: string; diff: string }>[] }>;
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
    // Approval policy and sandbox come from the launch's `-c` config overrides (registry); the wire call names only model and cwd.
    call('thread/start', { model: input.model, cwd: '/workspace' }, started => {
      if (failed(started)) return;
      threadId = text(object(object(started.result)['thread'])['id']);
      if (!threadId) { finish('failed', 'protocol'); return; }
      call('turn/start', { threadId, input: [{ type: 'text', text: input.prompt }] }, turned => { if (failed(turned)) return; turnId ??= text(object(object(turned.result)['turn'])['id']); });
    });
  });
  const items = new Map<string, Record<string, unknown>>();
  /** The approved action's exact content from the item the app-server announced (`item/started`), validated and bounded; null = refuse. */
  const content = (kind: SiwcNativeApproval['kind'], params: Record<string, unknown>) => {
    const item = items.get(String(params['itemId'])), L = R.limits;
    const inside = (path: unknown) => typeof path === 'string' && path.length > 0 && !path.includes('\0')
      && (posix.normalize(posix.resolve('/workspace', path)) + '/').startsWith('/workspace/') ? posix.normalize(posix.resolve('/workspace', path)) : null;
    const cwd = params['cwd'] === undefined || params['cwd'] === null ? item?.['cwd'] ?? '/workspace' : params['cwd'];
    if (!inside(cwd)) return null;
    if (kind === 'command') {
      const announced = item?.['type'] === 'commandExecution' ? item['command'] : undefined, command = announced ?? params['command'];
      if (item && item['type'] !== 'commandExecution' || typeof command !== 'string' || !command || Buffer.byteLength(command) > L.approvalCommandBytes
        || announced !== undefined && params['command'] !== undefined && params['command'] !== announced) return null;
      return { cwd: inside(cwd)!, command, changes: [] as SiwcNativeApproval['changes'] };
    }
    const raw = item?.['type'] === 'fileChange' ? item['changes'] : undefined;
    if (!Array.isArray(raw) || !raw.length || raw.length > L.approvalChanges) return null;
    const changes = raw.map(row => { const change = object(row), path = inside(change['path']);
      return path && typeof change['kind'] === 'string' && typeof (change['diff'] ?? '') === 'string' ? Object.freeze({ path, kind: change['kind'], diff: String(change['diff'] ?? '') }) : null; });
    if (changes.some(change => change === null) || changes.reduce((sum, change) => sum + Buffer.byteLength(change!.diff), 0) > L.approvalDiffBytes) return null;
    return { cwd: inside(cwd)!, command: null, changes: Object.freeze(changes as NonNullable<(typeof changes)[number]>[]) };
  };
  const answer = async (message: Message) => {
    const params = object(message.params), method = message.method as string;
    // Bound to the live thread AND a known turn: a request while the turn id is unknown is refused, never matched to "any turn".
    const bound = threadId !== null && turnId !== null && params['threadId'] === threadId && params['turnId'] === turnId && text(params['itemId']) !== null;
    // Permission expansion (managed network, extra sandbox access, exec-policy amendments) is never granted from a worker request.
    const expands = ['networkApprovalContext', 'additionalPermissions', 'proposedExecpolicyAmendment', 'grantRoot'].some(key => params[key] !== undefined && params[key] !== null);
    if (expands && R.methods.approvals.includes(method) && bound && !settled) { approvals.declined++; input.send({ jsonrpc: '2.0', id: message.id, result: { decision: 'decline' } }); return; }
    if (!R.methods.approvals.includes(method) || !bound || settled || interruptRequested) {
      refusedRequests++; input.send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'refused' } }); return;
    }
    const kind = method.includes('fileChange') ? 'file-change' as const : 'command' as const, action = content(kind, params);
    let accepted: boolean;
    // Unknown, unannounced, out-of-workspace or oversized actions are declined without asking: the decision always sees the exact content.
    try { accepted = action !== null && await input.approve(Object.freeze({ kind, threadId: threadId!, turnId: turnId!, itemId: String(params['itemId']), ...action })); } catch { accepted = false; }
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
      else if (message.method === 'item/started' && (params['threadId'] ?? threadId) === threadId && (params['turnId'] ?? turnId) === turnId && items.size < R.limits.approvalItems) {
        const item = object(params['item']), id = text(item['id']); if (id && !items.has(id)) items.set(id, item);
      }
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
