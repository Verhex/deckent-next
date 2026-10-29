import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { ErrorRegistry, clearConfigCache, exitCodeFor, getConfigFieldDefault, resolveGlobalConfigPaths, validateConfig, snapshotKnownSecrets, type Locale } from '../../../src/platform/index.js';
import { commandLocale, resolveCliLocale } from '#surfaces/core/cli-kit/index.js';
import { projectInputSchema } from '#engine/core/config/index.js';
import {
  AGENT_ENVIRONMENT, acceptanceEvidenceText, askCliCard, cliCardGate, cliTableStyle, detectCliMode, displayId, formatAgo, formatBytes, formatClock, formatDecimal, formatDuration,
  listRunIds, matchIdPrefix, orderPendingFirst, renderCliTable, renderInputSchema, requireIdPrefix, resolveCommandScope, safeCell, schemaRequested,
  scopeLister, scopeNotice, standingCardOptions, textCells, type CliCardRequest,
} from '#surfaces/core/cli-human/index.js';
import { hostAgentEnvironment, hostLocale } from '#composition/core/cli/index.js';
import { optionKey } from '#surfaces/core/terminal-window/index.js';

/** L-KIT (alpha.48): the CLI toolkit's observable contract. */
const caught = async (work: () => unknown): Promise<{ code?: string; message: string; exit: number }> => {
  try { await work(); } catch (error) { return { code: (error as { code?: string }).code, message: (error as Error).message, exit: exitCodeFor(error) }; }
  throw new Error('expected a refusal');
};
const tty = { isTTY: true, setRawMode: () => undefined }, pipe = { isTTY: false };

describe('locale chain', () => {
  const cases: Array<[string, Parameters<typeof resolveCliLocale>[0], Locale]> = [
    ['flag beats everything', { flag: 'en', env: { DECKENT_LANGUAGE: 'tr', LANG: 'tr_TR.UTF-8' }, configLanguage: 'tr' }, 'en'],
    ['DECKENT_LANGUAGE beats config', { env: { DECKENT_LANGUAGE: 'tr' }, configLanguage: 'en' }, 'tr'],
    ['DECKENT_LANG beats config', { env: { DECKENT_LANG: 'tr_TR' }, configLanguage: 'en' }, 'tr'],
    ['config beats the system locale', { env: { LC_ALL: 'en_US.UTF-8' }, configLanguage: 'tr' }, 'tr'],
    ['config tr with no environment', { env: {}, configLanguage: 'tr' }, 'tr'],
    ['empty LC_ALL is unset: LANG decides', { env: { LC_ALL: '', LANG: 'tr_TR.UTF-8' } }, 'tr'],
    ['empty DECKENT_LANGUAGE is unset: config decides', { env: { DECKENT_LANGUAGE: '', DECKENT_LANG: '' }, configLanguage: 'tr' }, 'tr'],
    ['LC_MESSAGES sits between LC_ALL and LANG', { env: { LC_MESSAGES: 'tr_TR.UTF-8', LANG: 'en_US.UTF-8' } }, 'tr'],
    ['LC_ALL beats LC_MESSAGES', { env: { LC_ALL: 'en_US.UTF-8', LC_MESSAGES: 'tr_TR.UTF-8' } }, 'en'],
    ['an unsupported value is passed over', { env: { LC_ALL: 'C.UTF-8', LANG: 'tr_TR.UTF-8' } }, 'tr'],
    ['unsupported flag falls through', { flag: 'de', env: { LANG: 'tr_TR' } }, 'tr'],
    ['nothing set: en', { env: {} }, 'en'],
  ];
  it.each(cases)('%s', (_name, input, expected) => expect(resolveCliLocale(input)).toBe(expected));

  it('a command uses its own supported --lang, else the host locale (config included), and reports the choice', () => {
    const seen: Locale[] = [];
    const context = { locale: 'tr' as Locale, env: { LANG: 'en_US.UTF-8' }, onLocale: (value: Locale) => seen.push(value) };
    expect(commandLocale(context)).toBe('tr');
    expect(commandLocale(context, 'en')).toBe('en');
    expect(commandLocale(context, 'de')).toBe('tr');
    expect(commandLocale({ env: { LANG: 'tr_TR' } })).toBe('tr');
    expect(seen).toEqual(['tr', 'en', 'tr']);
  });
});

