import { ensureConfiguredTerminalIdentity, loadConfiguredInstallationIdentity, loadConfiguredProjectIdentity } from '#composition/core/scoped-request/index.js';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RUNTIME_SERVICE_HEARTBEAT_MS } from '#engine/index.js';
import { main } from '../../../src/surfaces/index.js';
import { runtimeBuildSkew } from '#surfaces/core/cli/index.js';
import { clearConfigCache, t } from '#platform/index.js';
import { readLocalOsIdentity, registerProviderConfig } from '#adapters/index.js';

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
  if (process.platform !== 'win32') {
    const actor = readLocalOsIdentity();
    await writeFile(join(project, '.deckent/policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'p', restrictions: [],
      grants: [{ id: 'g', effect: 'allow', actions: ['inspect'], scopes: ['s'], principals: [{ issuer: actor.issuer, subject: actor.subject }],
        resource: { kind: 'scope', ids: 'all' } }] }), { mode: 0o600 });
  }
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
    expect(bare.text()).toContain('deckent init policy --scope <id> --apply');
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
    const context = { root: f.project, env: f.env, stdout: out.output, stderr: out.output, initialize() {}, loadInstallationIdentity: loadConfiguredInstallationIdentity, loadProjectIdentity: loadConfiguredProjectIdentity, ensureTerminalIdentity: ensureConfiguredTerminalIdentity,
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
      stdin: Object.assign(Readable.from([]), { isTTY: false }), initialize() {}, loadInstallationIdentity: loadConfiguredInstallationIdentity, loadProjectIdentity: loadConfiguredProjectIdentity, ensureTerminalIdentity: ensureConfiguredTerminalIdentity, async completeTerminalChat() { return 'x'; } });
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
        return `reply:${input.messages.at(-1)!.content} \u001b[31mpassword=hunter2x\u001b[0m`;
      } });
    expect(code).toBe(0);
    expect(calls.map(call => [call.scopeId, call.last])).toEqual([['team-a', 'one'], ['team-a', 'two'], ['team-a', 'three']]);
    expect(calls[2]!.roles).toEqual(['system', 'user', 'user']);
    expect(out.text()).toContain('reply:one password=[REDACTED]'); expect(out.text()).toContain('reply:three');
    expect(out.text()).not.toContain('\u001b'); expect(out.text()).not.toContain('hunter2x');
    expect(out.text()).toContain('The chat turn failed.'); expect(out.text()).not.toContain('provider detail');
  });

  // TERMINAL-GAPS: piped line mode writes the answer as the service streams it, plain, and cancels a turn that raises an approval card.
  it('streams piped line mode: first complete line before the turn ends, plain text, last line ended, tool and approval as plain stderr lines, a card cancels the turn', async () => {
    const f = await fixture(); const out = sink(), err = sink(); const stamps: { at: number; text: string }[] = []; let finishedAt = 0, brokenAt = 0, aborted = false; const seen: string[][] = [];
    const out2 = { write(value: string) { stamps.push({ at: performance.now(), text: value }); out.values.push(value); } };
    const code = await main(['terminal', 'session', '--scope', 's', '--lang', 'en'], { root: f.project, env: f.env, stdout: out2, stderr: err.output,
      stdin: Object.assign(Readable.from(['first\n', 'ask\n', 'again\n', 'broken\n', '/exit\n']), { isTTY: false }), initialize() {},
      async describeTerminalChatPlan() { return { ...plan, historyMessages: 40 }; },
      async completeTerminalChat() { throw new Error('line mode must stream'); },
      async *streamTerminalChat(_root: string, input: { messages: readonly { role: string; content: string }[] }, _o: unknown, signal?: AbortSignal) {
        const last = input.messages.at(-1)!.content; seen.push(input.messages.map(message => message.role));
        if (last === 'broken') { // A malformed escape before a newline waits one delta only: the pipe never stalls until the turn's end.
          yield { kind: 'text', text: '\u001b[3\nbroken\n' }; yield { kind: 'text', text: 'x\n' };
          await settle(150); brokenAt = performance.now(); yield { kind: 'done', finish: 'stop', note: null }; return;
        }
        if (last === 'ask') {
          yield { kind: 'approval', phase: 'requested', callId: 'c1', approvalId: 'a1', revision: 0, summary: 'write_file · x.txt', preview: '', expiresAt: 1 };
          await new Promise<void>(resolve => { if (signal?.aborted) resolve(); else signal?.addEventListener('abort', () => resolve(), { once: true }); });
          aborted = signal?.aborted === true;
          yield { kind: 'done', finish: 'cancelled', note: null }; return;
        }
        yield { kind: 'tool', phase: 'finished', callId: 't1', name: 'read_file', target: 'a.ts', status: 'ok', ms: 5 };
        yield { kind: 'text', text: '\u001b[31mhel\u001b[0m' };
        yield { kind: 'text', text: 'lo\u001b[3' };
        yield { kind: 'text', text: '1m!\nsec' };
        yield { kind: 'text', text: 'ond' };
        await settle(150); finishedAt ||= performance.now();
        yield { kind: 'message', message: { role: 'assistant', content: 'hello', toolCalls: [] } };
        yield { kind: 'done', finish: 'stop', note: null };
      } });
    expect(code).toBe(0);
    // The first complete line reached stdout well before the turn's end; the open last line waits for it; nothing carries an escape.
    expect(stamps[0]!.at).toBeLessThan(finishedAt - 100); expect(stamps[0]!.text).toBe('hello!\n');
    expect(out.text()).not.toContain('\u001b'); expect(out.text()).toBe('hello!\nsecond\nhello!\nsecond\n3\nbroken\nx\n');
    expect(stamps.find(stamp => stamp.text.includes('broken'))!.at).toBeLessThan(brokenAt - 100);
    expect(err.text()).toContain('tool read_file a.ts: ok (5 ms)');
    expect(err.text()).toContain('Approval required: write_file · x.txt');
    // Negative: the card was never answered, the turn was cancelled, and the cancelled question stays in history without an answer.
    expect(aborted).toBe(true);
    expect(seen).toEqual([['system', 'user'], ['system', 'user', 'assistant', 'user'], ['system', 'user', 'assistant', 'user', 'user'], ['system', 'user', 'assistant', 'user', 'user', 'assistant', 'user']]);
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
  // Windows cannot persist guarded local identities; typed refusal is covered by terminal-identity.test.ts.
  it.skipIf(process.platform === 'win32')('wires the workline composer with no visible "deckent>" prefix, through the real terminal entry', async () => {
    const f = await fixture(); const stdout = new Screen(); const stdin = keyboard();
    const run = main(['terminal', 'workline', '--scope', 's', '--lang', 'en'],
      { root: f.project, env: { ...f.env, NO_COLOR: '1' }, stdout: stdout as unknown as NodeJS.WriteStream, stderr: stdout as unknown as NodeJS.WriteStream,
        stdin: stdin as unknown as NodeJS.ReadStream, initialize() {}, loadInstallationIdentity: loadConfiguredInstallationIdentity, loadProjectIdentity: loadConfiguredProjectIdentity, ensureTerminalIdentity: ensureConfiguredTerminalIdentity, async completeTerminalChat() { return 'x'; } });
    await until(() => stdout.text.includes('Ask anything'), 'catalog placeholder rendered on the empty draft');
    expect(stdout.text).not.toContain('deckent>');
    stdin.write('/exit\r');
    expect(await run).toBe(0);
  }, 15_000);

  // #16: the terminal measures the answering service's configuration fingerprint against the one now in effect and keeps an idle-stopping
  // service alive with its own describe beat (clients connect per request, so an open terminal is otherwise invisible to the service).
  it.skipIf(process.platform === 'win32')('shows "restart required" only for a stale service and beats a describe while an idle-stopping service is connected', async () => {
    const { restartConfigDigest } = await import('#engine/index.js'); const { loadConfig } = await import('#platform/index.js');
    for (const stale of [true, false]) {
      const f = await fixture(); const stdout = new Screen(); const stdin = keyboard(); let described = 0;
      const digest = stale ? '0'.repeat(64) : restartConfigDigest(await loadConfig(f.project, { env: f.env, heal: false }) as never);
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      try {
        const run = main(['terminal', 'workline', '--scope', 's', '--lang', 'en'],
          { root: f.project, env: { ...f.env, NO_COLOR: '1' }, stdout: stdout as unknown as NodeJS.WriteStream, stderr: stdout as unknown as NodeJS.WriteStream,
            stdin: stdin as unknown as NodeJS.ReadStream, initialize() {}, loadInstallationIdentity: loadConfiguredInstallationIdentity, loadProjectIdentity: loadConfiguredProjectIdentity, ensureTerminalIdentity: ensureConfiguredTerminalIdentity, async completeTerminalChat() { return 'x'; },
            async ensureRuntimeService() { return { mode: 'connected' as const, instanceId: 'i', pid: null, logPath: null, shutdownAvailable: true, build: null, configDigest: digest, idleStopMs: 900_000 }; },
            async describeRuntimeService() { described++; return {} as never; } });
        await until(() => stdout.text.includes('Ask anything'), 'terminal startup');
        expect(stdout.text.includes('/service-restart')).toBe(stale);
        expect(described).toBe(0); vi.advanceTimersByTime(RUNTIME_SERVICE_HEARTBEAT_MS * 2); expect(described).toBe(2);
        stdin.write('/exit\r'); expect(await run).toBe(0);
        vi.advanceTimersByTime(RUNTIME_SERVICE_HEARTBEAT_MS * 2); expect(described).toBe(2); // the beat ends with the session
      } finally { vi.useRealTimers(); }
    }
  }, 30_000);

  it('keeps line mode\'s own prompt on the terminal.session.prompt catalog text', () => {
    // Line mode (`terminal session`) is a separate code path (readline, not the Composer) and unaffected by the
    // workline's D1-3 change; this pins the catalog string it reads so the two prompts are not confused.
    expect(t('terminal.session.prompt', {}, 'en')).toBe('deckent> ');
    expect(t('terminal.session.prompt', {}, 'tr')).toBe('deckent› ');
  });

  it.skipIf(process.platform === 'win32')('derives the source marker once at terminal startup and leaves a customer session unmarked', async () => {
    for (const selfSource of [true, false]) {
      const f = await fixture(); const stdout = new Screen(); const stdin = keyboard(); const rootsSeen: string[] = [];
      const run = main(['terminal', 'workline', '--scope', 's', '--lang', 'tr'],
        { root: f.project, env: { ...f.env, NO_COLOR: '1' }, stdout: stdout as unknown as NodeJS.WriteStream, stderr: stdout as unknown as NodeJS.WriteStream,
          stdin: stdin as unknown as NodeJS.ReadStream, initialize() {}, loadInstallationIdentity: loadConfiguredInstallationIdentity, loadProjectIdentity: loadConfiguredProjectIdentity, ensureTerminalIdentity: ensureConfiguredTerminalIdentity, async completeTerminalChat() { return 'x'; },
          async selfSourceProject(root) { rootsSeen.push(root); return selfSource; } });
      await until(() => stdout.text.includes(t('terminal.workline.placeholder', {}, 'tr')), 'terminal startup');
      expect(stdout.text.includes('öz-kaynak zemini açık')).toBe(selfSource);
      expect(rootsSeen).toEqual([f.project]);
      stdin.write('/exit\r');
      expect(await run).toBe(0);
    }
  }, 15_000);
});


