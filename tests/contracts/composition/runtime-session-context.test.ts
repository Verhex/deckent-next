import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_TURN_SYSTEM_PROMPT_VERSION } from '#engine/index.js';
import { closeModeRuntimes, modeRuntime, rule } from '../support/agent-turn-modes.js';

// NATIVE-BAGLAM (owner 2026-10-14: "hangi moddayız" was answered by reading .deckent/config.json): on the real runtime service, the system
// prompt the model endpoint received states the session's mode, thinking, model facts and each tool's effect; `session_state` returns the same
// snapshot fresh where policy allows it; a mode switched between turns is what the next turn sees. Nothing here widens any decision.
afterEach(closeModeRuntimes);
const SESSION = rule('session-state', 'agent-tool', ['session_state'], 'allow');
const GRANTS = [rule('read', 'agent-tool', ['read_file', 'list_dir', 'glob', 'grep'], 'allow'), rule('edit-tools', 'agent-tool', ['edit_file', 'write_file'], 'require-approval', true),
  rule('file-write', 'operation', ['workspace.file.write'], 'allow'), rule('mode-set', 'permission-mode', ['full-auto', 'full-access'], 'allow', false, ['set'])];
type Runtime = Awaited<ReturnType<typeof modeRuntime>>;
const lastPrompt = (f: Runtime, back = 2) => f.sent.at(-back)!.messages[0]!.content;
const offered = (f: Runtime, back = 2) => ((f.sent.at(-back) as unknown as { tools?: { function: { name: string } }[] }).tools ?? []).map(tool => tool.function.name);
const modeLine = (prompt: string) => prompt.split('\n').find(line => line.startsWith('- Permission mode:')) ?? '';

describe.skipIf(process.platform !== 'linux')('the session context reaches the model and follows the session (prompt v10)', () => {
  it('states the mode, thinking and effects; session_state returns the snapshot; a mode set between turns is the next turn\'s', async () => {
    const f = await modeRuntime({ grants: [...GRANTS, SESSION], mode: null });
    const first = await f.call('session_state', {});
    expect(first).toMatchObject({ card: false, status: 'ok' });
    const prompt = lastPrompt(f);
    expect(prompt.startsWith(`[Deckent runtime instructions v${AGENT_TURN_SYSTEM_PROMPT_VERSION}]`)).toBe(true);
    expect(modeLine(prompt)).toContain('- Permission mode: standart — ');
    expect(prompt).toContain('- Thinking: as the model is served');
    expect(prompt).toContain('edit_file, write_file: an ordinary file runs at once; a protected path asks the person');
    expect(prompt).toContain('session_state returns this context fresh as JSON.');
    expect(offered(f)).toContain('session_state');
    // The tool's answer is the typed snapshot itself: no file was read for it (the model made exactly this one call).
    const state = JSON.parse(first.text) as { mode: { name: string }; scopeId: string; tools: { name: string }[]; rules: string[] };
    expect(state).toMatchObject({ mode: { name: 'standart' }, scopeId: 'scope' });
    expect(state.tools.map(tool => tool.name)).toEqual(offered(f));
    expect(first.events.filter(event => event.kind === 'tool.started').map(event => event.kind === 'tool.started' && event.name)).toEqual(['session_state']);

    // The person switches the mode (Shift+Tab → the service's setPermissionMode); the very next turn's prompt and tool say full-auto.
    const shown = await f.client.inspectPermissionMode({ schemaVersion: 1, scopeId: 'scope' });
    await f.client.setPermissionMode({ schemaVersion: 1, scopeId: 'scope', mode: 'full-auto', expectedRevision: shown.revision });
    const second = await f.call('session_state', {});
    expect(modeLine(lastPrompt(f))).toContain('- Permission mode: full-auto — ');
    expect((JSON.parse(second.text) as { mode: { name: string } }).mode.name).toBe('full-auto');
  }, 60_000);

  it('without an explicit grant session_state is never offered or run, and every other decision is the same', async () => {
    const granted = await modeRuntime({ grants: [...GRANTS, SESSION], mode: { mode: 'standart', askEdits: true } });
    const plain = await modeRuntime({ grants: GRANTS, mode: { mode: 'standart', askEdits: true } });
    // The same edit asks in both (askEdits), whatever the context says; the card is the person's, and a no leaves the file unchanged.
    for (const f of [granted, plain]) {
      const edit = await f.call('edit_file', { path: 'src/a.ts', old_string: 'a = 1', new_string: 'a = 2' });
      expect(edit).toMatchObject({ card: true, status: 'denied' });
      expect(await readFile(join(f.project, 'src/a.ts'), 'utf8')).toBe('export const a = 1;\n');
      expect(modeLine(lastPrompt(f))).toContain('standart (the person also asks for every edit)');
    }
    expect(granted.audit().map(record => record.event.subject['kind'])).toEqual(plain.audit().map(record => record.event.subject['kind']));
    // Not offered: the model cannot call it — the provider adapter rejects a call of an undeclared tool, so nothing runs or is decided for it.
    const refused = await plain.call('session_state', {});
    expect(offered(plain, 1)).not.toContain('session_state');
    expect(refused.events.some(event => event.kind === 'tool.started')).toBe(false);
    expect(lastPrompt(plain, 1)).not.toContain('session_state returns');
  }, 60_000);
});
