import { afterEach, describe, expect, it } from 'vitest';
import { LIVE_OUTPUT_TAIL_CHARS, renderAssistantStream, startAssistantStream, terminalSafeText } from '#surfaces/core/terminal-render/index.js';
import { mountWorkline, settle, until } from '../support/workline-harness.js';

const mounted: Array<{ unmount(): void }> = [];
afterEach(() => { for (const instance of mounted.splice(0)) instance.unmount(); });

describe('live shell output in the terminal (T-L4 slice 3c-ii)', () => {
  it('removes every escape sequence and control character a command could use against the owner\'s terminal', () => {
    expect(terminalSafeText('\u001b[31mred\u001b[0m plain')).toBe('red plain');
    expect(terminalSafeText('a\u001b]0;evil title\u0007b')).toBe('ab');
    expect(terminalSafeText('a\u001b]52;c;Y2xpcGJvYXJk\u001b\\b')).toBe('ab');
    expect(terminalSafeText('x\u001b[2J\u001b[Hy\u001b7\u001b8')).toBe('xy');
    expect(terminalSafeText('one\r\ntwo\rthree')).toBe('one\ntwo\nthree');
    expect(terminalSafeText('nul\u0000 bell\u0007 c1\u009b31m tab\tok\n')).toBe('nul bell c131m tab\tok\n');
  });

  it('keeps a bounded, sanitized tail of the running call\'s output and forgets it when the call finishes', () => {
    let state = startAssistantStream(0);
    state = renderAssistantStream(state, { kind: 'tool', phase: 'started', callId: 'c1', name: 'run_shell', target: 'make', status: null, ms: null }, 1).state;
    state = renderAssistantStream(state, { kind: 'output', callId: 'c1', stream: 'stdout', text: 'building \u001b[32mok\u001b[0m\n' }, 2).state;
    state = renderAssistantStream(state, { kind: 'output', callId: 'other', stream: 'stdout', text: 'not mine\n' }, 3).state;
    expect(state.activeTool).toMatchObject({ callId: 'c1', output: 'building ok\n' });
    state = renderAssistantStream(state, { kind: 'output', callId: 'c1', stream: 'stderr', text: 'x'.repeat(5_000) }, 4).state;
    expect(state.activeTool!.output.length).toBe(LIVE_OUTPUT_TAIL_CHARS);
    const finished = renderAssistantStream(state, { kind: 'tool', phase: 'finished', callId: 'c1', name: 'run_shell', target: 'make', status: 'ok', ms: 5 }, 5);
    expect(finished.state.activeTool).toBeNull();
    expect(finished.staticUnits).toEqual([{ kind: 'tool', name: 'run_shell', target: 'make', status: 'ok', ms: 5 }]);
  });

  // T-L4 slice 3c-iii: SGR survived Ink (probe: a colour code in model text reached the screen), and SGR can conceal text (ESC[8m).
  // With the colourless test palette any escape on screen can only come from content.
  it('never lets model text, a tool target or an approval preview style, hide or move text on the owner\'s screen', async () => {
    let decide!: () => void; const decided = new Promise<void>(resolve => { decide = resolve; });
    const streamTurn = async function* () {
      yield { kind: 'tool' as const, phase: 'started' as const, callId: 'c1', name: 'run_shell', target: 'echo \u001b[8mhidden-target\u001b[0m', status: null, ms: null };
      yield { kind: 'approval' as const, phase: 'requested' as const, callId: 'c1', approvalId: 'appr-x', revision: 0, summary: 'run_shell · \u001b[31msummary',
        preview: '$ cat notes\n\u001b[8mhidden-preview-line\u001b[0m\n\u001b]0;title\u0007shown', expiresAt: Date.now() + 600_000 };
      await decided;
      yield { kind: 'approval' as const, phase: 'settled' as const, callId: 'c1', approvalId: 'appr-x', outcome: 'deny' as const };
      yield { kind: 'tool' as const, phase: 'finished' as const, callId: 'c1', name: 'run_shell', target: 'echo \u001b[8mhidden-target\u001b[0m', status: 'denied' as const, ms: 1 };
      yield { kind: 'text' as const, text: 'answer \u001b[8mconcealed\u001b[0m and \u001b[31mred\u001b[0m done' };
      yield { kind: 'done' as const, finish: 'stop' as const };
    };
    const ledger = { scopeId: 'scope', async listWorkers() { return { schemaVersion: 1, scopeId: 'scope', sources: [] } as never; }, async inspectRun() { return null; },
      async decideApproval(approval: { approvalId: string }, decision: 'allow' | 'deny') { decide();
        return { approvalId: approval.approvalId, runId: '-', taskId: '-', summary: '', requester: '-', revision: 1, status: 'decided' as const, decision, expiresAt: 0 }; } };
    const view = mountWorkline({ streamTurn, ledger: ledger as never }); mounted.push(view.instance);
    await until(() => view.stdout.text.includes('READY'), 'ready');
    view.stdin.write('go\r');
    await until(() => view.stdout.text.includes('hidden-preview-line'), 'approval card');
    await settle(60); view.stdin.write('n');
    await until(() => view.stdout.text.includes('done'), 'answer');
    const screen = view.stdout.text;
    for (const shown of ['hidden-target', 'hidden-preview-line', 'shown', 'concealed', 'red']) expect(screen).toContain(shown);
    expect(screen.includes('\u001b[8m') || screen.includes('\u001b[31m') || screen.includes('\u001b]0;')).toBe(false);
  });

  it('shows the last lines of a running command under its line, never an escape sequence, and nothing of it after it ends', async () => {
    let finish!: () => void; const gate = new Promise<void>(resolve => { finish = resolve; });
    const streamTurn = async function* () {
      yield { kind: 'tool' as const, phase: 'started' as const, callId: 'c1', name: 'run_shell', target: 'npm test', status: null, ms: null };
      yield { kind: 'output' as const, callId: 'c1', stream: 'stdout' as const, text: 'line-1\nline-2\nline-3\n' };
      yield { kind: 'output' as const, callId: 'c1', stream: 'stderr' as const, text: '\u001b]0;pwned\u0007line-4\n\u001b[31mline-5\u001b[0m\n' };
      await gate;
      yield { kind: 'tool' as const, phase: 'finished' as const, callId: 'c1', name: 'run_shell', target: 'npm test', status: 'ok' as const, ms: 40 };
      yield { kind: 'text' as const, text: 'Tests pass.' }; yield { kind: 'done' as const, finish: 'stop' as const };
    };
    const view = mountWorkline({ streamTurn }); mounted.push(view.instance);
    await until(() => view.stdout.text.includes('READY'), 'ready');
    view.stdin.write('run the tests\r');
    await until(() => view.stdout.text.includes('line-5'), 'live output');
    await settle(60);
    const live = view.stdout.text.slice(view.stdout.text.lastIndexOf('RUNNING'));
    expect(live).toContain('line-3'); expect(live).toContain('line-4'); expect(live).toContain('line-5');
    expect(live).not.toContain('line-1'); expect(live).not.toContain('line-2');
    expect(view.stdout.text).not.toContain('pwned'); expect(view.stdout.text).not.toContain('\u001b]0');
    finish();
    await until(() => view.stdout.text.includes('Tests pass.'), 'answer');
    await settle(60);
    const after = view.stdout.text.slice(view.stdout.text.lastIndexOf('Tests pass.'));
    expect(after).not.toContain('line-5');
  });
});