it.skipIf(process.platform === 'win32')('S06 CLI config snapshot protects actual complete and streamed assistant fields before markdown parsing in EN/TR', async () => {
  registerProviderConfig();
  for (const locale of ['en', 'tr'] as const) for (const streamed of [false, true]) {
    const f = await fixture(); const stdout = new Screen(); const stdin = keyboard();
    const canary = `fictitious-**s06**${streamed ? '-' : '\n'}known-0123456789`;
    await writeFile(join(f.project, '.deckent/config.json'), JSON.stringify({ projectName: '$DECK:S06_TEST', terminal: { autostartService: false } }));
    const reply = `Prose می\u200cروم 👩\u200d💻 ❤️ literal <U+202E>\n\`path\u200bfile\` ${canary} ${canary.slice(0, 14)}\u001b[31m${canary.slice(14)} ${canary.slice(0, 14)}\u0002${canary.slice(14)} override \u202eEND`;
    const stream = async function* () { yield { kind: 'text' as const, text: reply }; yield { kind: 'done' as const, finish: 'stop' as const, note: null }; };
    const run = main(['terminal', 'workline', '--scope', 's', '--lang', locale], {
      root: f.project, env: { ...f.env, S06_TEST: canary, NO_COLOR: '1' }, stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, initialize() {}, loadInstallationIdentity: loadConfiguredInstallationIdentity, loadProjectIdentity: loadConfiguredProjectIdentity, ensureTerminalIdentity: ensureConfiguredTerminalIdentity,
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

// S05: piped line mode writes through the rich view's one projection (B7 record redaction with the config's known values, B8 marks).
it('S05 line mode redacts a known value and a provider token split across deltas, marks bidi/tag characters and writes no escape', async () => {
  registerProviderConfig();
  const f = await fixture(), out = sink(), err = sink(), canary = 'fictitious-line-known-0123456789';
  await writeFile(join(f.project, '.deckent/config.json'), JSON.stringify({ projectName: '$DECK:LINE_TEST' }));
  const code = await main(['terminal', 'session', '--scope', 's', '--lang', 'en'], { root: f.project, env: { ...f.env, LINE_TEST: canary }, stdout: out.output, stderr: err.output,
    stdin: Object.assign(Readable.from(['go\n', 'osc\n', 'ask\n', '/exit\n']), { isTTY: false }), initialize() {},
    async describeTerminalChatPlan() { return plan; }, async completeTerminalChat() { throw new Error('line mode must stream'); },
    async *streamTerminalChat(_root: string, input: { messages: readonly { role: string; content: string }[] }, _o: unknown, signal?: AbortSignal) {
      if (input.messages.at(-1)!.content === 'osc') { // An OSC swallows the newline inside the value: the two halves are one visible line.
        yield { kind: 'text', text: `${canary.slice(0, 16)}\u001b]0;x\n` }; yield { kind: 'text', text: `\u0007${canary.slice(16)}\n` };
        yield { kind: 'done', finish: 'stop', note: null }; return;
      }
      if (input.messages.at(-1)!.content === 'ask') {
        yield { kind: 'approval', phase: 'requested', callId: 'c1', approvalId: 'a1', revision: 0, summary: `run_shell · echo \u202e ${canary}`, preview: '', expiresAt: 1 };
        await new Promise<void>(resolve => { if (signal?.aborted) resolve(); else signal?.addEventListener('abort', () => resolve(), { once: true }); });
        yield { kind: 'done', finish: 'cancelled', note: null }; return;
      }
      yield { kind: 'tool', phase: 'finished', callId: 't1', name: 'read_file', target: 'a\u{E0041}b.ts', status: 'ok', ms: 1 };
      for (const text of [`key ${canary.slice(0, 12)}`, `${canary.slice(12)} token sk-ant-`, 'abcdef123456 \u001b[3', '1mred \u202eEND\nnext']) yield { kind: 'text', text };
      yield { kind: 'done', finish: 'stop', note: null };
    } });
  expect(code).toBe(0);
  expect(out.text()).toBe('key \u2039secret:LINE_TEST\u203a token [REDACTED] red <U+202E>END\nnext\n\u2039secret:LINE_TEST\u203a\n');
  // Negative: no part of a value split across deltas or around an OSC, no token tail and no escape reaches the pipe.
  for (const text of [out.text(), err.text()]) for (const leaked of ['fictitious', 'known-0123', '0123456789', 'abcdef123456', '\u001b', '\u202e', '\u{E0041}']) expect(text).not.toContain(leaked);
  expect(err.text()).toContain('tool read_file a<U+E0041>b.ts: ok (1 ms)');
  expect(err.text()).toContain('Approval required: run_shell · echo <U+202E> \u2039secret:LINE_TEST\u203a');
});

it('dispatches deckent --scope to the same terminal command, including typed TTY and duplicate-scope refusals', async () => {
    const f = await fixture(); const out = sink();
    const context = { root: f.project, env: f.env, stdout: out.output, stderr: out.output,
      stdin: Object.assign(Readable.from([]), { isTTY: false }), initialize() {}, async completeTerminalChat() { return ''; } };
    expect(await main(['--scope', 's'], context), out.text()).toBe(2);
    expect(out.text()).toContain('TERMINAL_TTY_REQUIRED');
    expect(out.text()).not.toContain('Unknown command');
    expect(await main(['--scope', 's', '--scope', 'other'], context)).toBe(2);
  });

// W12: an exact registered value may itself include a newline, so the previous line cannot be committed early.
it('W12 line mode masks a multiline known value across complete-line and delta boundaries, preserving raw history', async () => {
  registerProviderConfig();
  const f = await fixture(), out = sink(), err = sink(), canary = 'W12-first-part\nsecond-part-012345';
  await writeFile(join(f.project, '.deckent/config.json'), JSON.stringify({ projectName: '$DECK:LINE_TEST' }));
  const histories: string[] = [];
  const code = await main(['terminal', 'session', '--scope', 's', '--lang', 'en'], { root: f.project, env: { ...f.env, LINE_TEST: canary }, stdout: out.output, stderr: err.output,
    stdin: Object.assign(Readable.from(['go\n', 'again\n', '/exit\n']), { isTTY: false }), initialize() {}, async describeTerminalChatPlan() { return { ...plan, historyMessages: 40 }; },
    async completeTerminalChat() { throw new Error('must use the streaming path'); },
    async *streamTerminalChat(_root: string, input: { messages: readonly { role: string; content: string }[] }) {
      histories.push(JSON.stringify(input.messages));
      for (const text of ['prefix ', 'W12-first-part\n', 'second-part-', '012345 suffix\n']) {
        yield { kind: 'text', text }; await settle(1);
        for (const fragment of ['first-part', 'second-part', '012345']) expect(out.text()).not.toContain(fragment);
      }
      yield { kind: 'message', message: { role: 'assistant', content: canary, toolCalls: [] } };
      yield { kind: 'done', finish: 'stop', note: null };
    } });
  expect(code).toBe(0); expect(out.text()).toBe('prefix ‹secret:LINE_TEST› suffix\nprefix ‹secret:LINE_TEST› suffix\n');
  expect(histories[1]).toContain('W12-first-part\\nsecond-part-012345');
});
