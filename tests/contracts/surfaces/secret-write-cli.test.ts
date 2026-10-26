import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { PassThrough, Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { clearConfigCache } from '#platform/index.js';
import { registerProviderConfig } from '#adapters/index.js';
import { main } from '#surfaces/core/cli/index.js';
import { readPiped } from '#surfaces/core/cli-admin/index.js';

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
  return { root: dir, env: { HOME: home, USERPROFILE: home, PATH: process.env['PATH'] ?? '/usr/bin:/bin', DECKENT_LANGUAGE: 'en' } };
}
const capture = () => { const lines: string[] = []; return { lines, text: () => lines.join(''), sink: { write: (text: string) => { lines.push(String(text)); return true; } } }; };
/** A person's terminal on stdout too (C-ADMIN/SEC-1: a key is stored only from a terminal; stdin alone being a TTY is not enough). */
const screen = () => { const out = capture(); return { ...out, sink: Object.assign(out.sink, { isTTY: true }) }; };
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

it('piped stdin (readPiped, still used by backup): exactly one trailing newline (LF or CRLF) is dropped, everything else is the value', async () => {
  for (const [input, expected] of [[`${CANARY}\n`, CANARY], [`${CANARY}\r\n`, CANARY], [CANARY, CANARY], [`${CANARY}\n\n`, `${CANARY}\n`], [` ${CANARY} `, ` ${CANARY} `]] as const) {
    expect(await readPiped(piped(input))).toBe(expected);
  }
  await expect(readPiped(piped(Buffer.alloc(65_539, 0x61).toString()))).rejects.toMatchObject({ code: 'SECRET_VALUE_INVALID' });
});

