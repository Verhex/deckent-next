import { runProgressionLines } from '#surfaces/core/recovery-text/index.js';
import { expect, it } from 'vitest';
import { main } from '#surfaces/index.js';
import { resolveProductPaths } from '#platform/index.js';
const layout = resolveProductPaths('/fixture/project', { env: { HOME: '/fixture/home' } });
const run = { runId: 'r', revision: 1, cancellationRequested: false, state: { kind: 'running' }, tasks: [], criteria: [] }; // RunView v3 (A1) always carries the Run state
function harness(value: unknown) {
  const out: string[] = []; const err: string[] = [];
  const context = { env: { NO_COLOR: '1', TERM: 'dumb' }, stdout: { write(v: string) { out.push(v); } }, stderr: { write(v: string) { err.push(v); } },
    async inspectRun() { return { schemaVersion: 1 as const, layout, run: value }; } };
  return { out, err, context: context as never };
}
it.each([['en', 'No recorded Run found: nope.'], ['tr', 'Kayıtlı iş bulunamadı: nope.']])('fails with RUN_NOT_FOUND for a missing Run (%s)', async (lang, message) => {
  const h = harness(null);
  expect(await main(['run', 'inspect', '--scope', 's', '--id', 'nope', '--lang', lang], h.context)).toBe(1);
  expect(h.out.join('')).toBe(''); expect(h.err.join('')).toContain(message);
  const j = harness(null);
  expect(await main(['run', 'inspect', '--scope', 's', '--id', 'nope', '--lang', lang, '--json'], j.context)).toBe(1);
  expect(j.out.join('')).toBe(''); expect(j.err.join('')).toContain('RUN_NOT_FOUND'); expect(j.err.join('')).toContain(message);
});
it('still prints an existing Run with exit 0', async () => {
  const h = harness(run);
  expect(await main(['run', 'inspect', '--scope', 's', '--id', 'r', '--lang', 'en'], h.context)).toBe(0);
  expect(h.out.join('')).toContain('recorded revision'); expect(h.err.join('')).toBe('');
});


it.each(['en', 'tr'] as const)('shows the durable progression failure code and deadline on run inspect in %s', async locale => {
  const state = { kind: 'parked', reason: 'progression-failed', failureCode: 'SUPERVISOR_OPTIONS_INVALID', since: 10, deadline: 1010 };
  const out: string[] = [];
  expect(await main(['run', 'inspect', '--scope', 's', '--id', 'r', '--lang', locale], {
    env: { NO_COLOR: '1', TERM: 'dumb' }, stdout: { write(text: string) { out.push(text); } }, stderr: { write() {} },
    async inspectRun() { return { schemaVersion: 1, layout, run: { ...run, state } }; },
  } as never)).toBe(0);
  // alpha.56 F2 (9ab5bc472): the state and its reason are words in the person's language, not the raw enum.
  expect(out.join('')).toContain('SUPERVISOR_OPTIONS_INVALID'); expect(out.join('')).toContain(locale === 'en' ? 'progression failed' : 'ilerleme başarısız');
  expect(out.join('')).toContain(locale === 'en' ? 'explicitly resume' : 'açıkça devam');
});

