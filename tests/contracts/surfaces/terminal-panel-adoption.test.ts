import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readLocalOsIdentity, openTerminalSessionStore } from '#adapters/index.js';
import { clearConfigCache, snapshotKnownSecrets } from '#platform/index.js';
import { ensureConfiguredTerminalIdentity, loadConfiguredInstallationIdentity, loadConfiguredProjectIdentity, loadConfiguredPeerScopeContext } from '#composition/core/scoped-request/index.js';
import { streamTerminalAgentTurn, type TerminalAgentTurnPorts } from '#surfaces/core/terminal-turn/index.js';
import { main } from '#surfaces/index.js';
import * as kit from '#surfaces/core/terminal-kit/index.js';
import type { ChatTurnCommand, ChatTurnCancellation, ChatTurnResult } from '#domain/index.js';
import { mountWorkline, settle, until } from '../support/workline-harness.js';

const roots: string[] = [], views: Array<{ unmount(): void }> = [];
afterEach(async () => { views.splice(0).forEach(view => view.unmount()); vi.restoreAllMocks(); clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const result = (command: ChatTurnCommand, answer = 'ANSWER'): ChatTurnResult => ({ schemaVersion: 1, turnId: command.turnId,
  finish: 'stop', note: null, rounds: 1, toolCalls: 0, answer, answerBytes: answer.length, replayed: false, recorded: true });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'desktop-o7-adoption-')); roots.push(root);
  const project = join(root, 'project'), data = join(root, 'data');
  await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 }); await mkdir(data, { mode: 0o700 });
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data }, company: { id: 'alpha' }, terminal: { autostartService: false } }));
  const actor = readLocalOsIdentity();
  await writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'p', restrictions: [], grants: [{ id: 'g', effect: 'allow', actions: ['inspect'],
    scopes: ['s'], principals: [{ issuer: actor.issuer, subject: actor.subject }], resource: { kind: 'scope', ids: 'all' } }] }), { mode: 0o600 });
  const peer = { pid: process.pid, uid: process.getuid!(), gid: process.getgid!(), assurance: 'linux-so-peercred' as const };
  const options = { env: { DECKENT_GLOBAL_HOME: join(root, 'global'), HOME: join(root, 'home'), NO_COLOR: '1' } };
  const ensured = await ensureConfiguredTerminalIdentity(project, 's', options);
  const scoped = await loadConfiguredPeerScopeContext(project, 's', options, peer, 'read');
  expect({ installationId: scoped.installationId, projectId: scoped.projectId }).toEqual(ensured);
  return { root, project, options, peer, identity: { installationId: scoped.installationId, projectId: scoped.projectId, scopeId: 's' } };
}
function observeController() {
  const original = kit.createPanelController, controllers: kit.PanelController<kit.TerminalLocalContext>[] = [], snapshots: kit.PanelSnapshot<kit.TerminalLocalContext>[] = [];
  vi.spyOn(kit, 'createPanelController').mockImplementation(((port: kit.TerminalLocalPanelPort) => {
    const controller = original(port); controllers.push(controller); snapshots.push(controller.snapshot()); controller.subscribe(state => snapshots.push(state)); return controller;
  }) as typeof kit.createPanelController);
  return { controllers, snapshots };
}
class Screen extends Writable {
  text = ''; readonly isTTY = true; readonly columns = 180; readonly rows = 60;
  override _write(chunk: Buffer, _encoding: string, done: () => void) { this.text += chunk.toString(); done(); }
}
const decisionRecord = () => ({ request: { schemaVersion: 3, approvalId: 'approval-1', scopeId: 's', requester: { id: 'u', issuer: 'i', subject: 's' },
  subject: { kind: 'operation', operation: { id: 'erp.post', version: 1 }, target: { kind: 'records', id: 'PO-1' }, commandId: 'cmd', inputDigest: 'd'.repeat(64),
    targetBinding: 'e'.repeat(64), expectedVersion: null, compensates: null }, actionDigest: 'a'.repeat(64), policyRevision: 'p', summary: 'fixture approval', createdAt: 1, expiresAt: 4_000_000_000_000,
  facts: { risk: { source: 'effect-class', effectClass: 'write', authority: false }, reversibility: { kind: 'irreversible' }, onExpiry: 'nothing-runs', requiredAssurance: 'turn-bound' } },
revision: 1, status: 'decided', decision: { schemaVersion: 2, commandId: 'c', decision: 'allow', actor: { id: 'u', issuer: 'i', subject: 's' }, sessionId: 'x',
  channel: 'local-terminal-card', reason: 'r', decidedAt: 2, requestDigest: 'd'.repeat(64), commandDigest: 'e'.repeat(64), idempotencyKeyHash: 'f'.repeat(64), assurance: 'turn-bound' }, keyId: 'k', mac: 'b'.repeat(64) });

