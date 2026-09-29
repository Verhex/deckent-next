import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { PassThrough, Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { clearConfigCache } from '#platform/index.js';
import { registerProviderConfig } from '#adapters/index.js';
import { main } from '#surfaces/core/cli/index.js';

registerProviderConfig(); // as the composed entry does: the `terminal` section (terminal.scopeId) is registered there

// SECRET-WRITE: `deckent secret set <NAME>` takes the value only from piped stdin or a no-echo terminal prompt, never from argv; the
// handler (the runtime service client in production) gets the scope, the name and the value; nothing is echoed. Synthetic canaries only.
const CANARY = 'synthetic-canary-8f31c2-not-a-real-key';
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function project(scopeId?: string) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-secret-cli-')); roots.push(root);
  const home = join(root, 'home'), dir = join(root, 'project');
  await mkdir(join(dir, '.deckent'), { recursive: true, mode: 0o700 }); await mkdir(home, { mode: 0o700 });
  if (scopeId) await writeFile(join(dir, '.deckent', 'config.json'), JSON.stringify({ terminal: { scopeId } }), { mode: 0o600 });
  return { root: dir, env: { HOME: home, PATH: process.env['PATH'] ?? '/usr/bin:/bin', DECKENT_LANGUAGE: 'en' } };
}
const capture = () => { const lines: string[] = []; return { lines, text: () => lines.join(''), sink: { write: (text: string) => { lines.push(String(text)); return true; } } }; };
type Call = { readonly scopeId: string; readonly name: string; readonly value?: string };
function handlers(calls: Call[]) {
  return {
    setSecret: async (_root: string, input: { scopeId: string; name: string; value: string }) => {
      calls.push({ scopeId: input.scopeId, name: input.name, value: input.value });
      return { schemaVersion: 1 as const, scopeId: input.scopeId, name: input.name, action: 'set' as const, backend: 'core.secret-store.file@1', removed: null };
    },
    deleteSecret: async (_root: string, input: { scopeId: string; name: string }) => {
      calls.push({ scopeId: input.scopeId, name: input.name });
      return { schemaVersion: 1 as const, scopeId: input.scopeId, name: input.name, action: 'delete' as const, backend: 'core.secret-store.file@1', removed: true };
    },
  };
}
const piped = (text: string | Buffer) => Object.assign(Readable.from([Buffer.from(text)]), { isTTY: false });

it('piped stdin: exactly one trailing newline (LF or CRLF) is dropped, everything else is the value; nothing is echoed', async () => {
  const f = await project('scope');
  for (const [input, expected] of [[`${CANARY}\n`, CANARY], [`${CANARY}\r\n`, CANARY], [CANARY, CANARY], [`${CANARY}\n\n`, `${CANARY}\n`], [` ${CANARY} `, ` ${CANARY} `]] as const) {
    const calls: Call[] = [], out = capture(), err = capture();
    expect(await main(['secret', 'set', 'PROVIDER_TOKEN', '--json'], { root: f.root, env: f.env, stdin: piped(input), stdout: out.sink, stderr: err.sink, ...handlers(calls) })).toBe(0);
    expect(calls).toEqual([{ scopeId: 'scope', name: 'PROVIDER_TOKEN', value: expected }]);
    expect(JSON.parse(out.text())).toMatchObject({ name: 'PROVIDER_TOKEN', action: 'set', backend: 'core.secret-store.file@1' });
    expect(out.text() + err.text()).not.toContain(CANARY);
  }
});

