import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../../../src/surfaces/index.js';
import { clearConfigCache } from '#platform/index.js';

const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-terminal-cli-')); roots.push(root);
  const project = join(root, 'project'), home = join(root, 'home');
  await Promise.all([mkdir(join(project, '.deckent'), { recursive: true }), mkdir(home, { recursive: true })]);
  return { project, env: { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'), DECKENT_GLOBAL_HOME: join(home, 'global') } };
}
function sink() { const values: string[] = []; return { values, text: () => values.join(''), output: { write(value: string) { values.push(value); } } }; }
const plan = { schemaVersion: 1 as const, status: 'ready' as const, reference: { providerId: 'local', providerVersion: 1, modelId: 'chat', modelVersion: 1 },
  catalogRevision: 'r1', maxCompletionTokens: 64, historyMessages: 3 };

describe('deckent terminal CLI', () => {
  it('opens the interactive terminal for bare `deckent` only on a real terminal; piped or dumb terminals get help', async () => {
    const f = await fixture(); let ensured = 0;
    const tty = (term: string) => ({ root: f.project, env: { ...f.env, TERM: term }, initialize() {},
      stdin: Object.assign(Readable.from([]), { isTTY: true }), async completeTerminalChat() { return 'x'; },
      async ensureRuntimeService() { ensured++; throw new Error('unreachable'); } });
    const piped = sink();
    expect(await main([], { root: f.project, env: { ...f.env, DECKENT_LANGUAGE: 'en' }, stdout: piped.output, stderr: piped.output, initialize() {},
      stdin: Object.assign(Readable.from([]), { isTTY: false }) })).toBe(0);
    expect(piped.text()).toContain('opens the interactive Deckent terminal');
    const dumb = sink();
    expect(await main([], { ...tty('dumb'), stdout: Object.assign(dumb.output, { isTTY: true }), stderr: dumb.output })).toBe(0);
    expect(dumb.text()).toContain('Usage:');
    // On a terminal without a configured scope the screen explains how to set one; no service is started for it.
    const bare = sink();
    expect(await main([], { ...tty('xterm-256color'), env: { ...f.env, TERM: 'xterm-256color', DECKENT_LANGUAGE: 'en' },
      stdout: Object.assign(bare.output, { isTTY: true }), stderr: bare.output })).toBe(2);
    expect(bare.text()).toContain('TERMINAL_SCOPE_REQUIRED');
    expect(bare.text()).toContain('terminal.scopeId');
    expect(ensured).toBe(0);
  });

  it('keeps slash input local in line mode: /status answers locally, unknown commands never reach the model, piped mode starts no service', async () => {
    const f = await fixture(); const out = sink(); const sent: string[] = []; let ensured = 0;
    const code = await main(['terminal', 'session', '--scope', 's', '--lang', 'en'], { root: f.project, env: f.env, stdout: out.output, stderr: out.output,
      stdin: Object.assign(Readable.from(['/status\n', '/nope\n', 'hi\n', '/exit\n']), { isTTY: false }), initialize() {},
      async describeTerminalChatPlan() { return plan; }, async ensureRuntimeService() { ensured++; throw new Error('unreachable'); },
      async completeTerminalChat(_root: string, input: { messages: ReadonlyArray<{ content: string }> }) { sent.push(input.messages.at(-1)!.content); return 'ok'; } });
    expect(code).toBe(0);
    expect(sent).toEqual(['hi']);
    expect(out.text()).toContain('Chat model:');
    expect(out.text()).toContain('Unknown command: /nope');
    expect(ensured).toBe(0);
  });

  it('requires a scope (flag or terminal.scopeId) for chat modes and rejects --json there before any turn', async () => {
    const f = await fixture(); const out = sink(); let turns = 0;
    const context = { root: f.project, env: f.env, stdout: out.output, stderr: out.output, initialize() {},
      async completeTerminalChat() { turns++; return 'x'; } };
    expect(await main(['terminal', 'workline'], context)).toBe(2);
    expect(await main(['terminal', 'session'], context)).toBe(2);
    expect(await main(['terminal', 'session', '--scope', 's', '--json'], context)).toBe(2);
    expect(await main(['terminal', 'session', '--scope', 'a', '--scope', 'b'], context)).toBe(2);
    expect(turns).toBe(0);
  });

  it('refuses the rich view without a terminal on stdin and stdout', async () => {
    const f = await fixture(); const out = sink();
    const code = await main(['terminal', 'workline', '--scope', 's', '--lang', 'en'], { root: f.project, env: f.env, stdout: out.output, stderr: out.output,
      stdin: Object.assign(Readable.from([]), { isTTY: false }), initialize() {}, async completeTerminalChat() { return 'x'; } });
    expect(code).toBe(2); expect(out.text()).toContain('TERMINAL_TTY_REQUIRED');
  });

  it('runs piped line mode: one governed turn per line in the caller scope with bounded history', async () => {
    const f = await fixture(); const out = sink(); const calls: Array<{ scopeId: string; roles: string[]; last: string }> = [];
    const code = await main(['terminal', 'session', '--scope', 'team-a', '--lang', 'en'], { root: f.project, env: f.env, stdout: out.output, stderr: out.output,
      stdin: Object.assign(Readable.from(['one\n', 'two\n', '\n', 'three\n', '/exit\n', 'never\n']), { isTTY: false }), initialize() {},
      async describeTerminalChatPlan() { return plan; },
      async completeTerminalChat(_root: string, input: { scopeId: string; messages: readonly { role: string; content: string }[] }) {
        calls.push({ scopeId: input.scopeId, roles: input.messages.map(message => message.role), last: input.messages.at(-1)!.content });
        if (input.messages.at(-1)!.content === 'two') throw new Error('provider detail must not leak');
        return `reply:${input.messages.at(-1)!.content}`;
      } });
    expect(code).toBe(0);
    expect(calls.map(call => [call.scopeId, call.last])).toEqual([['team-a', 'one'], ['team-a', 'two'], ['team-a', 'three']]);
    expect(calls[2]!.roles).toEqual(['system', 'user', 'user']);
    expect(out.text()).toContain('reply:one'); expect(out.text()).toContain('reply:three');
    expect(out.text()).toContain('The chat turn failed.'); expect(out.text()).not.toContain('provider detail');
  });

  it('fails typed when the executable composes no governed chat handler', async () => {
    const f = await fixture(); const out = sink();
    const context = { root: f.project, env: f.env, stdout: out.output, stderr: out.output, initialize() {},
      stdin: Object.assign(Readable.from(['hi\n']), { isTTY: false }) };
    expect(await main(['terminal', 'session', '--scope', 's', '--lang', 'en'], context)).toBe(1);
    expect(out.text()).toContain('TERMINAL_CHAT_UNAVAILABLE');
    expect(await main(['terminal', 'chat-plan', '--lang', 'en'], context)).toBe(1);
  });

  it('reports status as JSON with stdout TTY state and the chat plan, without inference configuration', async () => {
    const f = await fixture(); const out = sink();
    expect(await main(['terminal', 'status', '--json'], { root: f.project, env: f.env, stdout: out.output, stderr: out.output,
      stdin: Object.assign(Readable.from([]), { isTTY: true }), initialize() {}, async describeTerminalChatPlan() { return plan; } })).toBe(0);
    expect(JSON.parse(out.text())).toEqual({ schemaVersion: 1, tty: { stdin: true, stdout: false, columns: null, rows: null },
      inference: { configured: false }, chat: plan });
  });
});
