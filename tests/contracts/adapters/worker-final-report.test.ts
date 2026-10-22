import { expect, it } from 'vitest';
import * as bridge from '#adapters/core/native-connection/index.js';
import { compileNativeCodingDockerProfile, resolveDockerTaskProfile } from '#adapters/index.js';

const report = { schemaVersion: 1, summary: 'Done', changedFiles: ['note.txt'], checks: [{ command: 'npm test', outcome: 'passed' }], openIssues: [] };
const template = { id: 'coding', version: 1, adapter: { id: 'docker', version: 2 }, parameters: {
  argv: ['unused'], imageId: 'sha256:' + 'a'.repeat(64), memoryBytes: 268435456, pids: 64, cpus: 1,
  logMaxSizeKiB: 64, logMaxFiles: 2, tmpBytes: 16777216, deadlineMs: 20000, controlTimeoutMs: 10000, outputBytes: 65536,
} };
it('validates every report field, rejects extra authority fields and oversized claims, and redacts every string leaf', () => {
  expect(bridge.validateFinalReport(report, [])).toEqual({ status: 'reported', report });
  expect(workerFinalReportSchema.safeParse(report).success).toBe(true);
  for (const value of [{ ...report, accepted: true }, { ...report, changedFiles: [3] }, { ...report, checks: [{ command: 'x', outcome: 'accepted' }] },
    { ...report, schemaVersion: 2 }, { ...report, openIssues: null }]) {
    expect(bridge.validateFinalReport(value, [])).toEqual({ status: 'unavailable', reason: 'invalid' });
    expect(workerFinalReportSchema.safeParse(value).success).toBe(false);
  }
  expect(bridge.validateFinalReport({ ...report, summary: 'a'.repeat(40000) }, [])).toEqual({ status: 'unavailable', reason: 'oversized' });
  const sensitive = { ...report, summary: 'fixture-secret', changedFiles: ['fixture-secret.txt'], checks: [{ command: 'echo fixture-secret', outcome: 'passed', checkId: 'fixture-secret', role: 'exploratory' }], openIssues: ['Bearer abc.def.ghi'] };
  const clean = JSON.stringify(bridge.validateFinalReport(sensitive, ['fixture-secret']));
  expect(clean).not.toContain('fixture-secret'); expect(clean).not.toContain('abc.def.ghi'); expect(clean).toContain('[REDACTED]');
});
it.each(['claude', 'codex', 'cursor'])('opts v3 %s into a versioned report without changing v2 or adding an implicit turn limit', provider => {
  const invocation = { schemaVersion: 3, provider, cliVersion: 'fixture-1', discovery: { schemaVersion: 1, mode: 'repository' }, permissionMode: 'unattended', model: 'fixture-model', prompt: 'Work' };
  const compiled = resolveDockerTaskProfile(compileNativeCodingDockerProfile(template, invocation));
  expect(compiled.nativeSubscription).toMatchObject({ finalReport: { schemaVersion: 1 } });
  expect(compiled.argv).not.toContain('--max-turns');
  expect(resolveDockerTaskProfile(compileNativeCodingDockerProfile(template, { ...invocation, schemaVersion: 2 })).nativeSubscription).not.toHaveProperty('finalReport');
  if (provider === 'claude') {
    const bounded = resolveDockerTaskProfile(compileNativeCodingDockerProfile(template, { ...invocation, maxTurns: 7 }));
    expect(bounded.argv).toContain('--max-turns'); expect(bounded.argv[bounded.argv.indexOf('--max-turns') + 1]).toBe('7');
    expect(bounded.nativeSubscription?.preflight?.requiredFlags).toContain('--max-turns');
  } else expect(() => compileNativeCodingDockerProfile(template, { ...invocation, maxTurns: 7 })).toThrow('NATIVE_CODING_TURN_LIMIT_UNSUPPORTED');
  for (const maxTurns of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) expect(() => compileNativeCodingDockerProfile(template, { ...invocation, maxTurns })).toThrow();
});

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe } from 'vitest';
import { openNativeConnection } from '../../../dist/adapters/core/native-connection/index.js';
import { DockerSupervisor, FileArtifactStore } from '#adapters/index.js';
import { WorkerTranscriptApplication, type DispatchRecord, type SandboxRequest } from '#engine/index.js';
import { attemptIdentitySchema, workerFinalReportSchema, readWorkerFinalReport, type WorkerEvent, type VerifiedPrincipal } from '#domain/index.js';
import { main as cliMain } from '#surfaces/index.js';

const imageId = process.env.DECKENT_TEST_DOCKER_IMAGE;
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const fixtureSecret = 'fixture-private-value';
const valid = { ...report, summary: 'Completed fixture-private-value', openIssues: ['Bearer abc.def.ghi'] };
const principal = { id: 'fixture' } as VerifiedPrincipal;

