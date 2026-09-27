import { describe, expect, it } from 'vitest';
import { PERMISSION_MODES } from '#domain/index.js';
import { fitStatusRow, runModeCommand, worklineStatusSegments, WORKLINE_SLASH_COMMANDS } from '#surfaces/core/terminal/index.js';

// T-L4 slice 4c: the status row carries the person's permission mode as a droppable segment whose text only ever comes from the
// mode catalog; `/mode` shows it and `/mode <mode>` sets it through the service port (the surface reads and writes no file).
const labels = { queued: '{count} queued', elapsed: '{seconds}s' };
const base = { scope: 'company-acme/site-istanbul/project-erp', model: 'local-qwen · vllm', state: 'Ready', busy: false, labels };
const text = (input: Parameters<typeof worklineStatusSegments>[0], columns: number) =>
  fitStatusRow(worklineStatusSegments(input), columns, ' · ', '…').segments.map(segment => segment.text).join(' · ');

describe('permission mode in the status row (T-L4 slice 4c)', () => {
  it('shows exactly the catalog text of the mode after the state', () => {
    for (const mode of PERMISSION_MODES) {
      const segment = worklineStatusSegments({ ...base, mode }).find(item => item.id === 'mode');
      expect(segment).toMatchObject({ text: mode, droppable: true });
      expect(PERMISSION_MODES as readonly string[]).toContain(segment!.text);
    }
    expect(text({ ...base, mode: 'auto-edit' }, 160)).toBe('company-acme/site-istanbul/project-erp · local-qwen · vllm · Ready · auto-edit');
  });

  it('shows no mode segment for a value outside the catalog or when the mode is unknown', () => {
    for (const mode of ['yolo', 'Auto-Edit', 'auto-edit\u001b[31m', '', undefined]) {
      expect(worklineStatusSegments({ ...base, mode: mode as never }).some(item => item.id === 'mode')).toBe(false);
    }
  });

  it('drops the mode on a narrow terminal after the notice and elapsed time, before the model; scope and state stay', () => {
    const busy = { ...base, busy: true, spinner: '⠋', state: 'Working…', elapsedMs: 3_000, mode: 'full-auto' as const, notice: 'service notice' };
    const layout = (columns: number) => fitStatusRow(worklineStatusSegments(busy), columns, ' · ', '…');
    expect(layout(160).dropped).toEqual([]);
    expect(layout(50).dropped).toEqual(['notice', 'elapsed', 'mode']);
    expect(layout(40).dropped).toEqual(['notice', 'elapsed', 'mode', 'model']);
    expect(text(busy, 40)).toContain('⠋ Working…');
    expect(text(busy, 40)).not.toContain('full-auto');
  });
});

describe('/mode (T-L4 slice 4c)', () => {
  const view = { schemaVersion: 1 as const, scopeId: 'scope', supported: true, mode: 'ask' as const, revision: 'p1+b1', eligible: true };
  it('is offered in the slash palette with an argument', () => {
    expect(WORKLINE_SLASH_COMMANDS.find(command => command.name === 'mode')).toMatchObject({ descriptionKey: 'terminal.slash.mode', argumentKey: 'terminal.slash.modeArgument' });
  });

  it('shows the current mode, sets a catalog mode with the revision it last read, and refuses anything else without a call', async () => {
    const calls: unknown[] = [];
    const port = {
      async inspect() { calls.push('inspect'); return view; },
      async set(mode: 'ask' | 'auto-edit' | 'full-auto', expectedRevision: string) { calls.push(['set', mode, expectedRevision]); return { ...view, mode, revision: 'p1+m-2', previous: 'ask' as const, changed: true }; },
    };
    const shown = await runModeCommand('', port, null);
    expect(shown.view).toEqual(view);
    expect(shown.entries.map(entry => entry.kind === 'notice' ? entry.text : '')).toEqual(['/mode · ask']);
    const set = await runModeCommand('auto-edit', port, view);
    expect(set.view).toMatchObject({ mode: 'auto-edit', revision: 'p1+m-2' });
    expect(set.entries.map(entry => entry.kind === 'notice' ? entry.text : '')).toEqual(['/mode · ask → auto-edit']);
    const refused = await runModeCommand('yolo', port, view);
    expect(refused.entries.map(entry => entry.kind === 'notice' ? [entry.level, entry.text] : [])).toEqual([['error', '/mode ask|auto-edit|full-auto']]);
    expect(calls).toEqual(['inspect', ['set', 'auto-edit', 'p1+b1']]);
  });

  it('reads the revision first when none is known and says when the mode changes nothing here', async () => {
    const calls: unknown[] = [];
    const port = {
      async inspect() { calls.push('inspect'); return { ...view, eligible: false }; },
      async set(mode: 'ask' | 'auto-edit' | 'full-auto', expectedRevision: string) { calls.push(['set', mode, expectedRevision]); return { ...view, eligible: false, mode, previous: 'ask' as const, changed: true }; },
    };
    const set = await runModeCommand('full-auto', port, null);
    expect(calls).toEqual(['inspect', ['set', 'full-auto', 'p1+b1']]);
    expect(set.entries.map(entry => entry.kind === 'notice' ? entry.text : '')).toEqual(['/mode · ask → full-auto · modeEligible: 0']);
  });
});
