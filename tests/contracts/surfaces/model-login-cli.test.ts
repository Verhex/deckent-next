import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as files from 'node:fs/promises';
import { PassThrough, Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearConfigCache, DeckentError, ErrorRegistry, productResourcePath, reportFatal, resolveProductPaths } from '#platform/index.js';
import * as processRunner from '#adapters/core/process-runner/index.js';
import { nativeCliHeadless } from '#adapters/core/native-cli-registry/index.js';
import { loginConfiguredHeadless } from '#composition/core/model-connect/index.js';
import * as modelInvocation from '#composition/core/model-invocation/index.js';
import { main } from '#surfaces/core/cli/index.js';
import { modelsCommand, renderHeadlessLogin } from '#surfaces/core/cli-models/index.js';
import type { CliCardRequest } from '#surfaces/core/cli-human/index.js';

// s3c (owner 2026-10-24): `deckent models login` is a person's terminal act: an AI tool, a pipe and --json are refused before the handler runs; a card
// names the exact login dir before the CLI's own sign-in starts. The card is simulated as in model-roles-cli (the Ink view is PTY-proven separately).
const card = vi.hoisted(() => ({ interactive: false, answers: [] as (string | null)[], asked: [] as CliCardRequest[] }));
vi.mock('node:fs/promises', async original => ({ ...await original<typeof files>() }));
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
async function project(prefix = 'deckent-model-login-cli-') {
  const root = await mkdtemp(join(tmpdir(), prefix)); roots.push(root);
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

it.skipIf(process.platform !== 'linux')('keeps private paths out of real interactive sign-in lock and record failures', async () => {
  const launcher = await files.lstat(process.execPath, { bigint: true });
  const isolation = vi.spyOn(modelInvocation, 'configuredBubblewrap').mockReturnValue(async () => ({
    status: 'available', rejected: [], restriction: null, detail: null,
    launcher: { source: 'system', path: process.execPath, version: '0.13.0', sha256: null, overlay: false,
      identity: [launcher.dev, launcher.ino, launcher.size, launcher.mtimeNs, launcher.ctimeNs].join(':') },
  }));
  const sentinel = '/private/sign-in-fixture/never-share-2f62';
  const ioFailure = () => Object.assign(new Error(`EIO: fixture failed at ${sentinel}`), { code: 'EIO' });
  const isRecordTemp = (path: unknown) => typeof path === 'string' && /\.login\.[^/]+\.tmp$/u.test(path);
  const isLock = (path: unknown) => typeof path === 'string' && path.endsWith('.lock');
  const isLockDirectory = (path: unknown) => typeof path === 'string' && path.endsWith('/login-locks');
  const isStatusRun = (path: unknown) => typeof path === 'string' && /\/headless\/login-[a-f0-9]+\/run$/u.test(path);
  const isScratch = (path: unknown) => typeof path === 'string' && /\/headless\/login-[a-f0-9]+\/login-copy-/u.test(path);
  try {
    for (const [boundary, localExit, expected] of [
      ['lock directory create', 0, null], ['lock directory inspect', 0, null], ['marker write', 0, null], ['marker remove', 0, null], ['marker remove', 130, null],
      ['record write', 0, ['The sign-in command completed.', 'Giriş komutu tamamlandı.']],
      ['record rename', 130, ['The sign-in command was interrupted.', 'Giriş komutu kesildi.']],
      ['record write', 1, ['The sign-in command ended with a failure.', 'Giriş komutu başarısız sonuçlandı.']],
      ['status working directory list', 0, null], ['status working directory cleanup', 0, null],
      ['realm scratch create', 0, null], ['realm scratch cleanup', 0, null], ['realm response invalid', 0, null],
      ['realm response unverified', 0, null],
    ] as const) {
      const f = await project('g3-'), executable = join(f.root, 'fixture-provider');
      const scratch = boundary.startsWith('realm scratch'), command = scratch ? ['models', 'login', '--connection', 'codex-cli-subscription'] : LOGIN;
      const createRunEntry = boundary === 'status working directory cleanup' ? 'echo fixture > ./login-fixture-entry\n' : '';
      await writeFile(executable, `#!/bin/sh\n${createRunEntry}exit ${localExit}\n`, { mode: 0o700 });
      card.interactive = true; card.answers = ['apply']; card.asked = [];
      const original = { mkdir: files.mkdir, mkdtemp: files.mkdtemp, lstat: files.lstat, readdir: files.readdir, write: files.writeFile, remove: files.rm, rename: files.rename };
      const failure = ioFailure(), hit = vi.fn(() => { throw failure; });
      const mkdirSpy = vi.spyOn(files, 'mkdir').mockImplementation((async (...args: Parameters<typeof files.mkdir>) => {
        if (boundary === 'lock directory create' && isLockDirectory(args[0])) hit();
        return original.mkdir(...args);
      }) as typeof files.mkdir);
      const lstatSpy = vi.spyOn(files, 'lstat').mockImplementation((async (...args: Parameters<typeof files.lstat>) => {
        if (boundary === 'lock directory inspect' && isLockDirectory(args[0])) hit();
        return original.lstat(...args);
      }) as typeof files.lstat);
      const writeSpy = vi.spyOn(files, 'writeFile').mockImplementation(async (...args) => {
        if (boundary === 'marker write' && isLock(args[0]) || boundary === 'record write' && isRecordTemp(args[0])) hit();
        return original.write(...args);
      });
      const removeSpy = vi.spyOn(files, 'rm').mockImplementation(async (...args) => {
        if (boundary === 'marker remove' && isLock(args[0])) hit();
        if (boundary === 'status working directory cleanup' && typeof args[0] === 'string' && args[0].endsWith('/login-fixture-entry')) hit();
        if (boundary === 'realm scratch cleanup' && isScratch(args[0])) hit();
        return original.remove(...args);
      });
      const renameSpy = vi.spyOn(files, 'rename').mockImplementation(async (...args) => {
        if (boundary === 'record rename' && isRecordTemp(args[0])) hit();
        return original.rename(...args);
      });
      const readdirSpy = vi.spyOn(files, 'readdir').mockImplementation((async (...args: Parameters<typeof files.readdir>) => {
        if (boundary === 'status working directory list' && isStatusRun(args[0])) hit();
        return original.readdir(...args);
      }) as typeof files.readdir);
      const mkdtempSpy = vi.spyOn(files, 'mkdtemp').mockImplementation((async (...args: Parameters<typeof files.mkdtemp>) => {
        if (boundary === 'realm scratch create' && isScratch(args[0])) hit();
        return original.mkdtemp(...args);
      }) as typeof files.mkdtemp);
      const runner = scratch || boundary.startsWith('realm response') ? vi.spyOn(processRunner, 'runNodeProcess').mockImplementation(async input => ({
        schemaVersion: 1, requestId: input.requestId, started: true, reason: 'exit', exitCode: 0, signal: null,
        stdoutBase64: '', stderrBase64: Buffer.from('Logged in using ChatGPT').toString('base64'), stdoutTruncated: false, stderrTruncated: false, durationMs: 1,
      })) : undefined;
      if (boundary === 'realm response unverified') runner!.mockImplementation(async () => { hit(); throw failure; });
      if (boundary === 'realm response invalid') runner!.mockImplementation(async () => {
        hit.mockImplementationOnce(() => undefined);
        hit();
        const error = new processRunner.ProcessRunnerError('PROCESS_RUNNER_RESPONSE_INVALID');
        error.message = sentinel;
        throw error;
      });
      try {
        let sharedError: unknown;
        const cliError = capture(), cliOutput = capture();
        let observed: Awaited<ReturnType<typeof loginConfiguredHeadless>> | undefined;
        expect(await main([...command, '--executable', executable], { ...f, stdin: tty(), stdout: cliOutput.sink, stderr: cliError.sink,
          loginHeadless: (command, options, confirm) => loginConfiguredHeadless(command, options, confirm, { attest: async () => true })
            .then(view => { observed = view; if (view?.cleanupIssue || view?.statusIssue) sharedError = view.cleanupIssue ?? view.statusIssue; return view; })
            .catch((error: unknown) => { sharedError = error; throw error; }),
        })).toBe(1);
        expect(hit, boundary).toHaveBeenCalledOnce();
        if (boundary === 'marker remove' || boundary === 'status working directory list') {
          const interrupted = localExit === 130;
          const en = interrupted ? 'The sign-in command was interrupted.' : 'The sign-in command completed.';
          const tr = interrupted ? 'Giriş komutu kesildi.' : 'Giriş komutu tamamlandı.';
          expect.soft(cliOutput.text() + cliError.text(), boundary).toContain(en);
          expect.soft(observed, boundary).toMatchObject({ exit: interrupted ? 'cancelled' : 'completed', signedIn: false });
          if (observed) expect(renderHeadlessLogin(observed, 'tr', command[3]!)).toContain(tr);
        }
        expect(card.asked[0]?.body?.join('\n')).toContain(f.env.DECKENT_GLOBAL_HOME);
        expect.soft(sharedError, boundary).toBeInstanceOf(DeckentError);
        const typed = sharedError as DeckentError;
        expect.soft(JSON.stringify({ message: typed.message, params: typed.params, cause: typed.cause }), boundary).not.toContain(sentinel);
        expect.soft(cliError.text(), boundary).not.toContain(sentinel);
        if (expected) {
          expect.soft(typed.localize?.('en').message).toBe(`${expected[0]} deckent could not save the outcome. The subscription state in this directory was not verified.`);
          expect.soft(typed.localize?.('tr').message).toBe(`${expected[1]} deckent sonucu kaydedemedi. Bu dizindeki abonelik durumu doğrulanmadı.`);
        }
        if (boundary === 'realm response invalid') {
          expect.soft(typed.localize?.('en').message).toBe('The isolated process result failed validation.');
          expect.soft(typed.localize?.('tr').message).toBe('Yalıtılmış süreç sonucu doğrulamayı geçemedi.');
        }
        if (boundary === 'realm response unverified') {
          expect.soft(typed.localize?.('en').message).toBe('The isolated process result could not be determined.');
          expect.soft(typed.localize?.('tr').message).toBe('Yalıtılmış sürecin sonucu belirlenemedi.');
        }
        const crashes = productResourcePath(resolveProductPaths(f.root, { env: f.env }), 'crashes');
        expect.soft(await files.readdir(crashes).catch(() => []), boundary).toEqual([]);
        const portable = capture();
        await reportFatal(sharedError, { ...f, json: true, stderr: portable.sink });
        expect.soft(portable.text(), boundary).not.toContain(sentinel);
        expect.soft(await files.readdir(crashes).catch(() => []), boundary).toEqual([]);
      } finally {
        mkdirSpy.mockRestore(); lstatSpy.mockRestore(); writeSpy.mockRestore(); removeSpy.mockRestore(); renameSpy.mockRestore();
        readdirSpy.mockRestore(); mkdtempSpy.mockRestore(); runner?.mockRestore();
      }
    }
  } finally { isolation.mockRestore(); }
});

it.skipIf(process.platform !== 'linux')('interactive sign-in keeps the measured status limit when realm cleanup fails', async () => {
  const f = await project('g3-'), executable = join(f.root, 'fixture-provider');
  await writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const launcher = await files.lstat(process.execPath, { bigint: true });
  const isolation = vi.spyOn(modelInvocation, 'configuredBubblewrap').mockReturnValue(async () => ({
    status: 'available', rejected: [], restriction: null, detail: null,
    launcher: { source: 'system', path: process.execPath, version: '0.13.0', sha256: null, overlay: false,
      identity: [launcher.dev, launcher.ino, launcher.size, launcher.mtimeNs, launcher.ctimeNs].join(':') },
  }));
  const exitCode = nativeCliHeadless('codex-jsonl')!.headless.isolation.limits.exits['cpu-time'];
  const runner = vi.spyOn(processRunner, 'runNodeProcess').mockImplementation(async input => {
    return { schemaVersion: 1, requestId: input.requestId, started: true, reason: 'exit', exitCode, signal: null,
      stdoutBase64: '', stderrBase64: '', stdoutTruncated: false, stderrTruncated: false, durationMs: 1 };
  });
  const remove = files.rm;
  const cleanup = vi.spyOn(files, 'rm').mockImplementation(async (...args) => {
    if (typeof args[0] === 'string' && /\/login-copy-[^/]+$/u.test(args[0])) throw new Error('fixture cleanup failure');
    return remove(...args);
  });
  try {
    const view = await loginConfiguredHeadless({ connection: 'codex-cli-subscription', executable }, { env: f.env },
      async () => true, { attest: async () => true });
    expect(view).toMatchObject({ exit: 'completed', signedIn: false, statusIssue: { code: 'HEADLESS_LIMIT_REACHED', params: { limit: 'cpu-time' } } });
    expect(renderHeadlessLogin(view!, 'en', 'codex-cli-subscription')).toContain('CPU');
    expect(renderHeadlessLogin(view!, 'tr', 'codex-cli-subscription')).toContain('CPU');
    expect(cleanup.mock.calls.some(([path]) => typeof path === 'string' && /\/login-copy-[^/]+$/u.test(path))).toBe(true);
  } finally { cleanup.mockRestore(); runner.mockRestore(); isolation.mockRestore(); }
});

it.skipIf(process.platform !== 'linux')('a positive status with nonzero exit cannot advance sign-in when the status lock cleanup fails', async () => {
  const f = await project('g3-'), executable = join(f.root, 'fixture-provider');
  await writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const launcher = await files.lstat(process.execPath, { bigint: true });
  const isolation = vi.spyOn(modelInvocation, 'configuredBubblewrap').mockReturnValue(async () => ({
    status: 'available', rejected: [], restriction: null, detail: null,
    launcher: { source: 'system', path: process.execPath, version: '0.13.0', sha256: null, overlay: false,
      identity: [launcher.dev, launcher.ino, launcher.size, launcher.mtimeNs, launcher.ctimeNs].join(':') },
  }));
  const runner = vi.spyOn(processRunner, 'runNodeProcess').mockImplementation(async input => ({
    schemaVersion: 1, requestId: input.requestId, started: true, reason: 'exit', exitCode: 1, signal: null,
    stdoutBase64: Buffer.from(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty',
      configDirectory: input.env['CLAUDE_CONFIG_DIR'] })).toString('base64'),
    stderrBase64: '', stdoutTruncated: false, stderrTruncated: false, durationMs: 1,
  }));
  const remove = files.rm;
  const cleanup = vi.spyOn(files, 'rm').mockImplementation(async (...args) => {
    if (typeof args[0] === 'string' && args[0].endsWith('.lock') && runner.mock.calls.length) throw new Error('fixture status-lock cleanup failure');
    return remove(...args);
  });
  try {
    card.interactive = true; card.answers = ['apply'];
    const out = capture(), errors = capture();
    expect(await modelsCommand([...LOGIN, '--executable', executable], { root: f.root, env: f.env, stdin: tty(),
      stdout: out.sink, stderr: errors.sink, loginHeadless: (command, options, confirm) =>
        loginConfiguredHeadless(command, options, confirm, { attest: async () => true }) })).toBe(1);
    const text = out.text() + errors.text();
    expect(text).toContain('The sign-in command completed.');
    expect(text).toContain('The status check returned a nonzero exit code.');
    expect(text).toContain('The deckent sign-in lock marker could not be removed.');
    expect(text).not.toContain('Connect the Brain');
    expect(runner).toHaveBeenCalledOnce();
  } finally { cleanup.mockRestore(); runner.mockRestore(); isolation.mockRestore(); }
});