it('119-C4: EN/TR inspect preserves missing reserve and cancel, the person preview and separate recovery; stale observation is unknown', async () => {
  const now = Date.now(), observedRun = { ...run, schemaVersion: 3, scopeId: 's' };
  const progression = { schemaVersion: 1, scopeId: 's', runId: 'r', revision: 1, observedAtMs: now, validUntilMs: now + 60000, actorClass: 'ai' as const,
    state: 'blocked', reason: 'POLICY_DENIED', actor: { id: 'ai', issuer: 'local', subject: 'ai' }, policyRevision: 'p1',
    session: 'eligible', suspended: true, parkUnavailable: true,
    missing: ['reserve', 'cancel'].map(action => ({ kind: 'run', id: 'r', action, scope: 's', reason: 'NO_GRANT', code: 'POLICY_DENIED' })) };
  for (const locale of ['en', 'tr']) {
    const out: string[] = [], context = { env: { NO_COLOR: '1', TERM: 'dumb' }, stdout: { write(v: string) { out.push(v); } }, stderr: { write() {} },
      async inspectRun() { return { schemaVersion: 1, layout, run: observedRun, progression }; } };
    expect(await main(['run', 'inspect', '--scope', 's', '--id', 'r', '--lang', locale], context as never)).toBe(0);
    const text = out.join('');
    expect(text).toContain(locale === 'en' ? 'AI execution permission is missing' : 'Yapay zekâ yürütme izni eksik');
    for (const value of ['run/r/reserve', 'run/r/cancel', 'ai', 's', 'RUN_PROGRESSION_PARK_UNAVAILABLE',
      'deckent policy upgrade --template current --only ai-execution --scope s --preview', 'deckent run hold --scope s --id r', 'deckent run cancel --scope s --id r']) expect(text).toContain(value);
    out.length = 0; progression.revision = 0;
    await main(['run', 'inspect', '--scope', 's', '--id', 'r', '--lang', locale], context as never);
    expect(out.join('')).toContain(locale === 'en' ? 'Current service diagnosis is unavailable' : 'Güncel servis tanısı okunamadı');
    expect(out.join('')).not.toContain('--only ai-execution'); progression.revision = 1;
    out.length = 0; progression.validUntilMs = now - 1;
    await main(['run', 'inspect', '--scope', 's', '--id', 'r', '--lang', locale], context as never);
    expect(out.join('')).toContain(locale === 'en' ? 'Current service diagnosis is unavailable' : 'Güncel servis tanısı okunamadı');
    expect(out.join('')).not.toContain('--only ai-execution'); progression.validUntilMs = now + 60000;
    out.length = 0; progression.missing[0]!.reason = 'DENIED';
    await main(['run', 'inspect', '--scope', 's', '--id', 'r', '--lang', locale], context as never);
    expect(out.join('')).toContain(locale === 'en' ? 'authorized administrator' : 'yetkili yönetici');
    expect(out.join('')).not.toContain('--only ai-execution'); progression.missing[0]!.reason = 'NO_GRANT';
    const missing = progression.missing;
    out.length = 0; progression.state = 'maintenance-only'; progression.session = 'ineligible'; progression.missing = [];
    await main(['run', 'inspect', '--scope', 's', '--id', 'r', '--lang', locale], context as never);
    expect(out.join('')).toContain(locale === 'en' ? 'Started work is under maintenance' : 'Başlamış işin bakımı');
    expect(out.join('')).not.toContain(locale === 'en' ? 'propose it again through the service' : 'servis üzerinden yeniden önerin');
    progression.state = 'blocked'; progression.session = 'eligible'; progression.missing = missing;
  }
});

it('119-C4: recovery command arguments cannot become shell syntax', () => {
  for (const locale of ['en', 'tr'] as const) {
    const lines = runProgressionLines({ scopeId: 'scope;false', runId: 'run$(false)', revision: 0 }, undefined, locale).join('\n');
    expect(lines).toContain("deckent run inspect --scope 'scope;false' --id 'run$(false)'");
    expect(lines).not.toContain('--scope scope;false');
    expect(runProgressionLines({ scopeId: "s'cope", runId: 'r', revision: 0 }, undefined, locale).join('\n')).toContain("--scope 's'\\''cope' --id r");
  }
});


it('119-3308: terminal and cancellation-requested CLI inspection keeps state/id and JSON without progression text (EN/TR)', async () => {
  for (const locale of ['en', 'tr']) for (const state of [
    { ...run, state: { kind: 'terminal', outcome: 'completed', reason: 'completed' } },
    { ...run, cancellationRequested: true },
  ]) {
    const h = harness(state);
    expect(await main(['run', 'inspect', '--scope', 's', '--id', 'r', '--lang', locale], h.context)).toBe(0);
    const text = h.out.join('');
    expect(text).toContain(locale === 'en' ? 'Run r' : 'İş r');
    expect(text).toContain(locale === 'en' ? state.state.kind === 'terminal' ? 'completed' : 'running' : state.state.kind === 'terminal' ? 'tamamlandı' : 'çalışıyor');
    expect(text).not.toContain(locale === 'en' ? 'Current service diagnosis is unavailable' : 'Güncel servis tanısı okunamadı');
    expect(text).not.toContain(locale === 'en' ? 'Inspect again for the current cause and next step:' : 'Güncel neden ve sonraki adım için yeniden inceleyin:');
    if (state.cancellationRequested) expect(text).toContain(locale === 'en' ? 'Cancellation: request recorded; worker termination is not confirmed.' : 'İptal: istek kaydedilmiş; işçi sonlanması doğrulanmadı.');
    expect(h.err).toEqual([]);
    const json = harness(state);
    expect(await main(['run', 'inspect', '--scope', 's', '--id', 'r', '--json'], json.context)).toBe(0);
    expect(JSON.parse(json.out.join('')).run).toEqual(state);
  }
});
