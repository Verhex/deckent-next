import { chmod, link, mkdir, mkdtemp, rmdir, readFile, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => vi.unstubAllEnvs());
async function fixture(enabled = true) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-command-timing-'));
  vi.stubEnv('DECKENT_GLOBAL_HOME', root); vi.stubEnv('DECKENT_TIMING_TRACE', enabled ? '1' : '0'); vi.resetModules();
  const timing = await import('#platform/core/state-root/index.js');
  const file = join(root, 'state/timing/commands.jsonl');
  return { root, file, timing };
}
it('stays off without touching disk; records only allowlisted fields and bounds two generations without following links', async () => {
  const off = await fixture(false);
  const disabledClock = vi.spyOn(performance, 'now');
  expect(off.timing.startTiming('/private text')).toBeUndefined(); expect(disabledClock).not.toHaveBeenCalled(); disabledClock.mockRestore();
  await off.timing.flushTiming();
  await expect(stat(join(off.root, 'state'))).rejects.toMatchObject({ code: 'ENOENT' });
  const { root, file, timing } = await fixture();
  const LIMITS = timing.TIMING_TRACE_LIMITS;
  const record = () => { const trace = timing.startTiming('/private/path private-provider private prompt')!;
    timing.runWithTiming(trace, () => { timing.beginTimingRead('/private/path')?.(); const end = timing.beginTimingRead('config'); end?.('hit'); });
    trace.phase('finished'); };
  record(); await timing.flushTiming();
  const encoded = await readFile(file, 'utf8'), row = JSON.parse(encoded);
  expect(encoded).not.toContain('private');
  expect(Object.keys(row)).toEqual(['schemaVersion', 'buildId', 'traceId', 'command', 'phase', 'elapsedMs', 'counts', 'cacheOutcome', 'result']);
  expect(row.counts).toEqual({ 'config:hit': { count: 1, totalMs: expect.any(Number) }, dropped: { count: 0, totalMs: 0 } });
  expect([(await stat(file)).mode & 0o777, (await stat(join(root, 'state/timing'))).mode & 0o777]).toEqual([0o600, 0o700]);
  await writeFile(file, encoded.repeat(Math.floor(LIMITS.maxBytes / Buffer.byteLength(encoded))));
  record(); record(); await timing.flushTiming();
  expect((await stat(file)).size).toBeLessThanOrEqual(LIMITS.maxBytes); expect((await stat(`${file}.1`)).size).toBeLessThanOrEqual(LIMITS.maxBytes);
  const sentinel = join(root, 'sentinel'); await writeFile(sentinel, 'UNCHANGED', { mode: 0o600 });
  await unlink(file); await symlink(sentinel, file);
  record(); await timing.flushTiming(); expect(await readFile(sentinel, 'utf8')).toBe('UNCHANGED');
  await unlink(file); await link(sentinel, file); record(); await timing.flushTiming();
  expect(await readFile(sentinel, 'utf8')).toBe('UNCHANGED'); await unlink(file);
  await chmod(join(root, 'state/timing'), 0o755); record(); await timing.flushTiming();
  await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' }); await chmod(join(root, 'state/timing'), 0o700);
  await mkdir(`${file}.lock`); record(); await timing.flushTiming();
  await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' }); await rmdir(`${file}.lock`);
  // A bounded pending queue reports overflow in subsequent retained records.
  for (let index = 0; index < LIMITS.maxPendingRecords + 10; index++) timing.startTiming('model')?.phase('queued');
  await timing.flushTiming();
  expect((await readFile(file, 'utf8')).split('\n').filter(Boolean).some(line => JSON.parse(line).counts.dropped.count > 0)).toBe(true);
});