it('reports a relative login directory separately from an unresolved absolute directory in both languages', async () => {
  const f = await project();
  for (const [directory, en, tr] of [
    ['relative-login-dir', 'The login directory must be specified with an absolute path.', 'Oturum açma dizini mutlak bir yolla belirtilmeli.'],
    [join(f.root, 'missing-login-dir'), 'The login directory path could not be resolved.', 'Oturum açma dizininin yolu çözümlenemedi.'],
  ] as const) {
    const error = await loginConfiguredHeadless({ connection: 'claude-cli-subscription', configDir: directory }, { env: f.env },
      async () => { throw new Error('confirmation reached before directory validation'); }, { attest: async () => true })
      .catch((failure: unknown) => failure) as DeckentError;
    expect(error).toBeInstanceOf(DeckentError);
    expect.soft(error.localize?.('en').message).toBe(en);
    expect.soft(error.localize?.('tr').message).toBe(tr);
    expect(JSON.stringify(error)).not.toContain(directory);
  }
});

it('the person sees the exact dir on a card first, then the outcome (kind and plan only); a declined card signs nothing in and exits 1', async () => {
  for (const [lang, title, words] of [['en', 'Sign the Brain in for claude-cli-subscription?', ['Login directory: ' + DIR + " (the Brain's own", 'deckent captures nothing', 'Signed in: claude.ai (max)']],
    ['tr', 'Brain claude-cli-subscription için giriş yapsın mı?', ['Giriş dizini: ' + DIR + " (Brain'in kendi", 'deckent gösterdiği hiçbir şeyi almaz', 'Giriş yapıldı: claude.ai (max)']]] as const) {
    const f = await project(), calls: unknown[] = [], out = capture(); card.interactive = true; card.asked = []; card.answers = ['apply'];
    expect(await modelsCommand([...LOGIN, '--sso', '--lang', lang], { root: f.root, env: f.env, stdin: tty(), stdout: out.sink, ...handler(calls) } as never)).toBeUndefined();
    expect(card.asked.map(request => request.title)).toEqual([title]);
    expect(calls).toEqual([['login', { connection: 'claude-cli-subscription', sso: true }], ['signed']]);
    const shown = `${card.asked[0]!.body!.join('\n')}\n${out.text()}`;
    for (const word of words) expect(shown).toContain(word);
    expect(out.text()).toMatch(/^\n/u); // PV 2e: the result starts on its own line after the CLI's own sign-in output
  }
  const f = await project(), calls: unknown[] = []; card.interactive = true; card.answers = [null];
  expect(await modelsCommand([...LOGIN, '--config-dir', '/home/p/other'], { root: f.root, env: f.env, stdin: tty(), stdout: capture().sink, stderr: capture().sink, ...handler(calls) } as never)).toBe(1);
  expect(calls).toEqual([['login', { connection: 'claude-cli-subscription', configDir: '/home/p/other' }]]);
  // Codex (owner 2026-10-31): the card and the result name the connection, never another CLI.
  const codex = await project(), out = capture(); card.interactive = true; card.asked = []; card.answers = ['apply'];
  expect(await modelsCommand(['models', 'login', '--connection', 'codex-cli-subscription'], { root: codex.root, env: codex.env, stdin: tty(), stdout: out.sink,
    ...handler([], { configDir: DIR, owned: true, exit: 'completed', signedIn: true, authMethod: 'chatgpt', subscriptionType: null }) } as never)).toBeUndefined();
  expect(card.asked.map(request => request.title)).toEqual(['Sign the Brain in for codex-cli-subscription?']);
  expect(out.text()).toContain('Signed in: chatgpt. Connect the Brain with `deckent models connect --connection codex-cli-subscription ...`');
  expect(`${card.asked[0]!.body!.join('\n')}\n${out.text()}`).not.toMatch(/Claude/u);
});
it('a stopped or unfinished sign-in says so and exits 1; another dir is named as the person\'s own', () => {
  expect(renderHeadlessLogin({ configDir: '/x', owned: false, exit: 'cancelled', signedIn: false, authMethod: null, subscriptionType: null }, 'en', 'claude-cli-subscription')).toBe(
    'Login directory: /x (named by you; not the Brain\'s own).\nThe sign-in command was interrupted.\n'
    + 'A subscription was not confirmed for claude-cli-subscription.');
  expect(renderHeadlessLogin({ configDir: '/x', owned: true, exit: 'failed', signedIn: false, authMethod: null, subscriptionType: null }, 'tr', 'claude-cli-subscription')).toContain('Giriş tamamlanmadı');
  // NF-8: a failed attempt over an existing login never says "Signed in".
  const kept = renderHeadlessLogin({ configDir: '/x', owned: true, exit: 'failed', signedIn: true, authMethod: 'claude.ai', subscriptionType: null }, 'en', 'claude-cli-subscription');
  expect(kept).toContain('The status check reported a subscription in this directory: claude.ai'); expect(kept).not.toContain('Signed in:');
});
it('K3: an explicit login method follows the same person card; CI, AI and pipe cannot use it', async () => {
  const f = await project(), calls: unknown[] = [], argv = ['models', 'login', '--connection', 'codex-cli-subscription', '--login-method', 'device-auth'];
  for (const env of [{ ...f.env, CI: 'true' }, { ...f.env, CODEX_THREAD_ID: 'agent' }])
    await expect(modelsCommand(argv, { root: f.root, env, stdin: tty(), stdout: capture().sink, ...handler(calls) } as never)).rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
  await expect(modelsCommand(argv, { root: f.root, env: f.env, stdin: Readable.from([]), stdout: capture().sink, ...handler(calls) } as never)).rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
  expect(calls).toEqual([]); expect(card.asked).toEqual([]);
  card.interactive = true; card.answers = ['apply'];
  expect(await modelsCommand(argv, { root: f.root, env: f.env, stdin: tty(), stdout: capture().sink, ...handler(calls) } as never)).toBeUndefined();
  expect(calls).toEqual([['login', { connection: 'codex-cli-subscription', loginMethod: 'device-auth' }], ['signed']]);
  expect(card.asked).toHaveLength(1);
  await expect(modelsCommand([...argv, '--login-method', 'browser'], { root: f.root, env: f.env } as never)).rejects.toMatchObject({ code: 'CLI_USAGE' });
});
it('help names the own dir, the account switch and the refusals', async () => {
  const f = await project(), out = capture(), tr = capture(), calls: unknown[] = [];
  const example = 'deckent models login \\\n  --connection codex-cli-subscription --login-method device-auth';
  await modelsCommand(['models', 'login', '--help', '--lang', 'en'], { root: f.root, env: f.env, stdout: out.sink, ...handler(calls) } as never);
  await modelsCommand(['models', 'login', '--help', '--lang', 'tr'], { root: f.root, env: f.env, stdout: tr.sink, ...handler(calls) } as never);
  expect(calls).toEqual([]); expect(card.asked).toEqual([]);
  expect.soft(out.text()).toContain('Sign in to Codex with a device code: `' + example + '`.');
  expect.soft(tr.text()).toContain('Cihaz koduyla Codex’e giriş: `' + example + '`.');
  for (const word of ['deckent models login --connection claude-cli-subscription', 'codex-cli-subscription', 'deckent models login --connection chatgpt-login', 'always prints the sign-in link',
    'never in a backup', 'switch account', '--sso', 'an AI tool, MCP, CI, a pipe or --json is refused'])
    expect(out.text()).toContain(word);
  // FIX9: prose wraps at the width, never at a hard break in mid-sentence (a short row followed by its own continuation).
  const rows = out.text().split('\n');
  for (const [index, row] of rows.entries()) if (!/[.\]:]$/u.test(row) && /^[a-z(]/u.test(rows[index + 1] ?? '')) expect(row.length, row).toBeGreaterThan(55);
});
it('Esc or Ctrl+C while the ChatGPT browser sign-in waits cancels it: the wait is aborted, a cancellation line (not an error), exit 1 (FIX8c, FIX9)', async () => {
  for (const key of ['\u001b', '\u0003']) {
    const f = await project(), stdin = tty(), seen: AbortSignal[] = [], sigint = process.listenerCount('SIGINT'); card.interactive = true; card.answers = ['yes'];
    // The fake browser wait settles only through its signal, as the adapter does (it closes its loopback listener on abort).
    const execute = (_root: string, _request: unknown, _options: unknown, presentation?: { signal?: AbortSignal }) => new Promise<never>((_resolve, reject) => {
      seen.push(presentation!.signal!); presentation!.signal!.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { code: 'OAUTH_CONNECTION_CANCELLED' })));
      setImmediate(() => stdin.write('\u001b[B')); setTimeout(() => stdin.write(key), 20);
    });
    const out = capture();
    expect(await modelsCommand(['models', 'login', '--connection', 'chatgpt-login', '--scope', 'scope'], { root: f.root, env: f.env, locale: 'en', stdin, stdout: out.sink, stderr: out.sink,
      siwc: { connection: 'chatgpt-login', execute } } as never)).toBe(1);
    expect(out.text()).toContain('ChatGPT action cancelled.'); expect(out.text()).not.toMatch(/Error|OAUTH_CONNECTION_CANCELLED/u);
    expect(seen).toHaveLength(1); expect(seen[0]!.aborted).toBe(true); expect(process.listenerCount('SIGINT')).toBe(sigint);
  }
});

