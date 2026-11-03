import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { brainProviderFixture } from '../support/brain-provider.js';
import { createTerminalRuntimeClient, terminalRuntimePeer } from '../support/terminal-runtime-client.js';
import { DRIVER } from '../support/pty-steps.js';
import { nativeAgentRealmAvailable, writeFakeAgentCli } from '../../fixtures/native-headless/agent.js';
import { testIsolation } from '../../fixtures/native-headless/connection.js';
import { settleOnboarding } from '../../fixtures/onboarding-settled.js';
import { createNativeAgentDriver, preflightNativeAgent, readNativeAgentObservation } from '#adapters/core/native-cli-headless/index.js';
import { nativeCliAgent } from '#adapters/core/native-cli-registry/index.js';
import { createNativeToolBridge } from '#adapters/core/native-tool-bridge/index.js';
import { nativeEgressLimits } from '#adapters/core/native-connection/index.js';
import { readLocalOsIdentity } from '#adapters/core/local-principal/index.js';
import { modelInvocationProfileSchema, parseModelBindingDefinition, type AgentTurnStreamEvent } from '#domain/index.js';
import { describeTerminalChat } from '#composition/core/terminal-chat/index.js';
import { createConfiguredNativeChatRuntime } from '#composition/core/agent-turn/index.js';
import { clearConfigCache, resolveProductLayout, snapshotKnownSecrets } from '#platform/index.js';
import registry from '../../../assets/native-coding/commands.json' with { type: 'json' };

