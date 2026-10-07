import { appendFileSync } from 'node:fs';
import { hostname, tmpdir, userInfo } from 'node:os';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as adapters from '#adapters/index.js';
import * as modelInvocation from '#composition/core/model-invocation/index.js';
import * as catalog from '#composition/core/provider-catalog/index.js';
import { createRuntimeChatTurnHost, runPeerConfiguredChatTurn } from '#composition/core/agent-turn/index.js';
import { createConfiguredRuntimeClient } from '#composition/core/runtime-service/index.js';
import { executeRuntimeApproval } from '#composition/core/runtime-service/index.js';
import { openConfiguredAttemptStore } from '#composition/core/storage/index.js';
import { streamTerminalAgentTurn } from '#composition/core/terminal-chat/index.js';
import { createWorklineLedgerPorts, workSurfaceLabels } from '#surfaces/core/cli/index.js';
import { SessionStanding, RUNTIME_SERVICE_SCHEMA_VERSION, runtimeServiceRequestSchema, type RuntimeServiceRequest } from '#engine/index.js';
import { clearConfigCache, t, type Locale } from '#platform/index.js';
import type { AgentChatMessage } from '#surfaces/core/terminal-kit/index.js';
import { agentTurnStreamEventSchema, type AgentTurnStreamEvent } from '#domain/index.js';
import { mountWorkline, settle, until, WORKLINE_TEST_LABELS } from '../support/workline-harness.js';

