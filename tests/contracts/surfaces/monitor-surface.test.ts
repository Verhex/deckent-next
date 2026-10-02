import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { createElement } from 'react';
import { render, renderToString } from 'ink';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../../../src/surfaces/index.js';
import { clearConfigCache, t } from '#platform/index.js';
import { loadMonitorSurface } from '#surfaces/core/monitor/index.js';
import { resolveWorklinePalette } from '#surfaces/core/terminal-kit/index.js';
import { cells } from '#surfaces/core/terminal-render/index.js';
import { WORKLINE_SLASH_COMMANDS } from '#surfaces/core/terminal-kit/index.js';
import { mountWorkline, until as untilWorkline } from '../support/workline-harness.js';
import { BLOCKER_CODES, emptySnapshot, fullSnapshot, longIdSnapshot, OBSERVED_AT } from '../../fixtures/monitor/snapshots.js';

/** MONITOR-SURFACE: the text snapshot, `--json`, the typed unavailable error and the fullscreen view, all from fixture MonitorSnapshots. */
const surface = await loadMonitorSurface();
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const widest = (text: string) => Math.max(...text.split('\n').map(line => cells(line)));

describe('monitor text snapshot', () => {
  for (const locale of ['en', 'tr'] as const) for (const width of [120, 80, 60]) {
    it(`renders every section of the full fixture (${locale}, ${width} columns) without overflow`, async () => {
      const text = surface.renderMonitorText(fullSnapshot, { locale, width, ascii: false });
      expect(widest(text)).toBeLessThanOrEqual(width);
      await expect(`${text}\n`).toMatchFileSnapshot(`../../fixtures/monitor/text-full-${locale}-${width}.txt`);
    });
  }
  it('words every blocker code, puts the oldest stuck Run first and keeps the reason visible without colour', () => {
    const text = surface.renderMonitorText(fullSnapshot, { locale: 'en', width: 200, ascii: true });
    const labels = { none: 'progressing normally', 'waiting-pool-slot': 'waiting for a pool slot', 'pool-held': 'pool on hold',
      'waiting-dependency': 'waiting for a dependency', 'awaiting-approval': 'awaiting approval', 'worker-running': 'worker running',
      'worker-stale-heartbeat': 'worker silent (stale heartbeat)', 'worker-exited-unevaluated': 'worker exited, not evaluated',
      'evaluation-not-ready': 'evaluation not ready', 'evaluation-unknown': 'evaluation result unknown', 'unresolved-effect': 'effect outcome uncertain',
      'cancellation-pending': 'cancellation pending', 'not-admitted': 'not admitted yet', unknown: 'reason unknown' } as const;
    for (const code of BLOCKER_CODES) expect(text, code).toContain(labels[code]);
    const summary = text.slice(text.indexOf('Stuck or waiting'), text.indexOf('Workers running now'));
    // The approval wait (3 h 12 min) is the oldest; the `unknown` blocker has no proven start and goes last; moving Runs are not stuck.
    expect(summary.indexOf('run-blocked-approval')).toBeLessThan(summary.indexOf('run-waiting-pool-slot'));
    expect(summary.indexOf('run-cancellation-pending')).toBeLessThan(summary.indexOf('run-unknown'));
    expect(summary).not.toContain('run-none'); expect(summary).not.toContain('run-worker-running');
    expect(summary).toContain('3 h 12 min'); expect(summary).toContain('(appr-0001)');
    expect(text).toContain('x build: ✗ [unit-budget] src/surfaces/core/cli — 2001 lines > unit budget 2000');
    expect(text).toContain('x build: first failing line not recorded');
    expect(text).toContain('! remote-lab is unavailable: the ledger could not be read (LEDGER_LOCKED); service state could not be read (LOCAL_RUNTIME_DENIED)');
    expect(text).toContain('! current has problems: scope scope-x could not be read (LEDGER_LOCKED)');
    expect(text).toContain('! dogfood has problems: the ledger is version 43, older than this build: newer fields may be empty; future-code:abc');
    // An `info:` diagnostic is a neutral note: no warning mark, not counted in the header.
    expect(text).toContain('dogfood note: only the most recent finished workers are shown; 5 older ones are hidden');
    expect(text).not.toMatch(/! [^\n]*most recent finished workers/);
    expect(text).toMatch(/\* dogfood [^\n]*! 3 warning\(s\)/);
    expect(text).toContain('build b0e66d92c0ff (built 2026-10-02 08:00:00Z)'); expect(text).toContain('build 76582f9f0000 (built 2026-10-01 22:15:00Z)');
    expect(text).toContain('expired 2 min 0 s ago'); expect(text).toContain('expires in 45 min');
    expect(text).toContain('! 1 min 35 s (stale)');
    expect(text).not.toContain('\u001b[');
  });
  it('states every empty view in a sentence and points at the observation sources config', async () => {
    for (const locale of ['en', 'tr'] as const) {
      const text = surface.renderMonitorText(emptySnapshot, { locale, width: 100, ascii: false });
      for (const key of ['monitor.empty.approvals', 'monitor.empty.pools', 'monitor.empty.workers', 'monitor.empty.runs', 'monitor.empty.otherInstalls',
        'monitor.summary.noOpenRuns', 'monitor.summary.noWorkers'] as const) expect(text, key).toContain(t(key, {}, locale));
      await expect(`${text}\n`).toMatchFileSnapshot(`../../fixtures/monitor/text-empty-${locale}.txt`);
    }
    expect(surface.renderMonitorText(emptySnapshot, { locale: 'tr', width: 100, ascii: false })).toContain('Bekleyen onay yok');
  });
  it('cuts long ids and paths at every width instead of wrapping or overflowing', async () => {
    for (const width of [40, 60, 79, 80, 120, 200]) {
      const text = surface.renderMonitorText(longIdSnapshot, { locale: 'en', width, ascii: width < 60 });
      expect(widest(text), String(width)).toBeLessThanOrEqual(width);
    }
    await expect(`${surface.renderMonitorText(longIdSnapshot, { locale: 'en', width: 60, ascii: false })}\n`).toMatchFileSnapshot('../../fixtures/monitor/text-long-en-60.txt');
  });
  it('narrows to one install or one scope without changing the snapshot shape', () => {
    const one = surface.filterSnapshot(fullSnapshot, { install: 'dogfood' });
    expect(one.installs.map(install => install.id)).toEqual(['dogfood']);
    const scoped = surface.filterSnapshot(fullSnapshot, { scope: 'scope-dog' });
    expect(scoped.installs.flatMap(install => install.runs.map(run => run.runId))).toEqual(['run-dog-1']);
    expect(scoped.installs.flatMap(install => install.approvals.map(approval => approval.approvalId))).toEqual(['appr-dog']);
    expect(surface.filterSnapshot(fullSnapshot, {})).toBe(fullSnapshot);
  });
});

