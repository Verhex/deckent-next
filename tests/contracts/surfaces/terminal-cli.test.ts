import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../../../src/surfaces/index.js';
import { runtimeBuildSkew } from '#surfaces/core/cli/index.js';
import { clearConfigCache, t } from '#platform/index.js';
import { registerProviderConfig } from '#adapters/index.js';

/** A minimal in-memory TTY screen: the composer's real render lands here through `runTerminalWorkline`. */
class Screen extends Writable {
  text = '';
  readonly isTTY = true; readonly columns = 120; readonly rows = 40;
  override _write(chunk: Buffer, _encoding: string, done: () => void) { this.text += chunk.toString('utf8'); done(); }
}
function keyboard() {
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() { return stdin; }, ref() { return stdin; }, unref() { return stdin; } });
  return stdin;
}
const settle = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, label: string) {
  for (let attempt = 0; attempt < 300; attempt++) { if (check()) return; await settle(10); }
  throw new Error(`timed out waiting for ${label}`);
}

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
  it('flags a runtime service from another or an unknown build, never a source run or the same build', () => {
    const a = { sourceTreeSha256: 'a'.repeat(64) }, b = { sourceTreeSha256: 'b'.repeat(64) };
    expect(runtimeBuildSkew(a, a)).toBeNull();
    expect(runtimeBuildSkew(null, b)).toBeNull();
    expect(runtimeBuildSkew(a, b)).toEqual({ service: 'b'.repeat(12), terminal: 'a'.repeat(12) });
    expect(runtimeBuildSkew(a, null)).toEqual({ service: null, terminal: 'a'.repeat(12) });
  });

  it('opens the interactive terminal for bare `deckent` only on a real terminal; piped or dumb terminals get help', async () => {
    const f = await fixture(); let ensured = 0;
    const tty = (term: string) => ({ root: f.project, env: { ...f.env, TERM: term }, initialize() {},
      stdin: Object.assign(Readable.from([]), { isTTY: true }), async completeTerminalChat() { return 'x'; },
      async ensureRuntimeService() { ensured++; throw new Error('unreachable'); } });
    const piped = sink();
    expect(await main([], { root: f.project, env: { ...f.env, DECKENT_LANGUAGE: 'en' }, stdout: piped.output, stderr: piped.output, initialize() {},
      stdin: Object.assign(Readable.from([]), { isTTY: false }) })).toBe(0);
    expect(piped.text()).toContain('opens the interactive session');
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
      inference: { configured: false }, chat: plan, projectId: null, installationId: null, identity: {
        installation: { status: 'unavailable', reason: 'unsupported', bindingCapability: 'not-observed' },
        project: { status: 'unavailable', reason: 'unsupported' } } });
  });

  // D1-3: the workline's real label construction (worklineLabels in terminal.ts) wires the composer with no visible
  // `deckent> ` prefix; earlier tests only mounted the Composer with `prompt: ''` supplied directly, so a revert of
  // that one field to `t('terminal.session.prompt')` would still pass them. This mounts through the real CLI entry.
  it('wires the workline composer with no visible "deckent>" prefix, through the real terminal entry', async () => {
    const f = await fixture(); const stdout = new Screen(); const stdin = keyboard();
    const run = main(['terminal', 'workline', '--scope', 's', '--lang', 'en'],
      { root: f.project, env: { ...f.env, NO_COLOR: '1' }, stdout: stdout as unknown as NodeJS.WriteStream, stderr: stdout as unknown as NodeJS.WriteStream,
        stdin: stdin as unknown as NodeJS.ReadStream, initialize() {}, async completeTerminalChat() { return 'x'; } });
    await until(() => stdout.text.includes('Ask anything'), 'catalog placeholder rendered on the empty draft');
    expect(stdout.text).not.toContain('deckent>');
    stdin.write('/exit\r');
    expect(await run).toBe(0);
  }, 15_000);

  it('keeps line mode\'s own prompt on the terminal.session.prompt catalog text', () => {
    // Line mode (`terminal session`) is a separate code path (readline, not the Composer) and unaffected by the
    // workline's D1-3 change; this pins the catalog string it reads so the two prompts are not confused.
    expect(t('terminal.session.prompt', {}, 'en')).toBe('deckent> ');
    expect(t('terminal.session.prompt', {}, 'tr')).toBe('deckent› ');
  });

  it('derives the source marker once at terminal startup and leaves a customer session unmarked', async () => {
    for (const selfSource of [true, false]) {
      const f = await fixture(); const stdout = new Screen(); const stdin = keyboard(); const rootsSeen: string[] = [];
      const run = main(['terminal', 'workline', '--scope', 's', '--lang', 'tr'],
        { root: f.project, env: { ...f.env, NO_COLOR: '1' }, stdout: stdout as unknown as NodeJS.WriteStream, stderr: stdout as unknown as NodeJS.WriteStream,
          stdin: stdin as unknown as NodeJS.ReadStream, initialize() {}, async completeTerminalChat() { return 'x'; },
          async selfSourceProject(root) { rootsSeen.push(root); return selfSource; } });
      await until(() => stdout.text.includes(t('terminal.workline.placeholder', {}, 'tr')), 'terminal startup');
      expect(stdout.text.includes('öz-kaynak zemini açık')).toBe(selfSource);
      expect(rootsSeen).toEqual([f.project]);
      stdin.write('/exit\r');
      expect(await run).toBe(0);
    }
  }, 15_000);
});