describe('host locale (composition, resolved once per call)', () => {
  const roots: string[] = [];
  afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
  async function fixture(project: string | null) {
    const root = await mkdtemp(join(tmpdir(), 'deckent-lkit-')); roots.push(root);
    const home = join(root, 'home'), dir = join(root, 'project');
    await mkdir(join(dir, '.deckent'), { recursive: true });
    const env = { HOME: home, USERPROFILE: home, APPDATA: join(home, 'roaming'), LOCALAPPDATA: join(home, 'local'), XDG_CONFIG_HOME: join(home, '.config') };
    await mkdir(dirname(resolveGlobalConfigPaths(env).platformPath), { recursive: true });
    if (project !== null) await writeFile(join(dir, '.deckent', 'config.json'), project);
    return { dir, env };
  }
  it('reads config language when no flag or DECKENT_* variable decides (review: report.ts ignored config)', async () => {
    const f = await fixture('{"language":"tr"}');
    expect(await hostLocale(['report'], f.dir, { ...f.env, LANG: 'en_US.UTF-8' })).toBe('tr');
    expect(await hostLocale(['report', '--lang', 'en'], f.dir, f.env)).toBe('en');
    expect(await hostLocale(['report'], f.dir, { ...f.env, DECKENT_LANGUAGE: 'en' })).toBe('en');
    expect(await hostLocale(['report', '--lang', 'de'], f.dir, f.env)).toBe('tr');
    // An unsupported DECKENT_LANGUAGE is passed over like any other value: config still decides.
    expect(await hostLocale(['report'], f.dir, { ...f.env, DECKENT_LANGUAGE: 'de', LANG: 'en_US.UTF-8' })).toBe('tr');
  });
  it('an unreadable config never blocks a command: the environment chain decides', async () => {
    const f = await fixture('{broken');
    expect(await hostLocale(['--version'], f.dir, { ...f.env, LANG: 'tr_TR.UTF-8' })).toBe('tr');
    const invalid = await fixture('{"language":"xx"}');
    expect(await hostLocale(['doctor'], invalid.dir, { ...invalid.env, LC_ALL: '', LANG: 'tr_TR.UTF-8' })).toBe('tr');
  });
  it('INIT-D7: the agent list is one config field; the host reads the configured list, else the registry default', async () => {
    expect(AGENT_ENVIRONMENT).toEqual(getConfigFieldDefault('cli').agentEnvironment);
    expect(AGENT_ENVIRONMENT).toEqual(expect.arrayContaining(['CLAUDECODE', 'AI_AGENT', 'CURSOR_AGENT']));
    const configured = await fixture('{"cli":{"agentEnvironment":["MY_AGENT"]}}');
    expect(await hostAgentEnvironment(configured.dir, configured.env)).toEqual(['MY_AGENT']);
    expect(await hostAgentEnvironment((await fixture('{}')).dir, configured.env)).toBeUndefined();
    // Exact upper-case names only (no prefix or pattern); an invalid or unreadable config never blocks: the kit default decides.
    expect(() => validateConfig({ cli: { agentEnvironment: ['CODEX_*'] } })).toThrow();
    expect(() => validateConfig({ cli: { agentEnvironment: ['lower'] } })).toThrow();
    expect(await hostAgentEnvironment((await fixture('{"cli":{"agentEnvironment":["CODEX_*"]}}')).dir, configured.env)).toBeUndefined();
    expect(await hostAgentEnvironment((await fixture('{broken')).dir, configured.env)).toBeUndefined();
  });
});