const cleanups: Array<() => Promise<void>> = [];
beforeEach(async context => {
  if (process.platform === 'linux') return;
  if (process.platform !== 'win32') {
    await expect(adapters.LocalOsSessionAuthority.create(['scope'], 60000, { sample: () => ({ wallMs: Date.now(), monotonicMs: 0 }) }))
      .rejects.toMatchObject({ code: 'SESSION_REQUIRED' });
    context.skip('SESSION_REQUIRED: real session approval requires Linux process-liveness evidence; no macOS OS-session authority is implemented');
  }
  const root = await mkdtemp(join(tmpdir(), 's02-capability-'));
  try {
    const home = join(root, 'home');
    await expect(openConfiguredAttemptStore(root, { env: { HOME: home, USERPROFILE: home } }))
      .rejects.toMatchObject({ code: 'MANAGED_FILE_UNSUPPORTED' });
    context.skip('MANAGED_FILE_UNSUPPORTED: real session approval effects require POSIX managed ledger and OS peer identity');
  } finally { await rm(root, { recursive: true, force: true }); }
});
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.restoreAllMocks(); clearConfigCache(); });
async function fixture(locale: Locale, settings: { fullAccess?: boolean; path?: string; companyAsk?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 's02-terminal-')), project = join(root, 'project'), data = join(root, 'data');
  await mkdir(join(project, '.deckent'), { recursive: true }); await mkdir(join(project, 'src'));
  const reference = { providerId: 'fixture', providerVersion: 1, modelId: 'chat', modelVersion: 1 };
  const env = { HOME: join(root, 'home'), USERPROFILE: join(root, 'home'), PATH: process.env.PATH ?? '/usr/bin:/bin' };
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data }, language: locale,
    terminal: { chat: { schemaVersion: 1, reference, maxCompletionTokens: 128 }, shell: { schemaVersion: 1, realm: 'host' } } }));
  adapters.registerProviderConfig();
  const opened = await openConfiguredAttemptStore(project, { env }); opened.store.close();
  const me = [{ issuer: hostname(), subject: String(userInfo().uid) }];
  const grants = [
    { id: 'scope', effect: 'allow', actions: ['inspect'], scopes: ['scope'], principals: me, resource: { kind: 'scope', ids: ['scope'] } },
    { id: 'edit', effect: settings.companyAsk ? 'require-approval' : 'allow', actions: ['invoke'], scopes: ['scope'], principals: me, resource: { kind: 'agent-tool', ids: ['write_file'] } },
    { id: 'write', effect: 'allow', actions: ['execute'], scopes: ['scope'], principals: me, resource: { kind: 'operation', ids: ['workspace.file.write'] } },
    { id: 'decide', effect: 'allow', actions: ['inspect', 'decide'], scopes: ['scope'], principals: me, resource: { kind: 'approval', ids: 'all' } },
  ];
  if (settings.fullAccess) grants.push({ id: 'full-access', effect: 'allow', actions: ['set'], scopes: ['scope'], principals: me, resource: { kind: 'permission-mode', ids: ['full-access'] } });
  await writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'allow', restrictions: [], grants }), { mode: 0o600 });
  // Only the model and build-origin observation are fixtures. The loop, edit planning/effect, approval service, B1, audit and UI are real.
  vi.spyOn(adapters, 'isSelfSourceProject').mockResolvedValue(true);
  vi.spyOn(catalog, 'inspectModelBinding').mockResolvedValue({ status: 'declared', catalogRevision: 'fixture', binding: { digest: 'a'.repeat(64) }, definition: {
    model: { nativeId: 'fake', protocols: [{ family: 'openai-chat-completions', version: 'v1', capabilities: [{ id: 'tool-calls', version: 1, state: 'supported' }] }] } } } as never);
  vi.spyOn(modelInvocation, 'measurePeerConfiguredModel').mockResolvedValue(null as never);
  let invocation = 0;
  vi.spyOn(modelInvocation, 'invokePeerConfiguredModel').mockImplementation(async () => {
    invocation++;
    const tool = invocation % 2 === 1;
    return { receipt: { outcome: { state: 'responded' } }, response: { native: { choices: [{ finish_reason: tool ? 'tool_calls' : 'stop', message: {
      role: 'assistant', content: tool ? '' : `Done ${invocation / 2}.`, ...(tool ? { tool_calls: [{ id: `call-${invocation}`, type: 'function', function: {
        name: 'write_file', arguments: JSON.stringify({ path: settings.path ?? './src/a.ts', content: `value-${invocation}\n` }) } }] } : {}) } }] } } } as never;
  });
  const controller = new AbortController(), host = createRuntimeChatTurnHost({} as never, controller.signal, undefined, undefined, () => []);
  const peer = { pid: process.pid, uid: userInfo().uid, gid: userInfo().gid, assurance: 'linux-so-peercred' as const, connection: controller.signal, isConnectionActive: () => !controller.signal.aborted };
  const events: AgentTurnStreamEvent[] = [], requests: RuntimeServiceRequest[] = [];
  const faults = { dropDecision: false, failAudit: false, holdAudit: null as Promise<void> | null, enteredAudit: () => undefined as void };
  const openAudit = adapters.openSqliteAuditStore;
  vi.spyOn(adapters, 'openSqliteAuditStore').mockImplementation(async (...args) => { faults.enteredAudit(); await faults.holdAudit; if (faults.failAudit) throw new Error('injected-audit-failure'); return openAudit(...args); });
  // In-process transport routes through the same typed operation handlers, with a real OS peer. No socket or provider is opened.
  vi.spyOn(adapters, 'requestLocalRuntime').mockImplementation(async (_options, input) => {
    const request = runtimeServiceRequestSchema.parse(input); requests.push(request);
    const result = await executeRuntimeApproval(project, request, peer, 1048576, { env }, host.decisions, host.answers);
    if (request.operation === 'decideApproval' && faults.dropDecision) throw new Error('injected-response-loss');
    return { schemaVersion: RUNTIME_SERVICE_SCHEMA_VERSION, requestId: request.requestId, ok: true, result };
  });
  vi.spyOn(adapters, 'turnLocalRuntime').mockImplementation(async (_options, input, emit, signal) => {
    const request = runtimeServiceRequestSchema.parse(input); requests.push(request);
    const result = await runPeerConfiguredChatTurn(project, request.input, peer, { env }, { maxResultBytes: 65536 }, host,
      { signal: signal ?? controller.signal, drained: async () => undefined, emit: event => { const checked = agentTurnStreamEventSchema.parse(event); events.push(checked); emit([checked]); } });
    return { schemaVersion: RUNTIME_SERVICE_SCHEMA_VERSION, requestId: request.requestId, ok: true, result };
  });
  const client = createConfiguredRuntimeClient(project, { env });
  const ledger = createWorklineLedgerPorts({ root: project, scopeId: 'scope', options: { env }, locale,
    inspectWorkers: async () => ({ schemaVersion: 1, scopeId: 'scope', observedAt: Date.now(), control: 'observe-only', sources: [] }),
    inspectRun: async () => ({ run: null } as never), listApprovals: input => client.listApprovals(input), decideApproval: input => client.decideApproval(input),
    clearSessionStanding: input => client.clearSessionStanding(input) })!;
  const snapshots = new Map<string, readonly AgentChatMessage[]>();
  // Explicit test identity bypasses the renderer-only synthetic binding; the composition below binds its actual command.
  const context = { installationId: 'fixture-installation', projectId: 'fixture-project', scopeId: 'scope' };
  const view = mountWorkline({ context, ledger, fullAccess: settings.fullAccess === true, sessions: { async save(input) { snapshots.set(input.sessionId, input.messages); },
    async list() { return [...snapshots].map(([sessionId, messages]) => ({ sessionId, messages: messages.length, updatedAtMs: Date.now(), preview: 'saved' })); },
    async load(id) { return snapshots.get(id) ?? null; } }, labels: { ...WORKLINE_TEST_LABELS, work: workSurfaceLabels(locale) },
    streamTurn: (messages, signal, turn) => streamTerminalAgentTurn({ projectRoot: project, scopeId: 'scope', options: { env }, messages, signal,
      ...(turn?.onTurnBound ? { onTurnBound: turn.onTurnBound } : {}),
      ...(turn?.sessionId ? { sessionId: turn.sessionId } : {}), ...(turn?.fullAccess ? { fullAccess: true as const } : {}) }, { chatTurn: (_root, command, emit, _options, signal) => client.chatTurn(command, emit, signal),
      cancelChatTurn: async () => undefined }) });
  cleanups.push(async () => { view.instance.unmount(); controller.abort(); await rm(root, { recursive: true, force: true }); });
  const type = async (text: string) => { for (const ch of text) { view.stdin.write(ch); await settle(3); } };
  const rows = (sql: string) => { const db = new DatabaseSync(opened.path, { readOnly: true }); try { return db.prepare(sql).all(); } finally { db.close(); } };
  return { view, type, events, requests, rows, project, client, host, faults };
}
it.each(['en', 'tr'] as const)('producer → runtime service → real Workline s and clear-session: visible %s text, real writes, remembered/used audit and next prompt', async locale => {
  const f = await fixture(locale);
  await settle(100); await f.type('first\r');
  await until(() => f.events.some(e => e.kind === 'approval.requested'), 'first real approval');
  const first = f.events.find(e => e.kind === 'approval.requested')! as Extract<AgentTurnStreamEvent, { kind: 'approval.requested' }>;
  expect(first.standing).toEqual({ scopes: ['session'], pattern: 'src/*' });
  // T-APPROVAL-WINDOW: the offered keys in the window's hint row, and the window names the call from the real producer's own `tool.started`.
  const keys = [t('terminal.approval.window.keys.once', {}, locale), t('terminal.approval.window.keys.session', {}, locale), t('terminal.approval.window.keys.deny', {}, locale)].join(' · ');
  await until(() => f.view.stdout.frame.includes(keys), 'session key on card').catch(error => { throw new Error(String(error) + '\n' + f.view.stdout.frame); });
  expect(f.view.stdout.frame).not.toContain(t('terminal.approval.window.keys.always', {}, locale));
  if (process.env.DECKENT_L1_FRAME_PROOF) appendFileSync(process.env.DECKENT_L1_FRAME_PROOF, `\n## real producer approval window (${locale})\n${f.view.stdout.frame}\n`);
  await settle(60); await f.type('a'); await settle(40);
  expect(f.requests.filter(r => r.operation === 'decideApproval')).toHaveLength(0);
  await f.type('s');
  const saved = t('terminal.approval.standing.savedSession', { id: first.approvalId }, locale);
  await until(() => f.view.stdout.text.replace(/\s+/g, ' ').includes(saved), 'visible saved notice').catch(error => { throw new Error(String(error) + '\n' + f.view.stdout.frame); });
  await until(() => f.view.stdout.text.includes('Done 1.'), 'first completed turn');
  expect(await readFile(join(f.project, 'src/a.ts'), 'utf8')).toBe('value-1\n');
  await settle(50); await f.type('second\r'); await until(() => f.view.stdout.text.includes('Done 2.'), 'second completed without asking');
  expect(f.events.filter(e => e.kind === 'approval.requested')).toHaveLength(1);
  expect(await readFile(join(f.project, 'src/a.ts'), 'utf8')).toBe('value-3\n');
  const subjects = f.rows('SELECT record FROM audit_events').map(row => JSON.parse(String(row.record)).event.subject);
  expect(subjects.filter(s => s.kind === 'standing-approval').map(s => s.phase).sort()).toEqual(['remembered', 'used']);
  await settle(50); await f.type('/approvals clear-session\r');
  await until(() => f.requests.some(r => r.operation === 'clearSessionStanding'), 'typed clear operation');
  const clear = f.requests.find(r => r.operation === 'clearSessionStanding')!.input as { sessionId: string };
  await until(() => f.view.stdout.text.includes(t('terminal.approval.sessionCleared', { session: clear.sessionId }, locale)), 'visible clear acknowledgement');
  const command = f.requests.find(r => r.operation === 'decideApproval')!.input;
  expect(await f.client.decideApproval(command)).toMatchObject({ record: { status: 'decided', decision: { decision: 'allow' } }, standing: { status: 'unconfirmed' } });
  await f.type('third\r'); await until(() => f.events.filter(e => e.kind === 'approval.requested').length === 2, 'fresh card after clear');
  await settle(100); await f.type('N'); await until(() => f.view.stdout.text.includes('Done 3.'), 'denied third call');
  expect(await readFile(join(f.project, 'src/a.ts'), 'utf8')).toBe('value-3\n');
}, 20000);