const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); });
const families = [registry.adapters.claude.capabilities.eventStream, registry.adapters.codex.headless.protocolFamily];
const cli = resolve('dist/composition/core/cli/internal/entry.js');
const execute = promisify(execFile);
async function fixture(family: string) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-k16-production-'));
  closers.push(() => rm(root, { recursive: true, force: true }));
  const global = join(root, 'global'), bin = join(root, 'bin');
  const configDir = join(global, 'headless', 'logins', nativeCliAgent(family)!.id), stateDir = join(global, 'headless', 'connections', 'fixture');
  await mkdir(configDir, { recursive: true, mode: 0o700 }); await mkdir(bin);
  const credential = join(configDir, family === families[0] ? '.credentials.json' : 'auth.json');
  const canary = 'K16-LOGIN-CANARY-88e6c19'; await writeFile(credential, canary, { mode: 0o600 });
  const traceFile = join(configDir, family === families[0] ? '.claude.json' : 'config.toml');
  const executable = await writeFakeAgentCli(bin, family, { traceFile, turns: [
    { when: 'K16-READ', answer: 'K16-READ-OK', calls: [{ name: 'read_file', arguments: { path: 'input.txt' } }] },
    { when: 'K16-WRITE', answer: 'K16-WRITE-OK', calls: [{ name: 'write_file', arguments: { path: 'result.txt', content: 'business result\n' } }] },
    { when: 'K16-DENY', answer: 'K16-DENY-OK', calls: [{ name: 'write_file', arguments: { path: 'denied.txt', content: 'must not happen\n' } }] },
    { when: 'K16-SHELL', answer: 'K16-SHELL-OK', calls: [{ name: 'run_shell', arguments: { command: "printf '%s\\n' sandbox-ok > shell-result.txt; cat shell-result.txt" } }] },
    { when: 'K16-PROTECTED', answer: 'K16-PROTECTED-DONE', calls: [{ name: 'run_shell', arguments: { command: `cat '${credential}'` } }] },
    { when: 'K16-ATTACK', answer: 'K16-ATTACK-DONE', calls: [{ name: 'run_shell', arguments: { command: `cd /; cat '${credential.slice(1)}'` } }] },
    { when: 'K16-REVOKE', answer: 'K16-REVOKE-DONE', calls: [{ name: 'write_file', arguments: { path: 'revoked.txt', content: 'must not happen\n' } }] },
    { when: 'K16-WAIT', hang: true }, { when: 'K16-PLUGIN', pluginMismatch: true, nativeItem: true },
  ] });
  const owner = readLocalOsIdentity();
  const f = await brainProviderFixture({ headless: { executable, configDir, stateDir, protocolFamily: family,
    delegatedUse: { consentedBy: { issuer: owner.issuer, subject: owner.subject }, atMs: 1, classes: ['ai'] } } });
  closers.push(f.close);
  const options = { env: { ...f.options.env, DECKENT_GLOBAL_HOME: global } };
  const config = JSON.parse(await readFile(join(f.project, '.deckent/config.json'), 'utf8'));
  config.provider_invocation_profiles.profiles[0].limits.timeoutMs = 120_000;
  config.cancellation = { maxConcurrentDeliveries: 1 };
  config.cancellationRuntime = { scopeIds: ['s'], pollIntervalMs: 2147483647, failureBackoffMs: 1000 };
  config.runRuntime = { pollIntervalMs: 2147483647 };
  config.toolchains = { update: { atStartup: false, intervalMs: 0 } };
  config.approvals = { requestTtlMs: 120_000 };
  await writeFile(join(f.project, '.deckent/config.json'), JSON.stringify(config));
  const policy = JSON.parse(await readFile(join(f.data, 'policy.json'), 'utf8'));
  const ai = { issuer: `${owner.issuer}/mcp`, subject: owner.subject };
  policy.grants.push({ id: 'ai-model', effect: 'allow', scopes: ['s'], principals: [ai], actions: ['invoke', 'inspect', 'inspect-content', 'cancel-invocation'], resource: { kind: 'model-invocation', ids: 'all' } },
    { id: 'ai-read', effect: 'allow', scopes: ['s'], principals: [ai], actions: ['invoke'], resource: { kind: 'agent-tool', ids: ['read_file'] } },
    { id: 'ai-proposals', effect: 'require-approval', scopes: ['s'], principals: [ai], actions: ['invoke'], resource: { kind: 'agent-tool', ids: ['write_file', 'run_shell'] } },
    { id: 'ai-effects', effect: 'allow', scopes: ['s'], principals: [ai], actions: ['execute'], resource: { kind: 'operation', ids: ['workspace.file.write', 'host.shell.run'] } });
  await writeFile(join(f.data, 'policy.json'), JSON.stringify(policy)); clearConfigCache();
  await writeFile(join(f.project, 'input.txt'), 'BUSINESS-READBACK\n');
  const profile = modelInvocationProfileSchema.parse(config.provider_invocation_profiles.profiles[0]);
  const runtime = createConfiguredNativeChatRuntime(f.project, options)!;
  expect((await describeTerminalChat(f.project, options)).tools).toBe('none');
  const { execution } = await preflightNativeAgent(profile, Date.now, testIsolation);
  const session = { schemaVersion: 1 as const, turnId: 'explicit-synthetic-inspection', generation: 1, approvalTtlMs: 120_000, tools: [] };
  const closure = { turnId: session.turnId, generation: 1, pendingCallIds: [], termination: 'confirmed' as const, effects: 'settled' as const };
  const driver = createNativeAgentDriver({ profile, execution, now: Date.now, isolation: testIsolation, session: { session,
    propose: async () => { throw new Error('inspection-has-no-tools'); }, cancel: async () => ({ ...closure, kind: 'cancelled' }), revoke: async () => ({ ...closure, kind: 'revoked' }) } });
  const bridge = await createNativeToolBridge({ port: driver.port, bridge: nativeCliAgent(family)!.bridge, limits: runtime.limits,
    correlationKind: family === families[0] ? 'claude-tool-use' : 'codex-mcp' });
  try {
    const native = driver.native(bridge, { configured: snapshotKnownSecrets([]), turn: snapshotKnownSecrets([{ name: bridge.tokenEnvName, value: bridge.turnToken }]) });
    const binding = parseModelBindingDefinition({ encodingVersion: 1, provider: { id: f.reference.providerId, version: 1 }, model: config.provider_catalog.providers[0].models[0] });
    expect(await native.send(await native.prepare(profile, binding, { model: 'vendor/model', messages: [{ role: 'system', content: '' }, { role: 'user', content: 'K16-SEAL' }], stream: false }))).toMatchObject({ schemaVersion: 1 });
  } finally { await bridge.close(); await driver.close(); }
  expect((await describeTerminalChat(f.project, options)).tools).toBe('available');
  await settleOnboarding(resolveProductLayout({ projectRoot: f.project, root: f.data }));
  const child = spawn(process.execPath, [cli, 'runtime', 'serve', '--json'], { cwd: f.project, env: options.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let serviceOut = '', serviceErr = '';
  child.stdout.on('data', chunk => { serviceOut += String(chunk); }); child.stderr.on('data', chunk => { serviceErr += String(chunk); });
  closers.push(async () => { if (child.exitCode !== null) return; const closed = once(child, 'close'); child.kill('SIGTERM'); await closed; });
  await new Promise<void>((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error(`compiled-service-not-ready: ${serviceErr}`)), 20_000);
    child.stdout.on('data', () => { if (serviceOut.split('\n').some(line => { try { return JSON.parse(line).event === 'ready'; } catch { return false; } })) { clearTimeout(timer); resolveReady(); } });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`compiled-service-exit-${code}: ${serviceErr}`)); });
  });
  return { f, options, profile, config, credential, canary, traceFile, service: child as ChildProcess };
}