describe('real identity producer → shared controller → private adapter → Workline (fake runtime/model)', () => {
  beforeEach(context => { if (process.platform === 'win32') context.skip('INSTALLATION_IDENTITY_UNSUPPORTED: POSIX producer; no native Windows claim'); });
  it('uses the CLI forwarder, persisted context, exact generated command, private capability and canonical history end to end', async () => {
    const f = await fixture(), observed = observeController(), answered = gate(), commands: ChatTurnCommand[] = [], decisions: unknown[] = [];
    await mkdir(join(f.root, 'sessions'), { mode: 0o700 });
    const capability = 'fictitious-private-capability-o7', sessions = openTerminalSessionStore(join(f.root, 'sessions'));
    const ports: TerminalAgentTurnPorts = {
      preflight: async () => { const scoped = await loadConfiguredPeerScopeContext(f.project, 's', f.options, f.peer, 'read'); expect(scoped.projectId).toBe(f.identity.projectId); },
      async chatTurn(_root, command, event) {
        commands.push(command);
        const state = observed.controllers[0]!.snapshot();
        expect(state.context).toEqual({ kind: 'terminal-local', ...f.identity, sessionId: command.sessionId });
        expect(state.active?.binding).toEqual({ scopeId: 's', sessionId: command.sessionId, turnId: command.turnId, phase: 'command-generated' });
        event({ kind: 'approval.requested', callId: 'call-1', approvalId: 'approval-1', revision: 0, summary: 'PRIVATE-DECISION-SUMMARY', preview: 'PRIVATE-PREVIEW',
          expiresAt: Date.now() + 60_000, decisionCapability: capability, requiredAssurance: 'turn-bound', risk: 'edit-floor' });
        await answered.promise;
        event({ kind: 'approval.settled', callId: 'call-1', approvalId: 'approval-1', outcome: 'allow' });
        event({ kind: 'message', message: { role: 'assistant', content: 'ANSWER', toolCalls: [] } });
        return result(command);
      }, async cancelChatTurn() { throw new Error('unexpected cancel'); },
    };
    const stdout = new Screen(), stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() { return stdin; }, ref() { return stdin; }, unref() { return stdin; } });
    const stop = new AbortController();
    const run = main(['terminal', 'workline', '--scope', 's', '--lang', 'en'], { root: f.project, env: f.options.env,
      stdout: stdout as unknown as NodeJS.WriteStream, stderr: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, signal: stop.signal,
      initialize() {}, ensureTerminalIdentity: ensureConfiguredTerminalIdentity, loadInstallationIdentity: loadConfiguredInstallationIdentity, loadProjectIdentity: loadConfiguredProjectIdentity,
      async completeTerminalChat() { throw new Error('stream must own turn'); }, async openTerminalSessions() { return sessions; },
      async inspectWorkers() { throw new Error('unused worker observation'); }, async inspectRun() { throw new Error('unused run observation'); }, async listApprovals() { return []; },
      async decideApproval(input) { decisions.push(input); await settle(50); answered.resolve(); return decisionRecord(); },
      streamTerminalChat: (root, input, options, signal) => streamTerminalAgentTurn({ ...input, projectRoot: root, options, ...(signal ? { signal } : {}) }, ports) });
    try {
      await until(() => stdout.text.includes('Ask anything'), 'real CLI composer'); stdin.write('hello\r');
      await until(() => observed.controllers[0]?.snapshot().approval?.phase === 'pending' && stdout.text.includes('PRIVATE-PREVIEW'), 'private decision renderer'); await settle(40);
      stdin.write('y'); await until(() => observed.controllers[0]!.snapshot().approval?.phase === 'deciding', 'decision in flight'); stdin.write('y');
      await until(() => observed.controllers[0]?.snapshot().phase === 'idle' && stdout.text.includes('ANSWER'), 'one completed adapter invocation');
      expect(decisions).toHaveLength(1); expect(decisions[0]).toMatchObject({ scopeId: 's', approvalId: 'approval-1', expectedRevision: 0, decisionCapability: capability, channel: 'local-terminal-card', decision: 'allow' });
      expect(commands).toHaveLength(1); expect(observed.controllers).toHaveLength(1);
      expect(JSON.parse(await readFile(join(f.project, '.deckent/project-identity/identity.json'), 'utf8')).projectId).toBe(f.identity.projectId);
      const stored = await sessions.load('s', commands[0]!.sessionId!); expect(stored?.at(-1)?.content).toBe('ANSWER');
      for (const serialized of [JSON.stringify(observed.snapshots), JSON.stringify(stored)]) {
        expect(serialized).not.toContain(capability); expect(serialized).not.toContain('PRIVATE-DECISION-SUMMARY'); expect(serialized).not.toContain('PRIVATE-PREVIEW');
      }
      expect(stdout.text).not.toContain(capability); expect(observed.controllers[0]!.snapshot().context).not.toHaveProperty('sessionRevision');
      stdin.write('/exit\r'); expect(await run).toBe(0);
    } finally { stop.abort(); answered.resolve(); await run; }
  }, 15_000);

  it('cancels the exact composition-generated turn, drops queued work on close and clears private approval custody', async () => {
    const f = await fixture(), observed = observeController(), commands: ChatTurnCommand[] = [], cancellations: ChatTurnCancellation[] = [];
    const ports: TerminalAgentTurnPorts = {
      chatTurn: async (_root, command, _event, _options, signal) => { commands.push(command); await new Promise<void>(resolve => signal!.addEventListener('abort', () => resolve(), { once: true })); return { ...result(command), finish: 'cancelled' }; },
      async cancelChatTurn(_root, command) { cancellations.push(command); },
    };
    const view = mountWorkline({ context: f.identity, streamTurn: (messages, signal, turn) => streamTerminalAgentTurn({ projectRoot: f.project,
      scopeId: 's', messages, options: f.options, signal, ...turn }, ports) }); views.push(view.instance);
    await until(() => view.stdout.text.includes('READY'), 'ready'); view.stdin.write('first\r');
    await until(() => commands.length === 1, 'dispatch'); view.stdin.write('queued\r');
    await until(() => observed.controllers[0]!.snapshot().queued.length === 1, 'controller FIFO'); view.instance.unmount();
    await until(() => cancellations.length === 1, 'same cancel closure'); await settle(30);
    expect(cancellations).toEqual([{ schemaVersion: 1, scopeId: 's', turnId: commands[0]!.turnId }]); expect(commands).toHaveLength(1);
    expect(observed.controllers[0]!.snapshot()).toMatchObject({ phase: 'closed', queued: [], approval: null, picker: null, active: null });
  });

  it('does not offer a capability-bearing card from an unbound stream, and uses the existing secret projection for a bound card', async () => {
    const f = await fixture(), observed = observeController(), end = gate(), known = 'fictitious-known-private-label';
    const view = mountWorkline({ context: f.identity, knownSecrets: snapshotKnownSecrets([{ name: 'O7_FIXTURE', value: known }]),
      ledger: { scopeId: 's', async listWorkers() { throw new Error('unused'); }, async inspectRun() { return null; }, async decideApproval() { throw new Error('unused'); } },
      streamTurn: async function* (_messages, _signal, turn) {
        const request = { kind: 'approval' as const, phase: 'requested' as const, callId: 'c', approvalId: 'unbound', revision: 0,
          summary: known, preview: known, expiresAt: Date.now() + 60_000, decisionCapability: 'fixture-capability' };
        yield request; await settle(40); expect(observed.controllers[0]!.snapshot().approval).toBeNull();
        turn!.onTurnBound!({ scopeId: 's', sessionId: turn!.sessionId!, turnId: 'explicit-producer-fixture', phase: 'command-generated' });
        yield { ...request, approvalId: 'bound' }; await end.promise; yield { kind: 'done', finish: 'stop' };
      } }); views.push(view.instance);
    await until(() => view.stdout.text.includes('READY'), 'ready'); view.stdin.write('go\r');
    try {
      await until(() => view.stdout.frame.includes('‹secret:O7_FIXTURE›'), 'canonical A1 projection');
      expect(view.stdout.text).not.toContain(known); expect(view.stdout.text).not.toContain('fixture-capability');
      expect(observed.controllers[0]!.snapshot().approval?.approvalId).toBe('bound');
      expect(JSON.stringify(observed.snapshots)).not.toContain(known);
    } finally { end.resolve(); }
  });
});

