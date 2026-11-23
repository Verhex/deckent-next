import { existsSync } from 'node:fs';
import { chmod, mkdtemp, writeFile, rm, symlink, utimes, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { inspectLegacyWorkers, readWorkerSidecars, startWorkerObservation } from '#adapters/index.js';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const limits = { maxFileBytes: 4096, maxEntries: 64, staleMs: 1000 };
async function fixture() { const root = await mkdtemp(join(tmpdir(), 'dn-observe-')); roots.push(root); return root; }
it.skipIf(process.platform !== 'linux' || !existsSync('/proc/self/fd'))('[requires Linux /proc/self/fd observation custody] reads legacy shapes as observations, keeps heartbeat freshness separate and never emits raw secrets or result claims as terminal truth', async () => {
  const root = await fixture();
  await writeFile(join(root, 'task-a.hb'), JSON.stringify({ taskId: 'a', status: 'EXECUTING', timestamp: 'old', pid: process.pid, currentAction: 'synthetic-secret' }));
  await utimes(join(root, 'task-a.hb'), new Date(0), new Date(0));
  await writeFile(join(root, 'task-a.log'), 'authentication failed synthetic-secret\nwarning: timeout\n');
  await writeFile(join(root, 'task-a.result'), JSON.stringify({ selfAssessment: 'GO', notes: 'synthetic-secret' }));
  const result = await inspectLegacyWorkers(root, limits, 4, null); const worker = result.workers[0]!;
  expect(worker.process).toBe('present-unverified'); expect(worker.terminal).toBeNull(); expect(worker.identity).toBeNull();
  expect(worker.files?.heartbeat.freshness).toBe('stale'); expect(worker.files?.result.reportedAssessment).toBe('GO');
  expect(worker.files?.log.diagnostics).toEqual(expect.arrayContaining(['authentication', 'timeout', 'warning']));
  expect(JSON.stringify(result)).not.toContain('synthetic-secret');
});
it.skipIf(process.platform !== 'linux' || !existsSync('/proc/self/fd'))('[requires Linux /proc/self/fd observation custody] bounds tails and discovery, rejects symlinks and malformed results without blocking other workers', async () => {
  const root = await fixture(); await writeFile(join(root, 'task-a.log'), 'x'.repeat(10000) + '\nerror\n');
  await writeFile(join(root, 'task-a.result'), '{broken'); await symlink('/etc/passwd', join(root, 'task-a.hb'));
  await writeFile(join(root, 'task-b.result'), '{}');
  const page = await inspectLegacyWorkers(root, limits, 1, null);
  expect(page.truncated).toBe(true); expect(page.nextAfter).toBe('a');
  expect(page.workers[0]!.files).toMatchObject({ heartbeat: { state: 'unavailable' }, result: { state: 'malformed' }, log: { truncated: true } });
  expect((await inspectLegacyWorkers(root, limits, 1, page.nextAfter)).workers[0]?.taskId).toBe('b');
  await expect(inspectLegacyWorkers(join(root, 'task-a.hb'), limits, 1, null)).rejects.toThrow('WORKER_OBSERVATION_UNAVAILABLE');
});
it.skipIf(process.platform !== 'linux' || !existsSync('/proc/self/fd'))('[requires Linux /proc/self/fd observation custody] publishes host hb/log/result atomically and binds refusal audit loss to safe files and the full Attempt', async () => {
  const root = await fixture(); const identity = { scopeId: 's', runId: 'r', taskId: 't', attemptId: 'a', generation: 1, layoutRevision: 'layout' };
  const terminal = { handle: 'container', exitCode: 0, interrupted: false };
  const refusalAuditLoss = 'refusal-audit-loss';
  const sample = { schemaVersion: 1, identity, backend: 'docker', provider: 'codex', workspace: '/workspace',
    observedAt: Date.now(), process: 'exited', handle: 'container', terminal, outputRecorded: true, refusalAuditLoss } as const;
  const writer = await startWorkerObservation(root, 100, 4096, async () => sample);
  await writer.close();
  const files = await readWorkerSidecars(root, 'worker', limits, Date.now(), identity);
  expect(files.result.exitCode).toBe(0); expect(files.log.events[0]).toMatchObject({ process: 'exited', exitCode: 0 });
  expect(JSON.parse(await readFile(join(root, 'worker.result'), 'utf8')).identity).toEqual(identity);
  for (const wrongIdentity of [{ ...identity, attemptId: 'other' }, { ...identity, generation: 2 }]) {
    const wrong = await readWorkerSidecars(root, 'worker', limits, Date.now(), wrongIdentity);
    expect(wrong.heartbeat.state).toBe('identity-mismatch'); expect(wrong.result.state).toBe('identity-mismatch');
    expect(wrong).not.toHaveProperty('refusalAuditLoss');
  }
  expect(await readWorkerSidecars(root, 'worker', limits)).not.toHaveProperty('refusalAuditLoss');
  const heartbeat = join(root, 'worker.hb'), result = join(root, 'worker.result');
  await rm(heartbeat);
  expect((await readWorkerSidecars(root, 'worker', limits, Date.now(), identity)).refusalAuditLoss).toBe(refusalAuditLoss);
  await rm(result);
  await writeFile(heartbeat, JSON.stringify({ ...sample, process: 'running', terminal: null, outputRecorded: false }));
  expect((await readWorkerSidecars(root, 'worker', limits, Date.now(), identity)).refusalAuditLoss).toBe(refusalAuditLoss);

  const event = { schemaVersion: 1, sequence: 1, atMs: 1, kind: 'tool.call', toolId: 'call', name: 'Bash', toolClass: 'shell', target: refusalAuditLoss, detail: null };
  await writeFile(join(root, 'worker.events'), JSON.stringify({ receivedAt: 1, event, refusalAuditLoss }) + '\n');
  await writeFile(join(root, 'worker.log'), JSON.stringify({ ...sample, sequence: 1 }) + '\n');
  await rm(heartbeat);
  const read = () => readWorkerSidecars(root, 'worker', limits, Date.now(), identity);
  expect(await read()).toMatchObject({ heartbeat: { state: 'missing' }, result: { state: 'missing' }, activity: { receivedAt: 1 } });
  expect(await read()).not.toHaveProperty('refusalAuditLoss');
  await writeFile(heartbeat, '{"refusalAuditLoss":"refusal-audit-loss"');
  expect(await read()).toMatchObject({ heartbeat: { state: 'malformed' } });
  expect(await read()).not.toHaveProperty('refusalAuditLoss');
  await writeFile(heartbeat, JSON.stringify({ identity, refusalAuditLoss }));
  expect(await read()).not.toHaveProperty('refusalAuditLoss');
  await writeFile(heartbeat, JSON.stringify({ ...sample, identity: { attemptId: identity.attemptId } }));
  expect(await read()).toMatchObject({ heartbeat: { state: 'identity-mismatch' } });
  expect(await read()).not.toHaveProperty('refusalAuditLoss');
  await writeFile(heartbeat, JSON.stringify({ ...sample, refusalAuditLoss: 'private-detail' }));
  expect(await read()).not.toHaveProperty('refusalAuditLoss');
  await writeFile(heartbeat, JSON.stringify(sample) + ' '.repeat(limits.maxFileBytes));
  expect(await read()).toMatchObject({ heartbeat: { state: 'too-large' } });
  expect(await read()).not.toHaveProperty('refusalAuditLoss');
  await rm(heartbeat);
  await writeFile(result, JSON.stringify(sample), { mode: 0o600 });
  await symlink(result, heartbeat);
  await chmod(result, 0o622);
  expect(await read()).toMatchObject({ heartbeat: { state: 'unavailable' }, result: { state: 'unavailable' } });
  expect(await read()).not.toHaveProperty('refusalAuditLoss');
  expect(files.refusalAuditLoss).toBe(refusalAuditLoss);
});