it('S06 CLI config snapshot protects actual complete and streamed assistant fields before markdown parsing in EN/TR', async () => {
  registerProviderConfig();
  for (const locale of ['en', 'tr'] as const) for (const streamed of [false, true]) {
    const f = await fixture(); const stdout = new Screen(); const stdin = keyboard();
    const canary = `fictitious-**s06**${streamed ? '-' : '\n'}known-0123456789`;
    await writeFile(join(f.project, '.deckent/config.json'), JSON.stringify({ projectName: '$DECK:S06_TEST', terminal: { autostartService: false } }));
    const reply = `Prose می\u200cروم 👩\u200d💻 ❤️ literal <U+202E>\n\`path\u200bfile\` ${canary} ${canary.slice(0, 14)}\u001b[31m${canary.slice(14)} ${canary.slice(0, 14)}\u0002${canary.slice(14)} override \u202eEND`;
    const stream = async function* () { yield { kind: 'text' as const, text: reply }; yield { kind: 'done' as const, finish: 'stop' as const, note: null }; };
    const run = main(['terminal', 'workline', '--scope', 's', '--lang', locale], {
      root: f.project, env: { ...f.env, S06_TEST: canary, NO_COLOR: '1' }, stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, initialize() {},
      async completeTerminalChat() { return reply; }, ...(streamed ? { streamTerminalChat: stream } : {}) });
    try {
      await until(() => stdout.text.includes(t('terminal.workline.placeholder', {}, locale)), 'catalog composer');
      stdin.write('hello\r');
      await until(() => stdout.text.includes('path<U+200B>file') && stdout.text.includes('‹secret:S06_TEST›'), 'actual CLI known snapshot projection');
      expect(stdout.text).toContain(locale === 'en' ? '2 hidden characters' : '2 gizli karakter');
      expect(stdout.text).toContain('می\u200cروم 👩\u200d💻 ❤️');
      expect(stdout.text).not.toContain(canary);
      expect(stdout.text).not.toContain('fictitious-');
      expect(stdout.text).not.toContain('known-0123456789');
      expect(stdout.text).not.toContain('[31m');
      console.info('s06-cli-source-surface-evidence', JSON.stringify({ locale, streamed, snapshot: 'getConfigKnownSecrets(loadConfig) opaque production injection',
        renderedFrame: stdout.text.slice(stdout.text.lastIndexOf('Prose') - 40) }));
    } finally { stdin.write('/exit\r'); expect(await run, stdout.text).toBe(0); }
  }
}, 30_000);
