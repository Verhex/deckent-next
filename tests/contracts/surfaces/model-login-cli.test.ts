import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { PassThrough, Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearConfigCache } from '#platform/index.js';
import { modelsCommand, renderHeadlessLogin } from '#surfaces/core/cli-models/index.js';
import type { CliCardRequest } from '#surfaces/core/cli-human/index.js';

// s3c (owner 2026-10-24): `deckent models login` is a person's terminal act: an AI tool, a pipe and --json are refused before the handler runs; a card
// names the exact login dir before the CLI's own sign-in starts. The card is simulated as in model-roles-cli (the Ink view is PTY-proven separately).
const card = vi.hoisted(() => ({ interactive: false, answers: [] as (string | null)[], asked: [] as CliCardRequest[] }));
vi.mock('#surfaces/core/cli-human/index.js', async importOriginal => {
  const real = await importOriginal<typeof import('#surfaces/core/cli-human/index.js')>();
  return { ...real,
    cliMode: (context: Parameters<typeof real.cliMode>[0], json?: boolean) => card.interactive && !json ? { mode: 'interactive' as const, reason: 'tty' as const } : real.cliMode(context, json),
    askCliCard: async (request: CliCardRequest, io: Parameters<typeof real.askCliCard>[1]) => {
      if (!card.interactive) return real.askCliCard(request, io);
      card.asked.push(request); return card.answers.length ? card.answers.shift()! : null;
    } };
});
beforeEach(() => { card.interactive = false; card.answers = []; card.asked = []; });
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function project() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-model-login-cli-')); roots.push(root);
  const home = join(root, 'home'), dir = join(root, 'project');
  await mkdir(join(dir, '.deckent'), { recursive: true, mode: 0o700 }); await mkdir(home, { mode: 0o700 });
  await writeFile(join(dir, '.deckent', 'config.json'), JSON.stringify({}), { mode: 0o600 });
  return { root: dir, env: { HOME: home, DECKENT_GLOBAL_HOME: join(root, 'global'), PATH: process.env['PATH'] ?? '/usr/bin:/bin' } };
}
const capture = () => { let text = ''; return { text: () => text, sink: { write: (chunk: string) => { text += chunk; return true; } } }; };
const tty = () => Object.assign(new PassThrough(), { isTTY: true, setRawMode() { return undefined; } });
const LOGIN = ['models', 'login', '--connection', 'claude-cli-subscription'];
const DIR = '/home/p/.deckent/headless/logins/claude';
function handler(calls: unknown[], view: Record<string, unknown> | null = { configDir: DIR, owned: true, exit: 'completed', signedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' }) {
  return { loginHeadless: async (command: unknown, _options: unknown, confirm: (dir: { configDir: string; owned: boolean }) => Promise<boolean>) => {
    calls.push(['login', command]);
    if (!await confirm({ configDir: DIR, owned: true })) return null;
    calls.push(['signed']); return view;
  } };
}

it('negative: an AI tool, a pipe and --json are refused before the handler runs (AUTHORITY_WITNESS_REQUIRED)', async () => {
  const f = await project(), calls: unknown[] = [];
  for (const [argv, env, stdin] of [[LOGIN, { ...f.env, CLAUDECODE: '1' }, tty()], [LOGIN, f.env, Object.assign(Readable.from([]), { isTTY: false })],
    [[...LOGIN, '--json'], f.env, tty()]] as const)
    await expect(modelsCommand(argv, { root: f.root, env, stdin, stdout: capture().sink, ...handler(calls) } as never)).rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
  card.interactive = true;
  await expect(modelsCommand([...LOGIN, '--json'], { root: f.root, env: f.env, stdin: tty(), stdout: capture().sink, ...handler(calls) } as never)).rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
  await expect(modelsCommand(['models', 'login'], { root: f.root, env: f.env, stdin: tty(), stdout: capture().sink, ...handler(calls) } as never)).rejects.toMatchObject({ code: 'CLI_USAGE' });
  expect(calls).toEqual([]); expect(card.asked).toEqual([]);
});
it('the person sees the exact dir on a card first, then the outcome (kind and plan only); a declined card signs nothing in and exits 1', async () => {
  for (const [lang, title, words] of [['en', 'Sign the Brain in to Claude?', ['Login directory: ' + DIR + " (the Brain's own", 'Deckent captures nothing', 'Signed in: claude.ai (max)']],
    ['tr', "Brain Claude'a giriş yapsın mı?", ['Giriş dizini: ' + DIR + " (Brain'in kendi", 'Deckent gösterdiği hiçbir şeyi almaz', 'Giriş yapıldı: claude.ai (max)']]] as const) {
    const f = await project(), calls: unknown[] = [], out = capture(); card.interactive = true; card.asked = []; card.answers = ['apply'];
    expect(await modelsCommand([...LOGIN, '--sso', '--lang', lang], { root: f.root, env: f.env, stdin: tty(), stdout: out.sink, ...handler(calls) } as never)).toBeUndefined();
    expect(card.asked.map(request => request.title)).toEqual([title]);
    expect(calls).toEqual([['login', { connection: 'claude-cli-subscription', sso: true }], ['signed']]);
    const shown = `${card.asked[0]!.body!.join('\n')}\n${out.text()}`;
    for (const word of words) expect(shown).toContain(word);
  }
  const f = await project(), calls: unknown[] = []; card.interactive = true; card.answers = [null];
  expect(await modelsCommand([...LOGIN, '--config-dir', '/home/p/other'], { root: f.root, env: f.env, stdin: tty(), stdout: capture().sink, stderr: capture().sink, ...handler(calls) } as never)).toBe(1);
  expect(calls).toEqual([['login', { connection: 'claude-cli-subscription', configDir: '/home/p/other' }]]);
});
it('a stopped or unfinished sign-in says so and exits 1; another dir is named as the person\'s own', () => {
  expect(renderHeadlessLogin({ configDir: '/x', owned: false, exit: 'cancelled', signedIn: false, authMethod: null, subscriptionType: null }, 'en')).toBe(
    'Login directory: /x (named by you; not the Brain\'s own).\nThe sign-in was stopped; nothing else was changed.\n'
    + 'Not signed in with a Claude subscription: the Brain cannot use this directory yet. Run the sign-in again.');
  expect(renderHeadlessLogin({ configDir: '/x', owned: true, exit: 'failed', signedIn: false, authMethod: null, subscriptionType: null }, 'tr')).toContain('Giriş tamamlanmadı');
});
it('help names the own dir, the account switch and the refusals', async () => {
  const f = await project(), out = capture();
  await modelsCommand(['models', 'login', '--help'], { root: f.root, env: f.env, stdout: out.sink } as never);
  for (const word of ['deckent models login --connection claude-cli-subscription', 'never in a backup', 'switch account', '--sso', 'an AI tool, MCP, CI, a pipe or --json is refused'])
    expect(out.text()).toContain(word);
});
it('Esc or Ctrl+C while the ChatGPT browser sign-in waits cancels it: the wait is aborted, nothing returns, typed OAUTH_CONNECTION_CANCELLED (FIX8c)', async () => {
  for (const key of ['\u001b', '\u0003']) {
    const f = await project(), stdin = tty(), seen: AbortSignal[] = [], sigint = process.listenerCount('SIGINT'); card.interactive = true; card.answers = ['yes'];
    // The fake browser wait settles only through its signal, as the adapter does (it closes its loopback listener on abort).
    const execute = (_root: string, _request: unknown, _options: unknown, presentation?: { signal?: AbortSignal }) => new Promise<never>((_resolve, reject) => {
      seen.push(presentation!.signal!); presentation!.signal!.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { code: 'OAUTH_CONNECTION_CANCELLED' })));
      setImmediate(() => stdin.write('\u001b[B')); setTimeout(() => stdin.write(key), 20);
    });
    await expect(modelsCommand(['models', 'login', '--connection', 'chatgpt-login', '--scope', 'scope'], { root: f.root, env: f.env, stdin, stdout: capture().sink,
      siwc: { connection: 'chatgpt-login', execute } } as never)).rejects.toMatchObject({ code: 'OAUTH_CONNECTION_CANCELLED' });
    expect(seen).toHaveLength(1); expect(seen[0]!.aborted).toBe(true); expect(process.listenerCount('SIGINT')).toBe(sigint);
  }
});
