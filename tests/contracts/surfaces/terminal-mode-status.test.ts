import { describe, expect, it } from 'vitest';
import { PERMISSION_MODES } from '#domain/index.js';
import { cyclePermissionMode, fitStatusRow, nextPermissionModeStop, permissionModeCycle, permissionModeStop, runModeCommand, worklineStatusSegments, WORKLINE_SLASH_COMMANDS } from '#surfaces/core/terminal/index.js';

// T-L4 slice 4c, MODES-3: the status row carries the session's permission mode as a segment whose text only ever comes from the mode
// catalog (droppable, except full access: a standing warning); `/mode` shows it and sets it through the service port (the surface reads and
// writes no file). T2 (owner 2026-10-07, corrected): full access is switched into inside a session through the same service set (the
// service decides the company grant and audits the change); the 2026-09-29 "full access only at launch" rule is withdrawn.
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
    expect(worklineStatusSegments({ ...base, mode: 'full-access' }).find(item => item.id === 'mode')).toMatchObject({ role: 'warning', bold: true, droppable: false });
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
        .toEqual([['error', '/mode [standart|full-auto|full-access] · /mode ask-edits on|off · /mode start full-access']]);
    }
    expect(calls).toEqual(['inspect', ['set', 'full-auto', 'p1+b1', undefined]]);
  });

  it('switches into full access for this session only through the service (owner 2026-10-07, FA-SESSION); the service\'s refusal stays a refusal', async () => {
    const calls: unknown[] = [];
    // The service stores nothing for a session switch: the answer keeps the stored mode and revision (changed: false).
    const port = { async inspect() { return view; },
      async set(mode: Mode, expectedRevision: string, askEdits?: boolean, session?: { sessionId: string | null }) { calls.push([mode, expectedRevision, askEdits, session]);
        return { ...view, previous: 'standart' as const, changed: false }; } };
    const entered = await runModeCommand('full-access', port, view, undefined, false, { sessionId: 'conversation-1' });
    expect({ fullAccess: entered.fullAccess, texts: texts(entered.entries), level: (entered.entries[0] as { level: string }).level, stored: entered.view?.mode })
      .toEqual({ fullAccess: true, texts: ['/mode · standart → full-access'], level: 'warning', stored: 'standart' });
    expect(calls).toEqual([['full-access', 'p1+b1', undefined, { sessionId: 'conversation-1' }]]);
    const refusing = { async inspect() { return { ...view, fullAccess: false }; }, async set(): Promise<never> { throw new Error('PERMISSION_MODE_DENIED'); } };
    await expect(runModeCommand('full-access', refusing, { ...view, fullAccess: false })).rejects.toThrow('PERMISSION_MODE_DENIED');
  });

  it('leaves full access with /mode standart|full-auto, and full access can come back on the grant', async () => {
    const port = { async inspect() { return view; },
      async set(mode: Mode) { return { ...view, mode, revision: 'p1+m-3', previous: 'standart' as const, changed: mode !== 'standart' }; } };
    const shown = await runModeCommand('', port, view, undefined, true);
    expect(texts(shown.entries)).toEqual(['/mode · full-access']);
    const tightened = await runModeCommand('standart', port, view, undefined, true);
    expect(tightened.fullAccess).toBe(false);
    expect(texts(tightened.entries)).toEqual(['/mode · full-access → standart']);
    expect((await runModeCommand('full-access', port, tightened.view, undefined, tightened.fullAccess)).fullAccess).toBe(true);
  });

  it('sets the "ask for edits too" preference and saves full access as the next launch\'s start mode, keeping this session\'s mode', async () => {
    const calls: unknown[] = [];
    const port = { async inspect() { return view; },
      async set(mode: Mode, expectedRevision: string, askEdits?: boolean, session?: unknown) { calls.push([mode, expectedRevision, askEdits, session]);
        return { ...view, mode, askEdits: askEdits ?? view.askEdits, revision: 'p1+m-4', previous: 'standart' as const, changed: true }; } };
    const labels = { current: 'Mode: {mode}', changed: '{previous} → {mode}', inert: '', unsupported: 'v1', usage: 'usage', askEditsOn: 'edits ask', askEditsOff: 'edits run',
      startSaved: 'saved for next launch' };
    const on = await runModeCommand('ask-edits on', port, view, labels);
    expect(texts(on.entries)).toEqual(['edits ask']);
    expect(texts((await runModeCommand('ask-edits off', port, view, labels)).entries)).toEqual(['edits run']);
    const start = await runModeCommand('start full-access', port, view, labels);
    expect({ text: texts(start.entries), fullAccess: start.fullAccess }).toEqual({ text: ['saved for next launch'], fullAccess: false });
    // `/mode start full-access` is the explicit stored start mode (MODES-3): never a session switch.
    expect(calls).toEqual([['standart', 'p1+b1', true, undefined], ['standart', 'p1+b1', false, undefined], ['full-access', 'p1+b1', undefined, undefined]]);
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

  it('shows what each mode changes and which can be tried, from the view alone; full access only with the grant', async () => {
    const port = { async inspect() { return view; }, async set(): Promise<never> { throw new Error('unused'); } };
    const labels = { current: 'Mode: {mode}', changed: '{previous} → {mode}', inert: ' (inert)', unsupported: 'v1', usage: 'usage',
      effect: { standart: 'standard-effect', 'full-auto': 'full-effect', 'full-access': 'access-effect' }, switch: 'Try: {options}', fullAccessGrant: 'grant needed' };
    const shown = await runModeCommand('', port, null, labels);
    expect(texts(shown.entries)).toEqual(['Mode: standart — standard-effect', 'Try: /mode full-auto (full-effect); /mode full-access (access-effect)']);
    const inAccess = await runModeCommand('', port, null, labels, true);
    expect(texts(inAccess.entries)).toEqual(['Mode: full-access — access-effect', 'Try: /mode standart (standard-effect); /mode full-auto (full-effect)']);
    const noGrant = { async inspect() { return { ...view, fullAccess: false, fullAuto: false }; }, async set(): Promise<never> { throw new Error('unused'); } };
    expect(texts((await runModeCommand('', noGrant, null, labels)).entries)).toEqual(['Mode: standart — standard-effect', 'grant needed']);
  });
});