describe('mode detection', () => {
  it('json wins, agents/CI/dumb terminals are plain, a pipe is plain, a real terminal is interactive', () => {
    expect(detectCliMode({ json: true, env: {}, stdin: tty, stdout: tty })).toEqual({ mode: 'json', reason: 'json' });
    expect(detectCliMode({ env: { CLAUDECODE: '1' }, stdin: tty, stdout: tty })).toEqual({ mode: 'plain', reason: 'agent' });
    expect(detectCliMode({ env: { CURSOR_AGENT: '1' }, stdin: tty, stdout: tty }).reason).toBe('agent');
    expect(detectCliMode({ env: { CI: 'true' }, stdin: tty, stdout: tty })).toEqual({ mode: 'plain', reason: 'ci' });
    expect(detectCliMode({ env: { CI: 'false' }, stdin: tty, stdout: tty })).toEqual({ mode: 'interactive', reason: 'tty' });
    expect(detectCliMode({ env: { TERM: 'dumb' }, stdin: tty, stdout: tty })).toEqual({ mode: 'plain', reason: 'dumb' });
    expect(detectCliMode({ env: {}, stdin: tty, stdout: pipe })).toEqual({ mode: 'plain', reason: 'pipe' });
    expect(detectCliMode({ env: {}, stdin: pipe, stdout: tty })).toEqual({ mode: 'plain', reason: 'pipe' });
    expect(detectCliMode({ env: {}, stdin: tty, stdout: tty })).toEqual({ mode: 'interactive', reason: 'tty' });
  });
  it('agent names are exact (no prefix match) and the host may supply its own list', () => {
    expect(detectCliMode({ env: { CODEX_UNRELATED: '1', CLAUDECODE: '' }, stdin: tty, stdout: tty }).mode).toBe('interactive');
    expect(detectCliMode({ env: { MY_AGENT: 'yes' }, stdin: tty, stdout: tty, agentEnvironment: ['MY_AGENT'] }).reason).toBe('agent');
    expect(detectCliMode({ env: { CLAUDECODE: '1' }, stdin: tty, stdout: tty, agentEnvironment: ['MY_AGENT'] }).mode).toBe('interactive');
  });
});

describe('human formats', () => {
  it('bytes, durations, ages and decimals in each language without float noise', () => {
    expect(formatBytes(583852032, 'tr')).toBe('557 MB');
    expect(formatBytes(1288490188, 'en')).toBe('1.2 GB');
    expect(formatBytes(1288490188, 'tr')).toBe('1,2 GB');
    expect(formatBytes(512, 'en')).toBe('512 bytes');
    expect(formatBytes(512, 'tr')).toBe('512 bayt');
    expect(formatDuration(490.223, 'tr')).toBe('0,49 sn');
    expect(formatDuration(20900, 'tr')).toBe('20,9 sn');
    expect(formatDuration(20900, 'en')).toBe('20.9 s');
    expect(formatDuration(192_000, 'tr')).toBe('3 dk 12 sn');
    expect(formatDuration(8_280_000, 'tr')).toBe('2 sa 18 dk');
    expect(formatDuration(8_280_000, 'en')).toBe('2 h 18 min');
    expect(formatDuration(97_200_000, 'tr')).toBe('1 g 3 sa');
    const now = Date.UTC(2026, 9, 19, 12);
    expect(formatAgo(now - 12 * 3_600_000, now, 'tr')).toBe('12 sa önce');
    expect(formatAgo(now - 12 * 3_600_000, now, 'en')).toBe('12 h ago');
    expect(formatAgo(now - 30_000, now, 'tr')).toBe('az önce');
    expect(formatAgo(now + 60_000, now, 'en')).toBe('just now');
    expect(formatAgo(now - 3 * 86_400_000, now, 'tr')).toBe('3 gün önce');
    expect(formatDecimal(0.49022299999999996, 'tr')).toBe('0,49');
    expect(formatClock(Date.UTC(2026, 9, 18, 22, 26, 47), 'tr', 'Europe/Istanbul')).toBe('2026-10-19 01:26');
    for (const value of [null, undefined, Number.NaN, -1]) {
      expect(formatBytes(value, 'tr')).toBe('bilinmiyor'); expect(formatDuration(value, 'en')).toBe('unknown');
    }
  });
  it('lists put waiting items first, then newest to oldest, stable for ties', () => {
    const rows = [{ id: 'a', wait: false, at: 3 }, { id: 'b', wait: true, at: 1 }, { id: 'c', wait: false, at: 5 }, { id: 'd', wait: true, at: 4 },
      { id: 'e', wait: false, at: null }, { id: 'f', wait: false, at: 5 }];
    expect(orderPendingFirst(rows, { pending: row => row.wait, time: row => row.at }).map(row => row.id)).toEqual(['d', 'b', 'c', 'f', 'a', 'e']);
  });
});