it('y stays a plain once record and a second same-key call asks again', async () => {
  const f = await fixture('en'); await settle(100); await f.type('once\r');
  await until(() => f.events.some(e => e.kind === 'approval.requested'), 'once card'); await settle(100); await f.type('y');
  await until(() => f.view.stdout.text.includes('Done 1.'), 'once effect');
  const command = f.requests.find(r => r.operation === 'decideApproval')!.input;
  expect(command).not.toHaveProperty('standing');
  const once = await f.client.decideApproval(command); expect(once).toHaveProperty('status', 'decided'); expect(once).not.toHaveProperty('record');
  await f.type('again\r'); await until(() => f.events.filter(e => e.kind === 'approval.requested').length === 2, 'second once card');
  expect(f.rows('SELECT record FROM audit_events').map(row => JSON.parse(String(row.record)).event.subject).filter(s => s.kind === 'standing-approval')).toEqual([]);
  await settle(100); await f.type('N'); await until(() => f.view.stdout.text.includes('Done 2.'), 'denied second');
}, 20000);

it('a lost session answer is visibly unconfirmed, never not-saved; its sealed allow and actual effect remain separate', async () => {
  const f = await fixture('en'); f.faults.dropDecision = true;
  await settle(100); await f.type('lost answer\r'); await until(() => f.events.some(e => e.kind === 'approval.requested'), 'loss card');
  const card = f.events.find(e => e.kind === 'approval.requested') as Extract<AgentTurnStreamEvent, { kind: 'approval.requested' }>;
  await settle(100); await f.type('s');
  await until(() => f.view.stdout.text.includes('session permission could not be confirmed (transport-unknown)'), 'unknown notice');
  expect(f.view.stdout.text).not.toContain('session answer was not saved'); expect(f.view.stdout.text).not.toContain('permission saved for this conversation');
  await until(() => f.view.stdout.text.includes('Done 1.'), 'effect after lost answer');
  expect(await readFile(join(f.project, 'src/a.ts'), 'utf8')).toBe('value-1\n');
  f.faults.dropDecision = false;
  const command = f.requests.find(r => r.operation === 'decideApproval')!.input;
  expect(await f.client.decideApproval(command)).toMatchObject({ record: { request: { approvalId: card.approvalId }, status: 'decided' }, standing: { status: 'unconfirmed' } });
}, 20000);