// T2 T-MODE-CYCLE (owner 2026-10-07, corrected): Shift+Tab walks every mode the person may take — standart → careful (ask-edits) → full-auto →
// full-access → standart — full access only on the company grant, full-auto unless the company's set grant leaves it out.
describe('Shift+Tab permission-mode cycle (T2 T-MODE-CYCLE)', () => {
  const view = { schemaVersion: 1 as const, scopeId: 'scope', supported: true, mode: 'standart' as const, askEdits: false, revision: 'r0', eligible: true, fullAccess: true, fullAuto: true };
  type Mode = 'standart' | 'full-auto' | 'full-access';
  it('has four stops with the full-access grant, three without it, and no full-auto when the company leaves it out', () => {
    expect(permissionModeCycle(view)).toEqual(['standart', 'ask-edits', 'full-auto', 'full-access']);
    expect(permissionModeCycle({ ...view, fullAccess: false })).toEqual(['standart', 'ask-edits', 'full-auto']);
    expect(permissionModeCycle({ ...view, fullAccess: false, fullAuto: false })).toEqual(['standart', 'ask-edits']);
    expect(permissionModeCycle({ ...view, fullAuto: false })).toEqual(['standart', 'ask-edits', 'full-access']);
    const older: Omit<typeof view, 'fullAuto'> & { fullAuto?: boolean } = { ...view };
    delete older.fullAuto;
    expect(permissionModeCycle(older)).toEqual(['standart', 'ask-edits', 'full-auto', 'full-access']);
    expect(permissionModeCycle({ ...view, supported: false })).toEqual([]);
    expect(permissionModeStop({ ...view, askEdits: true }, false)).toBe('ask-edits');
    expect(permissionModeStop({ ...view, mode: 'full-access' }, false)).toBe('standart');
    expect(permissionModeStop(view, true)).toBe('full-access');
    expect(nextPermissionModeStop(['standart', 'ask-edits', 'full-auto'], 'full-access')).toBe('standart');
  });

  it('walks the whole cycle through the service with each stop\'s explicit askEdits and the revision it last read', async () => {
    const calls: unknown[] = [];
    let current: typeof view = view, revision = 0;
    const port = { async inspect() { return current; },
      async set(mode: Mode, expectedRevision: string, askEdits?: boolean, session?: { sessionId: string | null }) {
        calls.push([mode, expectedRevision, askEdits, session]);
        const previous = current.mode;
        // FA-SESSION: a session switch stores nothing (same mode, same revision).
        if (session) return { ...current, previous, changed: false };
        current = { ...current, mode, askEdits: askEdits ?? current.askEdits, revision: `r${++revision}` };
        return { ...current, previous, changed: true };
      } };
    const labels = { current: '', changed: '{previous} → {mode}', inert: '', unsupported: 'v1', usage: '', cycled: 'Mode: {previous} → {mode}', cycledFullAccess: 'Mode: {previous} → {mode} — audited',
      stops: { standart: 'standard', 'ask-edits': 'careful', 'full-auto': 'full auto', 'full-access': 'full access' } };
    let known: typeof view | null = null, fullAccess = false;
    const seen: string[] = [], stored: string[] = [];
    for (let step = 0; step < 4; step++) {
      const result = await cyclePermissionMode(port, known, labels, fullAccess);
      known = result.view as typeof view; fullAccess = result.fullAccess; stored.push(current.mode);
      seen.push(...result.entries.map(entry => entry.kind === 'notice' ? `${entry.level}:${entry.text}` : ''));
    }
    expect(seen).toEqual(['info:Mode: standard → careful', 'info:Mode: careful → full auto', 'warning:Mode: full auto → full access — audited', 'info:Mode: full access → standard']);
    expect(calls).toEqual([['standart', 'r0', true, undefined], ['full-auto', 'r1', false, undefined], ['full-access', 'r2', undefined, { sessionId: null }],
      ['standart', 'r2', false, undefined]]);
    expect(fullAccess).toBe(false);
    // While the session held full access the stored mode stayed full-auto: a relaunch at that point opens in full auto, never full access.
    expect(stored).toEqual(['standart', 'full-auto', 'full-auto', 'standart']);
  });

  it('skips full access without the grant; a refusal of the service propagates and leaves the session as it was', async () => {
    const port = { async inspect() { return { ...view, mode: 'full-auto' as const, fullAccess: false }; },
      async set(mode: Mode) { return { ...view, mode, fullAccess: false, previous: 'full-auto' as const, changed: true }; } };
    const result = await cyclePermissionMode(port, null);
    expect(result).toMatchObject({ fullAccess: false, view: { mode: 'standart' } });
    const refusing = { async inspect() { return { ...view, mode: 'full-auto' as const }; }, async set(): Promise<never> { throw new Error('PERMISSION_MODE_DENIED'); } };
    await expect(cyclePermissionMode(refusing, null)).rejects.toThrow('PERMISSION_MODE_DENIED');
    const v1 = { async inspect() { return { ...view, supported: false }; }, async set(): Promise<never> { throw new Error('unused'); } };
    expect((await cyclePermissionMode(v1, null)).entries).toEqual([expect.objectContaining({ level: 'error' })]);
  });

  it('shows the stop as mark and word in the status row; full access stays a non-droppable warning', () => {
    const words = { standart: 'standart', 'ask-edits': 'dikkatli', 'full-auto': 'tam otomatik', 'full-access': 'tam erişim' };
    const row = (mode: Mode, stop: 'standart' | 'ask-edits' | 'full-auto' | 'full-access', mark: string) =>
      worklineStatusSegments({ ...base, labels: { ...labels, modeStops: words }, mode, stop, modeMark: mark }).find(item => item.id === 'mode');
    expect(row('standart', 'standart', '⏸')).toMatchObject({ text: '⏸ standart', role: 'muted' });
    expect(row('standart', 'ask-edits', '⏸')).toMatchObject({ text: '⏸ dikkatli', role: 'muted' });
    expect(row('full-auto', 'full-auto', '⏵⏵')).toMatchObject({ text: '⏵⏵ tam otomatik', role: 'modeIndicator' });
    expect(row('full-access', 'full-access', '!!')).toMatchObject({ text: '!! tam erişim', role: 'warning', bold: true, droppable: false });
  });
});