describe('table', () => {
  const columns = [{ header: 'Task' }, { header: 'State' }, { header: 'Age', align: 'right' as const, shrink: false }];
  const rows = [['create-do-test-file with a rather long human title', 'waiting', '12 h ago'], ['ışık-çalışması 漢字', 'adopted', '3 min ago']];
  it.each([40, 80, 120])('fits a %i-column terminal', width => {
    const text = renderCliTable(columns, rows, { width, ascii: false });
    for (const line of text.split('\n')) expect(textCells(line)).toBeLessThanOrEqual(width);
    expect(text).toContain('waiting'); expect(text).toContain('12 h ago');
  });
  it('a pipe keeps whole values; ASCII terminals get ASCII rules and ellipses; nothing writes an escape sequence', () => {
    const piped = renderCliTable(columns, rows, cliTableStyle({ env: {}, stdout: pipe }));
    expect(piped).toContain('create-do-test-file with a rather long human title');
    const ascii = renderCliTable(columns, rows, { width: 40, ascii: true });
    expect(ascii).toContain('...'); expect(ascii).not.toMatch(/[─…]/u);
    expect(cliTableStyle({ env: { TERM: 'dumb', NO_COLOR: '1' }, stdout: { isTTY: true, columns: 60 } })).toEqual({ width: 60, ascii: true });
    // eslint-disable-next-line no-control-regex
    expect(renderCliTable(columns, [['\u001b[31mred\u001b[0m\u001b]0;title\u0007', 'x\ny', 'z']], { width: 80, ascii: false })).not.toMatch(/[\u001b\u0007]/u);
  });
  it('too narrow for every column: one `header: value` line each', () => {
    expect(renderCliTable(columns, rows, { width: 12, ascii: false }).split('\n')[0]).toBe('Task: create-do-test-file with a rather long human title');
  });
  it('no secret value reaches a rendered field (known secrets and credential patterns)', () => {
    const known = snapshotKnownSecrets([{ name: 'DEPLOY_TOKEN', value: 'hunter2-s3cr3t-value' }]);
    const text = renderCliTable([{ header: 'Note' }], [['note hunter2-s3cr3t-value'], ['key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA']], { width: 80, ascii: false }, known);
    expect(text).not.toContain('hunter2-s3cr3t-value'); expect(text).not.toContain('sk-ant-api03-AAAA');
    expect(safeCell('hunter2-s3cr3t-value', known)).not.toContain('hunter2');
  });
});