async function project() {
  const root = await mkdtemp(join(tmpdir(), 'dn-monitor-cli-')); roots.push(root);
  await mkdir(join(root, '.deckent'), { recursive: true }); await writeFile(join(root, '.deckent/config.json'), JSON.stringify({ layout: { root: join(root, 'd') } }));
  return root;
}
async function cli(argv: string[], handlers: Record<string, unknown>, root: string, env: Record<string, string> = {}) {
  const out: string[] = [], err: string[] = [];
  const code = await main(argv, { root, env: { HOME: join(root, 'h'), USERPROFILE: join(root, 'h'), ...env }, initialize() {},
    stdout: { write(value: string) { out.push(value); } }, stderr: { write(value: string) { err.push(value); } }, ...handlers } as never);
  return { code, out: out.join(''), err: err.join('') };
}

describe('deckent monitor command', () => {
  it('--json prints the handler snapshot byte for byte; --once and a pipe print the text snapshot', async () => {
    const root = await project(); let calls = 0;
    const handlers = { async inspectMonitor(at: string) { calls++; expect(at).toBe(root); return fullSnapshot; } };
    const json = await cli(['monitor', '--json'], handlers, root);
    expect(json.code).toBe(0); expect(json.out).toBe(`${JSON.stringify(fullSnapshot)}\n`);
    const narrowed = await cli(['monitor', '--json', '--install', 'dogfood'], handlers, root);
    expect(JSON.parse(narrowed.out).installs.map((install: { id: string }) => install.id)).toEqual(['dogfood']);
    const once = await cli(['monitor', '--once', '--lang', 'tr'], handlers, root);
    expect(once.code).toBe(0); expect(once.out).toBe(`${surface.renderMonitorText(fullSnapshot, { locale: 'tr', width: 120, ascii: false })}\n`);
    const piped = await cli(['monitor', '--lang', 'en'], handlers, root, { COLUMNS: '90' });
    expect(piped.out).toBe(`${surface.renderMonitorText(fullSnapshot, { locale: 'en', width: 90, ascii: false })}\n`);
    expect(calls).toBe(4);
  });
  it('fails typed (MONITOR_UNAVAILABLE, en/tr) without a monitor handler and rejects unknown flags as usage', async () => {
    const root = await project();
    const english = await cli(['monitor', '--once'], {}, root);
    expect(english.code).toBe(1); expect(english.err).toContain(t('error.MONITOR_UNAVAILABLE', {}, 'en'));
    const turkish = await cli(['monitor', '--once', '--lang', 'tr'], {}, root);
    expect(turkish.err).toContain('izleme veri kaynağı bağlı değil');
    expect((await cli(['monitor', '--watch'], { async inspectMonitor() { return fullSnapshot; } }, root)).code).toBe(2);
    expect((await cli(['monitor', '--scope'], { async inspectMonitor() { return fullSnapshot; } }, root)).code).toBe(2);
    expect((await cli(['monitor', 'toString'], { async inspectMonitor() { return fullSnapshot; } }, root)).code).toBe(2);
    expect((await cli(['monitor', '--help', '--once'], {}, root)).code).toBe(2);
    const help = await cli(['monitor', '--help', '--lang', 'tr'], {}, root);
    expect(help.code).toBe(0); expect(help.out).toContain('--once'); expect(help.out).toContain('Yalnız gözlem');
    expect((await cli(['--help'], {}, root)).out).toContain('monitor [--once|--json]');
  });
});