it('traces names/checking before completed row checks for model/provider, bypassing the unresolved service gate and excluding picker dwell', async () => {
  for (const command of ['model', 'provider'] as const) {
    const { file, timing } = await fixture();
    const { mountWorkline, settle, until, WORKLINE_TEST_LABELS } = await import('../support/workline-harness.js');
    const { SLASH_WINDOW_TEST_LABELS } = await import('../support/slash-window-labels.js');
    const { terminalPanelLabels } = await import('#surfaces/core/work-labels/index.js');
    let named!: () => void, populated!: () => void;
    const names = new Promise<void>(done => { named = done; }), data = new Promise<void>(done => { populated = done; });
    const reference = { providerId: 'fixture', providerVersion: 1, modelId: 'fixture', modelVersion: 1 };
    const model = { inspect: async (progress?: (value: import('#surfaces/core/terminal-panels/index.js').ModelPanelView) => void | Promise<void>) => {
      const end = timing.beginTimingRead('config'); await names; end?.('hit');
      await progress?.({ title: 'TIMING-NAMES', choices: [{ reference, label: 'Named model', group: 'fixture', detail: 'Checking…', blocked: 'Checking…',
        exact: 'fixture', command: null, configured: false }], notes: [], defaultBlocked: null });
      await data; return { title: 'TIMING-POPULATED', choices: [], notes: [], defaultBlocked: null };
    } };
    const provider = { inspect: async (progress?: (value: import('#surfaces/core/terminal-panels/index.js').ProviderPanelView) => void | Promise<void>) => {
      const end = timing.beginTimingRead('config'); await names; end?.('hit');
      await progress?.({ title: 'TIMING-NAMES', kinds: [{ id: 'fixture', label: 'Named provider', detail: 'Checking…', blocked: 'Checking…', keyName: null,
        keyStored: false, endpointEditable: false, endpointDefault: null, keyRequired: false, endpointChoices: [], models: [], modelBlocked: 'Checking…' }], notes: [] });
      await data; return { title: 'TIMING-POPULATED', kinds: [], notes: [] };
    }, transparency: [], endpoint: () => ({ ok: false as const, reason: 'fixture' }),
    connect: async () => ({ stored: false, title: 'fixture', lines: [] }), disconnect: async () => [] };
    const view = mountWorkline({ labels: { ...WORKLINE_TEST_LABELS, windows: SLASH_WINDOW_TEST_LABELS },
      streamTurn: async () => ({ text: '', usage: null }), opening: { ready: new Promise<void>(() => {}), notices: async () => [], wait: 'WAIT' },
      panels: { labels: terminalPanelLabels('en'), ports: { model, provider } } });
    const release = timing.installTimingFlush(async () => { await new Promise<void>(done => setImmediate(done)); await view.instance.waitUntilRenderFlush(); });
    try {
      await settle(50); view.stdin.write(`/${command} private-provider\r`);
      await until(() => view.stdout.frame.includes('Loading'), 'loading frame'); await timing.flushTiming();
      let rows = (await readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(rows.map(row => row.phase)).toEqual(['queued', 'started', 'gate-passed', 'dispatch']);
      expect(view.stdout.frame).not.toContain('WAIT');
      named(); await until(() => view.stdout.frame.includes('Checking…') && view.stdout.frame.includes(`Named ${command}`), 'names/checking frame');
      await settle(30); await timing.flushTiming();
      rows = (await readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(rows.map(row => row.phase)).toEqual(['queued', 'started', 'gate-passed', 'dispatch', 'first-flush']);
      populated(); await until(() => view.stdout.frame.includes('TIMING-POPULATED'), 'populated frame'); await settle(30); await timing.flushTiming();
      const beforeClose = await readFile(file, 'utf8'), phases = beforeClose.trim().split('\n').map(line => JSON.parse(line));
      expect(phases.map(row => row.phase)).toEqual(['queued', 'started', 'gate-passed', 'dispatch', 'first-flush', 'populated-flush', 'finished']);
      expect(new Set(phases.map(row => row.traceId)).size).toBe(1); expect(beforeClose).not.toContain('private-provider');
      expect(phases.at(-1).counts['config:hit'].count).toBe(1);
      await settle(100); view.stdin.write('\u001b'); await settle(50); await timing.flushTiming();
      expect(await readFile(file, 'utf8')).toBe(beforeClose);
      const summary = await timing.readTimingSummary(); expect(summary.commands).toEqual([{ command: `/${command}`, samples: 1,
        median: phases[5].elapsedMs, p95: phases[5].elapsedMs, slowestPhase: expect.any(String) }]);
    } finally { release(); view.instance.unmount(); await timing.flushTiming(); }
  }
});

it('attributes parallel reads to their own trace, cancels independently, and renders a read-only EN/TR CLI summary', async () => {
  const { timing, file } = await fixture();
  const { createPanelController } = await import('#surfaces/core/terminal-kit/index.js');
  const parent = timing.startTiming('terminal')!; parent.phase('process-entry');
  const context = { kind: 'terminal-local' as const, installationId: 'installation', projectId: 'project', scopeId: 'scope', sessionId: 'session' };
  let submitted: string | undefined;
  const controller = createPanelController({ kind: 'terminal-local', context, history: { kind: 'disabled', port: null }, now: Date.now,
    execute: async () => { submitted = timing.currentTiming()?.traceId; }, decideApproval: async () => {}, retireApproval() {} });
  timing.runWithTiming(parent, () => controller.send({ kind: 'submit', context, inputId: 'input', text: '/model' }));
  expect(submitted).toBeDefined(); expect(submitted).not.toBe(parent.traceId);
  const a = timing.startTiming('model')!, b = timing.startTiming('provider')!;
  a.phase('process-entry'); b.phase('process-entry');
  await Promise.all([timing.runWithTiming(a, async () => { const end = timing.beginTimingRead('config'); await Promise.resolve(); end?.('forced'); a.phase('first-flush'); a.finish(); }),
    timing.runWithTiming(b, async () => { const end = timing.beginTimingRead('runtime-request', 'inspectProviderSpendAccount'); await Promise.resolve(); end?.(); b.finish(true); })]);
  timing.runWithTiming(a, () => timing.beginTimingRead('config')?.('miss'));
  await timing.flushTiming();
  const rows = (await readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  expect(rows.find(row => row.traceId === a.traceId && row.phase === 'finished').counts).toHaveProperty('config:forced');
  expect(rows.find(row => row.traceId === a.traceId && row.phase === 'finished').counts).not.toHaveProperty('runtime-request.inspectProviderSpendAccount:none');
  expect(rows.find(row => row.traceId === b.traceId && row.phase === 'cancelled')).toMatchObject({ phase: 'cancelled', result: 'cancelled', counts: { 'runtime-request.inspectProviderSpendAccount:none': { count: 1 } } });
  expect(rows.find(row => row.traceId === a.traceId && row.phase === 'read-completed').counts['config:miss'].count).toBe(1);
  const clock = vi.spyOn(performance, 'now');
  for (const elapsed of [10, 20, 30, 40, 100]) { clock.mockReturnValue(0); const sample = timing.startTiming('doctor', 0)!; sample.phase('process-entry'); clock.mockReturnValue(elapsed); sample.phase('first-output'); sample.finish(); }
  clock.mockRestore(); await timing.flushTiming();
  expect((await timing.readTimingSummary()).commands.find(row => row.command === 'deckent doctor')).toEqual({ command: 'deckent doctor', samples: 5, median: 30, p95: 100, slowestPhase: 'first-output' });
  const { CLI_CATALOG } = await import('#surfaces/core/cli-kit/index.js');
  const { WORKLINE_SLASH_COMMANDS } = await import('#surfaces/core/terminal-kit/index.js');
  for (const command of [...CLI_CATALOG, ...WORKLINE_SLASH_COMMANDS]) expect(timing.timingCommand(command.name)).toBe(command.name);
  const { runKernelCommand } = await import('#surfaces/core/cli/index.js');
  for (const [locale, title] of [['en', 'Local command timing'], ['tr', 'Yerel komut süreleri']] as const) {
    const output: string[] = [];
    await runKernelCommand(['doctor', 'timing'], { locale, stdout: { write: (text: string) => { output.push(text); return true; } } });
    expect(output.join('')).toContain(title); expect(output.join('')).toContain('model: 1');
  }
});