describe('adopted session and decision lifecycle', () => {
  beforeEach(context => { if (process.platform === 'win32') context.skip('INSTALLATION_IDENTITY_UNSUPPORTED: POSIX producer; no native Windows claim'); });
  it('serializes canonical resume and clear ahead of queued messages with the new exact session context', async () => {
    const f = await fixture(), observed = observeController(), loaded = gate(), commands: ChatTurnCommand[] = [];
    await mkdir(join(f.root, 'sessions'), { mode: 0o700 });
    const store = openTerminalSessionStore(join(f.root, 'sessions')), savedId = 'ab000000-0000-4000-8000-000000000001';
    await store.save({ schemaVersion: 1, scopeId: 's', sessionId: savedId, updatedAtMs: 1, messages: [{ role: 'user', content: 'SAVED-CONTEXT' }] });
    const sessions = kit.bindSessionScope(store, 's'); let loading = false;
    const ports: TerminalAgentTurnPorts = { async chatTurn(_root, command) { commands.push(command); return result(command); }, async cancelChatTurn() {} };
    const view = mountWorkline({ context: f.identity, sessions: { ...sessions, async load(id) { loading = true; await loaded.promise; return sessions.load(id); } },
      streamTurn: (messages, signal, turn) => streamTerminalAgentTurn({ projectRoot: f.project, scopeId: 's', messages, options: f.options, signal, ...turn }, ports) }); views.push(view.instance);
    await until(() => view.stdout.text.includes('READY'), 'ready'); view.stdin.write(`/resume ${savedId}\r`);
    await until(() => loading, 'canonical load started'); view.stdin.write('next\r');
    await until(() => observed.controllers[0]!.snapshot().queued.length === 1, 'queued during resume'); loaded.resolve();
    await until(() => commands.length === 1 && observed.controllers[0]!.snapshot().phase === 'idle', 'resumed turn saved');
    expect(commands[0]!.sessionId).toBe(savedId); expect(commands[0]!.messages.map(m => m.content)).toContain('SAVED-CONTEXT');
    expect((await store.load('s', savedId))?.at(-1)?.content).toBe('ANSWER');
    view.stdin.write('/clear\r'); await until(() => observed.controllers[0]!.snapshot().context.sessionId !== savedId, 'fresh local session');
    const newId = observed.controllers[0]!.snapshot().context.sessionId; view.stdin.write('fresh\r');
    await until(() => commands.length === 2 && observed.controllers[0]!.snapshot().phase === 'idle', 'fresh turn saved');
    expect(newId).toMatch(/^[0-9a-f-]{36}$/); expect(commands[1]!.sessionId).toBe(newId);
    expect(commands[1]!.messages.map(m => m.content)).not.toContain('SAVED-CONTEXT'); expect((await store.load('s', newId))?.at(-1)?.content).toBe('ANSWER');
  });

  it('a late refused answer cannot reopen an earlier revision of the same approval id', async () => {
    const f = await fixture(), observed = observeController(), started = gate(), late = gate(), end = gate(), calls: number[] = [];
    const view = mountWorkline({ context: f.identity, ledger: { scopeId: 's', async listWorkers() { throw new Error('unused'); }, async inspectRun() { return null; },
      async decideApproval(approval) { calls.push(approval.revision); started.resolve(); await late.promise; throw Object.assign(new Error('refused'), { code: 'APPROVAL_ASSURANCE_INSUFFICIENT' }); } },
      streamTurn: async function* (_messages, _signal, turn) {
        turn!.onTurnBound!({ scopeId: 's', sessionId: turn!.sessionId!, turnId: 'fixture-command', phase: 'command-generated' });
        const request = { kind: 'approval' as const, phase: 'requested' as const, callId: 'old-call', approvalId: 'same-id', revision: 0,
          summary: 'OLD-REVISION', preview: 'old', expiresAt: Date.now() + 60_000, decisionCapability: 'fixture-old-cap' };
        yield request; await started.promise;
        yield { kind: 'approval', phase: 'settled', callId: 'old-call', approvalId: 'same-id', outcome: 'allow' };
        yield { ...request, callId: 'new-call', revision: 1, summary: 'NEW-REVISION', decisionCapability: 'fixture-new-cap' }; await end.promise;
        yield { kind: 'done', finish: 'stop' };
      } }); views.push(view.instance);
    await until(() => view.stdout.text.includes('READY'), 'ready'); view.stdin.write('go\r');
    try {
      await until(() => view.stdout.frame.includes('OLD-REVISION'), 'old card'); await settle(30); view.stdin.write('y');
      await until(() => view.stdout.frame.includes('NEW-REVISION'), 'new card'); late.resolve(); await settle(40);
      expect(observed.controllers[0]!.snapshot().approval).toMatchObject({ approvalId: 'same-id', revision: 1, phase: 'pending' });
      expect(view.stdout.frame).toContain('NEW-REVISION'); expect(calls).toEqual([0]);
    } finally { late.resolve(); end.resolve(); }
  });

  it('transport uncertainty keeps the controller unknown and releases the keyboard for exact turn cancellation', async () => {
    const f = await fixture(), observed = observeController(), end = gate(); let signal!: AbortSignal;
    const view = mountWorkline({ context: f.identity, ledger: { scopeId: 's', async listWorkers() { throw new Error('unused'); }, async inspectRun() { return null; },
      async decideApproval() { throw new Error('lost transport'); } }, streamTurn: async function* (_messages, inputSignal, turn) {
        signal = inputSignal; signal.addEventListener('abort', end.resolve, { once: true });
        turn!.onTurnBound!({ scopeId: 's', sessionId: turn!.sessionId!, turnId: 'fixture-command', phase: 'command-generated' });
        yield { kind: 'approval', phase: 'requested', callId: 'c', approvalId: 'uncertain', revision: 0, summary: 'UNCERTAIN-CARD', preview: 'preview', expiresAt: Date.now() + 60_000 };
        await end.promise; yield { kind: 'done', finish: 'cancelled' };
      } }); views.push(view.instance);
    await until(() => view.stdout.text.includes('READY'), 'ready'); view.stdin.write('go\r');
    try {
      await until(() => view.stdout.frame.includes('UNCERTAIN-CARD'), 'card'); await settle(30); view.stdin.write('y');
      await until(() => observed.controllers[0]!.snapshot().approval?.phase === 'unknown' && view.stdout.frame.includes('A-UNSETTLED uncertain'), 'unknown notice');
      expect(view.stdout.frame).not.toContain('A-PROMPT'); view.stdin.write('\u001b'); await until(() => signal.aborted, 'cancel via restored composer');
      await until(() => observed.controllers[0]!.snapshot().phase === 'idle', 'returned cancellation'); expect(observed.controllers[0]!.snapshot().last?.outcome).toBe('unknown');
    } finally { end.resolve(); }
  });
});