describe('short ids', () => {
  const ids = ['5ff7e6cb11aa', '5ff7e6cc22bb', '0a1b2c3d4e5f', 'create-do-test-file'];
  it('unique prefix, exact id, ambiguous, none and too short', () => {
    expect(matchIdPrefix('0a1b', ids)).toEqual({ kind: 'unique', id: '0a1b2c3d4e5f' });
    expect(matchIdPrefix('create-do-test-file', ids)).toEqual({ kind: 'unique', id: 'create-do-test-file' });
    expect(matchIdPrefix('5ff7e6c', ids)).toEqual({ kind: 'ambiguous', candidates: ['5ff7e6cb11aa', '5ff7e6cc22bb'] });
    expect(matchIdPrefix('ffff', ids)).toEqual({ kind: 'none' });
    expect(matchIdPrefix('5f', ids)).toEqual({ kind: 'short', min: 4 });
    expect(requireIdPrefix('5ff7e6cb', ids)).toBe('5ff7e6cb11aa');
  });
  it('refusals name the cause; an ambiguous prefix lists the candidates (usage, exit 2)', async () => {
    const ambiguous = await caught(() => requireIdPrefix('5ff7', ids));
    expect(ambiguous).toMatchObject({ code: 'CLI_ID_AMBIGUOUS', exit: 2 });
    expect(ambiguous.message).toContain('5ff7e6cb'); expect(ambiguous.message).toContain('5ff7e6cc');
    expect(await caught(() => requireIdPrefix('5f', ids))).toMatchObject({ code: 'CLI_ID_TOO_SHORT', exit: 2 });
    expect(await caught(() => requireIdPrefix('ffff\u001b[2J', ids))).toMatchObject({ code: 'CLI_ID_UNKNOWN', exit: 1 });
    expect((await caught(() => requireIdPrefix('ffff\u001b[2J', ids))).message).not.toContain('\u001b');
    expect(ErrorRegistry.createError('CLI_ID_UNKNOWN', { params: { prefix: 'ab12' }, locale: 'tr' }).message).toContain("'ab12' ile başlayan kimlik yok");
  });
  it('display ids are 8 characters, longer only to stay distinct', () => {
    expect(displayId('0a1b2c3d4e5f', ids)).toBe('0a1b2c3d');
    expect(displayId('5ff7e6cb11aa', ids)).toBe('5ff7e6cb');
    expect(displayId('5ff7e6cb11aa', ['5ff7e6cb11aa', '5ff7e6cb11ab'])).toBe('5ff7e6cb11aa');
    expect(displayId('owner-review', ['owner-review'])).toBe('owner-review');
    expect(displayId('queue-verify-readme', ['queue-verify-readme'])).toBe('queue-verify-readme');
  });
  it('run ids come from the /runs queries: surface ids first, else the first inventory page, else none', async () => {
    const options = {};
    expect(await listRunIds({ inspectSurfaceRunIds: async () => ['r1'], inspectInventory: async () => { throw new Error('second inventory'); } }, '/p', 's', options)).toEqual(['r1']);
    const seen: unknown[] = [];
    expect(await listRunIds({ inspectInventory: async (_root, input) => { seen.push(input); return { page: { entries: [{ identity: { runId: 'r2' } }, { identity: { runId: 'r2' } }, { identity: { runId: 'r3' } }] } }; } },
      '/p', 's', options)).toEqual(['r2', 'r3']);
    expect(seen).toEqual([{ schemaVersion: 1, scopeId: 's', after: null, limit: 50 }]);
    expect(await listRunIds({}, '/p', 's', options)).toEqual([]);
  });
});

