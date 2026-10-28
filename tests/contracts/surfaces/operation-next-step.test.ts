import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { main } from '#surfaces/index.js';
import { composeCore } from '#composition/core/root/index.js';
import { clearConfigCache, ErrorRegistry, resolveGlobalConfigPaths } from '#platform/index.js';
import { operationsConfigSchema } from '#adapters/index.js';

// BETA-RAKIP-3 (alpha.54 br3): an uncertain external effect tells the person what is known, what Deckent will not do, and the next safe step
// on the real CLI surface, with the exact command it names (scope + command id). The typed codes and the --json machine contract stay the same.
const roots: string[] = [];
beforeAll(() => { composeCore(); });
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

const command = { schemaVersion: 1, commandId: 'approve-po-1', scopeId: 'erp-company', operation: { id: 'erp.approve', version: 1 },
  target: { kind: 'erp-record', id: 'po-1' }, idempotencyKey: 'key-1', input: { status: 'approved' }, expectedVersion: '"revision-1"' };
async function project() {
  const root = await mkdtemp(join(tmpdir(), 'operation-next-step-')); roots.push(root);
  const home = join(root, 'home'), projectRoot = join(root, 'project');
  const env = { HOME: home, USERPROFILE: home, APPDATA: join(home, 'roaming'), LOCALAPPDATA: join(home, 'local'), XDG_CONFIG_HOME: join(home, '.config') };
  const path = join(projectRoot, '.deckent', 'config.json');
  await Promise.all([mkdir(dirname(resolveGlobalConfigPaths(env).platformPath), { recursive: true }), mkdir(dirname(path), { recursive: true })]);
  await writeFile(path, JSON.stringify({}));
  const input = join(projectRoot, 'approve.json'); await writeFile(input, JSON.stringify(command));
  return { projectRoot, env, input };
}
async function run(f: { projectRoot: string; env: Record<string, string> }, args: readonly string[], extra: Record<string, unknown>) {
  const stdout: string[] = [], stderr: string[] = [];
  const code = await main(args, { initialize: composeCore, root: f.projectRoot, env: f.env, stdout: { write(value: string) { stdout.push(value); } },
    stderr: { write(value: string) { stderr.push(value); } }, ...extra });
  return { code, stdout: stdout.join(''), stderr: stderr.join('') };
}
const inspectCommand = 'deckent operation inspect --scope erp-company --command-id approve-po-1';
const record = (state: 'claimed' | 'unknown' | 'settled' | 'refused') => ({ schemaVersion: 1 as const, record: { state, sequence: 3,
  intent: { command }, evidence: null, refusal: state === 'refused' ? 'EFFECT_REJECTED' : null } });