it('own-peer clear while the real remembered audit waits releases the producer barrier and prevents a late audit from resurrecting memory', async () => {
  const f = await fixture('en'); let release!: () => void, entered!: () => void;
  const auditing = new Promise<void>(resolve => { entered = resolve; });
  f.faults.holdAudit = new Promise<void>(resolve => { release = resolve; }); f.faults.enteredAudit = entered;
  try {
    await settle(100); await f.type('race\r'); await until(() => f.events.some(e => e.kind === 'approval.requested'), 'race card');
    await settle(100); await f.type('s'); await auditing;
    const turn = f.requests.find(r => r.operation === 'chatTurn')!.input as { sessionId: string };
    expect(await f.client.clearSessionStanding({ schemaVersion: 1, scopeId: 'scope', sessionId: turn.sessionId })).toEqual({ schemaVersion: 1, scopeId: 'scope', sessionId: turn.sessionId, cleared: true });
    await until(() => f.view.stdout.text.includes('session answer was not saved (revoked)'), 'confirmed revoke');
    release(); f.faults.holdAudit = null; await until(() => f.view.stdout.text.includes('Done 1.'), 'once effect unchanged by clear');
    await f.type('after clear\r'); await until(() => f.events.filter(e => e.kind === 'approval.requested').length === 2, 'late audit cannot remember');
    await settle(100); await f.type('N'); await until(() => f.view.stdout.text.includes('Done 2.'), 'race test finish');
    expect(await readFile(join(f.project, 'src/a.ts'), 'utf8')).toBe('value-1\n');
  } finally { release(); }
}, 20000);


