import { expect, it } from 'vitest';
import { main } from '#surfaces/index.js';
import { resolveProductPaths, t } from '#platform/index.js';

const identity = { scopeId: 's', runId: 'r', taskId: 't', attemptId: 'a', generation: 1, layoutRevision: 'layout' };
const identityArgs = ['--scope', 's', '--run', 'r', '--task', 't', '--attempt', 'a', '--generation', '1', '--layout-revision', 'layout'];
const layout = resolveProductPaths('/fixture/project', { env: { HOME: '/fixture/home' } });

it('executes only the exact reserved identity and never presents process exit as acceptance', async () => {
  let received: unknown, text = '';
  const response = { schemaVersion: 1 as const, layout, execution: { identity, status: 'terminal' as const, terminal: { exitCode: 0, signal: null }, outputRecorded: true } };
  const context = { env: { NO_COLOR: '1' }, stdout: { write(value: string) { text += value; } },
    async executeTask(_root: string, value: unknown) { received = value; return response; } };
  expect(await main(['task', 'execute', ...identityArgs], context)).toBe(0); expect(received).toEqual(identity);
  expect(text).toContain('exitCode=0'); expect(text).toContain('signal=none'); expect(text).toMatch(/not task acceptance/i);
  text = ''; expect(await main(['task', 'execute', ...identityArgs, '--json'], context)).toBe(0); expect(JSON.parse(text)).toEqual(response);
  // C3: an encoded or allowlisted reason in its sentence, any other registered code as the recorded code; the first line claims only the
  // missing final record.
  for (const [lang, reason, first, sentence, old] of [
    ['en', 'NATIVE_WORKER_EFFECTS_UNKNOWN', 'This attempt has no final dispatch record, so its outcome is unknown; the recorded reason follows.',
      'The native worker’s tool effects are unresolved. Inspect this Attempt and reconcile pending effects; do not repeat the work blindly.',
      'No process exit has been recorded'],
    ['tr', 'HEADLESS_CREDITS_REQUIRED', 'Bu denemenin son dağıtım kaydı yok, bu nedenle sonucu bilinmiyor; kaydedilen neden aşağıdadır.',
      'Kayıtta HEADLESS_CREDITS_REQUIRED hata kodu var. Hatanın kesin nedeni belirlenemedi.', 'nothing was accepted'],
    ['tr', 'HEADLESS_WORKER_RESULT__REASON_EXIT__23', 'Bu denemenin son dağıtım kaydı yok, bu nedenle sonucu bilinmiyor; kaydedilen neden aşağıdadır.',
      'Başlatılan yalıtım komutu 23 koduyla sonlandı.', 'Süreç çıkışı henüz kaydedilmemiş'],
  ] as const) {
    text = ''; Object.assign(response.execution, { status: 'unresolved', terminal: null, outputRecorded: false, waiting: { reason } });
    expect(await main(['task', 'execute', ...identityArgs, '--lang', lang], context)).toBe(0);
    expect(text.split('\n').slice(1, 3)).toEqual([first, sentence]); expect(text).not.toContain(old);
  }
  const reason = 'fixture-unregistered-wait';
  Object.assign(response.execution, { waiting: { reason } });
  text = '';
  expect(await main(['task', 'execute', ...identityArgs, '--json'], context)).toBe(0);
  expect(JSON.parse(text).execution.waiting).toEqual({ reason });
  text = '';
  expect(await main(['task', 'execute', ...identityArgs, '--lang', 'en'], context)).toBe(0);
  expect.soft(text.split('\n').slice(1, 3)).toEqual([
    'This attempt has no final dispatch record, so its outcome is unknown.',
    'A waiting reason is recorded. Its meaning could not be determined.',
  ]);
  expect(text).not.toContain(reason);
  expect.soft(t('cli.task.execute.unresolved', {}, 'tr')).toBe('Bu denemenin son dağıtım kaydı yok, bu nedenle sonucu bilinmiyor.');
  expect.soft(t('cli.task.execute.unverifiedReason', {}, 'tr')).toBe('Kayıtta bir bekleme nedeni var. Anlamı belirlenemedi.');
});

it.each([
  [null, 'SIGTERM', 'exitCode=yok, signal=SIGTERM'],
  [0, null, 'exitCode=0, signal=yok'],
] as const)('localizes absent terminal fields in Turkish: %s / %s', async (exitCode, signal, expected) => {
  let text = '';
  const context = { stdout: { write(value: string) { text += value; } },
    async executeTask() { return { schemaVersion: 1 as const, layout, execution: {
      identity, status: 'terminal' as const, terminal: { exitCode, signal }, outputRecorded: true,
    } }; } };
  expect(await main(['task', 'execute', ...identityArgs, '--lang', 'tr'], context)).toBe(0);
  expect(text).toContain(expected);
  expect(text).not.toContain('none');
});

it.each([
  ['prevented', null, 'Execution was prevented before launch permission was granted.'],
  ['unresolved', null, 'This attempt has no final dispatch record, so its outcome is unknown.'],
] as const)('renders %s without inventing terminal evidence', async (status, terminal, phrase) => {
  let text = '';
  const context = { stdout: { write(value: string) { text += value; } },
    async executeTask() { return { schemaVersion: 1 as const, layout, execution: { identity, status, terminal, outputRecorded: false } }; } };
  expect(await main(['task', 'execute', ...identityArgs], context)).toBe(0); expect(text).toContain(phrase); expect(text).toMatch(/not task acceptance/i);
});

it('evaluates with a strict command and emits the composition response unchanged as JSON', async () => {
  let received: unknown, text = '';
  const response = { schemaVersion: 1 as const, layout, evaluation: { schemaVersion: 1 as const, commandId: 'evaluate',
    run: { revision: 4, tasks: [{ id: 't', phase: 'accepted' }] } as never } };
  const context = { stdout: { write(value: string) { text += value; } }, async evaluateTask(_root: string, value: unknown) { received = value; return response; } };
  const args = ['task', 'evaluate', ...identityArgs, '--command-id', 'evaluate', '--expected-revision', '3'];
  expect(await main([...args, '--json'], context)).toBe(0);
  expect(received).toEqual({ schemaVersion: 1, commandId: 'evaluate', identity, expectedRevision: 3 }); expect(JSON.parse(text)).toEqual(response);
});

it.each([
  ['task', 'execute', ...identityArgs, '--argv', 'unsafe'],
  ['task', 'execute', ...identityArgs, '--generation', '2'],
  ['task', 'evaluate', ...identityArgs, '--command-id', 'evaluate', '--expected-revision', '0', '--verdict', 'pass'],
  ['task', 'evaluate', ...identityArgs, '--command-id', 'evaluate', '--expected-revision', '-1'],
].map(invalid => ({ invalid })))('rejects private execution fields, duplicates, caller verdicts and invalid counters: %j', async ({ invalid: args }) => {
  let calls = 0; const stderr = { write() {} };
  expect(await main(args, { stderr, async executeTask() { calls++; throw new Error(); }, async evaluateTask() { calls++; throw new Error(); } })).toBe(2);
  expect(calls).toBe(0);
});

it('ISY-24: task inspect names its unsupported attempt flag before reading a task', async () => {
  let output = '', calls = 0;
  expect(await main(['task', 'inspect', '--scope', 's', '--run', 'r', '--task', 't', '--attempt', 'a', '--lang', 'tr'], {
    stderr: { write(text: string) { output += text; } }, async inspectRun() { calls++; return {} as never; },
  })).toBe(2);
  expect(output).toContain('için --attempt geçersiz'); expect(calls).toBe(0);
});