describe('scope rule', () => {
  const listScopes = async () => ['live', 'pilot'];
  it('a read uses --scope or the configured default and says which', async () => {
    const read = await resolveCommandScope({ command: 'deckent workers', locale: 'tr', configured: 'live', mutating: false, interactive: false, listScopes });
    expect(read).toEqual({ scopeId: 'live', source: 'default' });
    expect(scopeNotice(read!, 'tr')).toBe('Kapsam: live (varsayılan)');
    expect(await resolveCommandScope({ command: 'deckent workers', locale: 'en', explicit: 'pilot', configured: 'live', mutating: false, interactive: false, listScopes }))
      .toEqual({ scopeId: 'pilot', source: 'flag' });
  });
  it('NEGATIVE: a change off a terminal without --scope exits 2 with the valid scopes, and nothing is written', async () => {
    let applied = 0;
    const command = async (interactive: boolean) => {
      const scope = await resolveCommandScope({ command: 'deckent pool hold', locale: 'en', configured: 'live', mutating: true, interactive, listScopes });
      if (scope) applied++;
    };
    const refusal = await caught(() => command(false));
    expect(refusal).toMatchObject({ code: 'CLI_SCOPE_REQUIRED', exit: 2 });
    expect(refusal.message).toContain('live, pilot'); expect(refusal.message).toContain('deckent pool hold');
    // A terminal without a card launcher is treated the same: never a silent default.
    expect(await caught(() => command(true))).toMatchObject({ code: 'CLI_SCOPE_REQUIRED' });
    expect(applied).toBe(0);
    expect(ErrorRegistry.createError('CLI_SCOPE_REQUIRED', { params: { command: 'deckent pool hold', scopes: 'live' }, locale: 'tr' }).message).toContain('Geçerli kapsamlar: live');
  });
  it('on a terminal the person picks (default preselected); a cancelled card applies nothing', async () => {
    const asked: CliCardRequest[] = [];
    let applied = 0;
    const run = async (answer: string | null) => {
      const scope = await resolveCommandScope({ command: 'deckent pool hold', locale: 'tr', configured: 'live', mutating: true, interactive: true, listScopes,
        pick: async request => { asked.push(request); return answer; } });
      if (scope) applied++;
      return scope;
    };
    expect(await run('pilot')).toEqual({ scopeId: 'pilot', source: 'picked' });
    expect(asked[0]).toMatchObject({ initial: 'live', options: [{ id: 'live', label: 'live (varsayılan)' }, { id: 'pilot', label: 'pilot' }] });
    expect(await run(null)).toBeNull();
    expect(await run('not-offered')).toBeNull();
    expect(applied).toBe(1);
  });
  it('NEGATIVE (J2c): a person on a terminal with no scope to pick gets the setup step, not an empty card; off a terminal the scope stays required', async () => {
    let asked = 0;
    const none = async (interactive: boolean) => resolveCommandScope({ command: 'deckent task', locale: 'en', mutating: false, interactive, listScopes: async () => [],
      pick: async () => { asked++; return null; } });
    const terminal = await caught(() => none(true));
    expect(terminal).toMatchObject({ code: 'TERMINAL_SCOPE_REQUIRED', exit: 2 });
    expect(terminal.message).toContain('deckent init policy --scope <id> --apply');
    expect(await caught(() => none(false))).toMatchObject({ code: 'CLI_SCOPE_REQUIRED', exit: 2 });
    expect(asked).toBe(0);
  });
  it('NEGATIVE (J2d): no installation in the folder names only `deckent init` on a terminal; off a terminal the scope stays required', async () => {
    let asked = 0;
    const missing = async (interactive: boolean, locale: Locale = 'en') => resolveCommandScope({ command: 'deckent task', locale, mutating: false, interactive,
      listScopes: async () => { throw ErrorRegistry.createError('CLI_INSTALLATION_MISSING'); }, pick: async () => { asked++; return null; } });
    const terminal = await caught(() => missing(true));
    expect(terminal).toMatchObject({ code: 'CLI_INSTALLATION_MISSING', exit: 2 });
    expect(terminal.message).toBe('No Deckent installation in this folder. Run `deckent init` to set it up.');
    expect(ErrorRegistry.createError('CLI_INSTALLATION_MISSING', { locale: 'tr' }).message).toBe('Bu klasörde Deckent kurulumu yok. Kurmak için `deckent init` çalıştırın.');
    expect(terminal.message).not.toContain('init policy');
    // Off a terminal (pipe, agent, CI, `deckent init --yes`) the answer is unchanged: the command needs `--scope`.
    expect(await caught(() => missing(false))).toMatchObject({ code: 'CLI_SCOPE_REQUIRED', exit: 2 });
    expect(asked).toBe(0);
  });
  it('the scope list is the /config scope query', async () => {
    const calls: unknown[] = [];
    const lister = scopeLister({ configChoiceSources: () => ({ async list(source, keyPath) { calls.push([source, keyPath]); return [{ value: 'live' }, { value: 7 }]; } }) }, '/p', {});
    expect(await lister()).toEqual(['live']);
    expect(calls).toEqual([['scopes', 'terminal.scopeId']]);
    expect(await scopeLister({}, '/p', {})()).toEqual([]);
  });
});