it('SEC-1 lead note: a piped secret set is refused before stdin is read (typed, exit 1); nothing is sent, stored or echoed', async () => {
  const f = await project('scope');
  for (const argv of [['secret', 'set', 'PROVIDER_TOKEN', '--scope', 'scope', '--json'], ['secret', 'set', 'PROVIDER_TOKEN']]) {
    let reads = 0; const stdin = Object.assign(new Readable({ read() { reads++; this.push(Buffer.from(`${CANARY}\n`)); this.push(null); } }), { isTTY: false });
    const calls: Call[] = [], out = capture(), err = capture();
    expect(await main(argv, { root: f.root, env: f.env, stdin, stdout: out.sink, stderr: err.sink, ...handlers(calls) }), argv.join(' ')).toBe(1);
    expect(err.text()).toContain('SECRET_SET_TERMINAL_REQUIRED'); expect(reads).toBe(0); expect(stdin.readableEnded).toBe(false);
    expect(calls).toEqual([]); expect(out.text() + err.text()).not.toContain(CANARY);
  }
  // An AI agent at a real terminal is no person: refused the same way.
  const agent = capture(), tty = Object.assign(new PassThrough(), { isTTY: true, setRawMode() { return tty; } });
  expect(await main(['secret', 'set', 'PROVIDER_TOKEN', '--scope', 'scope'], { root: f.root, env: { ...f.env, CLAUDECODE: '1' }, stdin: tty, stdout: screen().sink, stderr: agent.sink, ...handlers([]) })).toBe(1);
  expect(agent.text()).toContain('SECRET_SET_TERMINAL_REQUIRED');
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

it('an empty typed value is refused before the handler; the scope comes from --scope, else a typed refusal (C-ADMIN: no silent default)', async () => {
  const f = await project();
  const tty = (keys: readonly string[]) => { const stream = Object.assign(new PassThrough(), { isTTY: true, setRawMode() { return stream; } }); setImmediate(() => { for (const key of keys) stream.write(key); }); return stream; };
  const calls: Call[] = [], err = capture();
  // PRE-8 v2: `set` names its vault; with --json there is no card, so no vault is a typed usage refusal before the value is read.
  const noVault = capture();
  expect(await main(['secret', 'set', 'A', '--scope', 's', '--json'], { root: f.root, env: f.env, stdin: tty([`${CANARY}\r`]), stdout: screen().sink, stderr: noVault.sink, ...handlers(calls) })).toBe(2);
  expect(noVault.text()).toContain('SECRET_VAULT_REQUIRED'); expect(noVault.text()).not.toContain(CANARY);
  expect(await main(['secret', 'set', 'A', '--main', '--scope', 's', '--json'], { root: f.root, env: f.env, stdin: tty(['\r']), stdout: screen().sink, stderr: err.sink, ...handlers(calls) })).toBe(2);
  expect(err.text()).toContain('SECRET_VALUE_INVALID');
  const noScope = capture();
  expect(await main(['secret', 'set', 'A', '--main', '--json'], { root: f.root, env: f.env, stdin: tty([`${CANARY}\r`]), stdout: screen().sink, stderr: noScope.sink, ...handlers(calls) })).not.toBe(0);
  expect(noScope.text()).toMatch(/SCOPE_REQUIRED/u); expect(noScope.text()).not.toContain(CANARY);
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
  const calls: Call[] = [], out = screen(), err = capture();
  const typed = tty(['sy', 'nX', '\x7f', 'th', '\r']);
  expect(await main(['secret', 'set', 'PROVIDER_TOKEN', '--main', '--scope', 'scope'], { root: f.root, env: f.env, stdin: typed, stdout: out.sink, stderr: err.sink, ...handlers(calls) })).toBe(0);
  expect(calls).toEqual([{ scopeId: 'scope', name: 'PROVIDER_TOKEN', value: 'synth' }]);
  expect(typed.modes).toEqual([true, false]);
  expect(err.text()).toContain('PROVIDER_TOKEN'); expect(out.text() + err.text()).not.toMatch(/syn|nX|th/u);
  // A pasted multi-byte character split across two reads is one character, not two replacement characters.
  const bytes = Buffer.from('şé', 'utf8'), split = tty([]);
  setImmediate(() => { split.write(bytes.subarray(0, 1)); split.write(bytes.subarray(1, 3)); split.write(bytes.subarray(3)); split.write('\r'); });
  expect(await main(['secret', 'set', 'PROVIDER_TOKEN', '--main', '--scope', 'scope'], { root: f.root, env: f.env, stdin: split, stdout: screen().sink, stderr: capture().sink, ...handlers(calls) })).toBe(0);
  expect(calls.at(-1)).toEqual({ scopeId: 'scope', name: 'PROVIDER_TOKEN', value: 'şé' });
  const cancelled = tty(['abc', '\x03']), cancelErr = capture();
  expect(await main(['secret', 'set', 'PROVIDER_TOKEN', '--main', '--scope', 'scope'], { root: f.root, env: f.env, stdin: cancelled, stdout: screen().sink, stderr: cancelErr.sink, ...handlers(calls) })).not.toBe(0);
  expect(cancelled.modes).toEqual([true, false]); expect(calls).toHaveLength(2);
  expect(cancelErr.text()).toContain('SECRET_INPUT_CANCELLED'); expect(cancelErr.text()).not.toContain('abc');
});

it('PRE-8 v2: grant/revoke/handover need a person terminal before any handler; set --project goes to the project vault; list renders the one inventory', async () => {
  const f = await project('scope'), seen: unknown[] = [];
  const project_ = { setProjectSecret: async (_root: string, input: { scopeId: string; name: string; value: string | null }) => { seen.push({ project: input }); return { name: input.name, project: '/p', removed: false }; },
    changeSecretGrant: async (_root: string, input: { scopeId: string; name: string; action: string }) => { seen.push({ grant: input }); return { name: input.name, project: '/p', granted: input.action === 'grant', revision: 1 }; },
    handOverSecrets: async (_root: string, input: { scopeId: string }) => { seen.push({ handover: input }); return { project: '/p', handedOverAtMs: 1 }; },
    inspectSecretInventory: async (_root: string, input: { scopeId: string; all: boolean }) => { seen.push({ list: input }); return { schemaVersion: 1 as const, project: '/p', mainStore: 'core.secret-store.env@1', all: input.all,
      rows: [{ name: 'DECKENT_ANTHROPIC_KEY', vault: 'main' as const, project: '/p', usedBy: ['claude@1'], deck: 'undeclared' as const, grant: { state: 'none' as const }, presence: 'unverified' as const }],
      findings: [{ kind: 'grant-required' as const, name: 'DECKENT_ANTHROPIC_KEY', project: '/p' }] }; } };
  for (const argv of [['secret', 'grant', 'K', '--scope', 'scope'], ['secret', 'revoke', 'K', '--scope', 'scope'], ['secret', 'handover', '--scope', 'scope']]) {
    const err = capture();
    expect(await main(argv, { root: f.root, env: f.env, stdin: piped(''), stdout: capture().sink, stderr: err.sink, ...handlers([]), ...project_ }), argv.join(' ')).not.toBe(0);
    expect(err.text(), argv.join(' ')).toContain('AUTHORITY_WITNESS_REQUIRED');
  }
  expect(seen).toEqual([]);
  const tty = (keys: readonly string[]) => { const stream = Object.assign(new PassThrough(), { isTTY: true, setRawMode() { return stream; } }); setImmediate(() => { for (const key of keys) stream.write(key); }); return stream; };
  const granted = capture();
  expect(await main(['secret', 'grant', 'K', '--scope', 'scope', '--json'], { root: f.root, env: f.env, stdin: tty([]), stdout: Object.assign(granted.sink, { isTTY: true }), stderr: capture().sink, ...handlers([]), ...project_ })).toBe(0);
  expect(JSON.parse(granted.text())).toMatchObject({ name: 'K', granted: true });
  expect(await main(['secret', 'set', 'OWN', '--project', '--scope', 'scope', '--json'], { root: f.root, env: f.env, stdin: tty([`${CANARY}\r`]), stdout: screen().sink, stderr: capture().sink, ...handlers([]), ...project_ })).toBe(0);
  const listed = capture();
  expect(await main(['secret', 'list'], { root: f.root, env: f.env, stdout: listed.sink, stderr: capture().sink, ...handlers([]), ...project_ })).toBe(0);
  expect(listed.text()).toContain('DECKENT_ANTHROPIC_KEY'); expect(listed.text()).toContain('no grant');
  expect(listed.text()).toContain('deckent secret grant DECKENT_ANTHROPIC_KEY --scope <scope>');
  expect(seen).toEqual([{ grant: { scopeId: 'scope', name: 'K', action: 'grant' } }, { project: { scopeId: 'scope', name: 'OWN', value: CANARY } }, { list: { scopeId: 'scope', all: false } }]);
});

it('U1 main-vault custody refusal is shown before the hidden reader starts or any key is sent', async () => {
  const f = await project('scope'), out = screen(), err = capture(), calls: Call[] = [];
  let raw = 0, prepared = 0;
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() { raw++; return stdin; } });
  expect(await main(['secret', 'set', 'PROVIDER_TOKEN', '--main', '--scope', 'scope'], {
    root: f.root, env: f.env, stdin, stdout: out.sink, stderr: err.sink, ...handlers(calls),
    prepareMainSecret: async () => { prepared++; return { state: 'refused', backend: null, code: 'SECRET_STORE_UNSAFE', path: '/synthetic/private-root' }; },
  })).toBe(1);
  expect(prepared).toBe(1); expect(raw).toBe(0); expect(calls).toEqual([]);
  expect(err.text()).toContain('SECRET_STORE_UNSAFE'); expect(err.text()).toContain('/synthetic/private-root');
});