it('clear-session follows new and resumed conversation identity and leaves another conversation memory alone', async () => {
  const f = await fixture('en'); await settle(100); await f.type('remember\r');
  await until(() => f.events.some(e => e.kind === 'approval.requested'), 'remember card'); await settle(100); await f.type('s');
  await until(() => f.view.stdout.text.includes('Done 1.'), 'remembered original');
  const original = (f.requests.find(r => r.operation === 'chatTurn')!.input as { sessionId: string }).sessionId;
  const own = SessionStanding.sessionKey('scope', { issuer: hostname(), subject: String(userInfo().uid) }, original), key = 'v1:session:edit-self-source:write_file:directory:src/*';
  expect(f.host.answers.memory.has(own, key)).toBe(true);
  await f.type('/clear\r'); await until(() => f.view.stdout.text.includes('NEW-SESSION'), 'new conversation');
  await f.type('/approvals clear-session\r'); await until(() => f.requests.filter(r => r.operation === 'clearSessionStanding').length === 1, 'new conversation clear');
  const fresh = (f.requests.find(r => r.operation === 'clearSessionStanding')!.input as { sessionId: string }).sessionId;
  expect(fresh).not.toBe(original); expect(f.host.answers.memory.has(own, key)).toBe(true);
  await until(() => f.view.stdout.text.includes(t('terminal.approval.sessionCleared', { session: fresh }, 'en')), 'fresh clear notice');
  await f.type(`/resume ${original}\r`); await until(() => f.view.stdout.text.includes(`RESUMED 4 ${original.slice(0, 8)}`), 'resumed original conversation');
  await f.type('/approvals clear-session\r'); await until(() => f.requests.filter(r => r.operation === 'clearSessionStanding').length === 2, 'resumed clear');
  expect((f.requests.filter(r => r.operation === 'clearSessionStanding').at(-1)!.input as { sessionId: string }).sessionId).toBe(original);
  await until(() => !f.host.answers.memory.has(own, key), 'original memory withdrawn');
}, 20000);

it('a static hard-floor card offers neither s nor always and rejects forged session input before committing', async () => {
  const f = await fixture('en', { path: 'package.json' }); await settle(100); await f.type('floor\r');
  await until(() => f.events.some(e => e.kind === 'approval.requested'), 'floor card');
  const card = f.events.find(e => e.kind === 'approval.requested') as Extract<AgentTurnStreamEvent, { kind: 'approval.requested' }>;
  expect(card.standing).toBeUndefined(); expect(card.risk).toBe('edit-floor');
  await expect(f.client.decideApproval({ schemaVersion: 1, scopeId: 'scope', approvalId: card.approvalId, commandId: 'forged-session', expectedRevision: card.revision,
    decision: 'allow', reason: 'Must refuse', standing: 'session', decisionCapability: card.decisionCapability })).rejects.toMatchObject({ code: 'APPROVAL_INVALID' });
  expect(f.rows('SELECT snapshot FROM approvals').map(row => JSON.parse(String(row.snapshot)).status)).toEqual(['pending']);
  const sent = f.requests.length; await settle(100); await f.type('sa'); await settle(40); expect(f.requests.length).toBe(sent);
  await f.type('N'); await until(() => f.view.stdout.text.includes('Done 1.'), 'floor denied');
  await expect(readFile(join(f.project, 'package.json'))).rejects.toMatchObject({ code: 'ENOENT' });
}, 20000);

