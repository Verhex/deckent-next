import { execFileSync } from 'node:child_process';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import * as adapters from '#adapters/index.js';
import * as runs from '#composition/core/runs/index.js';
import { createConfiguredNativeCliWorkerRuntime } from '#composition/core/execution/index.js';
import { loadComposedConfig } from '#composition/core/root/index.js';
import { clearConfigCache } from '#platform/index.js';
import { approvalFacts, approvalSubject } from '#domain/index.js';
import { brainProviderFixture } from '../support/brain-provider.js';
import { connection, cleanupConnections } from '../../fixtures/native-headless/connection.js';

afterEach(async () => { await (await import('../support/agent-turn-modes.js')).closeModeRuntimes(); vi.restoreAllMocks(); await cleanupConnections(); clearConfigCache(); });

it('K23 measures real worker cards in disposable customer and self-source Attempt workspaces', async () => {
  const f = await brainProviderFixture(), c = await connection();
  let port: Awaited<ReturnType<adapters.NativeCliWorkerPorts['openTools']>> | undefined;
  try {
    const identity = adapters.isSelfSourceProject;
    execFileSync('git', ['init', '-q', f.project]);
    const common = await realpath(join(f.project, '.git'));
    const projectOptions = { ...f.options, env: { ...f.options.env, DECKENT_GLOBAL_HOME: join(f.data, 'global') } };
    const configPath = join(f.project, '.deckent/config.json'), config = JSON.parse(await readFile(configPath, 'utf8'));
    config.approvals = { requestTtlMs: 2000 }; await writeFile(configPath, JSON.stringify(config));
    const owner = adapters.readLocalOsIdentity(), principals = [{ issuer: `${owner.issuer}/mcp`, subject: owner.subject }];
    const policyPath = join(f.data, 'policy.json'), policy = JSON.parse(await readFile(policyPath, 'utf8'));
    policy.grants.push(...[
      { id: 'tools', actions: ['invoke'], resource: { kind: 'agent-tool', ids: 'all' } },
      { id: 'effects', actions: ['execute'], resource: { kind: 'operation', ids: 'all' } },
    ].map(row => ({ ...row, effect: 'allow', principals, scopes: ['s'] })));
    await writeFile(policyPath, JSON.stringify(policy), { mode: 0o600 }); clearConfigCache();
    vi.spyOn(runs, 'recheckNativeWorkerUse').mockResolvedValue({ profile: c.profile } as never);
    const source = vi.spyOn(adapters, 'isSelfSourceProject');
    const sqlite = (await loadComposedConfig(f.project, projectOptions)).storage.sqlite;
    const rows: unknown[] = [];
    for (const selfSource of [false, true]) {
      const build = { sourceCommonDir: selfSource ? common : join(f.data, 'unrelated.git') };
      expect(await identity(f.project, build)).toBe(selfSource);
      source.mockImplementation(root => identity(root, build));
      const attempt = join(f.project, '..', selfSource ? 'self-attempt' : 'customer-attempt'); await mkdir(join(attempt, 'src'), { recursive: true });
      await writeFile(join(attempt, 'note.txt'), 'attempt-only');
      port = await adapters.withMcpPrincipal(() => createConfiguredNativeCliWorkerRuntime(f.project, projectOptions)!.openTools({ protocolVersion: 1,
        identity: { scopeId: 's', runId: 'r', taskId: selfSource ? 'self' : 'customer', attemptId: 'a', generation: 1, layoutRevision: 'l' }, workspace: attempt, argv: [] },
      {} as adapters.NativeCliWorkerBinding, new AbortController().signal, {}));
      for (const [group, name, args] of [
        ['read', 'read_file', { path: 'note.txt' }],
        ['write', 'write_file', { path: 'src/result.ts', content: 'worker-result' }],
        ['shell', 'run_shell', { command: 'pwd' }],
        ['floor', 'write_file', { path: 'package.json', content: '{}' }],
      ] as const) {
        const stop = new AbortController(), id = `${selfSource}-${group}`;
        const pending = adapters.withMcpPrincipal(() => port!.propose({ id, name, argumentsJson: JSON.stringify(args) },
          { kind: 'claude-tool-use', toolUseId: id, deckentCallId: id }, stop.signal));
        let result: Awaited<typeof pending> | undefined, failed: unknown;
        void pending.then(value => { result = value; }, error => { failed = error; });
        let card: import('#domain/index.js').ApprovalRecord | undefined;
        for (let n = 0; n < 100 && !result && !failed; n++) {
          const journal = adapters.openSqliteApprovalStore(f.path, sqlite);
          try { card = journal.store.list('s', null, 100).find(row => row.status === 'pending'); } finally { journal.close(); }
          if (card) break;
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        const facts = card ? approvalFacts(card.request) : null;
        rows.push({ selfSource, group, tool: name, args, card: Boolean(card), facts, subject: card ? approvalSubject(card.request) : null });
        stop.abort(); const settled = await pending; console.log('K23-ROW ' + JSON.stringify({ selfSource, group, facts, settled }));
        if (group === 'read') expect(result?.outcome.status).toBe('ok');
        if (group === 'floor') expect(settled.outcome).toMatchObject({ status: 'error', text: expect.stringContaining('denied-by-policy') });
        if (group === 'write' && selfSource) expect(facts?.risk).toEqual({ source: 'cell', cell: 'edit-self-source' });
      }
      await adapters.withMcpPrincipal(() => port!.cancel()); port = undefined;
    }
    console.log('K23-MEASUREMENT ' + JSON.stringify(rows)); expect(f.posts).toBe(0);
  } finally { if (port) await adapters.withMcpPrincipal(() => port!.cancel()); await f.close(); }
}, 30_000);

async function workerFixture(ttl = 5000) {
  const { modeRuntime, rule, principal } = await import('../support/agent-turn-modes.js');
  const f = await modeRuntime({ mode: null, grants: [
    { id: 'worker-approval', actions: ['inspect', 'decide'], resource: { kind: 'approval', ids: 'all' }, effect: 'allow', scopes: ['scope'], principals: [{ issuer: `${principal.issuer}/mcp`, subject: principal.subject }] },
    ...[rule('worker-tools', 'agent-tool', ['write_file', 'read_file'], 'allow'), rule('worker-effects', 'operation', ['workspace.file.write'], 'allow')]
      .map(row => ({ ...row, principals: [{ issuer: `${principal.issuer}/mcp`, subject: principal.subject }] })),
  ] });
  const configPath = join(f.project, '.deckent/config.json'), config = JSON.parse(await readFile(configPath, 'utf8'));
  config.approvals = { requestTtlMs: ttl }; await writeFile(configPath, JSON.stringify(config)); clearConfigCache();
  execFileSync('git', ['init', '-q', f.project]); const common = await realpath(join(f.project, '.git'));
  const identityCheck = adapters.isSelfSourceProject;
  vi.spyOn(adapters, 'isSelfSourceProject').mockImplementation(root => identityCheck(root, { sourceCommonDir: common }));
  const c = await connection(); vi.spyOn(runs, 'recheckNativeWorkerUse').mockResolvedValue({ profile: c.profile } as never);
  const attempt = join(f.project, '..', 'attempt'); await mkdir(join(attempt, 'src'), { recursive: true });
  const options = { env: { ...f.env, DECKENT_GLOBAL_HOME: join(f.project, '..', 'global') } };
  const context = await (await import('#composition/core/scoped-request/index.js')).loadConfiguredScopeContext(f.project, 'scope', options, 'read');
  await adapters.openLocalIntegrityAuthority(context.layout, context.config.approvals.keyFile, true);
  const port = await adapters.withMcpPrincipal(() => createConfiguredNativeCliWorkerRuntime(f.project, options)!.openTools({ protocolVersion: 1,
    identity: { scopeId: 'scope', runId: 'worker-run', taskId: 'worker-task', attemptId: 'worker-attempt', generation: 1, layoutRevision: 'layout' }, workspace: attempt, argv: [] },
  {} as adapters.NativeCliWorkerBinding, new AbortController().signal, {}));
  const propose = (id: string, path: string, signal = new AbortController().signal) => adapters.withMcpPrincipal(() => port.propose({ id, name: 'write_file', argumentsJson: JSON.stringify({ path, content: id }) },
    { kind: 'claude-tool-use', toolUseId: id, deckentCallId: id }, signal));
  const pending = async () => {
    for (let n = 0; n < 100; n++) {
      const rows = await f.client.listApprovals({ schemaVersion: 1, scopeId: 'scope', afterId: null, limit: 100 }) as import('#domain/index.js').ApprovalRecord[];
      const card = rows.find(row => row.status === 'pending'); if (card) return card;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('worker-card-not-visible');
  };
  return { ...f, attempt, port, propose, pending };
}

it('K23 witnessed worker approval writes only its Attempt; denial and unattended AI/SDK leave targets unchanged', async () => {
  const { terminalRequest } = await import('../support/approval-terminal.js');
  const f = await workerFixture();
  try {
    const write = f.propose('approved-output', 'src/allowed.ts'), card = await f.pending();
    const worker = (await import('#capabilities/index.js')).readWorkerToolCard(card.request.summary);
    expect(worker).toMatchObject({ identity: { runId: 'worker-run', taskId: 'worker-task', attemptId: 'worker-attempt' }, tool: 'write_file', resource: 'src/allowed.ts' });
    expect(worker?.argsDigest).toMatch(/^[a-f0-9]{64}$/u);
    const command = { schemaVersion: 1, scopeId: 'scope', approvalId: card.request.approvalId, expectedRevision: card.revision, reason: 'Reviewed exact worker call', decision: 'allow' };
    await expect(f.client.decideApproval({ ...command, commandId: 'unattended-worker' })).rejects.toMatchObject({ code: 'APPROVAL_INTERACTIVE_REQUIRED' });
    await expect(readFile(join(f.attempt, 'src/allowed.ts'))).rejects.toMatchObject({ code: 'ENOENT' });
    const { terminalProgram } = await import('../support/approval-terminal.js');
    const { resolveProductLayout } = await import('#platform/index.js');
    const { RUNTIME_SERVICE_SCHEMA_VERSION } = await import('#engine/index.js');
    const endpoint = adapters.runtimeSocketLocation(resolveProductLayout({ projectRoot: f.project, root: f.data }));
    for (const decision of ['allow', 'deny']) {
      const ai = await terminalProgram([process.execPath, resolve('tests/fixtures/approval-terminal-peer.mjs'), endpoint,
        JSON.stringify({ schemaVersion: RUNTIME_SERVICE_SCHEMA_VERSION, requestId: 'mcp-worker-' + decision, channel: 'mcp', operation: 'decideApproval', delivery: { maxResultBytes: 65536 },
          input: { ...command, decision, commandId: 'mcp-tty-worker-' + decision, channel: 'local-terminal-card' } }), ''], f.env);
      expect(ai.status).toBe(0); expect(ai.output).toContain('AI_AUTHORITY_NON_DELEGABLE');
    }
    const allowed = await terminalRequest(f, 'decideApproval', { ...command, commandId: 'human-worker', channel: 'local-terminal-card' });
    expect(allowed.response).toMatchObject({ ok: true, result: { decision: { assurance: 'turn-bound', deciderClass: 'human-tty' } } });
    expect((await write).outcome.status).toBe('ok'); expect(await readFile(join(f.attempt, 'src/allowed.ts'), 'utf8')).toBe('approved-output');
    await expect(readFile(join(f.project, 'src/allowed.ts'))).rejects.toMatchObject({ code: 'ENOENT' });
    const deniedWrite = f.propose('denied-output', 'src/denied.ts'), deniedCard = await f.pending();
    expect((await terminalRequest(f, 'decideApproval', { ...command, approvalId: deniedCard.request.approvalId, commandId: 'human-deny-worker', decision: 'deny' })).response.ok).toBe(true);
    expect((await deniedWrite).outcome).toMatchObject({ status: 'error', text: expect.stringContaining('denied-by-owner') });
    await expect(readFile(join(f.attempt, 'src/denied.ts'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await adapters.withMcpPrincipal(() => f.port.cancel()); }
}, 30_000);

it('K23 the bridge deadline before the card TTL still expires durably and overrides model success', async () => {
  const { nativeWorkerProcessResult, nativeWorkerToolGate } = await import('#capabilities/index.js');
  const f = await workerFixture(5000);
  try {
    const deadline = new AbortController(), write = f.propose('expired-output', 'src/expired.ts', deadline.signal), card = await f.pending();
    expect(card.request.expiresAt).toBeGreaterThan(Date.now());
    deadline.abort(new DOMException('bridge deadline', 'TimeoutError'));
    expect((await write).outcome).toMatchObject({ status: 'error', text: expect.stringContaining('cancelled') });
    expect(await f.client.inspectApproval({ schemaVersion: 1, scopeId: 'scope', approvalId: card.request.approvalId })).toMatchObject({ status: 'expired' });
    expect(f.port.terminalFailure?.()).toBe('approval-expired');
    const gate = nativeWorkerToolGate(f.port, new AbortController().signal);
    expect(nativeWorkerProcessResult({ reason: 'exit', limit: null, stdoutTruncated: false, stderrTruncated: false }, false, false,
      { kind: 'completed', text: 'the model says done' }, undefined, gate.terminalFailure())).toMatchObject({ status: 'failed', text: 'APPROVAL_EXPIRED' });
    await expect(readFile(join(f.attempt, 'src/expired.ts'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(f.propose('retry', 'src/retry.ts')).rejects.toMatchObject({ code: 'APPROVAL_EXPIRED' });
  } finally { await adapters.withMcpPrincipal(() => f.port.cancel()); }
}, 30_000);

it('K23 worker mint refuses AI, expiry, foreign subject and forged capability while keeping peer/principal binding single-use', async () => {
  const { nativeWorkerApprovalExpired, mintAttendedWorkerDecision, workerToolCardSummary } = await import('#capabilities/index.js');
  const { createTurnDecisionCapabilities } = await import('#engine/index.js');
  const { principal } = await import('../support/agent-turn-modes.js');
  expect(nativeWorkerApprovalExpired(100, { wallMs: 50, monotonicMs: 5 }, { wallMs: 40, monotonicMs: 55 })).toBe(true);
  const ring = createTurnDecisionCapabilities(), identity = { runId: 'r', taskId: 't', attemptId: 'a', scopeId: 'scope', layoutRevision: 'l', generation: 1 };
  const subject = { kind: 'agent-tool-call' as const, turnId: 'worker-turn', round: 0, index: 0, tool: 'write_file', toolVersion: 1, resource: 'src/x.ts', argsDigest: 'a'.repeat(64) };
  const record = { request: { schemaVersion: 3, scopeId: 'scope', approvalId: 'card', subject, expiresAt: 100,
    summary: workerToolCardSummary({ identity, turnId: subject.turnId, tool: subject.tool, resource: subject.resource, argsDigest: subject.argsDigest }) }, status: 'pending', revision: 0, decision: null } as unknown as import('#domain/index.js').ApprovalRecord;
  expect(mintAttendedWorkerDecision(record, { ...principal, issuer: principal.issuer + '/mcp' }, 10, true, ring, 50)).toBeNull();
  expect(mintAttendedWorkerDecision(record, principal, 10, false, ring, 50)).toBeNull();
  expect(mintAttendedWorkerDecision(record, principal, 10, true, ring, 100)).toBeNull();
  expect(mintAttendedWorkerDecision({ ...record, request: { ...record.request, subject: { ...subject, resource: 'elsewhere' } } } as never, principal, 10, true, ring, 50)).toBeNull();
  const capability = mintAttendedWorkerDecision(record, principal, 10, true, ring, 50)!;
  const evidence = { scopeId: 'scope', approvalId: 'card', decider: principal, peerPid: 10, capability, nowMs: 50 };
  expect(ring.attests({ ...evidence, peerPid: 11 })).toBe(false);
  expect(ring.attests({ ...evidence, decider: { ...principal, subject: 'other' } })).toBe(false);
  expect(ring.attests({ ...evidence, capability: 'A'.repeat(43) })).toBe(false);
  expect(ring.attests(evidence)).toBe(true); ring.settle(evidence); expect(ring.attests(evidence)).toBe(false);
});
