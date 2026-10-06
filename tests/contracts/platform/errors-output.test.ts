import { mkdtemp, rm, readFile, stat, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DeckentError, ErrorRegistry, ERROR_CODES, lintErrorRegistry, exitCodeFor, colorTier, formatHumanError,
  createEmitter, emit, formatStatus, readMemoryKnowledge, reportFatal, writeCrashArtifact, redactSensitive,
  resolveLocale, getConfigValue,
} from '../../../src/platform/index.js';

describe('errors, output and locale public contracts', () => {
  it('freezes registry authority, keeps no legacy numbered codes and returns defensive collections', () => {
    expect(ERROR_CODES.filter(code => /^DECKENT_E\d{3}$/.test(code))).toEqual([]);
    expect(ErrorRegistry.has('DECKENT_E001')).toBe(false); expect(ErrorRegistry.has('CONFIG_FILE_INVALID')).toBe(true);
    expect(lintErrorRegistry()).toEqual([]); expect(Object.isFrozen(ErrorRegistry)).toBe(true); expect('register' in ErrorRegistry).toBe(false);
    const rows = ErrorRegistry.getAll(); rows.clear(); expect(ErrorRegistry.has('CONFIG_FILE_INVALID')).toBe(true);
    expect(Object.isFrozen(ErrorRegistry.get('CONFIG_FILE_INVALID'))).toBe(true);
    expect(ErrorRegistry.createError('not-registered').message).toContain('not-registered');
    expect(ErrorRegistry.createError('DECKENT_E077').message).toContain('DECKENT_E077');
    expect(ErrorRegistry.get('constructor')).toBeUndefined();
    expect(Object.isFrozen(ErrorRegistry.get('CONFIG_FILE_INVALID')?.howToFix)).toBe(true);
    expect(formatHumanError(ErrorRegistry.createError('CONFIG_FILE_INVALID'), { noColor: true, locale: 'tr' })).toContain('eksik veya hatalı alanlar');
  });
  it('rejects a legacy numbered code and a lowercase code at the registry lint pattern (negative proof)', () => {
    expect(lintErrorRegistry()).toEqual([]);
    for (const bad of ['lower_case', 'DECKENT-E001', 'x']) expect(/^[A-Z][A-Z0-9_]+$/.test(bad)).toBe(false);
  });
  it('keeps no registered code that nothing in src references (unused-code contract)', async () => {
    const source = new Map<string, string>();
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (entry.name.endsWith('.ts') && !path.endsWith(join('errors', 'internal', 'registry.ts'))) source.set(path, await readFile(path, 'utf8'));
      }
    };
    await walk(join(process.cwd(), 'src'));
    const text = [...source.values()].join('\n');
    expect(ERROR_CODES.filter(code => !text.includes(code))).toEqual([]);
  });
  it('maps success/error/usage/config in one place and keeps degraded success at zero', () => {
    expect(exitCodeFor()).toBe(0); expect(exitCodeFor(new Error())).toBe(1);
    expect(exitCodeFor(ErrorRegistry.createError('CLI_USAGE'))).toBe(2);
    expect(exitCodeFor(ErrorRegistry.createError('CONFIG_FILE_INVALID'))).toBe(78);
    expect(exitCodeFor(new DeckentError('CUSTOM', 'detail'))).toBe(1);
  });
  it('resolves locale explicit → LANGUAGE → LANG override → config → LC_ALL → LANG → en', () => {
    expect(resolveLocale('tr', { DECKENT_LANGUAGE: 'en' }, 'en')).toBe('tr');
    expect(resolveLocale(undefined, { DECKENT_LANGUAGE: 'tr', DECKENT_LANG: 'en' })).toBe('tr');
    expect(resolveLocale(undefined, { DECKENT_LANGUAGE: '', DECKENT_LANG: 'tr' }, 'en')).toBe('tr');
    expect(resolveLocale(undefined, { LC_ALL: 'en' }, 'tr')).toBe('tr');
    expect(resolveLocale(undefined, { LC_ALL: 'tr_TR.UTF-8', LANG: 'en_US' })).toBe('tr');
    expect(resolveLocale(undefined, { LANG: 'tr_TR.UTF-8' })).toBe('tr');
    expect(resolveLocale(undefined, { LANG: 'de_DE' })).toBe('en');
  });
  it('applies color precedence and requires known dark background for inferred extended color', () => {
    expect(colorTier({ noColor: true, env: { FORCE_COLOR: '3' }, argv: [] })).toBe('none');
    expect(colorTier({ env: { FORCE_COLOR: '0' }, isTTY: true, argv: [] })).toBe('none');
    expect(colorTier({ env: { NO_COLOR: '' }, isTTY: true, argv: [] })).toBe('none');
    expect(colorTier({ env: { NO_COLOR: '', FORCE_COLOR: '2' }, argv: [] })).toBe('ansi256');
    expect(colorTier({ env: { COLORTERM: 'truecolor' }, isTTY: true, argv: [] })).toBe('ansi16');
    expect(colorTier({ env: { COLORTERM: 'truecolor', COLORFGBG: '15;0' }, isTTY: true, argv: [] })).toBe('truecolor');
    expect(colorTier({ env: { TERM: 'dumb' }, isTTY: true, argv: [] })).toBe('none');
    const plain = formatHumanError(ErrorRegistry.createError('CONFIG_FILE_INVALID', { locale: 'tr' }), { env: { NO_COLOR: '' }, isTTY: true, locale: 'tr', argv: [] });
    expect(plain).toContain('Hata:'); expect(plain).not.toContain('\x1b');
  });
  it('centralizes JSON/human routing and gives critical output an independent byte budget', () => {
    let out = '', err = '';
    const stdout = { write: (s: string) => { out += s; } }, stderr = { write: (s: string) => { err += s; } };
    emit({ n: 1 }, { json: true, stdout, stderr }); expect(JSON.parse(out)).toEqual({ n: 1 });
    const bounded = createEmitter({ normalBytes: 3, criticalBytes: 100 });
    expect(bounded('too long', { stdout, stderr })).toBe(false);
    expect(bounded('fatal', { stdout, stderr, level: 'critical' })).toBe(true); expect(err).toBe('fatal\n');
  });
  it('never presents COMPLETE as live and labels unreadable memory unknown', async () => {
    const data = { status: 'COMPLETE', activeWorkers: 5, liveRows: ['stale-live-row'] };
    expect(formatStatus(data)).not.toContain('stale-live-row');
    expect(JSON.parse(formatStatus(data, 'json'))).toMatchObject({ activeWorkers: 0, liveRows: [] });
    expect(await readMemoryKnowledge(async () => { throw new Error('unreadable'); })).toEqual({ state: 'unknown' });
    expect(formatStatus({ memory: { state: 'unknown' } }, 'verbose')).toContain('unknown');
  });
  it('writes private schema-v1 crash artifacts, redacts secrets and does not throw on fatal IO failures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deckent-crash-'));
    try {
      const path = await writeCrashArtifact(new Error('password=sample-secret'), root, ['deckent', '--token=another-secret'], {});
      expect(path).not.toBeNull();
      const bytes = await readFile(path!, 'utf8'); expect(bytes).not.toContain('sample-secret'); expect(bytes).not.toContain('another-secret');
      expect(JSON.parse(bytes)).toMatchObject({ schemaVersion: 1, name: 'Error' });
      if (process.platform !== 'win32') expect((await stat(path!)).mode & 0o777).toBe(0o600);
      await writeFile(join(root, 'not-directory'), 'x');
      expect(await writeCrashArtifact(new Error('x'), root, [], { DECKENT_HOME: join(root, 'not-directory') })).toBeNull();
      expect(await reportFatal(new Error('x'), { root, env: {}, stderr: { write() { throw new Error('broken pipe'); } } })).toBe(1);
      const hostile = new Proxy({}, { getPrototypeOf() { throw new Error('hostile object'); } });
      expect(await reportFatal(hostile, { root, env: {}, stderr: { write() {} } })).toBe(1);
      expect((await readdir(join(root, '.deckent/crashes'))).some(name => name.endsWith('.tmp'))).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('redacts admitted bearer, URL passwords, bounded argv assignments and environment assignments', () => {
    for (const text of ['Bearer example-secret-12345', 'https://user:example-secret@host', '--password=example-secret', 'API_KEY=example-secret']) expect(redactSensitive(text)).not.toContain('example-secret');
    expect(() => getConfigValue({}, 'constructor')).toThrow();
  });
});