describe('TTY card contract', () => {
  it('NEGATIVE: "always" is never offered on a hard-floor cell, whatever the caller asked', () => {
    expect(standingCardOptions('en', { session: true, always: true, hardFloor: true }).map(option => option.id)).toEqual(['once', 'session', 'no']);
    expect(standingCardOptions('tr', { session: true, always: true, hardFloor: false }).map(option => option.id)).toEqual(['once', 'session', 'always', 'no']);
    expect(standingCardOptions('en', { hardFloor: false }).map(option => optionKey(option))).toEqual(['y', 'n']);
  });
  it('NEGATIVE: only a person on a real terminal is asked; pipes, agents and dumb terminals are refused before anything is drawn', async () => {
    const request = { title: 'x', options: [{ id: 'a', label: 'A' }] };
    expect(cliCardGate(request, { locale: 'en', env: {}, stdin: tty, stdout: tty }).env).toEqual({});
    for (const io of [{ env: {}, stdin: pipe, stdout: tty }, { env: { CLAUDECODE: '1' }, stdin: tty, stdout: tty }, { env: { TERM: 'dumb' }, stdin: tty, stdout: tty },
      { env: {}, stdin: { isTTY: true }, stdout: tty }]) {
      expect(await caught(() => cliCardGate(request, { locale: 'en', ...io }))).toMatchObject({ code: 'TERMINAL_TTY_REQUIRED', exit: 2 });
    }
    expect(await caught(() => cliCardGate({ title: 'x', options: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }] }, { locale: 'en', env: {}, stdin: tty, stdout: tty })))
      .toMatchObject({ code: 'CLI_USAGE' });
    // walk16: a card with a yes/no answer offers exactly one yes and one no, so it always shows and takes both (y) and (n).
    for (const options of [[{ id: 'go', label: 'Go', role: 'yes' as const }, { id: 'later', label: 'Later' }], [{ id: 'a', label: 'A', role: 'yes' as const }, { id: 'b', label: 'B', role: 'yes' as const }, { id: 'c', label: 'C', role: 'no' as const }]]) {
      expect(await caught(() => cliCardGate({ title: 'x', options }, { locale: 'en', env: {}, stdin: tty, stdout: tty }))).toMatchObject({ code: 'CLI_USAGE' });
    }
  });
  it('J1: askCliCard passes the same gate before its Ink view loads, and an already cancelled command gets no answer', async () => {
    const request = { title: 'x', options: [{ id: 'a', label: 'A' }] };
    expect(await caught(() => askCliCard(request, { locale: 'en', env: { CLAUDECODE: '1' }, stdin: tty, stdout: tty }))).toMatchObject({ code: 'TERMINAL_TTY_REQUIRED' });
    expect(await caught(() => askCliCard(request, { locale: 'en', env: {}, stdin: pipe, stdout: tty }))).toMatchObject({ code: 'TERMINAL_TTY_REQUIRED' });
    const cancelled = new AbortController(); cancelled.abort();
    expect(await askCliCard(request, { locale: 'en', env: {}, stdin: tty, stdout: tty, signal: cancelled.signal })).toBeNull();
  });
  /** A raw-mode terminal pair that records every byte drawn; nothing answers, so a card that mounts would wait for input. */
  const terminalPair = (onWrite?: () => void) => {
    const written: string[] = [];
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => stdin, ref: () => stdin, unref: () => stdin });
    const stdout = Object.assign(new Writable({ write(chunk, _encoding, done) { written.push(String(chunk)); onWrite?.(); done(); } }), { isTTY: true, columns: 80, rows: 24 });
    return { stdin, stdout, written };
  };
  const settledWithin = <T,>(work: Promise<T>, ms: number) => Promise.race([work, new Promise<'still-waiting'>(resolve => { setTimeout(() => resolve('still-waiting'), ms).unref(); })]);
  it('Astra 2661 P2: a card cancelled while its view is still loading returns null at once, draws nothing and never waits for input', async () => {
    const request = { title: 'x', options: [{ id: 'a', label: 'A' }] }, io = terminalPair(), controller = new AbortController();
    const asked = askCliCard(request, { locale: 'en', env: {}, stdin: io.stdin, stdout: io.stdout, signal: controller.signal });
    controller.abort(); // the gate and the first check already ran; the view module is still loading
    expect(await settledWithin(asked, 2000)).toBeNull();
    expect(io.written.join('')).toBe('');
  });
  it('J2e (C-APPROVE note): a hostile option label is drawn inert: no OSC, BEL or screen-clearing sequence from the label reaches the terminal', async () => {
    const ESC = String.fromCharCode(27), BEL = String.fromCharCode(7);
    const request = { title: 'Pick', options: [{ id: 'a', label: `evil-label${ESC}]52;c;cHduZWQ=${BEL}${ESC}[2Jtail` }, { id: 'b', label: 'B' }] }, controller = new AbortController();
    const io = terminalPair(() => controller.abort()); // the first frame drawn cancels the command
    expect(await settledWithin(askCliCard(request, { locale: 'en', env: {}, stdin: io.stdin, stdout: io.stdout, signal: controller.signal }), 2000)).toBeNull();
    const drawn = io.written.join('');
    expect(drawn).toContain('evil-label');
    expect(drawn).not.toContain(`${ESC}]52`); expect(drawn).not.toContain(BEL); expect(drawn).not.toContain(`${ESC}[2J`);
  });
  it('Astra 2661 P2: a cancellation that lands while the card mounts (before its abort listener exists) still closes it with no answer', async () => {
    const request = { title: 'x', options: [{ id: 'a', label: 'A' }] }, controller = new AbortController();
    const io = terminalPair(() => controller.abort()); // the first frame drawn cancels the command
    expect(await settledWithin(askCliCard(request, { locale: 'en', env: {}, stdin: io.stdin, stdout: io.stdout, signal: controller.signal }), 2000)).toBeNull();
    expect(controller.signal.aborted).toBe(true);
  });
});

