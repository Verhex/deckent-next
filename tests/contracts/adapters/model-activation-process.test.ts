import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as wait } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { ModelBindingApplication } from '#engine/core/provider-catalog/index.js';
import { openSqliteModelActivationStore } from '#adapters/index.js';
import { DatabaseSync } from 'node:sqlite';

const options = { journalMode: 'delete' as const, durability: 'full' as const, busyTimeoutMs: 2000 };
const reference = { providerId: 'p', providerVersion: 1, modelId: 'm', modelVersion: 1 };
const actor = { id: 'operator', issuer: 'local', subject: '1000', assurance: 'os-user' as const };
const authorization = { revision: 'policy-1', ruleId: 'explicit' };
const program = `
  import { openSqliteModelActivationStore } from './dist/adapters/index.js';
  import { access, readFile, writeFile } from 'node:fs/promises';
  import { setTimeout as wait } from 'node:timers/promises';
  const [db, admission, ready, gate, rawOptions] = process.argv.slice(1);
  const store = await openSqliteModelActivationStore(db, JSON.parse(rawOptions), 'forbid');
  await writeFile(ready, 'ready');
  const deadline = performance.now() + 15000;
  try {
    while (true) {
      try { await access(gate); break; } catch { if (performance.now() >= deadline) throw new Error('BARRIER_TIMEOUT'); await wait(10); }
    }
    try { const result = await store.admit(JSON.parse(await readFile(admission, 'utf8'))); process.stdout.write(JSON.stringify({ ok: true, result })); }
    catch (error) { process.stdout.write(JSON.stringify({ ok: false, code: error.code ?? error.message })); }
  } finally { store.close(); }
`;
it('fences two actual compiled writers and preserves the revoked state when replaying the winning command', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-activation-race-')), dbPath = join(root, 'ledger.db'), gate = join(root, 'go');
  const children: ReturnType<typeof launch>[] = [];
  function launch(file: string, ready: string) {
    let resolveResult!: (value: { stdout: string; stderr: string; error: Error | null }) => void;
    let completed: { stdout: string; stderr: string; error: Error | null } | undefined;
    const result = new Promise<{ stdout: string; stderr: string; error: Error | null }>(resolve => { resolveResult = resolve; });
    const child = execFile(process.execPath, ['--input-type=module', '-e', program, dbPath, file, ready, gate, JSON.stringify(options)],
      { timeout: 20000, maxBuffer: 65536 }, (error, stdout, stderr) => { completed = { error, stdout, stderr }; resolveResult(completed); });
    return { child, result, ready, get completed() { return completed; } };
  }
  try {
    const observed = await new ModelBindingApplication({ async read() { return { schemaVersion: 1, revision: 'c', providers: [
      { id: 'p', version: 1, models: [{ id: 'm', version: 1, nativeId: 'native', protocols: [{ family: 'wire', version: '1', capabilities: [] }] }] },
    ] }; } }).inspect(reference);
    if (observed.status !== 'declared') throw new Error('FIXTURE_NOT_DECLARED');
    const seed = await openSqliteModelActivationStore(dbPath, options); seed.close();
    const admissions = ['first', 'second'].map(commandId => ({ command: { schemaVersion: 1 as const, action: 'activate' as const,
      commandId, scopeId: 's', reference, expectedRevision: 0, catalogRevision: 'c', expectedBinding: observed.binding },
      actor, authorization, admittedAtMs: 1000, definition: observed.definition }));
    for (const admission of admissions) {
      const file = join(root, admission.command.commandId + '.json'), ready = file + '.ready';
      await writeFile(file, JSON.stringify(admission)); children.push(launch(file, ready));
    }
    const deadline = performance.now() + 10000;
    while (!(await Promise.all(children.map(async child => { try { return await readFile(child.ready, 'utf8') === 'ready'; } catch { return false; } }))).every(Boolean)) {
      const exited = children.find(child => child.completed !== undefined);
      if (exited) throw new Error('COMPILED_WRITER_EXITED_BEFORE_GATE: ' + JSON.stringify(exited.completed));
      if (performance.now() >= deadline) throw new Error('COMPILED_WRITERS_NOT_READY'); await wait(10);
    }
    await writeFile(gate, 'go');
    const outputs = await Promise.all(children.map(child => child.result));
    for (const output of outputs) expect(output.error, output.stderr).toBeNull();
    const outcomes = outputs.map(output => JSON.parse(output.stdout));
    expect(outcomes.filter(outcome => outcome.ok)).toHaveLength(1);
    expect(outcomes.find(outcome => !outcome.ok)?.code).toBe('MODEL_ACTIVATION_REVISION_CONFLICT');
    const winner = outcomes.find(outcome => outcome.ok)!.result.receipt;
    const store = await openSqliteModelActivationStore(dbPath, options, 'forbid');
    try {
      await store.admit({ command: { schemaVersion: 1, action: 'deactivate', commandId: 'revoke', scopeId: 's', reference,
        expectedRevision: 1, expectedBinding: observed.binding }, actor, authorization, admittedAtMs: 1001 });
      const replay = await store.admit(admissions.find(value => value.command.commandId === winner.command.commandId)!);
      expect(replay).toEqual({ replayed: true, receipt: winner });
      expect(await store.loadRecord('s', reference)).toMatchObject({ state: 'inactive', revision: 2 });
    } finally { store.close(); }
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try { expect(db.prepare('SELECT count(*) AS n FROM model_activation_receipts').get()?.n).toBe(2); } finally { db.close(); }
  } finally {
    for (const child of children) if (child.child.exitCode === null) child.child.kill('SIGKILL');
    await Promise.all(children.map(child => child.result)); await rm(root, { recursive: true, force: true });
  }
});
