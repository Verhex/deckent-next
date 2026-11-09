import { mkdtemp, rm, readFile, stat, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DeckentError, ErrorRegistry, ERROR_CODES, lintErrorRegistry, exitCodeFor, colorTier, formatHumanError,
  createEmitter, emit, formatStatus, readMemoryKnowledge, reportFatal, writeCrashArtifact, redactSensitive,
  resolveLocale, getConfigValue, unexpectedQueryFailure, CodedError, isCodedError, errorCodeOf, isAbsent, t,
} from '../../../src/platform/index.js';
import { CodedError as DomainCodedError, isCodedError as isDomainCodedError } from '../../../src/domain/index.js';

describe('errors, output and locale public contracts', () => {
  it('freezes registry authority, keeps no legacy numbered codes and returns defensive collections', () => {
    expect(ERROR_CODES.filter(code => /^DECKENT_E\d{3}$/.test(code))).toEqual([]);
    expect(ErrorRegistry.has('DECKENT_E001')).toBe(false); expect(ErrorRegistry.has('CONFIG_FILE_INVALID')).toBe(true);
    expect(lintErrorRegistry()).toEqual([]); expect(Object.isFrozen(ErrorRegistry)).toBe(true); expect('register' in ErrorRegistry).toBe(false);
    const rows = ErrorRegistry.getAll(); rows.clear(); expect(ErrorRegistry.has('CONFIG_FILE_INVALID')).toBe(true);
    expect(Object.isFrozen(ErrorRegistry.get('CONFIG_FILE_INVALID'))).toBe(true);
    expect(ErrorRegistry.createError('not-registered').message).toContain('not-registered');
    expect(ErrorRegistry.createError('DECKENT_E077').message).toContain('DECKENT_E077');
    for (const code of ['AGENT_USE_PIN_MISMATCH', 'AGENT_USE_TASK_UNAVAILABLE', 'AGENT_USE_WORK_CLASS_REQUIRED', 'AGENT_USE_CATALOG_UNAVAILABLE', 'MCP_TOOL_SUMMARY_UNAVAILABLE']) {
      for (const locale of ['en', 'tr'] as const) {
        const error = ErrorRegistry.createError(code, { locale, params: { name: 'lookup' } });
        expect(error.code).toBe(code); expect(error.message).toBe(t(`error.${code}` as Parameters<typeof t>[0], { name: 'lookup' }, locale));
        expect(formatHumanError(error, { noColor: true, locale })).toContain(error.message);
        expect(error.message).not.toContain('{');
      }
    }
    expect(ErrorRegistry.createError('MCP_TOOL_SUMMARY_UNAVAILABLE').category).toBe('usage');

    expect(ErrorRegistry.get('constructor')).toBeUndefined();
    expect(Object.isFrozen(ErrorRegistry.get('CONFIG_FILE_INVALID')?.howToFix)).toBe(true);
    expect(formatHumanError(ErrorRegistry.createError('CONFIG_FILE_INVALID'), { noColor: true, locale: 'tr' })).toContain('eksik veya hatalı alanlar');
    // KG14 F-H2c: a plain code renders its own catalog sentence (any family prefix) with the caller's params and keeps its exit category.
    for (const locale of ['en', 'tr'] as const) expect([ErrorRegistry.get('AGENT_CATALOG_UNAVAILABLE', locale, { id: 'a' })?.message, ErrorRegistry.get('NATIVE_WORKER_F08_INVALID', locale)?.message,
      ErrorRegistry.createError('AUDIT_RECORD_NOT_FOUND').category]).toEqual([t('error.AGENT_CATALOG_UNAVAILABLE', { id: 'a' }, locale), t('headless.agent.worker.NATIVE_WORKER_F08_INVALID', {}, locale), 'usage']);
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
  it('KG14 H1: the coded-error brand passes both twins, a subclass and a separately distributed copy; a wire or spoofed { code } does not', () => {
    class Twin extends DomainCodedError<'TWIN_REFUSED'> {}
    class EnterpriseCopy extends Error { readonly code = 'COPY_REFUSED'; }
    Object.defineProperty(EnterpriseCopy.prototype, Symbol.for('deckent.coded-error'), { value: true });
    const cause = new Error('inner'), typed = new CodedError('PLATFORM_REFUSED', { params: { id: 'a' }, cause }), twin = new Twin('TWIN_REFUSED');
    expect([typed.message, typed.name, typed.params, typed.cause, twin.name, twin.params, 'cause' in twin]).toEqual(['PLATFORM_REFUSED', 'CodedError', { id: 'a' }, cause, 'Twin', undefined, false]);
    expect([isCodedError(typed, 'PLATFORM_REFUSED'), isDomainCodedError(typed, 'PLATFORM_REFUSED'), isCodedError(twin, 'TWIN_REFUSED'), isCodedError(new EnterpriseCopy(), 'COPY_REFUSED')]).toEqual([true, true, true, true]);
    const wire = JSON.parse(JSON.stringify(typed)) as unknown, spoofed = Object.assign(new Error('PLATFORM_REFUSED'), { code: 'PLATFORM_REFUSED' });
    expect([isCodedError(typed, 'OTHER'), isCodedError(wire, 'PLATFORM_REFUSED'), isCodedError(spoofed, 'PLATFORM_REFUSED'), isCodedError(null, 'X'), isCodedError('PLATFORM_REFUSED', 'PLATFORM_REFUSED')]).toEqual([false, false, false, false, false]);
    expect([errorCodeOf(wire), errorCodeOf(spoofed), errorCodeOf({ code: 7 }), errorCodeOf(undefined)]).toEqual(['PLATFORM_REFUSED', 'PLATFORM_REFUSED', null, null]);
    const errno = (code: string) => Object.assign(new Error(code), { code });
    expect([isAbsent(errno('ENOENT')), isAbsent(errno('ENOTDIR')), isAbsent(errno('ENOTDIR'), { notDir: true }), isAbsent(errno('EACCES'), { notDir: true }), isAbsent(null)]).toEqual([true, false, true, false, false]);
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
  it('BeUser E-05: an unexpected query failure of a local command leaves a private record under its diagnostic id and the error line names it; without the installation\'s known secrets no detail is kept', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deckent-diag-'));
    try {
      const failure = unexpectedQueryFailure(new Error('boom password=sample-secret')), id = String(failure.params?.['diagnosticId']);
      let text = '';
      expect(await reportFatal(failure, { root, env: {}, locale: 'en', argv: ['deckent', 'hub'], stderr: { write(value: string) { text += value; } } })).toBe(1);
      const name = (await readdir(join(root, '.deckent/crashes'))).find(entry => entry.includes(id))!;
      const path = join(root, '.deckent/crashes', name), record = JSON.parse(await readFile(path, 'utf8'));
      // No readable installation config here, so no known-secret snapshot: the record keeps code, time, command and id only (fail closed).
      expect(record).toMatchObject({ schemaVersion: 1, diagnosticId: id, name: 'QUERY_UNEXPECTED_FAILURE', message: '' });
      expect(JSON.stringify(record)).not.toContain('sample-secret'); expect(text).toContain(id); expect(text).toContain(path);
      if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('redacts admitted bearer, URL passwords, bounded argv assignments and environment assignments', () => {
    for (const text of ['Bearer example-secret-12345', 'https://user:example-secret@host', '--password=example-secret', 'API_KEY=example-secret']) expect(redactSensitive(text)).not.toContain('example-secret');
    expect(() => getConfigValue({}, 'constructor')).toThrow();
  });
});

// Merge regression: the existing config/spending witness guidance and uninstall's person-only guidance share one code.
it('keeps contextual witness guidance in both locales and never offers an automatic unit card when disable is refused', () => {
  for (const locale of ['en', 'tr'] as const) {
    const witness = (operation: string) => formatHumanError(ErrorRegistry.createError('AUTHORITY_WITNESS_REQUIRED', { params: { operation } }), { noColor: true, locale });
    expect(witness('config set permission_mode')).toContain('permission_mode');
    expect(witness('models.create-budget')).toContain('deckent models create-budget');
    expect(witness('models.reconcile-spending')).toContain('deckent models reconcile-spending');
    expect(witness('manageProviderSpend')).toContain('deckent models revise-budget');
    expect(witness('uninstall')).toContain('deckent uninstall --dry-run');
    expect(witness('uninstall')).toContain('CI');
    const command = 'systemctl --user disable --now deckent.service';
    const refused = formatHumanError(ErrorRegistry.createError('UNINSTALL_SERVICE_RUNNING', { params: { unit: 'deckent.service', command } }), { noColor: true, locale });
    expect(refused).toContain(command);
    expect(refused).not.toContain('deckent uninstall --disable-unit');
  }
});
