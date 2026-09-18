import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openSqliteAttemptStore } from '#adapters/index.js';
import type { CancellationDeliveryLimits } from '#engine/index.js';
import { admitRunAttempts } from '../support/admission.js';
import { custodyProfiles, dispatchAdmission } from '../support/custody.js';

const roots: string[] = [];
const identity = Object.freeze({ runId: 'r', scopeId: 's', taskId: 't', attemptId: 'a', layoutRevision: 'l', generation: 1 });
const limits: CancellationDeliveryLimits = Object.freeze({ maxAttempts: 2, retryDelayMs: 4, claimTtlMs: 10 });
const options = Object.freeze({ busyTimeoutMs: 1_000, journalMode: 'wal' as const, durability: 'full' as const });
const profile = Object.freeze({ schemaVersion: 1, adapterId: 'test-supervisor', adapterVersion: 1, parameters: Object.freeze({ fixture: 'strict-custody-profile' }) });

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-cancellation-delivery-process-')); roots.push(root);
  const path = join(root, 'ledger.db'); const seed = await openSqliteAttemptStore(path, options, 'allow', custodyProfiles);
  try {
    await admitRunAttempts(seed, [identity]);
    const dispatch = { owner: 'fixture', request: { protocolVersion: 1 as const, identity, workspace: '/recorded/workspace', argv: ['recorded-tool'] } };
    await seed.claimDispatch(dispatchAdmission(dispatch));
    await seed.cancelRun({ commandId: 'cancel', actor: { id: 'canceller', issuer: 'test', subject: 'fixture' }, scopeId: 's', runId: 'r', expectedRevision: 1 });
  } finally { seed.close(); }
  return path;
}

const childProgram = `
  import { openSqliteAttemptStore } from './dist/adapters/index.js';
  const [path, profileText, inputText] = process.argv.slice(1);
  const profile = JSON.parse(profileText); const input = JSON.parse(inputText);
  const store = await openSqliteAttemptStore(path, { busyTimeoutMs: 1000, journalMode: 'wal', durability: 'full' }, 'allow', {
    validate(value) { if (JSON.stringify(value) !== JSON.stringify(profile)) throw new Error('TEST_SUPERVISOR_PROFILE_INVALID'); return undefined; }
  });
  process.stdout.write('READY\\n');
  process.stdin.once('data', async () => {
    try { process.stdout.write(JSON.stringify({ ok: true, result: await store.claimCancellationDelivery(input) })); }
    catch (error) { process.stdout.write(JSON.stringify({ ok: false, code: error?.code ?? error?.message })); }
    finally { store.close(); }
  });
`;

function writer(path: string, token: string): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, ['--input-type=module', '-e', childProgram, path, JSON.stringify(profile),
    JSON.stringify({ identity, token, now: 1, limits })], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'inherit'] });
}

async function awaitReady(child: ChildProcessWithoutNullStreams, buffer: { value: string }): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let ready = false;
    child.once('error', reject);
    child.stdout.on('data', chunk => {
      buffer.value += String(chunk);
      if (!ready && buffer.value.startsWith('READY\n')) { ready = true; resolve(); }
    });
    child.once('close', code => { if (!ready) reject(new Error(`delivery child exited before READY: ${code}`)); });
  });
}

async function awaitOutcome(child: ChildProcessWithoutNullStreams, buffer: { value: string }) {
  return new Promise<{ ok: boolean; result?: { acquired: boolean; record: { token: string } }; code?: string }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0
      ? resolve(JSON.parse(buffer.value.slice('READY\n'.length))) : reject(new Error(`delivery child exited ${code}`)));
  });
}

it('linearizes cancellation delivery across two OS writers, then retries a crashed lease after reopen', async () => {
  const path = await fixture(); const children = [writer(path, 'first'), writer(path, 'second')];
  const buffers = children.map(() => ({ value: '' }));
  try {
    await Promise.all(children.map((child, index) => awaitReady(child, buffers[index]!)));
    const pendingOutcomes = children.map((child, index) => awaitOutcome(child, buffers[index]!));
    for (const child of children) child.stdin.end('claim');
    const outcomes = await Promise.all(pendingOutcomes);
    const winner = outcomes.find(value => value.ok && value.result?.acquired);
    expect(outcomes.filter(value => value.ok && value.result?.acquired)).toHaveLength(1);
    expect(outcomes.filter(value => value.ok && !value.result?.acquired)).toHaveLength(1);

    const reopened = await openSqliteAttemptStore(path, options, 'allow', custodyProfiles);
    try {
      const retry = await reopened.claimCancellationDelivery({ identity, token: 'retry', now: 11, limits });
      expect(retry).toMatchObject({ acquired: true, record: { token: 'retry', attempts: 2 } });
      await expect(reopened.finishCancellationDelivery({ identity, token: winner!.result!.record.token, now: 12, limits, outcome: 'terminal' }))
        .rejects.toThrow('CANCELLATION_DELIVERY_CONFLICT');
    } finally { reopened.close(); }
  } finally {
    for (const child of children) {
      if (!child.stdin.destroyed) child.stdin.end();
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  }
});