describe('--schema and acceptance wording', () => {
  it('prints the projected input contract as JSON', () => {
    expect(schemaRequested(['run', 'create', '--schema'])).toBe(true);
    expect(schemaRequested(['run', 'create'])).toBe(false);
    const projected = zodToJsonSchema(z.object({ scopeId: z.string().min(1) }).strict(), { $refStrategy: 'none' });
    expect(JSON.parse(renderInputSchema(projected))).toMatchObject({ type: 'object', required: ['scopeId'], additionalProperties: false });
    // J1 option B: the engine's one projection helper gives the MCP tool list's exact JSON Schema (one contract, no new owner).
    expect(projectInputSchema(z.object({ scopeId: z.string().min(1) }).strict())).toEqual(projected);
    expect(() => renderInputSchema('nope')).toThrow('CLI_INPUT_SCHEMA_OBJECT_REQUIRED');
  });
  it('says what an acceptance rests on (law 1)', () => {
    expect(acceptanceEvidenceText({ id: 'process-exit', version: 1 }, 'tr')).toBe('kabul: çıkış kodu · içerik bağımsız doğrulanmadı');
    expect(acceptanceEvidenceText({ id: 'process-exit', version: 1 }, 'en')).toBe('accepted on: exit code · content not independently verified');
    expect(acceptanceEvidenceText({ id: 'beuser', version: 1 }, 'en')).toContain('harness readback');
    expect(acceptanceEvidenceText({ id: 'operation-evidence', version: 1 }, 'tr')).toBe('kabul: sistemin geri okuduğu işlem kaydı · işçi beyanı değil, sistem doğruladı');
    expect(acceptanceEvidenceText({ id: 'ext:erp-posting', version: 2 }, 'en')).toBe('accepted on: evaluator ext:erp-posting@2 · what it checks is not known to this version');
  });
});
