import { describe, expect, it } from 'vitest';
import { PERMISSION_MODES } from '#domain/index.js';
import { fitStatusRow, runModeCommand, worklineStatusSegments, WORKLINE_SLASH_COMMANDS } from '#surfaces/core/terminal/index.js';

// T-L4 slice 4c, MODES-3: the status row carries the session's permission mode as a segment whose text only ever comes from the mode
// catalog (droppable, except full access: a standing warning); `/mode` shows it and sets it through the service port (the surface reads and
// writes no file); full access is never switched into from inside a session.
const labels = { queued: '{count} queued', elapsed: '{seconds}s' };
const base = { scope: 'company-acme/site-istanbul/project-erp', model: 'local-qwen · vllm', state: 'Ready', busy: false, labels };
const text = (input: Parameters<typeof worklineStatusSegments>[0], columns: number) =>
  fitStatusRow(worklineStatusSegments(input), columns, ' · ', '…').segments.map(segment => segment.text).join(' · ');

describe('permission mode in the status row (T-L4 slice 4c, MODES-3)', () => {
  it('shows exactly the catalog text of the mode after the state; full access is a standing, non-droppable warning', () => {
    for (const mode of PERMISSION_MODES) {
      const segment = worklineStatusSegments({ ...base, mode }).find(item => item.id === 'mode');
      expect(segment).toMatchObject({ text: mode, droppable: mode !== 'full-access' });
      expect(PERMISSION_MODES as readonly string[]).toContain(segment!.text);
    }
    expect(text({ ...base, mode: 'full-auto' }, 160)).toBe('company-acme/site-istanbul/project-erp · local-qwen · vllm · Ready · full-auto');
    expect(worklineStatusSegments({ ...base, mode: 'full-access' }).find(item => item.id === 'mode')).toMatchObject({ role: 'error', droppable: false });
  });

  it('shows no mode segment for a value outside the catalog or when the mode is unknown (the v2 names are not catalog values)', () => {
    for (const mode of ['yolo', 'ask', 'auto-edit', 'Full-Access', 'full-access\u001b[31m', '', undefined]) {
      expect(worklineStatusSegments({ ...base, mode: mode as never }).some(item => item.id === 'mode')).toBe(false);
    }
  });

  it('drops the mode on a narrow terminal after the notice and elapsed time, before the model; scope and state stay — never full access', () => {
    const busy = { ...base, busy: true, spinner: '⠋', state: 'Working…', elapsedMs: 3_000, mode: 'full-auto' as const, notice: 'service notice' };
    const layout = (columns: number) => fitStatusRow(worklineStatusSegments(busy), columns, ' · ', '…');
    expect(layout(160).dropped).toEqual([]);
    expect(layout(50).dropped).toEqual(['notice', 'elapsed', 'mode']);
    expect(layout(40).dropped).toEqual(['notice', 'elapsed', 'mode', 'model']);
    expect(text(busy, 40)).toContain('⠋ Working…');
    expect(text(busy, 40)).not.toContain('full-auto');
    const access = { ...busy, mode: 'full-access' as const };
    for (const columns of [160, 50, 40, 30]) expect(text(access, columns)).toContain('full-access');
  });
});