it('full access retains its own admitted and audited effect path with no session card or remembered grant', async () => {
  const f = await fixture('en', { fullAccess: true }); await settle(100); await f.type('full access\r');
  await until(() => f.view.stdout.text.includes('Done 1.'), 'full-access result');
  expect(f.events.filter(e => e.kind === 'approval.requested')).toEqual([]);
  expect(await readFile(join(f.project, 'src/a.ts'), 'utf8')).toBe('value-1\n');
  const kinds = f.rows('SELECT record FROM audit_events').map(row => JSON.parse(String(row.record)).event.subject.kind);
  expect(kinds).toContain('full-access-turn'); expect(kinds).toContain('full-access-call'); expect(kinds).not.toContain('standing-approval');
}, 20000);


it('company-required approval that standing cannot lower never offers a session shortcut', async () => {
  const f = await fixture('en', { companyAsk: true }); await settle(100); await f.type('company approval\r');
  await until(() => f.events.some(e => e.kind === 'approval.requested'), 'company card');
  const card = f.events.find(e => e.kind === 'approval.requested') as Extract<AgentTurnStreamEvent, { kind: 'approval.requested' }>;
  expect(card.risk).toBe('edit-self-source'); expect(card.standing).toBeUndefined();
  await settle(100); await f.type('s'); await settle(40); expect(f.requests.filter(r => r.operation === 'decideApproval')).toEqual([]);
  await f.type('N'); await until(() => f.view.stdout.text.includes('Done 1.'), 'company denial');
}, 20000);


it('two authenticated runtime callers join the actual pending remembered audit with one decision, audit and memory write', async () => {
  const f = await fixture('en'); let release!: () => void, entered!: () => void;
  const auditing = new Promise<void>(resolve => { entered = resolve; });
  f.faults.holdAudit = new Promise<void>(resolve => { release = resolve; }); f.faults.enteredAudit = entered;
  try {
    await settle(100); await f.type('duplicate\r'); await until(() => f.events.some(e => e.kind === 'approval.requested'), 'duplicate card');
    await settle(100); await f.type('s'); await auditing;
    const command = f.requests.find(r => r.operation === 'decideApproval')!.input as Record<string, unknown>;
    let completed = false;
    const duplicate = f.client.decideApproval(command).then(result => { completed = true; return result; });
    await expect(f.client.decideApproval({ ...command, reason: 'different' })).rejects.toMatchObject({ code: 'APPROVAL_CONFLICT' });
    await settle(50); expect(completed).toBe(false);
    expect(f.rows('SELECT command_id FROM approval_receipts')).toHaveLength(1);
    expect(f.rows('SELECT record FROM audit_events')).toHaveLength(0);
    release(); f.faults.holdAudit = null;
    expect(await duplicate).toMatchObject({ standing: { scope: 'session', status: 'saved' } });
    await until(() => f.view.stdout.text.includes('permission saved for this conversation'), 'duplicate saved');
    await until(() => f.view.stdout.text.includes('Done 1.'), 'barrier releases effect');
    const subjects = f.rows('SELECT record FROM audit_events').map(row => JSON.parse(String(row.record)).event.subject);
    expect(subjects.filter(s => s.kind === 'standing-approval' && s.phase === 'remembered')).toHaveLength(1);
    expect(f.rows('SELECT command_id FROM approval_receipts')).toHaveLength(1);
  } finally { release(); }
}, 20000);

it('a real remembered-audit failure reports not-saved while preserving only the once decision; next call asks again', async () => {
  const f = await fixture('en'); f.faults.failAudit = true;
  await settle(100); await f.type('audit failure\r'); await until(() => f.events.some(e => e.kind === 'approval.requested'), 'audit failure card');
  await settle(100); await f.type('s'); await until(() => f.view.stdout.text.includes('session answer was not saved (audit-unavailable)'), 'audit failure notice');
  await until(() => f.view.stdout.text.includes('Done 1.'), 'once effect without standing audit');
  expect(await readFile(join(f.project, 'src/a.ts'), 'utf8')).toBe('value-1\n');
  f.faults.failAudit = false;
  await f.type('try again\r'); await until(() => f.events.filter(e => e.kind === 'approval.requested').length === 2, 'no memory after audit failure');
  await settle(100); await f.type('N'); await until(() => f.view.stdout.text.includes('Done 2.'), 'audit test complete');
}, 20000);