class Screen extends Writable {
  frame = ''; readonly isTTY = true;
  constructor(readonly columns: number, readonly rows: number) { super(); }
  override _write(chunk: Buffer, _encoding: string, done: () => void) { const text = chunk.toString('utf8'); if (text.trim()) this.frame = text; done(); }
}
const settle = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, label: string) { for (let i = 0; i < 300; i++) { if (check()) return; await settle(10); } throw new Error(`timed out: ${label}`); }
function mount(props: { load: () => Promise<typeof fullSnapshot>; intervalMs?: number; columns?: number; rows?: number; locale?: 'en' | 'tr'; now?: () => number; loadConfigView?: () => Promise<Awaited<ReturnType<import('#engine/index.js').ConfigApplication['inspect']>>> }) {
  const stdout = new Screen(props.columns ?? 120, props.rows ?? 40);
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() { return stdin; }, ref() { return stdin; }, unref() { return stdin; } });
  const instance = render(createElement(surface.MonitorApp, { load: props.load, intervalMs: props.intervalMs ?? 60_000, locale: props.locale ?? 'en', ascii: false,
    ...(props.loadConfigView ? { loadConfigView: props.loadConfigView } : {}), palette: resolveWorklinePalette('none'), errorText: (error: unknown) => surface.monitorFailureText(error, props.locale ?? 'en'), ...(props.now ? { now: props.now } : {}) }),
  { stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, debug: true, exitOnCtrlC: false, patchConsole: false });
  const press = async (key: string) => { stdin.write(key); await settle(); };
  return { stdout, stdin, instance, press };
}
const KEY = { tab: '\t', right: '\u001b[C', left: '\u001b[D', down: '\u001b[B', up: '\u001b[A', enter: '\r', esc: '\u001b' };