it('argv never carries a value: an extra positional or a value flag is a usage refusal, the handler is not called and nothing is echoed', async () => {
  const f = await project('scope');
  for (const argv of [['secret', 'set', 'PROVIDER_TOKEN', CANARY], ['secret', 'set', 'PROVIDER_TOKEN', '--value', CANARY], ['secret', 'set', `PROVIDER_TOKEN=${CANARY}`],
    ['secret', 'delete', 'PROVIDER_TOKEN', CANARY], ['secret', 'set'], ['secret', 'delete']]) {
    const calls: Call[] = [], out = capture(), err = capture();
    expect(await main([...argv, '--json'], { root: f.root, env: f.env, stdin: piped(CANARY), stdout: out.sink, stderr: err.sink, ...handlers(calls) }), argv.join(' ')).toBe(2);
    expect(calls).toEqual([]);
    expect(out.text() + err.text()).not.toContain(CANARY);
  }
});

it('an empty or oversized piped value is refused before the handler; the scope comes from --scope or terminal.scopeId, else a typed refusal', async () => {
  const f = await project();
  const calls: Call[] = [], err = capture();
  expect(await main(['secret', 'set', 'A', '--scope', 's', '--json'], { root: f.root, env: f.env, stdin: piped(''), stdout: capture().sink, stderr: err.sink, ...handlers(calls) })).toBe(2);
  expect(err.text()).toContain('SECRET_VALUE_INVALID');
  const big = capture();
  expect(await main(['secret', 'set', 'A', '--scope', 's', '--json'], { root: f.root, env: f.env, stdin: piped(Buffer.alloc(65_538, 0x61)), stdout: capture().sink, stderr: big.sink, ...handlers(calls) })).toBe(2);
  expect(big.text()).toContain('SECRET_VALUE_INVALID');
  const noScope = capture();
  expect(await main(['secret', 'set', 'A', '--json'], { root: f.root, env: f.env, stdin: piped(CANARY), stdout: capture().sink, stderr: noScope.sink, ...handlers(calls) })).not.toBe(0);
  expect(noScope.text()).toContain('TERMINAL_SCOPE_REQUIRED');
  expect(calls).toEqual([]);
  expect(await main(['secret', 'delete', 'A', '--scope', 's', '--json'], { root: f.root, env: f.env, stdout: capture().sink, stderr: capture().sink, ...handlers(calls) })).toBe(0);
  expect(calls).toEqual([{ scopeId: 's', name: 'A' }]);
});

it('a terminal gets a no-echo prompt on stderr: raw mode on, backspace edits, Enter ends, raw mode restored; Ctrl-C cancels without a call', async () => {
  const f = await project('scope');
  const tty = (keys: readonly string[]) => {
    const stream = Object.assign(new PassThrough(), { isTTY: true, isRaw: false, modes: [] as boolean[],
      setRawMode(mode: boolean) { stream.modes.push(mode); stream.isRaw = mode; return stream; } });
    setImmediate(() => { for (const key of keys) stream.write(key); });
    return stream;
  };
  const calls: Call[] = [], out = capture(), err = capture();
  const typed = tty(['sy', 'nX', '\x7f', 'th', '\r']);
  expect(await main(['secret', 'set', 'PROVIDER_TOKEN'], { root: f.root, env: f.env, stdin: typed, stdout: out.sink, stderr: err.sink, ...handlers(calls) })).toBe(0);
  expect(calls).toEqual([{ scopeId: 'scope', name: 'PROVIDER_TOKEN', value: 'synth' }]);
  expect(typed.modes).toEqual([true, false]);
  expect(err.text()).toContain('PROVIDER_TOKEN'); expect(out.text() + err.text()).not.toMatch(/syn|nX|th/u);
  const cancelled = tty(['abc', '\x03']), cancelErr = capture();
  expect(await main(['secret', 'set', 'PROVIDER_TOKEN'], { root: f.root, env: f.env, stdin: cancelled, stdout: capture().sink, stderr: cancelErr.sink, ...handlers(calls) })).not.toBe(0);
  expect(cancelled.modes).toEqual([true, false]); expect(calls).toHaveLength(1);
  expect(cancelErr.text()).toContain('SECRET_INPUT_CANCELLED'); expect(cancelErr.text()).not.toContain('abc');
});
