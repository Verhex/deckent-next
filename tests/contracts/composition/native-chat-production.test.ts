import { configuredNativeChatReadiness } from '#composition/core/subscription-readiness/index.js';
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
import { settleOnboarding } from '../../fixtures/onboarding-settled.js';
import { readNativeAgentObservation } from '#adapters/core/native-cli-headless/index.js';
import { nativeCliAgent } from '#adapters/core/native-cli-registry/index.js';
import { nativeEgressLimits } from '#adapters/core/native-connection/index.js';
import { readLocalOsIdentity, withMcpPrincipal } from '#adapters/core/local-principal/index.js';
import { createConfiguredRuntimeClient } from '#composition/core/runtime-service/index.js';
import { firstRunPolicyTemplate, modelInvocationProfileSchema, type AgentTurnStreamEvent } from '#domain/index.js';
import { FIRST_RUN_TOOL_NAMES } from '#engine/index.js';
import { describeTerminalChat } from '#composition/core/terminal-chat/index.js';
import { clearConfigCache, resolveProductLayout } from '#platform/index.js';
import registry from '../../../assets/native-coding/commands.json' with { type: 'json' };

const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); });
const families = [registry.adapters.claude.capabilities.eventStream, registry.adapters.codex.headless.protocolFamily];
const cli = resolve('dist/composition/core/cli/internal/entry.js');
const execute = promisify(execFile);
/** Proof JSON for CI artifacts: approval decision capabilities are redacted. */
const proofJson = (value: unknown) => JSON.stringify(value, (key, item: unknown) => key === 'decisionCapability' ? '[redacted]' : item, 2);
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
    { when: 'K16-DENY', answer: 'K16-DENY-OK', calls: [{ name: 'run_shell', arguments: { command: "printf '%s\\n' must-not-happen > denied.txt" } }] },
    { when: 'K16-SHELL', answer: 'K16-SHELL-OK', calls: [{ name: 'run_shell', arguments: { command: "printf '%s\\n' sandbox-ok > shell-result.txt; cat shell-result.txt" } }] },
    { when: 'K16-PROTECTED', answer: 'K16-PROTECTED-DONE', calls: [{ name: 'run_shell', arguments: { command: `cat '${credential}'` } }] },
    { when: 'K16-ATTACK', answer: 'K16-ATTACK-DONE', calls: [{ name: 'run_shell', arguments: { command: `cd /; cat '${credential.slice(1)}'` } }] },
    { when: 'K16-REVOKE', answer: 'K16-REVOKE-DONE', calls: [{ name: 'run_shell', arguments: { command: "printf '%s\\n' must-not-happen > revoked.txt" } }] },
    { when: 'K16-ASK-DENY', answer: 'K16-ASK-DENY-OK', calls: [{ name: 'write_file', arguments: { path: 'ask-denied.txt', content: 'must not happen\n' } }] },
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
  // R4a: the real first-run template (v19) for this person, never injected MCP grants: the native turn runs as the MCP actor on its v19 rules.
  const template = firstRunPolicyTemplate({ scopeId: 's', principal: { issuer: owner.issuer, subject: owner.subject }, ...FIRST_RUN_TOOL_NAMES });
  await writeFile(join(f.data, 'policy.json'), JSON.stringify(template.policy)); await writeFile(join(f.data, 'bindings.json'), JSON.stringify(template.bindings), { mode: 0o600 }); clearConfigCache();
  await writeFile(join(f.project, 'input.txt'), 'BUSINESS-READBACK\n');
  const profile = modelInvocationProfileSchema.parse(config.provider_invocation_profiles.profiles[0]);
  expect((await describeTerminalChat(f.project, options)).tools).toBe('none');
  expect(await readNativeAgentObservation(profile)).toBeNull();
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
      if (process.env['K16_PROOF_DIR']) await writeFile(join(process.env['K16_PROOF_DIR'], `turn-${nativeCliAgent(family)!.id}-${id}.json`),
        proofJson({ result, events, decisions,
          limits: { idleMs: nativeEgressLimits().idleMs, approvalTtlMs: h.config.approvals.requestTtlMs, timeoutMs: h.profile.limits.timeoutMs },
          trace: await readFile(h.traceFile, 'utf8') }));
      return result;
    };
    expect(await call('K16-READ', 'allow')).toMatchObject({ finish: 'stop', toolCalls: 1 });
    expect(events.some(event => event.kind === 'text' && event.text.includes('first guarded turn'))).toBe(true);
    const firstSeal = await readNativeAgentObservation(h.profile);
    expect(firstSeal).toMatchObject({ cli: true, login: true, environment: true, toolSurface: true, plugins: true, bridge: true });
    const firstRecord = JSON.parse(await readFile(join(String(h.profile.adapter.definition['stateDir']), `agent-${firstSeal!.execution.profileDigest}.json`), 'utf8'));
    expect(firstRecord.observed).toMatchObject(firstSeal!);
    const reader = configuredNativeChatReadiness(h.f.project, h.options);
    const query = { surface: 'worker' as const, scopeId: h.profile.scopeId, reference: h.profile.reference,
      profileDigest: firstSeal!.execution.profileDigest, flagSetDigest: firstSeal!.execution.flagSetDigest };
    expect(await reader.read(query)).toEqual(firstSeal);
    expect(await reader.read({ ...query, flagSetDigest: '0'.repeat(64) })).toBeNull();
    expect((await describeTerminalChat(h.f.project, h.options)).tools).toBe('available');
    expect(await call('K16-READ-SECOND', 'allow')).toMatchObject({ finish: 'stop', toolCalls: 1 });
    const secondSeal = await readNativeAgentObservation(h.profile);
    expect(secondSeal).toMatchObject({ execution: firstSeal!.execution });
    const idleMs = nativeEgressLimits().idleMs, keepAliveMs = Math.floor(idleMs / 2);
    const approvalWaitMs = Math.min(idleMs + keepAliveMs, h.config.approvals.requestTtlMs / 2);
    expect(approvalWaitMs).toBeGreaterThan(idleMs);
    // v19 edit rule is modeEligible (owner 2026-11-05) and the MCP actor has no mode entry: the default standart lowers an ordinary write, no card.
    const cards = () => events.filter(event => event.kind === 'approval.requested').length, beforeWrite = cards();
    const written = await call('K16-WRITE', 'allow');
    expect(written, JSON.stringify({ family, result: written })).toMatchObject({ finish: 'stop', toolCalls: 1 });
    expect(cards()).toBe(beforeWrite);
    expect(await readFile(join(h.f.project, 'result.txt'), 'utf8')).toBe('business result\n');
    // A mutating shell call asks the person's card in standart; a denied card leaves no effect.
    expect(await call('K16-DENY', 'deny')).toMatchObject({ toolCalls: 0 });
    expect(await readFile(join(h.f.project, 'denied.txt'), 'utf8').catch(() => null)).toBeNull();
    expect(await call('K16-SHELL', 'allow', async () => {
      expect(await readFile(join(h.f.project, 'shell-result.txt'), 'utf8').catch(() => null)).toBeNull();
      // Derive a wait beyond gateway idle while reserving half the approval TTL for completion.
      await new Promise(resolveWait => setTimeout(resolveWait, approvalWaitMs));
    })).toMatchObject({ toolCalls: 1 });
    expect(await readFile(join(h.f.project, 'shell-result.txt'), 'utf8')).toBe('sandbox-ok\n');
    expect(await call('K16-PROTECTED', 'allow')).toMatchObject({ toolCalls: 0 });
    expect(await call('K16-ATTACK', 'allow')).toMatchObject({ toolCalls: 1 });
    expect(await readFile(h.credential, 'utf8')).toBe(h.canary);
    const records = decisions as { request: { requester: { issuer: string } }; decision: { deciderClass: string; actor: { issuer: string } } }[];
    expect(records).toHaveLength(3);
    for (const record of records) { expect(record.request.requester.issuer).toMatch(/\/mcp$/u); expect(record.decision.deciderClass).toBe('human-tty'); expect(record.decision.actor.issuer).not.toMatch(/\/mcp$/u); }
    expect(await client.chatTurn(turn('K16-WRITE'), event => events.push(event))).toMatchObject({ replayed: true });
    // R4a negative: an external MCP client (same MCP actor, v19 operation rule) cannot reach `workspace.file.write` through execute_operation:
    // the Core operation has no configured target, so the agent-tool gate stays its only route.
    const external = { schemaVersion: 1 as const, commandId: `r4a-external-${family}`, scopeId: 's', operation: { id: 'workspace.file.write', version: 1 },
      target: { kind: 'workspace-file', id: 'external.txt' }, idempotencyKey: `r4a-external-${family}`, input: { path: 'external.txt', content: 'must not happen\n' }, expectedVersion: null };
    await expect(withMcpPrincipal(() => createConfiguredRuntimeClient(h.f.project, h.options).executeOperation(external))).rejects.toMatchObject({ code: 'EFFECT_OPERATION_UNKNOWN' });
    expect(await readFile(join(h.f.project, 'external.txt'), 'utf8').catch(() => null)).toBeNull();
    // R4a: the person's own "ask for edits too" applies to the AI turn they start: the write now shows a card; denied, nothing is written.
    const mode = await client.inspectPermissionMode({ schemaVersion: 1, scopeId: 's' });
    expect(await client.setPermissionMode({ schemaVersion: 1, scopeId: 's', mode: 'standart', askEdits: true, expectedRevision: mode.revision })).toMatchObject({ askEdits: true });
    const beforeAsk = cards();
    expect(await call('K16-ASK-DENY', 'deny')).toMatchObject({ toolCalls: 0 });
    expect(await readFile(join(h.f.project, 'ask-denied.txt'), 'utf8').catch(() => null)).toBeNull();
    expect(cards()).toBe(beforeAsk + 1);
    await call('K16-REVOKE', 'allow', async () => {
      h.config.provider_invocation_profiles.profiles[0].adapter.definition.delegatedUse = null;
      await writeFile(join(h.f.project, '.deckent/config.json'), JSON.stringify(h.config));
    });
    expect(await readFile(join(h.f.project, 'revoked.txt'), 'utf8').catch(() => null)).toBeNull();
    expect(JSON.stringify(events)).not.toContain(h.canary);
    expect(await readFile(h.traceFile, 'utf8')).not.toContain(h.canary);
    if (process.env['K16_PROOF_DIR']) await writeFile(join(process.env['K16_PROOF_DIR'], `compiled-${nativeCliAgent(family)!.id}${process.env['CI'] === 'true' ? '-ci' : ''}.json`), proofJson({ events, decisions, firstRecord, firstSeal, secondSeal }));
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
