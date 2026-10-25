import { main } from '#surfaces/core/cli/index.js';
import { expect, it, vi } from 'vitest';
import { configSlash } from '#surfaces/core/config/index.js';
import { mountWorkline, settle, until } from '../support/workline-harness.js';
import { loadMonitorSurface, monitorCommand } from '#surfaces/core/monitor/index.js';
const { configMonitorBlocks } = await loadMonitorSurface();
const field = { key: 'max_workers', value: 2, defaultValue: 'auto', descriptionKey: 'config.field.max_workers', description: 'Workers', schema: {}, source: 'global', binding: { state: 'bound', consumers: ['src/composition/core/runs'] }, apply: 'restart', redacted: false } as const;
const view = { schemaVersion: 1 as const, digest: null, layer: 'project' as const, fields: [field] };
it('config tab rows and detail use one inspect truth, in Turkish too', () => {
  const blocks = configMonitorBlocks(view, 'tr'); const table = blocks.find(block => block.kind === 'table');
  expect(table?.kind).toBe('table'); if (table?.kind !== 'table') return;
  expect(table.rows[0]?.cells.map(cell => cell.text).join(' ')).toBe('İşçi tavanı (max_workers) 2 genel (kullanıcı) yeniden başlatınca');
  expect(table.rows[0]?.detail().flatMap(line => line.map(cell => cell.text)).join('\n')).toContain('max_workers');
});
it('monitor --config uses shared application without creating monitor runtime or reading workers', async () => {
  const output: string[] = [], inspect = vi.fn(async () => view), inspectMonitor = vi.fn();
  await monitorCommand(['monitor', '--config', '--once', '--json'], { root: '/tmp/config-view', env: {}, stdout: { write: (s: string) => { output.push(s); } },
    configApplication: () => ({ inspect }) as never, inspectMonitor });
  expect(inspect).toHaveBeenCalled(); expect(inspectMonitor).not.toHaveBeenCalled(); expect(JSON.parse(output.join(''))).toEqual(view);
});

// C-SETUP §4 (lead, J2e): `deckent config` on a person's terminal opens the writable /config window; `deckent monitor --config` stays observe-only.
it('monitor --config on a person\'s terminal never opens the writable /config window; it prints the read', async () => {
  const output: string[] = [], inspect = vi.fn(async () => view), openConfigPanel = vi.fn(async () => []);
  await monitorCommand(['monitor', '--config'], { root: '/tmp/config-view', env: {}, stdin: { isTTY: true, setRawMode() {} }, stdout: { isTTY: true, columns: 120, write: (s: string) => { output.push(s); } },
    configApplication: () => ({ inspect }) as never, openConfigPanel } as never);
  expect(openConfigPanel).not.toHaveBeenCalled(); expect(inspect).toHaveBeenCalled(); expect(output.join('')).not.toBe('');
});
it('terminal /config renders shared inspect as notices and never becomes a chat request or write', async () => {
  const inspect = vi.fn(async () => view), set = vi.fn(), chat = vi.fn();
  const ctx = { configApplication: () => ({ inspect, set }) as never };
  const terminal = mountWorkline({ completeTurn: chat, config: args => configSlash('/tmp/config-terminal', args, ctx, {}, 'en', 80) });
  try {
    await settle(20); terminal.stdin.write('/config\r');
    await until(() => terminal.stdout.text.includes('max_workers'), 'config notice');
    expect(inspect).toHaveBeenCalledOnce(); expect(chat).not.toHaveBeenCalled();
    terminal.stdin.write('/config set max_workers 4\r');
    await until(() => terminal.stdout.text.includes('read only'), 'config refusal');
    expect(set).not.toHaveBeenCalled(); expect(chat).not.toHaveBeenCalled();
  } finally { terminal.instance.unmount(); }
});

it('monitor --config returns exit zero through the real dispatcher', async () => {
  const output: string[] = [], errors: string[] = [];
  expect(await main(['monitor', '--config'], { root: '/tmp/f1-monitor-config', env: {}, configApplication: () => ({ inspect: async () => view }) as never,
    stdout: { write: (s: string) => { output.push(s); } }, stderr: { write: (s: string) => { errors.push(s); } } })).toBe(0);
  expect(output.join('')).toContain('max_workers'); expect(errors).toEqual([]);
});