describe.skipIf(!imageId)('real Docker final report custody', () => {
  it.each([
    ['claude', 'valid', 'reported'], ['codex', 'valid', 'reported'], ['claude', 'typed', 'reported'], ['codex', 'typed', 'reported'],
    ['claude', 'invalid', 'invalid'], ['claude', 'oversized', 'oversized'], ['claude', 'missing', 'missing'],
    ['cursor', 'valid', 'reported'], ['cursor', 'fenced', 'reported'], ['cursor', 'invalid', 'invalid'], ['cursor', 'oversized', 'oversized'], ['cursor', 'missing', 'missing'],
    ['claude', 'unsupported', 'unsupported'],
  ])('%s %s reaches the sealed transcript as %s', async (provider, variant, expected) => {
    const root = await mkdtemp(join(tmpdir(), 'dn-report-')); cleanups.push(() => rm(root, { recursive: true, force: true }));
    const workspace = join(root, 'work'); await mkdir(workspace);
    const value = variant === 'invalid' ? { ...valid, accepted: true } : variant === 'oversized' ? { ...valid, summary: 'x'.repeat(40000) }
      : variant === 'typed' ? { ...valid, checks: [{ command: 'lint', outcome: 'failed', checkId: 'lint', role: 'acceptance' }, { command: 'npm test', outcome: 'passed', ...(provider === 'codex' ? { checkId: null, role: null } : {}) }] } : valid;
    const compiled = resolveDockerTaskProfile(compileNativeCodingDockerProfile(template, { schemaVersion: 3, provider, cliVersion: 'fixture-1',
      discovery: { schemaVersion: 1, mode: 'repository' }, permissionMode: 'unattended', model: 'fixture-model', prompt: 'Work',
      ...(provider === 'claude' ? { maxTurns: 7 } : {}) }));
    const flags = compiled.nativeSubscription!.preflight!.requiredFlags;
    const flag = provider === 'claude' ? '--json-schema' : '--output-schema';
    const native = `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('invalid')) { process.stderr.write("error: option '--max-turns <turns>' argument 'invalid' is invalid. must be a number"); process.exit(1); }
if (args.includes('--version')) { console.log('fixture-1'); process.exit(0); }
if (args.includes('--help')) { console.log(${JSON.stringify([...flags.filter(x => x !== '--max-turns'), ...(variant === 'unsupported' || provider === 'cursor' ? [] : [flag])].join(' '))}); process.exit(0); }
if (${JSON.stringify(provider !== 'cursor' && variant !== 'unsupported')}) {
  const i = args.indexOf(${JSON.stringify(flag)}); if (i < 0) process.exit(42);
  const schema = JSON.parse(${provider === 'claude' ? 'args[i+1]' : "readFileSync(args[i+1], 'utf8')"});
  if (!schema.required.includes('checks') || schema.additionalProperties !== false) process.exit(43);
}
if (${JSON.stringify(provider === 'claude')} && args[args.indexOf('--max-turns')+1] !== '7') process.exit(44);
// The flagless final-text-json channel (cursor) receives the instruction and schema in the prompt and answers in the final result text.
if (${JSON.stringify(provider === 'cursor')} && !args.at(-1).includes('### report:final-text-json@1')) process.exit(45);
const report = ${JSON.stringify(value)};
const text = ${JSON.stringify(variant === 'fenced')} ? '\`\`\`json\\n' + JSON.stringify(report) + '\\n\`\`\`' : JSON.stringify(report);
if (${JSON.stringify(variant !== 'missing')}) console.log(JSON.stringify(${provider === 'claude' ? "{type:'result', subtype:'success', structured_output: report}" : provider === 'cursor' ? "{type:'result', subtype:'success', is_error:false, result:text}" : "{type:'item.completed', item:{type:'agent_message', text:JSON.stringify(report)}}"}));
`;
    await writeFile(join(workspace, 'native.mjs'), native, { mode: 0o755 });
    const received: WorkerEvent[] = [];
    const jwt = 'eyJhbGciOiJub25lIn0.' + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url') + '.fixture-signature';
    const credential = provider === 'claude' ? { claudeAiOauth: { accessToken: fixtureSecret, expiresAt: Date.now() + 3600000 } }
      : provider === 'codex' ? { tokens: { access_token: jwt, id_token: fixtureSecret } } : { accessToken: jwt };
    const connection = await openNativeConnection({ binding: compiled.nativeSubscription!,
      directory: root, credential, deadlineMs: 20000, onEvents: events => received.push(...events) });
    cleanups.push(connection.close);
    const supervisor = new DockerSupervisor({ executable: '/usr/bin/docker', workspaceRoot: root, imageId: imageId!, uid: process.getuid!(), gid: process.getgid!(),
      logMaxSizeKiB: 64, logMaxFiles: 2, memoryBytes: 536870912, pids: 128, cpus: 1, tmpBytes: 67108864, deadlineMs: 20000,
      controlTimeoutMs: 10000, outputBytes: 65536, connection: connection.descriptor });
    const sandbox: SandboxRequest = { protocolVersion: 1, identity: { scopeId: 'test', runId: 'run', taskId: 'task', attemptId: randomUUID(), generation: 1, layoutRevision: 'layout' },
      workspace, argv: ['/workspace/native.mjs', ...compiled.argv.slice(1)] };
    cleanups.push(async () => { await supervisor.cancel(sandbox); await supervisor.release(sandbox); });
    const result = await supervisor.execute(sandbox);
    expect(result.result).toEqual({ kind: 'exited', exitCode: 0 });
    const final = readWorkerFinalReport(result.stdout);
    if (expected === 'reported') {
      expect(final).toMatchObject({ status: 'reported', report: { changedFiles: ['note.txt'], summary: 'Completed [REDACTED]', openIssues: ['Bearer [REDACTED]'] } });
      expect(result.stdout).not.toContain(fixtureSecret); expect(result.stdout).not.toContain('abc.def.ghi');
      // PRE-1: a typed failed acceptance check leaves the real bridge intact, so the domain refuses the task (owner D5a).
      if (variant === 'typed' && final.status === 'reported') {
        expect(final.report.checks).toEqual([{ command: 'lint', outcome: 'failed', checkId: 'lint', role: 'acceptance' }, { command: 'npm test', outcome: 'passed' }]);
        expect(workerReportRefusal(workerReportEvidence(final))).toBe('declared-check-not-passed');
      }
    } else expect(final).toMatchObject({ status: 'unavailable', reason: expected });
    const dropped = received.filter(e => e.kind === 'dropped').reduce((n, e) => n + (e.kind === 'dropped' ? e.count : 0), 0);
    expect(dropped).toBe(['invalid', 'oversized'].includes(expected!) ? 1 : 0);
    await mkdir(join(root, 'artifacts'), { mode: 0o700 });
    const artifacts = new FileArtifactStore({ root: join(root, 'artifacts'), maxBytes: 1048576 });
    const output = await artifacts.put('test', Buffer.from(JSON.stringify({ schemaVersion: 1, identity: sandbox.identity,
      completeness: result.outputCompleteness, stdout: result.stdout, stderr: result.stderr })));
    const eventReceipt = await artifacts.put('test', Buffer.from(received.map(e => JSON.stringify(e)).join('\n')));
    let authorized = 0;
    const app = new WorkerTranscriptApplication({ async loadWorkerEventLog() { return { schemaVersion: 1, identity: attemptIdentitySchema.parse(sandbox.identity), events: eventReceipt, eventCount: received.length, sealedAt: 1 }; },
      async loadBoundDispatch() { return { output } as DispatchRecord; },
      // The composed store (openSqliteAttemptStore) owns loadRun; this attempt has no persisted Run, so the model row is absent (WORKER-CURRENCY-2).
      async loadRun() { return null; } }, artifacts, { async authorizeIdentity() { authorized++; } });
    const transcript = await app.inspect(sandbox.identity, principal);
    expect(transcript.finalReport).toEqual(final); expect(authorized).toBe(1);
    expect(transcript).toHaveProperty('model', null);
    const printed: string[] = [];
    expect(await cliMain(['task', 'transcript', '--scope', 'test', '--run', 'run', '--task', 'task', '--attempt', sandbox.identity.attemptId, '--generation', '1', '--layout-revision', 'layout'],
      { root: workspace, stdout: { write: (s: string) => { printed.push(s); } }, inspectWorkerTranscript: async () => transcript })).toBe(0);
    expect(printed.join('')).toContain('native-worker-report');
    if (expected === 'reported') {
      expect(printed.join('')).toContain('note.txt');
      const prepared = await artifacts.prepareReadOnlyFile('test', output);
      await writeFile(prepared.path, 'tampered');
      expect((await app.inspect(sandbox.identity, principal)).finalReport).toMatchObject({ status: 'unavailable', reason: 'invalid' });
    }
  }, 30000);
});

