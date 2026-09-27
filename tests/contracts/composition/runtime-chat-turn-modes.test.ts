import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeModeRuntimes, me, modeRuntime, rule, type Mode } from '../support/agent-turn-modes.js';

// T-L4 slice 4a on the real runtime service: cell × mode. The company marks a require-approval rule `modeEligible` (policy v2); the
// person's mode lives in bindings.json (v2 `modes`). A mode lowers only an eligible require-approval on a relaxable cell, writes one
// sealed `permission-mode` audit event before the effect, and never touches deny, the write floor, `low`, destructive or always-ask.
afterEach(closeModeRuntimes);
const MODES: readonly Mode[] = ['ask', 'auto-edit', 'full-auto'];
type Effect = 'allow' | 'deny' | 'require-approval';
const edit = (tool: Effect, op: Effect, eligible: { tool?: boolean; op?: boolean } = {}) => [
  rule('edit-tools', 'agent-tool', ['edit_file', 'write_file'], tool, eligible.tool), rule('file-write', 'operation', ['workspace.file.write'], op, eligible.op)];
const shell = (tool: Effect, op: Effect, eligible: { tool?: boolean; op?: boolean } = {}) => [
  rule('shell-tool', 'agent-tool', ['run_shell'], tool, eligible.tool), rule('shell-run', 'operation', ['host.shell.run'], op, eligible.op)];
const setA = (to: number) => ({ path: 'src/a.ts', old_string: `a = ${to - 1}`, new_string: `a = ${to}` });