describe('fullscreen monitor', () => {
  it('opens on the summary, moves through tabs and rows with the keyboard, shows details and goes back', async () => {
    const view = mount({ load: async () => fullSnapshot });
    try {
      await until(() => view.stdout.frame.includes('Stuck or waiting'), 'summary');
      expect(view.stdout.frame).toContain('[1 Summary]'); expect(view.stdout.frame).toContain('Tab/←→ tabs');
      await view.press(KEY.tab);
      expect(view.stdout.frame).toContain('[2 Runs]');
      // Runs are newest first; the selection marker (not colour) shows the selected row under the NO_COLOR palette.
      expect(view.stdout.frame).toMatch(/› run-broken\s/);
      await view.press(KEY.down);
      expect(view.stdout.frame).toMatch(/› run-broken-quiet/);
      await view.press(KEY.up); await view.press(KEY.enter);
      // "Where did it first fail": the recorded first failing line, the attempt timeline and the last worker events.
      expect(view.stdout.frame).toContain('Run run-broken · scope scope-a · revision 7');
      expect(view.stdout.frame).toContain('first failure: ✗ [unit-budget] src/surfaces/core/cli — 2001 lines > unit budget 2000');
      expect(view.stdout.frame).toMatch(/attempt [0-9a-f]{8} gen 1 · launch launched · 08:55:00Z → 09:05:00Z \(≈ 10 min\) · exit 1 · claude\/model-alpha-2/);
      expect(view.stdout.frame).toContain('09:29:30Z · tool.call · shell npm test -- monitor-surface');
      expect(view.stdout.frame).toContain('Delivery/adoption: no integration, delivery or adoption recorded.');
      expect(view.stdout.frame).toContain('depends on: build');
      await view.press(KEY.esc); await view.press(KEY.down); await view.press(KEY.enter);
      expect(view.stdout.frame).toContain('first failure: the first failing line is not in the record');
      await view.press(KEY.esc);
      expect(view.stdout.frame).toMatch(/› run-broken-quiet/);
      await view.press('3');
      expect(view.stdout.frame).toContain('[3 Workers]');
      await view.press(KEY.enter);
      expect(view.stdout.frame).toContain('Doing now: editing · src/app.ts — apply patch');
      expect(view.stdout.frame).toContain('requested model-alpha-2');
      await view.press(KEY.esc); await view.press(KEY.down); await view.press(KEY.enter);
      // A finished ledger-only worker: model and first failure come from its Run attempt.
      expect(view.stdout.frame).toContain('Worker run-broken/build');
      expect(view.stdout.frame).toContain('first failure: ✗ [unit-budget]');
      expect(view.stdout.frame).toContain('ledger record only (the worker\'s files are gone)');
      await view.press(KEY.esc); await view.press(KEY.left);
      expect(view.stdout.frame).toContain('[2 Runs]');
      await view.press('?');
      expect(view.stdout.frame).toContain('pause or resume automatic refresh');
      expect(view.stdout.frame).toContain('Legend: mark · colour · meaning');
      expect(view.stdout.frame).toContain('row changed since the last refresh');
      await view.press(KEY.esc);
      expect(view.stdout.frame).not.toContain('pause or resume automatic refresh');
      await view.press('6');
      expect(view.stdout.frame).toContain('remote-lab');
      await view.press('7');
      expect(view.stdout.frame).toContain('[7 Map]');
      expect(view.stdout.frame).toContain('task kind coding → profile coding-default@3 (docker)');
      expect(view.stdout.frame).toContain('Memory: none yet — waits for the MEMORY card');
      await view.press('q');
      await view.instance.waitUntilExit();
    } finally { view.instance.unmount(); }
  });
  it('refreshes in place every interval, single-flight; r refreshes now; p pauses; a failure keeps the last snapshot with a warning', async () => {
    let calls = 0, fail = false, release: (() => void) | null = null;
    const view = mount({ intervalMs: 40, load: async () => {
      calls++;
      if (fail) throw Object.assign(new Error('socket path /secret/x'), { code: 'INVENTORY_UNAVAILABLE' });
      if (calls === 3) await new Promise<void>(resolve => { release = resolve; });
      return { ...fullSnapshot, observedAt: OBSERVED_AT + calls * 1000 };
    } });
    try {
      await until(() => calls >= 3, 'automatic refreshes');
      // The third read hangs: neither the timer nor `r` may start a fourth read meanwhile.
      await view.press('r'); await view.press('r'); await settle(120);
      expect(calls).toBe(3);
      release!(); await until(() => view.stdout.frame.includes('2026-10-02 09:30:03Z'), 'third snapshot');
      await view.press('p');
      expect(view.stdout.frame).toContain('Paused: press p to resume');
      const paused = calls; await settle(150);
      expect(calls).toBe(paused);
      fail = true; await view.press('r');
      await until(() => view.stdout.frame.includes('refresh failed'), 'failure warning');
      expect(view.stdout.frame).toContain(t('error.INVENTORY_UNAVAILABLE', {}, 'en'));
      expect(view.stdout.frame).not.toContain('/secret/x');
      expect(view.stdout.frame).toContain('Stuck or waiting');
      fail = false; await view.press('p');
      await until(() => !view.stdout.frame.includes('refresh failed'), 'recovered');
    } finally { view.instance.unmount(); }
  });
  it('never overflows a narrow terminal and keeps a stable height', async () => {
    for (const columns of [60, 79]) {
      const view = mount({ load: async () => longIdSnapshot, columns, rows: 20 });
      try {
        await until(() => view.stdout.frame.includes('Stuck'), 'summary');
        for (const key of ['', KEY.tab, KEY.tab, KEY.tab, KEY.tab, KEY.tab, KEY.tab, '?']) {
          if (key) await view.press(key);
          const lines = view.stdout.frame.replace(/\n$/, '').split('\n');
          expect(widest(view.stdout.frame), `${columns} ${JSON.stringify(key)}`).toBeLessThanOrEqual(columns);
          // rows - 1 lines, always: a frame that fills every row makes some terminals (Windows console) clear and redraw each refresh.
          expect(lines.length).toBe(19);
        }
      } finally { view.instance.unmount(); }
    }
  });
  it('renders one deterministic frame for a snapshot (frame dump)', async () => {
    const frame = renderToString(createElement(surface.MonitorApp, { load: async () => fullSnapshot, initial: fullSnapshot, intervalMs: 2000, locale: 'tr', ascii: false,
      palette: resolveWorklinePalette('none'), errorText: () => 'x', size: { columns: 120, rows: 40 } }), { columns: 120 });
    expect(widest(frame)).toBeLessThanOrEqual(120);
    await expect(`${frame}\n`).toMatchFileSnapshot('../../fixtures/monitor/frame-full-tr-120.txt');
  });
});