it('compiled service and real synthetic-person PTY use both production CLI drivers: approve-card-then-assert, denial, protected shell, idle wait and revoke', async () => {
  if (!await nativeAgentRealmAvailable(expect.getState().testPath ?? 'unknown', expect.getState().currentTestName ?? 'unknown')) return;
  for (const family of families) {
    const h = await fixture(family), client = createTerminalRuntimeClient(h.f.project, h.options);
    await terminalRuntimePeer(client);
    const turn = (id: string) => ({ schemaVersion: 1 as const, scopeId: 's', turnId: id, messages: [{ role: 'user' as const, content: id }] });
    const events: AgentTurnStreamEvent[] = [], decisions: unknown[] = [];
    const call = async (id: string, decision: 'allow' | 'deny', before?: () => Promise<void>) => {
      const pending: Promise<unknown>[] = [];
      const result = await client.chatTurn(turn(id), event => { events.push(event); if (event.kind === 'approval.requested') pending.push((async () => {
        await before?.(); const record = await client.decideApproval({ schemaVersion: 1, commandId: `decision-${id}`, scopeId: 's', approvalId: event.approvalId,
          expectedRevision: event.revision, decisionCapability: event.decisionCapability, decision, reason: 'synthetic-person reviewed exact request' }); decisions.push(record);
      })()); });
      await Promise.all(pending);
      return result;
    };
    expect(await call('K16-READ', 'allow')).toMatchObject({ finish: 'stop', toolCalls: 1 });
    expect(await call('K16-WRITE', 'allow', async () => {
      expect(await readFile(join(h.f.project, 'result.txt'), 'utf8').catch(() => null)).toBeNull();
      // Actual gateway idle=30s is crossed while the authoritative approval card remains pending.
      await new Promise(resolveWait => setTimeout(resolveWait, nativeEgressLimits().idleMs + 1000));
    })).toMatchObject({ finish: 'stop', toolCalls: 1 });
    expect(await readFile(join(h.f.project, 'result.txt'), 'utf8')).toBe('business result\n');
    expect(await call('K16-DENY', 'deny')).toMatchObject({ toolCalls: 0 });
    expect(await readFile(join(h.f.project, 'denied.txt'), 'utf8').catch(() => null)).toBeNull();
    expect(await call('K16-SHELL', 'allow')).toMatchObject({ toolCalls: 1 });
    expect(await readFile(join(h.f.project, 'shell-result.txt'), 'utf8')).toBe('sandbox-ok\n');
    expect(await call('K16-PROTECTED', 'allow')).toMatchObject({ toolCalls: 0 });
    expect(await call('K16-ATTACK', 'allow')).toMatchObject({ toolCalls: 1 });
    expect(await readFile(h.credential, 'utf8')).toBe(h.canary);
    const records = decisions as { request: { requester: { issuer: string } }; decision: { deciderClass: string; actor: { issuer: string } } }[];
    expect(records).toHaveLength(4);
    for (const record of records) { expect(record.request.requester.issuer).toMatch(/\/mcp$/u); expect(record.decision.deciderClass).toBe('human-tty'); expect(record.decision.actor.issuer).not.toMatch(/\/mcp$/u); }
    expect(await client.chatTurn(turn('K16-WRITE'), event => events.push(event))).toMatchObject({ replayed: true });
    await call('K16-REVOKE', 'allow', async () => {
      h.config.provider_invocation_profiles.profiles[0].adapter.definition.delegatedUse = null;
      await writeFile(join(h.f.project, '.deckent/config.json'), JSON.stringify(h.config));
    });
    expect(await readFile(join(h.f.project, 'revoked.txt'), 'utf8').catch(() => null)).toBeNull();
    expect(JSON.stringify(events)).not.toContain(h.canary);
    expect(await readFile(h.traceFile, 'utf8')).not.toContain(h.canary);
    if (process.env['K16_PROOF_DIR']) await writeFile(join(process.env['K16_PROOF_DIR'], `compiled-${nativeCliAgent(family)!.id}${process.env['CI'] === 'true' ? '-ci' : ''}.json`), JSON.stringify({ events, decisions }, null, 2));
  }
}, 150_000);

