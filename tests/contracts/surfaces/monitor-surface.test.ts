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
    expect(text).toContain('run-broken'); expect(text).toContain('build: failed, evaluation rejected');
    expect(text).toContain('! remote-lab is unavailable: MONITOR_SOURCE_UNREADABLE, LEDGER_LOCKED');
    expect(text).toContain('! dogfood: could not read WORKER_SIDECAR_UNREADABLE');
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
    expect(scoped.installs.flatMap(install => install.approvals)).toEqual([]);
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
function mount(props: { load: () => Promise<typeof fullSnapshot>; intervalMs?: number; columns?: number; rows?: number; locale?: 'en' | 'tr' }) {
  const stdout = new Screen(props.columns ?? 120, props.rows ?? 40);
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() { return stdin; }, ref() { return stdin; }, unref() { return stdin; } });
  const instance = render(createElement(surface.MonitorApp, { load: props.load, intervalMs: props.intervalMs ?? 60_000, locale: props.locale ?? 'en', ascii: false,
    palette: resolveWorklinePalette('none'), errorText: (error: unknown) => surface.monitorFailureText(error, props.locale ?? 'en') }),
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
      // The first Runs row is the oldest stuck Run and carries the selection marker (NO_COLOR palette: the marker, not inverse, shows it).
      expect(view.stdout.frame).toMatch(/› run-blocked-approval/);
      await view.press(KEY.down);
      expect(view.stdout.frame).toMatch(/› run-not-admitted/);
      await view.press(KEY.up); await view.press(KEY.enter);
      expect(view.stdout.frame).toContain('Run run-blocked-approval · scope scope-a · revision 7');
      expect(view.stdout.frame).toContain('Blocker: awaiting approval (appr-0001) · task build · for 3 h 12 min');
      expect(view.stdout.frame).toContain('depends on: build');
      await view.press(KEY.esc);
      expect(view.stdout.frame).toMatch(/› run-blocked-approval/);
      await view.press('3');
      expect(view.stdout.frame).toContain('[3 Workers]');
      await view.press(KEY.enter);
      expect(view.stdout.frame).toContain('Doing now: editing · src/app.ts — apply patch');
      expect(view.stdout.frame).toContain('requested model-alpha-2');
      await view.press(KEY.esc); await view.press(KEY.left);
      expect(view.stdout.frame).toContain('[2 Runs]');
      await view.press('?');
      expect(view.stdout.frame).toContain('pause or resume automatic refresh');
      await view.press(KEY.esc);
      expect(view.stdout.frame).not.toContain('pause or resume automatic refresh');
      await view.press('6');
      expect(view.stdout.frame).toContain('remote-lab');
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
      await until(() => view.stdout.frame.includes('Refresh failed'), 'failure warning');
      expect(view.stdout.frame).toContain(t('error.INVENTORY_UNAVAILABLE', {}, 'en'));
      expect(view.stdout.frame).not.toContain('/secret/x');
      expect(view.stdout.frame).toContain('Stuck or waiting');
      fail = false; await view.press('p');
      await until(() => !view.stdout.frame.includes('Refresh failed'), 'recovered');
    } finally { view.instance.unmount(); }
  });
  it('never overflows a narrow terminal and keeps a stable height', async () => {
    for (const columns of [60, 79]) {
      const view = mount({ load: async () => longIdSnapshot, columns, rows: 20 });
      try {
        await until(() => view.stdout.frame.includes('Stuck'), 'summary');
        for (const key of ['', KEY.tab, KEY.tab, KEY.tab, KEY.tab, KEY.tab]) {
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