it('does not convert duplicate, malformed or truncated sealed records into a report', () => {
  const record = JSON.stringify({ schemaVersion: 1, kind: 'native-worker-report', status: 'reported', report });
  expect(readWorkerFinalReport(record + '\n' + record)).toMatchObject({ status: 'unavailable', reason: 'invalid' });
  expect(readWorkerFinalReport(record.slice(0, -10))).toMatchObject({ status: 'unavailable', reason: 'missing' });
  expect(readWorkerFinalReport(record.replace('"passed"', '"accepted"'))).toMatchObject({ status: 'unavailable', reason: 'invalid' });
});

it('rejects an array masquerading as a check outcome before the report leaves the bridge', () => {
  expect(bridge.validateFinalReport({ ...report, checks: [{ command: 'npm test', outcome: ['passed'] }] }, []))
    .toEqual({ status: 'unavailable', reason: 'invalid' });
});

// PRE-1 KABUL-DURUSTLUK: the owner D5a typed check (`checkId`, `role`) must survive the bridge, or a failed required check can never block.
// The standalone bridge's report schema and collector are mounted-file internals with no package export (no host imports there).
// eslint-disable-next-line no-restricted-imports
import { createFinalReportJsonSchema, createCodexState, createNormalizerState, createNativeLineObserver, finalReportCollector } from '#adapters/core/native-connection/internal/worker.js';
import { workerReportEvidence, workerReportRefusal, workerReportLimits } from '#domain/index.js';
const refusalOf = (value: unknown) => {
  const result = bridge.validateFinalReport(value, []);
  return workerReportRefusal(workerReportEvidence({ schemaVersion: 1, kind: 'native-worker-report', ...result } as Parameters<typeof workerReportEvidence>[0]));
};
const typedCheck = (outcome: string, role?: string) => ({ command: 'node scripts/lint-arch.mjs', outcome, checkId: 'lint-arch', ...(role ? { role } : {}) });
it('keeps a typed acceptance check through the bridge so its failure refuses the task as declared-check-not-passed', () => {
  const failed = { ...report, checks: [typedCheck('failed', 'acceptance')] };
  expect(bridge.validateFinalReport(failed, [])).toEqual({ status: 'reported', report: failed });
  expect(workerFinalReportSchema.safeParse(failed).success).toBe(true);
  expect(refusalOf(failed)).toBe('declared-check-not-passed');
  // The last outcome of an acceptance check decides; a re-run that passed clears an earlier failure.
  expect(refusalOf({ ...report, checks: [typedCheck('failed', 'acceptance'), typedCheck('passed', 'acceptance')] })).toBeNull();
  // PRE-7: a last outcome `not-run` still refuses, under its own observed reason.
  expect(refusalOf({ ...report, checks: [typedCheck('passed', 'acceptance'), typedCheck('not-run', 'acceptance')] })).toBe('acceptance-check-not-run');
  // Negatives: a passing acceptance check, an exploratory failure and an untyped failure stay claims (owner D5a), never a refusal.
  expect(refusalOf({ ...report, checks: [typedCheck('passed', 'acceptance')] })).toBeNull();
  expect(refusalOf({ ...report, checks: [typedCheck('failed', 'exploratory')] })).toBeNull();
  expect(refusalOf({ ...report, checks: [{ command: 'node scripts/lint-arch.mjs', outcome: 'failed' }] })).toBeNull();
  // The bridge stays as strict as the domain: unknown roles, empty or oversized ids and extra keys are invalid.
  for (const check of [typedCheck('failed', 'required'), { ...typedCheck('failed', 'acceptance'), checkId: '' },
    { ...typedCheck('failed', 'acceptance'), checkId: 'x'.repeat(workerReportLimits.checkIdChars + 1) }, { ...typedCheck('passed', 'acceptance'), accepted: true }]) {
    expect(bridge.validateFinalReport({ ...report, checks: [check] }, [])).toEqual({ status: 'unavailable', reason: 'invalid' });
    expect(workerFinalReportSchema.safeParse({ ...report, checks: [check] }).success).toBe(false);
  }
});
it('offers checkId and role in both report schemas and turns a strict-schema null into absence before sealing', () => {
  const loose = createFinalReportJsonSchema(workerReportLimits, false) as { properties: { checks: { items: { properties: Record<string, unknown>; required: string[] } } } };
  expect(Object.keys(loose.properties.checks.items.properties)).toEqual(['command', 'outcome', 'checkId', 'role']);
  expect(loose.properties.checks.items.required).toEqual(['command', 'outcome']);
  const strict = createFinalReportJsonSchema(workerReportLimits, true) as typeof loose;
  expect(strict.properties.checks.items.required).toEqual(['command', 'outcome', 'checkId', 'role']);
  const collect = (checks: unknown[]) => {
    const collector = finalReportCollector('codex', [], workerReportLimits);
    const observer = createNativeLineObserver('codex-exec-json', createNormalizerState([]), createCodexState(), () => {}, collector);
    observer.observe(Buffer.from(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ ...report, checks, handoff: null, exit: null }) } }) + '\n'));
    return collector.finish();
  };
  expect(collect([{ command: 'npm test', outcome: 'passed', checkId: null, role: null }])).toEqual({ status: 'reported', report });
  expect(collect([typedCheck('failed', 'acceptance')])).toEqual({ status: 'reported', report: { ...report, checks: [typedCheck('failed', 'acceptance')] } });
});