describe.skipIf(process.platform === 'win32')('uncertain operation outcome on the CLI', () => {
  it('an unknown outcome names the next safe step with the exact inspect command and the record (EN/TR); nothing is resent by the CLI', async () => {
    const f = await project();
    const executeOperation = vi.fn(async () => { throw ErrorRegistry.createError('EFFECT_OUTCOME_UNKNOWN'); });
    const en = await run(f, ['operation', 'execute', '--input', f.input, '--lang', 'en'], { executeOperation });
    expect(en.code).toBe(1); expect(en.stderr).toContain('EFFECT_OUTCOME_UNKNOWN');
    expect(en.stderr).toContain(inspectCommand); expect(en.stderr).toContain('erp-record/po-1');
    expect(en.stderr).toContain('same command'); expect(en.stderr).toContain('never resent automatically');
    const tr = await run(f, ['operation', 'execute', '--input', f.input, '--lang', 'tr'], { executeOperation });
    expect(tr.code).toBe(1); expect(tr.stderr).toContain(inspectCommand); expect(tr.stderr).toContain('aynı komutu');
    expect(tr.stderr).toContain('otomatik olarak yeniden gönderilmez');
    // One call per invocation: the CLI itself never retries an unknown outcome.
    expect(executeOperation).toHaveBeenCalledTimes(2);
  });
  it('a policy refusal names the missing operation cell and the founder-baseline command; --json keeps POLICY_DENIED (BeUser ZEY-02)', async () => {
    const f = await project();
    const executeOperation = vi.fn(async () => { throw ErrorRegistry.createError('POLICY_DENIED'); });
    const en = await run(f, ['operation', 'execute', '--input', f.input, '--lang', 'en'], { executeOperation });
    expect(en.code).toBe(1); expect(en.stderr).toContain('operation/erp.approve/execute');
    expect(en.stderr).toContain('deckent init policy --scope erp-company --owner-baseline mcp-delegable --apply');
    const tr = await run(f, ['operation', 'execute', '--input', f.input, '--lang', 'tr'], { executeOperation });
    expect(tr.stderr).toContain('yöneticinizden');
    const machine = await run(f, ['operation', 'execute', '--input', f.input, '--json'], { executeOperation });
    expect(JSON.parse(machine.stderr.trim().split('\n').at(-1)!)).toMatchObject({ code: 'POLICY_DENIED', params: { operation: 'erp.approve', action: 'execute', scope: 'erp-company' } });
  });
  it('--json keeps the typed code and carries the identifiers the next step needs', async () => {
    const f = await project();
    const executeOperation = vi.fn(async () => { throw ErrorRegistry.createError('EFFECT_OUTCOME_UNKNOWN'); });
    const machine = await run(f, ['operation', 'execute', '--input', f.input, '--json'], { executeOperation });
    expect(machine.code).toBe(1);
    expect(JSON.parse(machine.stderr.trim().split('\n').at(-1)!)).toMatchObject({ code: 'EFFECT_OUTCOME_UNKNOWN',
      params: { scope: 'erp-company', command: 'approve-po-1', kind: 'erp-record', id: 'po-1' } });
  });
  it('a busy record says an earlier operation on it must settle first and how to look at it (EN/TR)', async () => {
    const f = await project();
    const executeOperation = vi.fn(async () => { throw ErrorRegistry.createError('EFFECT_TARGET_BUSY'); });
    const en = await run(f, ['operation', 'execute', '--input', f.input, '--lang', 'en'], { executeOperation });
    expect(en.code).toBe(1); expect(en.stderr).toContain('EFFECT_TARGET_BUSY'); expect(en.stderr).toContain('erp-record/po-1');
    expect(en.stderr).toContain('deckent operation inspect --scope erp-company --command-id');
    const tr = await run(f, ['operation', 'execute', '--input', f.input, '--lang', 'tr'], { executeOperation });
    expect(tr.stderr).toContain('erp-record/po-1'); expect(tr.stderr).toContain('önce');
  });
  it('NEGATIVE: other refusals keep their own text and gain no uncertain-outcome step', async () => {
    const f = await project();
    const executeOperation = vi.fn(async () => { throw ErrorRegistry.createError('EFFECT_PRECONDITION_CHANGED'); });
    const en = await run(f, ['operation', 'execute', '--input', f.input, '--lang', 'en'], { executeOperation });
    expect(en.stderr).toContain('EFFECT_PRECONDITION_CHANGED'); expect(en.stderr).not.toContain(inspectCommand);
  });
  it('inspect of an unknown or claimed operation shows the next step; settled and refused show none (EN/TR)', async () => {
    const f = await project();
    for (const state of ['unknown', 'claimed'] as const) {
      const inspectOperation = vi.fn(async () => record(state));
      const en = await run(f, ['operation', 'inspect', '--scope', 'erp-company', '--command-id', 'approve-po-1', '--lang', 'en'], { inspectOperation });
      expect(en.code).toBe(0); expect(en.stdout).toContain(`Operation approve-po-1: ${state}`); expect(en.stdout).toContain('Next:');
      expect(en.stdout).toContain('same command'); expect(en.stdout).toContain('erp-record/po-1');
      const tr = await run(f, ['operation', 'inspect', '--scope', 'erp-company', '--command-id', 'approve-po-1', '--lang', 'tr'], { inspectOperation });
      expect(tr.stdout).toContain('Sonraki adım:'); expect(tr.stdout).toContain('aynı komutu');
    }
    for (const state of ['settled', 'refused'] as const) {
      const inspectOperation = vi.fn(async () => record(state));
      const en = await run(f, ['operation', 'inspect', '--scope', 'erp-company', '--command-id', 'approve-po-1', '--lang', 'en'], { inspectOperation });
      expect(en.stdout).toContain(`Operation approve-po-1: ${state}`); expect(en.stdout).not.toContain('Next:');
    }
    // The machine view is the unchanged record.
    const inspectOperation = vi.fn(async () => record('unknown'));
    const machine = await run(f, ['operation', 'inspect', '--scope', 'erp-company', '--command-id', 'approve-po-1', '--json'], { inspectOperation });
    expect(JSON.parse(machine.stdout)).toEqual(record('unknown'));
  });
});

describe('BeUser ZEY-01: a person can start an operation catalog without a ready file', () => {
  it('`operation --example --json` is a valid operations section (the same schema config validates); `execute --example` builds a command for the configured catalog', async () => {
    const f = await project();
    const shown = await run(f, ['operation', '--example', '--json'], {});
    expect(shown.code).toBe(0);
    const section = JSON.parse(shown.stdout);
    expect(operationsConfigSchema.safeParse(section).success).toBe(true);
    const human = await run(f, ['operation', '--example', '--lang', 'tr'], {});
    expect(human.stdout).toContain('targets[].options.baseUrl'); expect(human.stdout).toContain('deckent config set operations');
    await writeFile(join(f.projectRoot, '.deckent', 'config.json'), JSON.stringify({ terminal: { scopeId: 'erp-company' }, operations: section }));
    const command = JSON.parse((await run(f, ['operation', 'execute', '--example', '--json'], {})).stdout);
    expect(command).toMatchObject({ scopeId: 'erp-company', operation: { id: 'erp.purchase-order.approve', version: 1 }, target: { kind: 'purchase-order' } });
  });
});