it('F1-MSG: the subscription CLI explains the failed store check and reserves reconnect advice for a connection record mismatch', async () => {
  const f = await project(); card.interactive = true;
  for (const [locale, unverified, reconnect] of [
    ['en', 'Subscription access is unavailable because deckent could not verify the personal store. Disconnecting and reconnecting does not fix the store verification problem. Ask the installation administrator to check the personal store folder, its backing device and its binding record.',
      "The connection's saved binding does not match the verified personal store. Disconnect the connection and then connect it again from your own terminal."],
    ['tr', 'deckent kişisel depoyu doğrulayamadığı için aboneliğe erişilemiyor. Bağlantıyı kesip yeniden bağlamak depo doğrulama sorununu gidermez. Kurulum yöneticisinden kişisel depo klasörünü, bağlı olduğu aygıtı ve bağ kaydını kontrol etmesini isteyin.',
      'Bağlantının kayıtlı bağı, doğrulanan kişisel depoyla eşleşmiyor. Bağlantıyı kesin ve kendi terminalinizden yeniden bağlanın.'],
  ] as const) {
    for (const [command, reason, message, answers] of [
      ['connect', 'binding-changed', unverified, ['no', 'no']],
      ['login', 'binding-changed', unverified, ['yes']],
      ['login', 'connection-binding-changed', reconnect, ['yes']],
    ] as const) {
      const out = capture(), err = capture(); card.answers = [...answers];
      const execute = async (_root: string, request: { operation: string }) => {
        if (request.operation === 'prepare') return { apiTargets: [] };
        throw ErrorRegistry.createError('SIWC_STORE_NOT_PERSONAL', { params: { reason } });
      };
      expect(await main(['models', command, '--connection', 'chatgpt-login', '--scope', 'scope'], { ...f, locale, stdin: tty(), stdout: out.sink, stderr: err.sink,
        siwc: { connection: 'chatgpt-login', execute } } as never)).toBe(1);
      expect(err.text()).toContain(`${message} [SIWC_STORE_NOT_PERSONAL]`);
      if (reason === 'binding-changed') expect(err.text()).not.toMatch(/Disconnect the connection|Bağlantıyı kesin|deckent (?:models|init|secret|recovery)\b|`/u);
    }
  }
});

// Semantic expectations are independent of the catalog keys and of the case renderer.
const diagnosticMeaning = new Map(`path-search-not-file	A candidate on PATH was not a regular file	PATH üzerindeki bir aday normal bir dosya değildi
spawn/legacy-unverified	The previous check concerned running a CLI probe. The specific cause could not be determined.	Önceki denetim CLI yoklamasının çalıştırılmasıyla ilgiliydi. Kesin neden belirlenemedi.
launcher/legacy-unverified	The previous check concerned the isolation launcher. The specific cause could not be determined.	Önceki denetim yalıtım başlatıcısıyla ilgiliydi. Kesin neden belirlenemedi.
executable-recheck/legacy-unverified	The previous check concerned checking the program again. The specific cause could not be determined.	Önceki denetim programın yeniden denetlenmesiyle ilgiliydi. Kesin neden belirlenemedi.
config-dir/legacy-unverified	The previous check concerned the CLI login configuration directory. The specific cause could not be determined.	Önceki denetim CLI oturum açma yapılandırma diziniyle ilgiliydi. Kesin neden belirlenemedi.
worker-result/exit	The launched isolation command exited with code 16.	Başlatılan yalıtım komutu 16 koduyla sonlandı.
worker-result/signal	A signal was observed for the launched isolation command. The invocation outcome is unknown.	Başlatılan yalıtım komutunda bir sinyal gözlendi. Çağrının sonucu belirsiz.
worker-result/quota	The subscription CLI reported that the usage limit was reached.	Abonelik CLI'ı kullanım sınırına ulaşıldığını bildirdi.
worker-result/quota-status-unrecognized	The subscription CLI did not report a recognized quota status.	Abonelik CLI'ı tanınan bir kota durumu bildirmedi.
worker-result/invalid-output	The subscription CLI did not provide a usable response.	Abonelik CLI'ı kullanılabilir bir yanıt vermedi.
worker-result/model-mismatch	The subscription CLI reported a different model from the one requested.	Abonelik CLI'ı istenenden farklı bir model bildirdi.
worker-result/provider-error	The subscription CLI reported a provider error.	Abonelik CLI'ı bir sağlayıcı hatası bildirdi.
worker-result/guard	A safety check refused the subscription CLI result.	Bir güvenlik denetimi abonelik CLI'ının sonucunu reddetti.
agent-path-outside-roots	The configured directory is outside the permitted installation roots.	Yapılandırılan dizin izin verilen kurulum köklerinin dışında.
agent-resolved-path-outside-roots	The resolved directory is outside the permitted installation roots that matched the original path.	Çözümlenen dizin, özgün yolla eşleşen izinli kurulum köklerinin dışında.
agent-readiness-verifier-unavailable	Tool readiness could not be verified here.	Araç hazırlığı burada doğrulanamadı.
agent-readiness-query-unavailable	The tool-readiness query is unavailable for this provider profile.	Bu sağlayıcı profili için araç hazırlığı sorgusu kullanılamıyor.
recorded-program-unverified	provider program for the recorded preflight could not be checked	kayıtlı ön denetimdeki sağlayıcı programı denetlenemedi
recorded-program-mismatch	earlier preflight record does not establish the current program identity	önceki ön denetim kaydı güncel program kimliğini doğrulamıyor
login-status-positive-nonzero	status check returned a nonzero exit code	durum denetimi sıfır dışı bir çıkış kodu döndürdü
manifest-target-missing	A declared launcher path has a missing component.	Bildirilen başlatıcı yolunun bir bileşeni bulunamadı.
manifest-target-not-directory	A declared launcher path requires a directory at one of its components.	Bildirilen başlatıcı yolunun bir bileşeninde dizin gerekiyor.
manifest-target-not-regular	A declared launcher path ends at an entry that is not a regular file.	Bildirilen başlatıcı yolunun sonundaki öğe normal bir dosya değil.
recorded-owner-mismatch	The recorded connection owner differs from the current operating-system user.	Kayıtlı bağlantının sahibi mevcut işletim sistemi kullanıcısından farklı.
agent-observation-identity-unverified	The recorded agent observation could not be verified against the current login metadata.	Kayıtlı ajan gözlemi mevcut oturum üstverisiyle doğrulanamadı.
login-status-operation-unverified	The follow-up sign-in status check could not be completed.	Giriş sonrası durum denetimi tamamlanamadı.
login-status-unreadable	The subscription CLI did not report its login state in a readable form.	Abonelik CLI'ı giriş durumunu okunabilir biçimde bildirmedi.
realm-process-response	The isolated process result failed validation.	Yalıtılmış süreç sonucu doğrulamayı geçemedi.
realm-process-unverified	The isolated process result could not be determined.	Yalıtılmış sürecin sonucu belirlenemedi.
realm-bridge-close	The tool bridge for the isolated process could not be closed.	Yalıtılmış sürecin araç köprüsü kapatılamadı.
relay-signal-diagnostic	The version check exited with a signal diagnostic.	Sürüm denetimi bir sinyal tanısıyla sonlandı.
agent-run-dispose	Temporary files from the agent turn could not be cleared.	Ajan turunun geçici dosyaları temizlenemedi.
agent-run-remove	The agent turn’s temporary directory could not be removed.	Ajan turunun geçici dizini kaldırılamadı.
worker-preparation-release	The worker preparation lock could not be released.	İşçi hazırlık kilidi serbest bırakılamadı.
lock-marker-read-changed	The sign-in lock marker did not match its initial file metadata during the read.	Giriş kilidi işareti okuma sırasında ilk dosya üstverisiyle eşleşmedi.
login-status-incomplete/timeout	The subscription status check timed out.	Abonelik durum denetimi zaman aşımına uğradı.
login-status-incomplete/signal	The subscription status check reported termination by a signal.	Abonelik durum denetimi bir sinyalle sonlanma bildirdi.
login-status-incomplete/cancelled	The subscription status check was cancelled.	Abonelik durum denetimi iptal edildi.
login-status-incomplete/start-failed	The process for the subscription status check could not be started.	Abonelik durum denetiminin süreci başlatılamadı.
login-status-incomplete/output-limit	The subscription status check exceeded its output limit.	Abonelik durum denetimi çıktı sınırını aştı.
login-status-incomplete/line-limit	A line of the subscription status check output exceeded its limit.	Abonelik durum denetimi çıktısının bir satırı sınırı aştı.
login-status-incomplete/stopped	The subscription status check was stopped.	Abonelik durum denetimi durduruldu.
login-status-incomplete	subscription status check could not be completed	abonelik durum denetimi tamamlanamadı
executable-changed/bind-race-diagnostic	process exited with a bind-race diagnostic	süreç, bağlama yarışı tanısıyla sonlandı
executable-changed/legacy-unverified	verification of the executable	çalıştırılabilir dosyanın doğrulanması
npm-layout-unknown/legacy-unverified	npm launcher layout	npm başlatıcısının yerleşimi
npm-payload-missing/legacy-unverified	native program behind the npm launcher	npm başlatıcısının arkasındaki yerel program
npm-payload-unverified/legacy-unverified	native program behind the npm launcher	npm başlatıcısının arkasındaki yerel program
path-search-execute-denied	did not pass the execute-access check	çalıştırma erişimi denetimini geçemedi
path-search-empty	was not found in the PATH directories checked	denetlenen PATH dizinlerinde bulunamadı
path-search-unverified	A candidate on PATH could not be checked	PATH üzerindeki bir aday denetlenemedi
path-search-execute-unverified	A regular file was found on PATH, but its execute access could not be verified	PATH üzerinde normal bir dosya bulundu ancak çalıştırma erişimi doğrulanamadı
path-search-incomplete	The PATH search for the provider's program could not be completed	Sağlayıcının programı için PATH araması tamamlanamadı
recorded-path-unverified	could not be verified at its recorded path	kayıtlı yolunda doğrulanamadı
recorded-path-missing	missing at the connected path	bağlanan yolda yok
login-launch-unverified	could not be started for sign-in	oturum açmak için başlatılamadı
executable-bind-target-mismatch	requested bind path differs from the verified CLI path	doğrulanan CLI yolundan farklı
npm-package-directory-overlap	package directory overlaps a directory required by process isolation	süreç yalıtımı için gereken bir dizinle çakışıyor
npm-package-runtime-overlap	package contains a program required to start process isolation	süreç yalıtımını başlatmak için gereken bir programı içeriyor
realm-command-unverified	launch command for the isolated process could not be prepared	yalıtılmış sürecin başlatma komutu
preflight-record-write	check result could not be saved	denetiminin sonucu kaydedilemedi
preflight-record-unreadable	previous subscription CLI check record could not be interpreted	önceki denetim kaydı yorumlanamadı
legacy-unverified	previous check recorded a sign-in requirement	önceki denetimde oturum açma gerekliliği kaydedildi
auth-status	did not report its login state in a readable form	giriş durumunu okunabilir biçimde bildirmedi
agent-owner-mismatch	The operating-system user in the agent execution record differs from the configured user.	Ajan yürütme kaydındaki işletim sistemi kullanıcısı yapılandırılan kullanıcıdan farklı.
agent-program-changed	CLI identity differs from the one recorded by the agent execution check	ajan yürütme denetiminin kaydettiği kimlikten farklı
agent-program-path-mismatch	The verified program path differs from the path in the agent execution record.	Doğrulanan program yolu ajan yürütme kaydındaki yoldan farklı.
agent-seal	agent execution record differs from the verified configuration	ajan yürütme kaydı doğrulanan yapılandırmadan farklı
managed-login-dir	managed sign-in root directory could not be prepared	Yönetilen giriş kök dizini hazırlanamadı
program-owner-unverified	operating-system user for the provider program could not be established	Sağlayıcı programının işletim sistemi kullanıcısı belirlenemedi
probe-scratch-create	temporary parser-check directory could not be created	Geçici ayrıştırıcı denetim dizini oluşturulamadı
probe-scratch-remove	temporary parser-check directory could not be removed after the check	Geçici ayrıştırıcı denetim dizini denetimden sonra kaldırılamadı
login-status-run-list	working directory for the status check could not be listed	Durum denetimi için çalışma dizininin içeriği listelenemedi
login-status-run-remove	entry in the status check's working directory could not be removed	Durum denetiminin çalışma dizinindeki bir girdi kaldırılamadı
realm-scratch-create	temporary directory for the isolated login view could not be created	Yalıtılmış giriş görünümü için geçici dizin oluşturulamadı
realm-scratch-remove	temporary directory for the isolated login view could not be removed	Yalıtılmış giriş görünümü için geçici dizin kaldırılamadı
realm-config-directory-close	directory used to enumerate the isolated configuration could not be closed	Yalıtılmış yapılandırma girdilerini listelemek için açılan dizin kapatılamadı
realm-program-close	program descriptor for the isolated process could not be closed	Yalıtılmış sürecin program tanıtıcısı kapatılamadı
realm-gateway-close	isolated network gateway could not be closed	Yalıtılmış ağ geçidi kapatılamadı
realm-process-request	isolated process request failed validation	Yalıtılmış süreç isteği doğrulamayı geçemedi
lock-directory-create	sign-in lock directory could not be created	Giriş kilidi dizini oluşturulamadı
lock-directory-read	sign-in lock directory could not be checked	Giriş kilidi dizini denetlenemedi
lock-directory-type	sign-in lock path does not lead to a directory	Giriş kilidi yolu bir dizine çıkmıyor
lock-directory-private	sign-in lock directory failed its ownership or privacy check	Giriş kilidi dizini sahiplik veya gizlilik denetimini geçemedi
lock-marker-read	sign-in lock marker could not be read safely	giriş kilidi işareti güvenli biçimde okunamadı
lock-marker-write	sign-in lock marker could not be created	giriş kilidi işareti oluşturulamadı
lock-marker-parse	sign-in lock marker could not be interpreted during release	giriş kilidi işareti serbest bırakma sırasında yorumlanamadı
lock-marker-remove	sign-in lock marker could not be removed	giriş kilidi işareti kaldırılamadı
lock-guard-release	sign-in lock guard could not be released	Giriş kilidi koruması serbest bırakılamadı
login-lock/legacy-unverified	The previous check could not acquire the sign-in lock. The specific cause could not be verified.	Önceki denetim oturum açma kilidini alamadı. Kesin neden doğrulanamadı.
login-lock/guard-path	sign-in lock guard path failed validation	Giriş kilidi korumasının yolu doğrulamayı geçemedi
login-lock/native-unavailable	Native support for the sign-in lock could not be loaded	Giriş kilidi için yerel destek yüklenemedi
login-lock/guard-unsafe	sign-in lock guard failed its safety check	Giriş kilidi koruması güvenlik denetimini geçemedi
login-lock/guard-acquire	sign-in lock guard could not be acquired	Giriş kilidi koruması alınamadı
environment/probe	check environment contains a disallowed variable name	Denetim ortamında izin verilmeyen bir değişken adı var
environment/sign-in	sign-in environment contains a disallowed variable name	Giriş ortamında izin verilmeyen bir değişken adı var
version/exit	version check reported exit code 9	sürüm denetimi 9 çıkış kodunu bildirdi
version/exit-unrenderable	version check reported a nonzero exit	sürüm denetimi sıfır dışı bir çıkış bildirdi
version/unreadable	version check did not yield a readable version	sürüm denetimi okunabilir bir sürüm üretmedi
version/too-old	reported version 1.2.3	1.2.3 sürümünü bildirdi
version/too-old-unrenderable	version was below the configured minimum	sürümü yapılandırılan alt sınırın altında kaldı
version/legacy-unverified	The previous check concerned the CLI version. The specific cause could not be determined.	Önceki denetim CLI sürümüyle ilgiliydi. Kesin neden belirlenemedi.
config-dir/relative-path	login directory must be specified with an absolute path	Oturum açma dizini mutlak bir yolla belirtilmeli
config-dir/unresolved	login directory path could not be resolved	Oturum açma dizininin yolu çözümlenemedi
config-dir/missing	login directory was not found	Oturum açma dizini bulunamadı
config-dir/not-directory	login directory path requires a directory	Oturum açma yolu bir dizin gerektiriyor
config-dir/untrusted-owner	login directory belongs to a different user	Oturum açma dizini başka bir kullanıcıya ait
config-dir/unverified	login directory could not be verified	Oturum açma dizini doğrulanamadı
config-dir/unreported	did not report a readable login directory	okunabilir bir oturum açma dizini bildirmedi
config-dir/reported-mismatch	reported a login directory that differs	bildirdiği oturum açma dizini bağlı olandan farklı
config-dir/entry-limit	login directory exceeded the limit for entries	girdi sayısı sınırını aştı
config-dir/copy-entry-rejected	did not meet the requirements for an isolated copy	yalıtılmış kopya
config-dir/copy-size-limit	exceeded the size limit for an isolated copy	yalıtılmış kopya
config-dir/mask-unverified	isolated view of the login directory could not be prepared	oturum açma dizininin yalıtılmış görünümü hazırlanamadı
config-dir/private-entry-refused	did not pass the private directory check	özel dizin denetimini geçemedi
config-dir/lock-unverified	CLI login lock could not be checked	CLI oturum kilidi denetlenemedi
state-dir/not-directory	working path is not a directory	çalışma yolu bir dizin değil
state-dir/unverified	private working directory for the subscription CLI could not be prepared	özel çalışma dizini hazırlanamadı
state-dir/not-private	working directory for the subscription Brain is not private	özel çalışma dizini yalnız size ait değil
flags/help-unverified	required option could not be verified in the subscription CLI help output	yardım çıktısında
flags/parser-unverified	parser check could not verify a required option	ayrıştırıcı denetimi
flags/legacy-unverified	The previous check concerned CLI options. The specific cause could not be determined.	Önceki denetim CLI seçenekleriyle ilgiliydi. Kesin neden belirlenemedi.
spawn/timeout	exceeded its time limit	süre sınırını aştı
spawn/start-failed	process for the subscription CLI check could not be started	denetimi için gereken süreç başlatılamadı
spawn/output-limit	check output exceeded its limit	denetim çıktısı sınırını aştı
spawn/line-limit	check output line limit	satır uzunluğu sınırını
spawn/stopped	check was stopped	denetimi durduruldu
launcher/platform	platform cannot start the process isolation	platform
launcher/unverified	isolation launcher could not be verified	Yalıtım başlatıcısı doğrulanamadı
launcher/identity-mismatch	no longer matches the measured identity	ölçümdeki kimlikle artık eşleşmiyor
user-namespace	kernel does not let bubblewrap create the user namespace	kullanıcı ad alanı
gateway	network gateway of the isolated subscription Brain could not be opened	ağ geçidi
realm	exited with an isolation-related diagnostic	yalıtıma ilişkin bir tanıyla sonlandı
limits/limiter-unverified	path to the program that sets isolation limits could not be resolved	yalıtım sınırlarını
limits/limiter-unrunnable	did not pass the execute access check	çalıştırma izni denetimini
limits/limit-application	limit-related diagnostic	sınıra ilişkin
limits/limit-verification	limit-verification diagnostic	sınır doğrulama
limits/legacy-unverified	The previous check concerned isolation limits. The specific cause could not be determined.	Önceki denetim yalıtım sınırlarıyla ilgiliydi. Kesin neden belirlenemedi.
holder/cli	refresh marker was still present	yenileme işareti hâlâ duruyordu
holder/guard	lock guard remained held	kilidi koruması hâlâ tutuluyordu
holder/legacy-family-unverified	The previous check recorded a busy sign-in lock. The holder could not be verified.	Önceki denetimde oturum açma kilidi meşgul olarak kaydedildi. Kilidi kimin tuttuğu doğrulanamadı.
holder/legacy-unverified	no verifiable holder	sahibi hâlâ doğrulanamamıştı
holder/legacy-process	process ID in the sign-in lock marker still existed	kimliğe sahip bir süreç hâlâ vardı
holder/legacy-process-unverified	process ID in the sign-in lock marker could not be checked	işaretindeki süreç kimliği denetlenemedi
status-unconfirmed	status check did not confirm an eligible subscription	Durum denetimi uygun bir aboneliği doğrulamadı
reported-signed-out	reported that the subscription CLI was signed out	abonelik CLI'ında oturum açılmadığını bildirdi
subscription-unconfirmed	reported sign-in did not establish an eligible subscription	Bildirilen oturum uygun bir aboneliği doğrulamadı
cancelled	check was cancelled	denetimi iptal edildi
signal	check reported a signal	denetimi bir sinyal bildirdi
executable-changed	program identity differs	daha önce denetlenen program kimliğinden farklı
executable-bind-unverified	process exited with a bind-source diagnostic	Süreç, bağlama kaynağına ilişkin bir tanıyla sonlandı
npm-layout-unknown	npm launcher layout is unsupported	npm başlatıcı yerleşimi desteklenmiyor
npm-proof	native program file you have verified	Doğruladığınız bir yerel program dosyasını
manifest-exclusion-changed	package directory or manifest changed	paket dizini veya bildirim dosyası değişti
manifest-declares-bin	declares this file as a launcher target	bu dosyayı başlatıcı hedefi olarak belirtiyor
manifest-exclusion-unverified	launcher declarations could not be fully checked	başlatıcı bildirimleri tam olarak denetlenemedi
native-platform-unverified	native file check is unavailable on this platform	Yerel program dosyası bu platformda denetlenemiyor
native-file-changed	file identity differed	dosya kimliği farklı çıktı
native-format-unverified	file format did not pass	Dosya biçimi yerel program denetimini geçemedi
native-read-incomplete	required bytes for the native program check could not be read completely	Yerel program denetimi için gereken baytların tamamı okunamadı
native-proof-unavailable	native program check could not be completed	Yerel program denetimi tamamlanamadı
npm-check	npm installation check stopped	npm kurulumu denetimi durdu
npm-recheck	program could not be checked again	Program yeniden denetlenemedi
npm-unverified	npm program check could not be completed	npm programı denetimi tamamlanamadı
npm/missing	required entry is missing	Gerekli dosya veya dizin bulunamadı
npm/not-directory	check expected a directory	Denetim bir dizin bekliyordu
npm/not-regular-file	check expected a regular file	Denetim normal bir dosya bekliyordu
npm/not-expected-link	not the expected symbolic link to the launcher	başlatıcıya giden beklenen sembolik bağlantı değil
npm/untrusted-owner	outside the trusted set	sahibi güvenilen kullanıcılar arasında değil
npm/group-or-other-writable	writable by the group or by other users	grup veya diğer kullanıcılar yazabilir
npm/set-id	special permission bit set	özel izin biti
npm/multiple-hard-links	more than one hard link	birden fazla sabit bağlantısı var
npm/no-hard-links	recorded link count is zero	okunan sabit bağlantı sayısı sıfır
npm/manifest-mismatch	manifest does not match the registered npm layout	bildirim dosyası kayıtlı npm yerleşimiyle eşleşmiyor
npm/manifest-invalid	manifest does not contain valid JSON	bildirim dosyası geçerli JSON içermiyor
npm/manifest-too-large	manifest is too large to check	bildirim dosyası denetim için fazla büyük
npm/manifest-unreadable	manifest could not be read completely	bildirim dosyasının tamamı okunamadı
npm/not-executable	execute permission check failed	Çalıştırma izni denetimi başarısız oldu
npm/changed-during-check	file changed during the check	Dosya denetim sırasında değişti
npm/verification-unavailable	required properties could not be verified	gerekli özellikleri doğrulanamadı
selection/directory	path leads to a directory	yol bir dizine çıkıyor
selection/not-regular-file	path does not lead to a regular file	yol normal bir dosyaya çıkmıyor
selection/not-executable	regular file without execute permission	Çalıştırma izni olmayan bir normal dosya
selected-file/unavailable	file you chose could not be verified	Seçtiğiniz dosya çalıştırılabilir bir program olarak doğrulanamadı
selected-file/relative-path	provider program must be specified with an absolute path	Sağlayıcı programı mutlak bir yolla belirtilmeli
path-candidate-unverified/unavailable	program found on PATH could not be verified	PATH üzerinde bulunan program doğrulanamadı
entry-recheck	program could not be checked again	Program yeniden denetlenemedi
login-outcome/completed	The sign-in command completed.	Giriş komutu tamamlandı.
login-outcome/cancelled	The sign-in command was interrupted.	Giriş komutu kesildi.
login-outcome/failed	The sign-in command ended with a failure.	Giriş komutu başarısız sonuçlandı.
login-outcome/unsaved	deckent could not save the outcome. The subscription state in this directory was not verified.	deckent sonucu kaydedemedi. Bu dizindeki abonelik durumu doğrulanmadı.
os-owner-mismatch	belongs to another operating-system user	başka bir işletim sistemi kullanıcısına ait
limit/legacy-unverified	The previous check recorded a resource limit. Which limit was reached could not be verified.	Önceki denetimde bir kaynak sınırı kaydedildi. Hangi sınıra ulaşıldığı doğrulanamadı.
limit/cpu-time	status reserved for the CPU-time limit	CPU süresi sınırına ayrılan çıkış kodu
limit/processes	status reserved for the process-count limit	süreç sayısı sınırına ayrılan çıkış kodu
limit/memory	status reserved for the data-size limit	veri boyutu sınırına ayrılan çıkış kodu
program-definition	provider program definition is unavailable	Sağlayıcı programı tanımı kullanılamıyor
prepared-definition	The prepared provider connection definition did not pass validation.	Hazırlanan sağlayıcı bağlantısı tanımı doğrulamayı geçemedi.
connect-definition	connection program definition is unavailable	Bağlantı programı tanımı kullanılamıyor
login-family	definition for this provider's sign-in is unavailable	Bu sağlayıcının giriş tanımı kullanılamıyor
login-method	requested sign-in method is unavailable	İstenen giriş yöntemi bu sağlayıcı programı için kullanılamıyor
sso	does not support the requested single sign-on method	istenen tek oturum açma yöntemini desteklemiyor
gateway-provider	provider identifier failed validation for the isolated network gateway	Sağlayıcı kimliği yalıtılmış ağ geçidi için doğrulamayı geçemedi
definition	The provider program definition did not meet the requirements.	Sağlayıcı programı tanımı koşulları karşılamadı.
profile	The invocation profile did not meet the provider program requirements.	Çağrı profili sağlayıcı programının koşullarını karşılamadı.
token	No valid preparation token was provided for this call.	Bu çağrı için geçerli bir hazırlık anahtarı sunulmadı.
binding	The model binding could not be read for this provider call.	Bu sağlayıcı çağrısı için model bağı okunamadı.
request	The request did not meet the provider program’s input requirements.	İstek sağlayıcı programının girdi koşullarını karşılamadı.
size	The request exceeded the provider program’s input size limit.	İstek sağlayıcı programının girdi boyutu sınırını aştı.
effort	The requested reasoning setting is unavailable for this provider program.	İstenen akıl yürütme ayarı bu sağlayıcı programında kullanılamıyor.
agent-closed	The agent’s tool invocation is no longer accepting requests.	Ajanın araç çağrısı artık istek kabul etmiyor.
agent-order	The agent tool request arrived outside the supported call sequence.	Ajan araç isteği desteklenen çağrı sırasının dışında geldi.
model-alias	The provider program’s model or turn settings did not pass validation.	Sağlayıcı programının model veya tur ayarları doğrulamayı geçemedi.
turn-bound	The provider program’s turn bound could not be established.	Sağlayıcı programının tur sınırı belirlenemedi.
forbidden-flag	The provider program’s invocation contains an unsupported option.	Sağlayıcı programının çağrısı desteklenmeyen bir seçenek içeriyor.
agent-profile	The connection profile is ineligible for native agent execution.	Bağlantı profili yerel ajan çalıştırmaya uygun değil.`.split('\n').map(line => {
  const [id, en, tr] = line.split('\t');
  return [id!, [en!, tr!] as const];
}));

function headlessExpectationIds(fields: Readonly<Record<string, string | number>>) {
  const { check, reason, native, exit, holder, limit, recheck } = fields;
  const entry = reason === 'missing' || reason === 'not-directory' ? 'npm/' + reason : 'selection/' + reason;
  if (native && reason) return ['npm-proof', String(reason), String(native)];
  if ((check === 'npm-payload-missing' || check === 'npm-payload-unverified') && reason !== 'legacy-unverified') {
    const uncertainty = ['manifest-too-large', 'manifest-unreadable', 'changed-during-check', 'verification-unavailable'].includes(String(reason));
    return [uncertainty ? 'npm-unverified' : recheck ? 'npm-recheck' : 'npm-check', 'npm/' + reason];
  }
  if (check === 'executable-recheck' && reason !== 'legacy-unverified') return ['entry-recheck', reason === 'directory' ? 'selection/directory' : 'npm/' + reason];
  if (exit) return ['login-outcome/' + exit, 'login-outcome/unsaved'];
  if (holder) return ['holder/' + holder];
  if (limit) return ['limit/' + limit];
  switch (check) {
    case 'recorded-path-not-directory': return ['npm/not-directory'];
    case 'recorded-path-directory': return ['selection/directory'];
    case 'recorded-path-not-file': return ['selection/not-regular-file'];
    case 'recorded-path-not-executable': return ['selection/not-executable'];
    case 'selected-file':
      if (reason !== 'relative-path' && reason !== 'unavailable') return [entry];
      break;
    case 'path-candidate-unverified':
      if (reason !== 'unavailable') return [entry];
      break;
  }
  if (check && reason) return [check + '/' + reason];
  return [String(check ?? reason ?? 'os-owner-mismatch')];
}

it('explains every provider diagnostic by operation and reason in English and Turkish', async () => {
  const unknown = [
    'The provider-program diagnostic could not be verified.',
    'Sağlayıcı programına ilişkin tanı doğrulanamadı.',
  ];
  const locales = ['en', 'tr'] as const;
  const external = ErrorRegistry.createError('HEADLESS_PREFLIGHT_FAILED', { params: {
    check: 'environment', reason: '/fixture/private/unknown-value',
  } });
  for (const [index, locale] of locales.entries()) expect.soft(external.localize?.(locale).message).toBe(unknown[index]);
  expect.soft(JSON.stringify(external)).not.toContain('/fixture/private/unknown-value');

  const { headlessDiagnosticCases } = await import('#platform/core/errors/index.js');
  expect(headlessDiagnosticCases).toBeDefined();
  for (const row of headlessDiagnosticCases) {
    const fields: Readonly<Record<string, string | number>> = row.fields;
    const example = Object.fromEntries(Object.entries(row.extras ?? {}).map(([key, field]) => [key, field.example]));
    const proof = row.code === 'HEADLESS_WORKER_RESULT' ? [`worker-result/${fields['reason']}`] : headlessExpectationIds(fields);
    const label = `${row.code} ${JSON.stringify(fields)}`;
    for (const [index, locale] of locales.entries()) {
      const rendered = ErrorRegistry.createError(row.code, { params: { ...fields, ...example }, locale }).message;
      expect.soft(rendered, label).not.toContain(unknown[index]);
      for (const id of proof) {
        const pair = diagnosticMeaning.get(id);
        expect(pair, `${label}, expectation ${id}`).toBeDefined();
        expect.soft(rendered.toLowerCase(), label).toContain(pair![index]!.toLowerCase());
      }
    }
  }
});