describe('monitor v1.1: first failure, timeline, map, diagnostics, order', () => {
  it('words every data-lane diagnostic, keeps unknown codes visible and treats info: as a note', () => {
    const codes = ['service-unavailable:LOCAL_RUNTIME_DENIED', 'ledger-unavailable:LEDGER_LOCKED', 'ledger-version-older:43', 'scope-denied:s1', 'scope-unavailable:s1',
      'scope-unavailable:s1:LEDGER_LOCKED', 'workers-unavailable:s1', 'workers-denied:s1', 'workers-not-sampled:s1', 'workers-truncated:s1', 'workers-finished-capped:5',
      'runs-truncated:900', 'run-corrupt:s1/r1', 'approvals-truncated', 'approval-corrupt:s1/a1', 'pool-occupancy-corrupt:p1', 'pool-corrupt:p1', 'ledger-only'];
    for (const locale of ['en', 'tr'] as const) for (const code of codes) {
      const described = surface.describeDiagnostic(code, locale);
      expect(described.note, code).toBe(false); expect(described.text, code).not.toBe(code); expect(described.text, code).not.toContain('{');
    }
    expect(surface.describeDiagnostic('scope-unavailable:s1:LEDGER_LOCKED', 'tr').text).toBe('s1 kapsamı okunamadı (LEDGER_LOCKED)');
    expect(surface.describeDiagnostic('scope-unavailable:s1', 'en').text).toBe('scope s1 could not be read');
    expect(surface.describeDiagnostic('info:workers-finished-capped:5', 'tr')).toEqual({ code: 'workers-finished-capped', note: true,
      text: "biten worker'ların yalnız en yenileri gösteriliyor; 5 eskisi gizli" });
    expect(surface.describeDiagnostic('brand-new-code:x', 'en')).toEqual({ code: 'brand-new-code', note: false, text: 'brand-new-code:x' });
  });
  it('shows the Map tab in sentences (layers, registry, models, policy, honest memory) and says when no map was read', () => {
    const tr = surface.renderMonitorText(fullSnapshot, { locale: 'tr', width: 160, ascii: false });
    expect(tr).toContain('Yapılandırma katmanları (sonraki katman öncekileri ezer):');
    expect(tr).toContain('3. proje — /home/owner/projects/deckent-next/.deckent/config.json — belirlediği bölümler: layout, terminal, inspection');
    expect(tr).toContain('coding görevi → coding-default@3 profili (docker)');
    expect(tr).toContain('legacy-shell@1 (host) — hiçbir görev türü kullanmıyor');
    expect(tr).toContain('✓ subscription / model-alpha-2'); expect(tr).toContain('○ subscription / model-alpha-1 (etkin değil)');
    expect(tr).toContain('Politika: 12 izin (operation 5, effect 4, secret 3) · 2 görev ayrılığı kuralı');
    expect(tr).toContain('İzin kipleri: owner@local: standart, ci@local: full-auto');
    expect(tr).toContain('Bellek: yok — MEMORY kartı bekleniyor');
    expect(tr).toContain('Bu kurulum için harita okunmadı.');
    expect(tr).not.toMatch(/[{}]"/);
  });
  it('lists Runs newest first with a duration column, unknown admission last; workers newest first with the attempt model', () => {
    const text = surface.renderMonitorText(fullSnapshot, { locale: 'en', width: 200, ascii: false });
    const runs = text.slice(text.indexOf('── Runs'), text.indexOf('── Workers'));
    const order = ['run-broken ', 'run-broken-quiet', 'run-dog-1', 'run-not-admitted', 'run-stopped', 'run-unknown'].map(name => runs.indexOf(name));
    expect(order.every(index => index > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(runs).toMatch(/run-broken\s+✗ failed\s+—\s+—\s+≈ 15 min\s+0\/2 accepted\s+—\s/);
    // No proven end → unknown, never last-activity arithmetic (owner: the "1 s" for 8-minute Runs on N1).
    expect(runs).toMatch(/run-broken-quiet\s+✗ failed\s+—\s+—\s+unknown\s/);
    expect(runs).toMatch(/run-done\s+✓ accepted\s+—\s+—\s+1 h 10 min\s+2\/2 accepted\s+adopted 1a2b3c4\s/);
    expect(runs).toMatch(/run-stopped\s+■ cancelled\s+—\s+—\s+unknown\s+0\/2 accepted\s+rolled back\s/);
    expect(runs).toMatch(/run-not-admitted\s+~ waiting\s+not admitted yet\s+1 h 33 min\s+running\s/);
    const workers = text.slice(text.indexOf('── Workers'), text.indexOf('── Approvals'));
    expect(workers).toMatch(/run-broken\/build .*exited 1 .*claude\/model-alpha-2/);
  });
});

describe('monitor finish/delivery/attempt diagnostics', () => {
  it('shows delivery in the Run detail, attempt diagnostics as problems and hidden approval summaries honestly (en/tr)', () => {
    const en = surface.renderMonitorText(fullSnapshot, { locale: 'en', width: 200, ascii: false });
    expect(en).toContain('operation: you may not see the summary'); expect(en).toContain('approvals of scope scope-dog are hidden: you may not see them');
    const tr = surface.renderMonitorText(fullSnapshot, { locale: 'tr', width: 200, ascii: false });
    expect(tr).toContain('operation: özet görme izniniz yok'); expect(tr).toContain('scope-dog kapsamının onayları gizli: görme izniniz yok');
    expect(surface.describeDiagnostic('output-denied', 'tr').text).toBe('denemenin çıktısı okunmadı: okuma izni yok');
    expect(surface.describeDiagnostic('attempt-files-unavailable:scope-a/run-x/build:EACCES', 'en').text).toBe('the files of attempt scope-a/run-x/build could not be read (EACCES)');
    expect(surface.describeDiagnostic('ledger-version-unsupported:99', 'en').text).toBe('the ledger is version 99, which this build cannot read');
  });
  it('Run detail: delivery state + commit, "no delivery recorded", unknown end, ≈ host-observed end, output-denied', async () => {
    const view = mount({ load: async () => fullSnapshot });
    try {
      await until(() => view.stdout.frame.includes('Stuck or waiting'), 'summary');
      await view.press('2'); await view.press(KEY.enter);
      expect(view.stdout.frame).toContain('Run run-broken'); expect(view.stdout.frame).toContain('duration ≈ 15 min');
      expect(view.stdout.frame).toContain('Delivery/adoption: no integration, delivery or adoption recorded.');
      expect(view.stdout.frame).toContain('08:55:00Z → 09:05:00Z (≈ 10 min) · exit 1');
      await view.press(KEY.esc); await view.press(KEY.down); await view.press(KEY.enter);
      expect(view.stdout.frame).toContain('Run run-broken-quiet'); expect(view.stdout.frame).toContain('duration unknown');
      expect(view.stdout.frame).toContain("⚠ the attempt's output was not read: no permission to read it");
      await view.press(KEY.esc);
      for (let i = 0; i < 10 && !/› run-done/.test(view.stdout.frame); i++) await view.press(KEY.down);
      await view.press(KEY.enter);
      expect(view.stdout.frame).toContain('Delivery/adoption: adopted · commit 1a2b3c4d5e6f708192a3b4c5d6e7f80912a3b4c5');
    } finally { view.instance.unmount(); }
  });
});

describe('fullscreen controls: filter, sort, group, change marks, snapshot age', () => {
  it('filters with text, prefixes and !, shows the filter in the header and clears it with Esc', async () => {
    const run = (name: string, state: string) => ({ key: name, cells: [{ text: name }], detail: () => [], facets: { state, install: 'current', kind: 'coding', run: name } });
    expect(surface.rowMatches(run('run-a', 'failed'), 's:failed')).toBe(true);
    expect(surface.rowMatches(run('run-a', 'failed'), '!s:failed')).toBe(false);
    expect(surface.rowMatches(run('run-a', 'failed'), 'i:dog')).toBe(false);
    expect(surface.rowMatches(run('run-a', 'failed'), 'run-a t:coding')).toBe(true);
    const view = mount({ load: async () => fullSnapshot });
    try {
      await until(() => view.stdout.frame.includes('Stuck or waiting'), 'summary');
      await view.press(KEY.tab); await view.press('/'); await view.press('s:failed');
      expect(view.stdout.frame).toContain('/s:failed');
      await view.press(KEY.enter);
      expect(view.stdout.frame).toContain('filter: s:failed');
      expect(view.stdout.frame).toContain('run-broken-quiet'); expect(view.stdout.frame).not.toContain('run-none');
      await view.press('/'); await view.press('\u007f'.repeat(8)); await view.press('!i:current'); await view.press(KEY.enter);
      expect(view.stdout.frame).toContain('run-dog-1'); expect(view.stdout.frame).not.toContain('run-none');
      await view.press('/'); await view.press('\u007f'.repeat(10)); await view.press('zzz'); await view.press(KEY.enter);
      expect(view.stdout.frame).toContain('No row matches the filter.');
      await view.press(KEY.esc);
      expect(view.stdout.frame).not.toContain('filter: '); expect(view.stdout.frame).toContain('run-none');
    } finally { view.instance.unmount(); }
  });
  it('sorts with s (age, state, name) and S (reverse), marks the column, and groups with g', async () => {
    const view = mount({ load: async () => fullSnapshot });
    try {
      await until(() => view.stdout.frame.includes('Stuck or waiting'), 'summary');
      await view.press(KEY.tab); await view.press('s');
      expect(view.stdout.frame).toContain('Duration ▼'); expect(view.stdout.frame).toContain('sorted by age (newest first)');
      await view.press('s');
      expect(view.stdout.frame).toContain('State ▼'); expect(view.stdout.frame).toMatch(/› run-[a-z-]+\s+! blocked/);
      await view.press('s');
      expect(view.stdout.frame).toContain('Run ▼'); expect(view.stdout.frame).toMatch(/› run-blocked-approval/);
      await view.press('S');
      expect(view.stdout.frame).toContain('Run ▲'); expect(view.stdout.frame).toMatch(/› run-worker-stale-heartbeat/);
      await view.press('s');
      expect(view.stdout.frame).not.toMatch(/[▲▼]/);
      await view.press('g');
      expect(view.stdout.frame).toContain('grouped by install'); expect(view.stdout.frame).toMatch(/\n {1}current\n/); expect(view.stdout.frame).toMatch(/\n {1}dogfood\n/);
      await view.press('g');
      expect(view.stdout.frame).toContain('grouped by state'); expect(view.stdout.frame).toMatch(/\n {1}✗ failed\n/);
      await view.press('g');
      expect(view.stdout.frame).not.toContain('grouped by');
    } finally { view.instance.unmount(); }
  });
  it('marks new (+) and changed (*) rows for exactly one refresh, never on the first snapshot', async () => {
    const changed = { ...fullSnapshot, installs: fullSnapshot.installs.map(install => install.id !== 'current' ? install : { ...install, runs: [
      ...install.runs.map(run => run.runId !== 'run-none' ? run : { ...run, state: 'blocked' as const, blocker: { code: 'unknown' as const, taskId: 'build', sinceMs: null, detail: null } }),
      { ...install.runs.find(run => run.runId === 'run-stopped')!, runId: 'run-new', createdAtMs: OBSERVED_AT - 20 * 3_600_000 }] }) };
    let calls = 0;
    const view = mount({ intervalMs: 60, load: async () => (++calls === 1 ? fullSnapshot : changed) });
    try {
      await until(() => view.stdout.frame.includes('Stuck or waiting'), 'summary');
      await view.press(KEY.tab);
      expect(view.stdout.frame).not.toMatch(/^[+*] run-/m);
      await until(() => calls >= 2 && /^\+ run-new/m.test(view.stdout.frame), 'new row mark');
      expect(view.stdout.frame).toMatch(/^\* run-none/m);
      await until(() => calls >= 3 && !/^[+*] run-/m.test(view.stdout.frame), 'marks gone after one refresh');
    } finally { view.instance.unmount(); }
  });
  it('shows the snapshot age: neutral when fresh, ⚠ after two intervals, ✗ after five; a failed read names the last read time', async () => {
    let clock = OBSERVED_AT, calls = 0;
    const view = mount({ intervalMs: 40, now: () => clock, load: async () => { if (++calls > 1) throw Object.assign(new Error('x'), { code: 'INVENTORY_UNAVAILABLE' }); return fullSnapshot; } });
    try {
      await until(() => view.stdout.frame.includes('Stuck or waiting'), 'summary');
      expect(view.stdout.frame).not.toMatch(/snapshot \S+ s old/);
      clock += 100; await until(() => view.stdout.frame.includes('⚠ snapshot 0 s old'), 'yellow age');
      await until(() => view.stdout.frame.includes('refresh failed,'), 'failed read');
      expect(view.stdout.frame).toContain('Stale snapshot (last read 09:30:00Z)');
      clock += 200; await until(() => view.stdout.frame.includes('✗ snapshot 0 s old'), 'red age');
    } finally { view.instance.unmount(); }
  });
});

describe('untrusted text never reaches the terminal with control sequences (Fable REVISE #1)', () => {
  const NASTY = 'A\u001b]52;c;aGVsbG8=\u0007B\u001b]8;;http://evil\u001b\\link\u001b]8;;\u001b\\C\u0007D\u001bcE\u009b31mF\u007fG\u0085H\u0000I';
  const CLEAN = 'ABlinkCDE31mFGHI';
  // Matching control characters is the point of this check.
  // eslint-disable-next-line no-control-regex
  const BAD = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u;
  // Every untrusted field at once: first failure, events, activity, approval summary, diagnostics detail, another install's path, workspace.
  const hostile: typeof fullSnapshot = { ...fullSnapshot, installs: fullSnapshot.installs.map(install => install.id === 'dogfood'
    ? { ...install, path: `/srv/${NASTY}`, diagnostics: [...install.diagnostics, `scope-unavailable:${NASTY}:CODE`] }
    : install.id !== 'current' ? install : { ...install,
      runs: install.runs.map(run => run.runId !== 'run-broken' ? run : { ...run, tasks: run.tasks.map(task => !task.lastAttempt ? task : { ...task,
        lastAttempt: { ...task.lastAttempt, firstFailure: `✗ ${NASTY}`, recentEvents: [{ atMs: OBSERVED_AT - 1000, kind: 'message', summary: NASTY }] } }) }),
      workers: install.workers.map((worker, index) => index !== 0 || !worker.files ? worker : { ...worker, workspace: `/w/${NASTY}`,
        files: { ...worker.files, activity: { ...worker.files.activity!, target: NASTY, detail: NASTY } } }),
      approvals: install.approvals.map((approval, index) => index ? approval : { ...approval, summary: NASTY }) }) };
  it('text snapshot (--once and /monitor) carries the visible text without any control', async () => {
    for (const locale of ['en', 'tr'] as const) {
      const text = surface.renderMonitorText(hostile, { locale, width: 240, ascii: false });
      expect(text).not.toMatch(BAD); expect(text).not.toContain('\u001b'); expect(text).not.toContain('\u0007');
      expect(text).toContain(`✗ build: ✗ ${CLEAN}`); expect(text).toContain(`operation: ${CLEAN}`); expect(text).toContain(`/srv/${CLEAN}`);
    }
    const { monitorSlash } = await import('#surfaces/core/monitor/index.js');
    const lines = await monitorSlash('/root', '', { async inspectMonitor() { return hostile; } } as never, { env: {} }, 'en', 200);
    for (const line of lines) expect(line).not.toMatch(BAD);
    expect(lines.join('\n')).toContain(CLEAN);
  });
  it('fullscreen frames (Run detail with first failure and events, worker detail with activity) carry no control', async () => {
    const view = mount({ load: async () => hostile });
    try {
      await until(() => view.stdout.frame.includes('Stuck or waiting'), 'summary');
      expect(view.stdout.frame).not.toMatch(BAD);
      await view.press('2'); await view.press(KEY.enter);
      expect(view.stdout.frame).toContain(`first failure: ✗ ${CLEAN}`); expect(view.stdout.frame).not.toMatch(BAD);
      await view.press(KEY.esc); await view.press('3'); await view.press(KEY.enter);
      expect(view.stdout.frame).toContain(`Doing now: editing · ${CLEAN} — ${CLEAN}`); expect(view.stdout.frame).not.toMatch(BAD);
      await view.press(KEY.esc); await view.press('6');
      expect(view.stdout.frame).not.toMatch(BAD);
    } finally { view.instance.unmount(); }
  });
  it('the task transcript view leaves through the same sanitizer', async () => {
    const { renderWorkerTranscript } = await import('#surfaces/core/monitor/index.js');
    const summary = fullSnapshot.installs[0]!.workers[0]!.files!.usage!;
    const text = renderWorkerTranscript({ schemaVersion: 1, identity: { scopeId: 's', runId: 'r', taskId: 't', attemptId: 'a', layoutRevision: 'l', generation: 1 },
      sealed: { eventCount: 2, sealedAt: 1 }, summary, events: [
        { kind: 'message', atMs: 1000, role: 'assistant', thinking: false, excerpt: NASTY, textBytes: 9 },
        { kind: 'tool.call', atMs: 2000, toolClass: 'edit', target: NASTY, detail: NASTY, toolId: 'x', name: 'Edit' }] as never }, 'en');
    expect(text).not.toMatch(BAD); expect(text).toContain(CLEAN);
  });
});

describe('terminal /monitor', () => {
  it('prints the text snapshot as notice lines in the interactive terminal and is listed in the slash palette', async () => {
    expect(WORKLINE_SLASH_COMMANDS.some(command => command.name === 'monitor' && command.descriptionKey === 'terminal.slash.monitor')).toBe(true);
    const asked: string[] = [];
    const view = mountWorkline({ monitor: async (args: string) => { asked.push(args); return surface.renderMonitorText(fullSnapshot, { locale: 'en', width: 100, ascii: false }).split('\n'); } });
    try {
      await settle(20); view.stdin.write('/monitor --scope scope-a\r');
      await untilWorkline(() => view.stdout.text.includes('Stuck or waiting, oldest first (12)'), 'monitor notice lines');
      expect(asked).toEqual(['--scope scope-a']);
      expect(view.stdout.text).toContain('run-blocked-approval');
    } finally { view.instance.unmount(); }
    const bare = mountWorkline({});
    try {
      await settle(20); bare.stdin.write('/monitor\r');
      await untilWorkline(() => bare.stdout.text.includes('monitor: not available in this terminal'), 'unwired notice');
    } finally { bare.instance.unmount(); }
  });
  it('/monitor through the CLI wiring renders the same text and refuses chat-only flags', async () => {
    const { monitorSlash } = await import('#surfaces/core/monitor/index.js');
    const lines = await monitorSlash('/root', '--install dogfood', { async inspectMonitor() { return fullSnapshot; } } as never, { env: {} }, 'tr', 90);
    expect(lines.join('\n')).toBe(surface.renderMonitorText(fullSnapshot, { locale: 'tr', width: 90, ascii: false, filters: { install: 'dogfood' } }));
    expect(await monitorSlash('/root', '--json', { async inspectMonitor() { return fullSnapshot; } } as never, { env: {} }, 'en', 90)).toEqual([t('monitor.slash.usage', {}, 'en')]);
    await expect(monitorSlash('/root', '', {} as never, { env: {} }, 'en', 90)).rejects.toMatchObject({ code: 'MONITOR_UNAVAILABLE' });
  });
});

it('fullscreen Config tab reads the shared inspect, exposes source/binding/apply and opens details', async () => {
  let reads = 0;
  const config = { schemaVersion: 1 as const, layer: 'project' as const, digest: null, fields: [{ key: 'max_workers', value: 2,
    defaultValue: 'auto', source: 'global' as const, descriptionKey: 'config.field.max_workers', description: 'Worker ceiling', schema: { type: 'integer', minimum: 1 },
    binding: { state: 'bound' as const, consumers: ['src/composition/core/runs'] }, apply: 'restart' as const, redacted: false }] };
  const view = mount({ load: async () => fullSnapshot, loadConfigView: async () => { reads++; return config; }, columns: 80 });
  try {
    await until(() => reads > 0 && view.stdout.frame.includes('Stuck or waiting'), 'config inspected');
    await view.press('8'); expect(view.stdout.frame).toContain('[8 Config]'); expect(view.stdout.frame).toContain('max_workers');
    expect(view.stdout.frame).toContain('global'); expect(view.stdout.frame).toContain('bound'); expect(view.stdout.frame).toContain('restart');
    await view.press(KEY.enter); expect(view.stdout.frame).toContain('Key: max_workers'); expect(view.stdout.frame).toContain('Installation ceiling');
    expect(widest(view.stdout.frame)).toBeLessThanOrEqual(80);
  } finally { view.instance.unmount(); }
});
