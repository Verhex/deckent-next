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
    // R4a: the real first-run template (v19), no injected MCP grant.
    const owner = adapters.readLocalOsIdentity(), { firstRunPolicyTemplate } = await import('#domain/index.js'), { FIRST_RUN_TOOL_NAMES } = await import('#engine/index.js');
    const template = firstRunPolicyTemplate({ scopeId: 's', principal: { issuer: owner.issuer, subject: owner.subject }, ...FIRST_RUN_TOOL_NAMES });
    await writeFile(join(f.data, 'policy.json'), JSON.stringify(template.policy), { mode: 0o600 }); await writeFile(join(f.data, 'bindings.json'), JSON.stringify(template.bindings), { mode: 0o600 }); clearConfigCache();
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

it('R4a: a customer worker edit follows its owning person\'s mode: default standart runs audited without a card, ask-edits shows a card', async () => {
  const f = await brainProviderFixture(), c = await connection();
  let port: Awaited<ReturnType<adapters.NativeCliWorkerPorts['openTools']>> | undefined;
  try {
    const projectOptions = { ...f.options, env: { ...f.options.env, DECKENT_GLOBAL_HOME: join(f.data, 'global') } };
    const owner = adapters.readLocalOsIdentity(), { firstRunPolicyTemplate } = await import('#domain/index.js'), { FIRST_RUN_TOOL_NAMES } = await import('#engine/index.js');
    const template = firstRunPolicyTemplate({ scopeId: 's', principal: { issuer: owner.issuer, subject: owner.subject }, ...FIRST_RUN_TOOL_NAMES });
    const bindings = (modes: unknown[]) => writeFile(join(f.data, 'bindings.json'), JSON.stringify({ schemaVersion: 3, revision: `b-${modes.length}`, bindings: [], modes }), { mode: 0o600 });
    await writeFile(join(f.data, 'policy.json'), JSON.stringify(template.policy), { mode: 0o600 }); await bindings([]); clearConfigCache();
    vi.spyOn(runs, 'recheckNativeWorkerUse').mockResolvedValue({ profile: c.profile } as never);
    const attempt = join(f.project, '..', 'customer-attempt'); await mkdir(join(attempt, 'src'), { recursive: true });
    port = await adapters.withMcpPrincipal(() => createConfiguredNativeCliWorkerRuntime(f.project, projectOptions)!.openTools({ protocolVersion: 1,
      identity: { scopeId: 's', runId: 'r', taskId: 'mode', attemptId: 'a', generation: 1, layoutRevision: 'l' }, workspace: attempt, argv: [] },
    {} as adapters.NativeCliWorkerBinding, new AbortController().signal, {}));
    const propose = (id: string, path: string, signal = new AbortController().signal) => adapters.withMcpPrincipal(() => port!.propose({ id, name: 'write_file',
      argumentsJson: JSON.stringify({ path, content: id }) }, { kind: 'claude-tool-use', toolUseId: id, deckentCallId: id }, signal));
    const sqlite = (await loadComposedConfig(f.project, projectOptions)).storage.sqlite;
    const pending = () => { const journal = adapters.openSqliteApprovalStore(f.path, sqlite); try { return journal.store.list('s', null, 100).filter(row => row.status === 'pending'); } finally { journal.close(); } };
    expect((await propose('default-write', 'src/default.ts')).outcome.status).toBe('ok');
    expect(pending()).toEqual([]); expect(await readFile(join(attempt, 'src/default.ts'), 'utf8')).toBe('default-write');
    const { DatabaseSync } = await import('node:sqlite'), db = new DatabaseSync(f.path, { readOnly: true });
    try { expect((db.prepare("SELECT record FROM audit_events WHERE kind = 'permission-mode'").all() as { record: string }[]).map(row => row.record).join()).toMatch(/"mode":"standart","cell":"edit-non-floor"/u); }
    finally { db.close(); }
    await bindings([{ id: 'person-ask', principal: { issuer: owner.issuer, subject: owner.subject }, scopes: ['s'], mode: 'standart', askEdits: true }]); clearConfigCache();
    const stop = new AbortController(), asked = propose('asked-write', 'src/asked.ts', stop.signal);
    let card: unknown[] = [];
    for (let n = 0; n < 200 && !card.length; n++) { card = pending(); if (!card.length) await new Promise(resolve => setTimeout(resolve, 10)); }
    expect(card).toHaveLength(1); stop.abort();
    expect((await asked).outcome.status).toBe('error');
    await expect(readFile(join(attempt, 'src/asked.ts'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(f.posts).toBe(0);
  } finally { if (port) await adapters.withMcpPrincipal(() => port!.cancel()); await f.close(); }
}, 30_000);

async function workerFixture(ttl = 5000) {
  const { modeRuntime, principal } = await import('../support/agent-turn-modes.js');
  // R4a: the real first-run template (v19) for the person, no injected MCP grant.
  const f = await modeRuntime({ mode: null, grants: [] });
  const { firstRunPolicyTemplate } = await import('#domain/index.js'), { FIRST_RUN_TOOL_NAMES } = await import('#engine/index.js');
  const template = firstRunPolicyTemplate({ scopeId: 'scope', principal: { issuer: principal.issuer, subject: principal.subject }, ...FIRST_RUN_TOOL_NAMES });
  await writeFile(join(f.data, 'policy.json'), JSON.stringify(template.policy), { mode: 0o600 }); await writeFile(join(f.data, 'bindings.json'), JSON.stringify(template.bindings), { mode: 0o600 });
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
    expect(card.request).toMatchObject({ preview: { schemaVersion: 1, argsDigest: worker?.argsDigest, text: expect.stringContaining('+approved-output'), cut: null } });
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
      // Real v19: the MCP actor holds no approval-decide rule (MCP-NO-DECIDE); the floor with a grant is engine/mcp-ai-actor.test.ts.
      expect(ai.status).toBe(0); expect(ai.output).toContain('APPROVAL_DENIED');
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
    preview: { schemaVersion: 1, argsDigest: subject.argsDigest, text: '+reviewed-content', cut: null },
    summary: workerToolCardSummary({ identity, turnId: subject.turnId, tool: subject.tool, resource: subject.resource, argsDigest: subject.argsDigest }) }, status: 'pending', revision: 0, decision: null } as unknown as import('#domain/index.js').ApprovalRecord;
  expect(mintAttendedWorkerDecision(record, { ...principal, issuer: principal.issuer + '/mcp' }, 10, true, ring, 50)).toBeNull();
  expect(mintAttendedWorkerDecision(record, principal, 10, false, ring, 50)).toBeNull();
  expect(mintAttendedWorkerDecision(record, principal, 10, true, ring, 100)).toBeNull();
  expect(mintAttendedWorkerDecision({ ...record, request: { ...record.request, subject: { ...subject, resource: 'elsewhere' } } } as never, principal, 10, true, ring, 50)).toBeNull();
  for (const preview of [undefined, { schemaVersion: 1, argsDigest: 'b'.repeat(64), text: 'foreign-call', cut: null },
    { schemaVersion: 1, argsDigest: subject.argsDigest, text: 'cut', cut: { shown: 1, total: 2, bytes: 3, totalBytes: 10, digest: 'c'.repeat(64), kept: '/synthetic/full' } }])
    expect(mintAttendedWorkerDecision({ ...record, request: { ...record.request, preview } } as never, principal, 10, true, ring, 50)).toBeNull();
  const capability = mintAttendedWorkerDecision(record, principal, 10, true, ring, 50)!;
  const evidence = { scopeId: 'scope', approvalId: 'card', decider: principal, peerPid: 10, capability, nowMs: 50 };
  expect(ring.attests({ ...evidence, peerPid: 11 })).toBe(false);
  expect(ring.attests({ ...evidence, decider: { ...principal, subject: 'other' } })).toBe(false);
  expect(ring.attests({ ...evidence, capability: 'A'.repeat(43) })).toBe(false);
  expect(ring.attests(evidence)).toBe(true); ring.settle(evidence); expect(ring.attests(evidence)).toBe(false);
});