it('compiled Workline in a real PTY cancels with Esc, stops plugin/native-surface mismatch and continues text chat for both CLIs', async () => {
  if (!await nativeAgentRealmAvailable(expect.getState().testPath ?? 'unknown', expect.getState().currentTestName ?? 'unknown')) return;
  for (const family of families) {
    for (const walk of ['plugin', 'cancel']) {
    const h = await fixture(family);
    const steps = walk === 'cancel' ? [['Deckent workline', 'K16-WAIT\r'], ['K16-WAITING', '\u001b'], ['cancelled', '/exit\r']]
      : [['Deckent workline', 'K16-PLUGIN\r'], [family === families[0] ? 'The CLI loaded a plugin' : 'The CLI exposed an unexpected tool', 'after mismatch\r'], ['text-only still available', '/exit\r']];
    const { stdout } = await execute('python3', ['-c', DRIVER.replaceAll('time.time() + 40', 'time.time() + 15'), JSON.stringify([process.execPath, cli, 'terminal', 'workline', '--scope', 's']), JSON.stringify(steps), 'tty', 'until-exit'],
      { cwd: h.f.project, env: { ...h.options.env, TERM: 'xterm-256color', NO_COLOR: '1', DECKENT_LANGUAGE: 'en' }, timeout: 100_000, maxBuffer: 16 * 1024 * 1024 });
    const result = JSON.parse(stdout) as { status: number; timeout?: string; output: string };
    if (process.env['K16_PROOF_DIR']) await writeFile(join(process.env['K16_PROOF_DIR'], `workline-${nativeCliAgent(family)!.id}-${walk}${process.env['CI'] === 'true' ? '-ci' : ''}.json`), JSON.stringify(result));
    expect(result.timeout, result.output.slice(-5000)).toBeUndefined(); expect(result.status).toBe(0);
    expect(result.output).not.toContain(h.canary);
    expect(await readFile(h.traceFile, 'utf8')).not.toContain(h.canary);
    expect(await readNativeAgentObservation(h.profile)).not.toMatchObject({ toolSurface: true });
    }
  }
}, 150_000);