describe.skipIf(process.platform !== 'linux')('permission modes through the runtime service (T-L4 slice 4a)', () => {
  it('lowers an eligible require-approval on an ordinary edit in auto-edit and full-auto, with one audit event each; ask still shows the card', async () => {
    const f = await modeRuntime({ grants: edit('require-approval', 'allow', { tool: true }), mode: 'ask' });
    const asked = await f.call('edit_file', setA(2));
    expect(asked).toMatchObject({ card: true, status: 'denied' });
    let expected = 1;
    for (const mode of ['auto-edit', 'full-auto'] as const) {
      await f.writeAuthority(edit('require-approval', 'allow', { tool: true }), mode, mode);
      const silent = await f.call('edit_file', setA(++expected));
      expect(silent).toMatchObject({ card: false, status: 'ok' });
      expect(await readFile(join(f.project, 'src/a.ts'), 'utf8')).toBe(`export const a = ${expected};\n`);
    }
    const events = f.audit();
    expect(events).toHaveLength(2);
    expect(events.map(record => record.event.subject)).toEqual([
      expect.objectContaining({ kind: 'permission-mode', mode: 'auto-edit', cell: 'edit-non-floor', tool: { name: 'edit_file', version: 1 },
        grants: { company: 'edit-tools', person: 'me-mode' }, decision: { previous: 'require-approval', next: 'allow' }, summary: { kind: 'edit', path: 'src/a.ts' } }),
      expect.objectContaining({ mode: 'full-auto', cell: 'edit-non-floor' })]);
    expect(events[0]!.event).toMatchObject({ principal: me[0], policyRevision: 'p-auto-edit+b-auto-edit' });
    expect(events[0]!.event.subject.call).toMatchObject({ round: 1, index: 0, callId: 'call_1' });
    // The audit event precedes the effect it admits: one event per settled write, none for the carded call.
    expect(f.rows("SELECT state FROM effect_intents WHERE target_kind='workspace-file'")).toEqual([{ state: 'settled' }, { state: 'settled' }]);
  }, 90_000);

  it('never lowers a require-approval the company did not mark mode-eligible, nor lets a second allow grant pass it (M6, M7)', async () => {
    const f = await modeRuntime({ grants: [...edit('require-approval', 'allow'), rule('edit-allow', 'agent-tool', ['edit_file'], 'allow')], mode: 'full-auto' });
    expect(await f.call('edit_file', setA(2))).toMatchObject({ card: true, status: 'denied' });
    // Operation side required but not eligible, tool side eligible: the stricter side is not eligible → card.
    await f.writeAuthority(edit('require-approval', 'require-approval', { tool: true }), 'full-auto', 'r2');
    expect(await f.call('edit_file', setA(2))).toMatchObject({ card: true, status: 'denied' });
    expect(await readFile(join(f.project, 'src/a.ts'), 'utf8')).toBe('export const a = 1;\n');
    expect(f.audit()).toEqual([]);
  }, 60_000);

  it('answers a denied tool or operation as denied in every mode: no card, no event, nothing written (M2)', async () => {
    const f = await modeRuntime({ grants: edit('deny', 'require-approval', { op: true }), mode: 'ask' });
    for (const mode of MODES) {
      await f.writeAuthority(edit('deny', 'require-approval', { op: true }), mode, `tool-${mode}`);
      expect(await f.call('edit_file', setA(2))).toMatchObject({ card: false, status: 'denied' });
      await f.writeAuthority(edit('require-approval', 'deny', { tool: true }), mode, `op-${mode}`);
      expect(await f.call('edit_file', setA(2))).toMatchObject({ card: false, status: 'denied' });
    }
    expect(await readFile(join(f.project, 'src/a.ts'), 'utf8')).toBe('export const a = 1;\n');
    expect(f.audit()).toEqual([]);
    expect(f.rows('SELECT * FROM effect_intents')).toEqual([]);
  }, 90_000);

  it('asks for a floor path in every mode, with an allow grant and with an eligible require-approval (M1)', async () => {
    const f = await modeRuntime({ grants: edit('allow', 'allow'), mode: 'ask' });
    for (const grants of [edit('allow', 'allow'), edit('require-approval', 'require-approval', { tool: true, op: true })]) {
      for (const mode of MODES) {
        await f.writeAuthority(grants, mode, `${mode}-${grants[0]!.effect}`);
        expect(await f.call('write_file', { path: 'package.json', content: '{}\n' })).toMatchObject({ card: true, status: 'denied' });
      }
    }
    await expect(readFile(join(f.project, 'package.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(f.audit()).toEqual([]);
  }, 90_000);

  it('keeps a silent allow silent in every mode: no event, one summary count per call (q5)', async () => {
    const f = await modeRuntime({ grants: [...shell('allow', 'allow'), ...edit('allow', 'allow')], mode: 'ask' });
    for (const mode of MODES) {
      await f.writeAuthority([...shell('allow', 'allow'), ...edit('allow', 'allow')], mode, mode);
      expect(await f.call('run_shell', { command: 'cat src/a.ts' })).toMatchObject({ card: false, status: 'ok' });
    }
    expect(await f.call('write_file', { path: 'src/b.ts', content: 'export {};\n' })).toMatchObject({ card: false, status: 'ok' });
    expect(f.audit()).toEqual([]);
    expect(f.counters()).toEqual({ 'agent-tool.silent.shell': 3, 'agent-tool.silent.edit': 1 });
  }, 90_000);

  it('asks in full-auto for low, destructive and always-ask commands, and for an eligible read tool (M5)', async () => {
    const f = await modeRuntime({ grants: [...shell('require-approval', 'require-approval', { tool: true, op: true }),
      rule('read', 'agent-tool', ['read_file'], 'require-approval', true)], mode: 'full-auto' });
    for (const command of ['find .', 'rg a', 'git show HEAD:.env', 'rm -rf src', 'git reset --hard', 'python3 -c 1', 'sudo true', 'npm install left-pad',
      'curl http://127.0.0.1:9/', 'touch a | cat', 'touch $HOME/x', 'rm src/a.ts']) {
      expect({ command, ...(await f.call('run_shell', { command })) }).toMatchObject({ command, card: true, status: 'denied' });
    }
    expect(await f.call('read_file', { path: 'src/a.ts' })).toMatchObject({ card: true, status: 'denied' });
    expect(await readFile(join(f.project, 'src/a.ts'), 'utf8')).toBe('export const a = 1;\n');
    expect(f.audit()).toEqual([]);
  }, 120_000);

  it('runs a narrow mutating command silently only in full-auto, with one audit event; auto-edit and ask show the card (q1)', async () => {
    const f = await modeRuntime({ grants: shell('require-approval', 'allow', { tool: true }), mode: 'auto-edit' });
    expect(await f.call('run_shell', { command: 'touch made.txt' })).toMatchObject({ card: true, status: 'denied' });
    await f.writeAuthority(shell('require-approval', 'allow', { tool: true }), 'ask', 'ask');
    expect(await f.call('run_shell', { command: 'touch made.txt' })).toMatchObject({ card: true, status: 'denied' });
    await expect(readFile(join(f.project, 'made.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await f.writeAuthority(shell('require-approval', 'allow', { tool: true }), 'full-auto', 'full');
    expect(await f.call('run_shell', { command: 'cp src/a.ts out.ts' })).toMatchObject({ card: false, status: 'ok' });
    expect(await readFile(join(f.project, 'out.ts'), 'utf8')).toBe('export const a = 1;\n');
    // A narrow command whose target is on the write floor is not narrow.
    expect(await f.call('run_shell', { command: 'touch package.json' })).toMatchObject({ card: true, status: 'denied' });
    const events = f.audit();
    expect(events.map(record => record.event.subject)).toEqual([expect.objectContaining({ mode: 'full-auto', cell: 'shell-modify',
      summary: { kind: 'shell', head: 'cp src/a.ts out.ts', argsDigest: expect.stringMatching(/^[0-9a-f]{64}$/u) } })]);
  }, 90_000);

  it('asks for a compound command in full-auto: an earlier part must not turn a later target into a floor path (Astra 2133)', async () => {
    const f = await modeRuntime({ grants: [rule('shell-tool', 'agent-tool', ['run_shell'], 'require-approval', true), rule('shell-run', 'operation', ['host.shell.run'], 'allow')],
      mode: 'full-auto' });
    await writeFile(join(f.project, 'package.json'), '{"scripts":{"preinstall":"echo floor"}}\n');
    // Astra's case: `mkdir out` makes the copy target a directory, so `cp` would write `out/package.json` (write floor `**/package.json`).
    expect(await f.call('run_shell', { command: 'mkdir out && cp package.json out' })).toMatchObject({ card: true, status: 'denied' });
    // A harmless compound asks too: the narrow set is one simple command (no `&&`, `;`, `||`, pipe).
    expect(await f.call('run_shell', { command: 'mkdir out && cp src/a.ts out/a.ts' })).toMatchObject({ card: true, status: 'denied' });
    await expect(stat(join(f.project, 'out'))).rejects.toMatchObject({ code: 'ENOENT' });
    // A directory that exists already is not a narrow target: `cp` would write into it under a path nobody checked.
    await mkdir(join(f.project, 'out'));
    expect(await f.call('run_shell', { command: 'cp package.json out' })).toMatchObject({ card: true, status: 'denied' });
    expect(await f.call('run_shell', { command: 'mv src/a.ts out' })).toMatchObject({ card: true, status: 'denied' });
    expect(await readdir(join(f.project, 'out'))).toEqual([]);
    expect(await readFile(join(f.project, 'package.json'), 'utf8')).toBe('{"scripts":{"preinstall":"echo floor"}}\n');
    expect(f.audit()).toEqual([]);
    expect(f.rows("SELECT state FROM effect_intents WHERE target_kind='host-shell'")).toEqual([]);
  }, 90_000);

  it('Astra 2134 R1 repro: compound narrow commands must not bypass the package manifest write floor', async () => {
    const f = await modeRuntime({ grants: [rule('shell-tool', 'agent-tool', ['run_shell'], 'require-approval', true), rule('shell-run', 'operation', ['host.shell.run'], 'allow')], mode: 'full-auto' });
    await writeFile(join(f.project, 'package.json'), '{"scripts":{"preinstall":"echo floor"}}\n');
    const result = await f.call('run_shell', { command: 'mkdir out && cp package.json out' });
    const content = await readFile(join(f.project, 'out/package.json'), 'utf8').catch(() => null);
    expect(result.card).toBe(true);
    expect(content).toBeNull();
    expect(f.audit()).toEqual([]);
  }, 60_000);

  it('runs nothing when the audit event cannot be written: the relaxation is not applied (M3)', async () => {
    const f = await modeRuntime({ grants: [...edit('require-approval', 'allow', { tool: true }), ...shell('require-approval', 'allow', { tool: true })], mode: 'full-auto' });
    f.exec("CREATE TRIGGER audit_refuses BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'unavailable'); END;");
    const edited = await f.call('edit_file', setA(2));
    expect(edited).toMatchObject({ card: false, status: 'error' });
    expect(edited.text).toContain('audit-unavailable');
    expect((await f.call('run_shell', { command: 'touch made.txt' })).text).toContain('audit-unavailable');
    expect(await readFile(join(f.project, 'src/a.ts'), 'utf8')).toBe('export const a = 1;\n');
    await expect(readFile(join(f.project, 'made.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(f.rows('SELECT * FROM effect_intents')).toEqual([]);
  }, 60_000);
});