it('K24 oversized worker diff is redacted, retained owner-only, and cannot mint or allow a cut card', async () => {
  const platform = await import('#platform/index.js'), { terminalRequest } = await import('../support/approval-terminal.js');
  const secret = 'synthetic-known-card-value';
  vi.spyOn(platform, 'getConfigKnownSecrets').mockReturnValue(platform.snapshotKnownSecrets([{ name: 'SYNTHETIC_CARD_SECRET', value: secret }]));
  const f = await workerFixture(), text = secret + '\n' + 'visible-diff-line\n'.repeat(1500) + 'unseen-tail';
  try {
    const write = adapters.withMcpPrincipal(() => f.port.propose({ id: 'oversized', name: 'write_file', argumentsJson: JSON.stringify({ path: 'src/oversized.ts', content: text }) },
      { kind: 'claude-tool-use', toolUseId: 'oversized', deckentCallId: 'oversized' }, new AbortController().signal));
    const card = await f.pending(); expect(card.request.schemaVersion).toBe(3);
    const preview = card.request.schemaVersion === 3 ? card.request.preview : undefined;
    expect(preview?.cut?.totalBytes).toBeGreaterThan(16_384); expect(preview?.argsDigest).toBe(approvalSubject(card.request).kind === 'agent-tool-call' ? (approvalSubject(card.request) as { argsDigest: string }).argsDigest : '');
    expect(JSON.stringify(card)).not.toContain(secret); expect(preview?.text).toContain('‹secret:SYNTHETIC_CARD_SECRET›');
    const retained = preview!.cut!.kept;
    const { stat } = await import('node:fs/promises');
    expect((await stat(retained!)).mode & 0o777).toBe(0o600);
    const full = await readFile(retained!, 'utf8'); expect(full).toContain('unseen-tail'); expect(full).not.toContain(secret); expect(platform.sha256(full)).toBe(preview?.cut?.digest);
    const command = { schemaVersion: 1, scopeId: 'scope', approvalId: card.request.approvalId, expectedRevision: card.revision, reason: 'synthetic person sees only the cut', channel: 'local-terminal-card' };
    expect((await terminalRequest(f, 'decideApproval', { ...command, decision: 'allow', commandId: 'cut-worker-allow' })).response).toMatchObject({ ok: false, error: { code: 'APPROVAL_ASSURANCE_INSUFFICIENT' } });
    await expect(readFile(join(f.attempt, 'src/oversized.ts'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await terminalRequest(f, 'decideApproval', { ...command, decision: 'deny', commandId: 'cut-worker-deny' })).response.ok).toBe(true);
    expect((await write).outcome).toMatchObject({ status: 'error', text: expect.stringContaining('denied-by-owner') });
    await expect(readFile(retained!)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await adapters.withMcpPrincipal(() => f.port.cancel()); }
}, 30_000);

it('K24 a truncated worker summary and a genuine capability cannot authorize an unseen cut diff', async () => {
  const { terminalRuntimePeer, createTerminalRuntimeClient } = await import('../support/terminal-runtime-client.js');
  const { terminalRequest } = await import('../support/approval-terminal.js');
  const { createTurnDecisionCapabilities } = await import('#engine/index.js');
  const { configuredApproval } = await import('#composition/core/approvals/index.js');
  const { principal } = await import('../support/agent-turn-modes.js');
  const f = await workerFixture(), dir = 'src/' + Array.from({ length: 40 }, () => 'nested-directory-'.repeat(3)).join('/'), path = dir + '/unseen.ts';
  try {
    await mkdir(join(f.attempt, dir), { recursive: true });
    const write = adapters.withMcpPrincipal(() => f.port.propose({ id: 'long-path', name: 'write_file', argumentsJson: JSON.stringify({ path, content: 'unseen-change\n'.repeat(2000) }) },
      { kind: 'claude-tool-use', toolUseId: 'long-path', deckentCallId: 'long-path' }, new AbortController().signal));
    const card = await f.pending();
    expect(card.request.summary.length).toBeLessThanOrEqual(2048); expect((await import('#capabilities/index.js')).readWorkerToolCard(card.request.summary)).toMatchObject({ kind: 'worker-tool-call' }); // A6-2: the card stays readable
    expect(card.request.schemaVersion === 3 && card.request.preview?.cut).toBeTruthy();
    const peer = await terminalRuntimePeer(createTerminalRuntimeClient(f.project, { env: f.env })), ring = createTurnDecisionCapabilities();
    const capability = ring.mint({ scopeId: 'scope', approvalId: card.request.approvalId, principal, peerPid: peer.pid, expiresAt: card.request.expiresAt }, Date.now());
    const command = { schemaVersion: 1, scopeId: 'scope', approvalId: card.request.approvalId, expectedRevision: card.revision, reason: 'synthetic person attempts the exact unseen change' };
    let error: unknown;
    try { await configuredApproval(f.project, 'decide', { ...command, decision: 'allow', commandId: 'truncated-summary-allow', decisionCapability: capability }, { env: f.env }, peer, undefined, {}, ring); }
    catch (failure) { error = failure; }
    if (!error) await write;
    await expect(readFile(join(f.attempt, path))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(error).toMatchObject({ code: 'APPROVAL_ASSURANCE_INSUFFICIENT' });
    expect((await terminalRequest(f, 'decideApproval', { ...command, decision: 'deny', commandId: 'truncated-summary-deny' })).response.ok).toBe(true);
    expect((await write).outcome).toMatchObject({ status: 'error', text: expect.stringContaining('denied-by-owner') });
  } finally { await adapters.withMcpPrincipal(() => f.port.cancel()); }
}, 30_000);

it('A6-2: a long worker target still stores a readable worker card (the interactive-human rule holds); a card that cannot fit is refused', async () => {
  const { workerToolCardSummary, readWorkerToolCard } = await import('#capabilities/index.js');
  const { sha256 } = await import('#platform/index.js');
  const identity = { runId: 'r', taskId: 't', attemptId: 'a', scopeId: 'scope', layoutRevision: 'l', generation: 1 }, target = 'src/' + 'ş"'.repeat(3000);
  const summary = workerToolCardSummary({ identity, turnId: 'worker-turn', tool: 'write_file', resource: target, argsDigest: 'a'.repeat(64) });
  expect(summary.length).toBeLessThanOrEqual(2048);
  expect(readWorkerToolCard(summary.slice(0, 2048))).toMatchObject({ kind: 'worker-tool-call', resourceDigest: sha256(target) });
  expect(() => workerToolCardSummary({ identity, turnId: 'worker-turn', tool: 'x'.repeat(3000), resource: 'a', argsDigest: 'a'.repeat(64) }))
    .toThrow(expect.objectContaining({ code: 'APPROVAL_INVALID' }));
});