it('StrictMode effect replay keeps one dispatch and one exact cancellation owner', async context => {
  if (process.platform === 'win32') context.skip('INSTALLATION_IDENTITY_UNSUPPORTED: POSIX producer');
  const f = await fixture(), commands: ChatTurnCommand[] = [], cancelled: ChatTurnCancellation[] = [];
  const ports: TerminalAgentTurnPorts = {
    async chatTurn(_root, command, _event, _options, signal) {
      commands.push(command); await new Promise<void>(resolve => signal!.addEventListener('abort', () => resolve(), { once: true })); return result(command);
    }, async cancelChatTurn(_root, command) { cancelled.push(command); },
  };
  const view = mountWorkline({ context: f.identity, streamTurn: (messages, signal, turn) => streamTerminalAgentTurn({ projectRoot: f.project,
    scopeId: 's', messages, options: f.options, signal, ...turn }, ports) }, 200, { strict: true }); views.push(view.instance);
  await until(() => view.stdout.text.includes('READY'), 'strict view ready'); view.stdin.write('one\r');
  await until(() => commands.length === 1, 'one dispatch'); view.stdin.write('queued\r'); await settle(30); view.instance.unmount();
  await until(() => cancelled.length === 1, 'one cancellation'); await settle(30);
  expect(commands).toHaveLength(1); expect(cancelled).toEqual([{ schemaVersion: 1, scopeId: 's', turnId: commands[0]!.turnId }]);
});
