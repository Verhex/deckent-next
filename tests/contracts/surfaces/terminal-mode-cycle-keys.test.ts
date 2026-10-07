import { afterEach, describe, expect, it } from 'vitest';
import { mountWorkline, settle, until } from '../support/workline-harness.js';

// T2 T-MODE-CYCLE on the real interactive workline (in-memory TTY): Shift+Tab and Alt+M step the mode through the port only while the composer
// owns the keyboard and no turn runs; a running turn keeps its mode (as a queued `/mode` does), so the status row never disagrees with it.
const mounted: Array<{ unmount(): void }> = [];
afterEach(() => { for (const view of mounted.splice(0)) view.unmount(); });

const view = { schemaVersion: 1 as const, scopeId: 'scope', supported: true, mode: 'standart' as const, askEdits: false, revision: 'r0', eligible: true, fullAccess: true, fullAuto: true };
type Mode = 'standart' | 'full-auto' | 'full-access';
function port() {
  const calls: unknown[] = [];
  let current: typeof view = view;
  return { calls, port: { async inspect() { return current; },
    async set(mode: Mode, expectedRevision: string, askEdits?: boolean) {
      calls.push([mode, expectedRevision, askEdits]);
      const previous = current.mode;
      current = { ...current, mode, askEdits: askEdits ?? current.askEdits, revision: `r${calls.length}` };
      return { ...current, previous, changed: true };
    } } };
}

describe('Shift+Tab / Alt+M ownership (T2 T-MODE-CYCLE)', () => {
  it('steps the mode when idle; Alt+M does the same', async () => {
    const { calls, port: permissionMode } = port();
    const mountedView = mountWorkline({ permissionMode });
    mounted.push(mountedView.instance);
    await settle(40);
    mountedView.stdin.write('\u001b[Z');
    await until(() => calls.length === 1, 'first step');
    mountedView.stdin.write('\u001bm');
    await until(() => calls.length === 2, 'Alt+M step');
    expect(calls).toEqual([['standart', 'r0', true], ['full-auto', 'r1', false]]);
  });

  it('does nothing while a turn runs; the mode changes only after the turn', async () => {
    const { calls, port: permissionMode } = port();
    let release!: (value: string) => void;
    const mountedView = mountWorkline({ permissionMode, completeTurn: () => new Promise<string>(resolve => { release = resolve; }) });
    mounted.push(mountedView.instance);
    await settle(40);
    mountedView.stdin.write('hello\r');
    await until(() => mountedView.stdout.text.includes('BUSY'), 'turn running');
    mountedView.stdin.write('\u001b[Z');
    await settle(60);
    expect(calls).toEqual([]);
    release('done');
    await until(() => mountedView.stdout.text.includes('READY'), 'turn finished');
    await settle(30);
    mountedView.stdin.write('\u001b[Z');
    await until(() => calls.length === 1, 'step after the turn');
  });
});