describe('/mode (T-L4 slice 4c, MODES-3)', () => {
  const view = { schemaVersion: 1 as const, scopeId: 'scope', supported: true, mode: 'standart' as const, askEdits: false, revision: 'p1+b1', eligible: true, fullAccess: true };
  type Mode = 'standart' | 'full-auto' | 'full-access';
  const texts = (entries: readonly { kind: string; text?: string; level?: string }[]) => entries.map(entry => entry.kind === 'notice' ? entry.text : '');
  it('is offered in the slash palette with an argument', () => {
    expect(WORKLINE_SLASH_COMMANDS.find(command => command.name === 'mode')).toMatchObject({ descriptionKey: 'terminal.slash.mode', argumentKey: 'terminal.slash.modeArgument' });
  });

  it('shows the current mode, sets a switchable mode with the revision it last read, and refuses anything else without a call', async () => {
    const calls: unknown[] = [];
    const port = {
      async inspect() { calls.push('inspect'); return view; },
      async set(mode: Mode, expectedRevision: string, askEdits?: boolean) { calls.push(['set', mode, expectedRevision, askEdits]); return { ...view, mode, revision: 'p1+m-2', previous: 'standart' as const, changed: true }; },
    };
    const shown = await runModeCommand('', port, null);
    expect(shown.view).toEqual(view);
    expect(texts(shown.entries)).toEqual(['/mode · standart']);
    const set = await runModeCommand('full-auto', port, view);
    expect(set.view).toMatchObject({ mode: 'full-auto', revision: 'p1+m-2' });
    expect(texts(set.entries)).toEqual(['/mode · standart → full-auto']);
    for (const refused of ['yolo', 'ask', 'auto-edit', 'ask-edits', 'start full-auto']) {
      expect((await runModeCommand(refused, port, view)).entries.map(entry => entry.kind === 'notice' ? [entry.level, entry.text] : []))
        .toEqual([['error', '/mode [standart|full-auto] · /mode ask-edits on|off · /mode start full-access']]);
    }
    expect(calls).toEqual(['inspect', ['set', 'full-auto', 'p1+b1', undefined]]);
  });

  it('refuses /mode full-access inside a session without asking the service, and says how to start it (owner: start only)', async () => {
    const calls: unknown[] = [];
    const port = { async inspect() { calls.push('inspect'); return view; }, async set(): Promise<never> { calls.push('set'); throw new Error('set must not be called'); } };
    const labels = { current: 'Mode: {mode}', changed: '{previous} → {mode}', inert: ' (inert)', unsupported: 'v1', usage: 'usage', fullAccessLaunch: 'Relaunch with deckent --full-access' };
    for (const fullAccess of [false, true]) {
      const refused = await runModeCommand('full-access', port, view, labels, fullAccess);
      expect(refused).toEqual({ entries: [expect.objectContaining({ level: 'error', text: 'Relaunch with deckent --full-access' })], view, fullAccess });
    }
    expect(calls).toEqual([]);
  });

  it('tightens a full-access session with /mode standart|full-auto for the rest of the session; full access does not come back', async () => {
    const port = { async inspect() { return view; },
      async set(mode: Mode) { return { ...view, mode, revision: 'p1+m-3', previous: 'standart' as const, changed: mode !== 'standart' }; } };
    const shown = await runModeCommand('', port, view, undefined, true);
    expect(texts(shown.entries)).toEqual(['/mode · full-access']);
    const tightened = await runModeCommand('standart', port, view, undefined, true);
    expect(tightened.fullAccess).toBe(false);
    expect(texts(tightened.entries)).toEqual(['/mode · full-access → standart']);
    expect((await runModeCommand('full-access', port, tightened.view, undefined, tightened.fullAccess)).fullAccess).toBe(false);
  });

  it('sets the "ask for edits too" preference and saves full access as the next launch\'s start mode, keeping this session\'s mode', async () => {
    const calls: unknown[] = [];
    const port = { async inspect() { return view; },
      async set(mode: Mode, expectedRevision: string, askEdits?: boolean) { calls.push([mode, expectedRevision, askEdits]);
        return { ...view, mode, askEdits: askEdits ?? view.askEdits, revision: 'p1+m-4', previous: 'standart' as const, changed: true }; } };
    const labels = { current: 'Mode: {mode}', changed: '{previous} → {mode}', inert: '', unsupported: 'v1', usage: 'usage', askEditsOn: 'edits ask', askEditsOff: 'edits run',
      startSaved: 'saved for next launch' };
    const on = await runModeCommand('ask-edits on', port, view, labels);
    expect(texts(on.entries)).toEqual(['edits ask']);
    expect(texts((await runModeCommand('ask-edits off', port, view, labels)).entries)).toEqual(['edits run']);
    const start = await runModeCommand('start full-access', port, view, labels);
    expect({ text: texts(start.entries), fullAccess: start.fullAccess }).toEqual({ text: ['saved for next launch'], fullAccess: false });
    expect(calls).toEqual([['standart', 'p1+b1', true], ['standart', 'p1+b1', false], ['full-access', 'p1+b1', undefined]]);
  });

  it('reads the revision first when none is known and says when the mode changes nothing here', async () => {
    const calls: unknown[] = [];
    const port = {
      async inspect() { calls.push('inspect'); return { ...view, eligible: false }; },
      async set(mode: Mode, expectedRevision: string) { calls.push(['set', mode, expectedRevision]); return { ...view, eligible: false, mode, previous: 'standart' as const, changed: true }; },
    };
    const set = await runModeCommand('full-auto', port, null);
    expect(calls).toEqual(['inspect', ['set', 'full-auto', 'p1+b1']]);
    expect(texts(set.entries)).toEqual(['/mode · standart → full-auto · modeEligible: 0']);
  });

  it('says a v1 policy has no modes and calls no set (nothing to write), whether the view was known or is read first', async () => {
    const v1 = { ...view, supported: false, revision: 'p1', fullAccess: false };
    const calls: unknown[] = [];
    const port = {
      async inspect() { calls.push('inspect'); return v1; },
      async set(mode: Mode, expectedRevision: string) { calls.push(['set', mode, expectedRevision]); throw new Error('set must not be called'); },
    };
    for (const known of [null, v1]) {
      const result = await runModeCommand('full-auto', port, known);
      expect(result.entries.map(entry => entry.kind === 'notice' ? [entry.level, entry.text] : [])).toEqual([['error', '/mode · standart · policy v1']]);
      expect(result.view).toEqual(v1);
    }
    expect(calls).toEqual(['inspect']);
  });

  it('shows what each mode changes and which can be tried, from the view alone; full access only as a launch', async () => {
    const port = { async inspect() { return view; }, async set(): Promise<never> { throw new Error('unused'); } };
    const labels = { current: 'Mode: {mode}', changed: '{previous} → {mode}', inert: ' (inert)', unsupported: 'v1', usage: 'usage',
      effect: { standart: 'standard-effect', 'full-auto': 'full-effect', 'full-access': 'access-effect' }, switch: 'Try: {options}', fullAccessLaunch: 'launch' };
    const shown = await runModeCommand('', port, null, labels);
    expect(texts(shown.entries)).toEqual(['Mode: standart — standard-effect', 'Try: /mode full-auto (full-effect)', 'launch']);
    const inAccess = await runModeCommand('', port, null, labels, true);
    expect(texts(inAccess.entries)).toEqual(['Mode: full-access — access-effect', 'Try: /mode standart (standard-effect); /mode full-auto (full-effect)']);
  });
});
