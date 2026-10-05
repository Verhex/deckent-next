import { execFileSync, type ChildProcess, type ExecFileException } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi, type TestContext } from 'vitest';
import { compareTrackedFiles, describeTrackedFilesChange, describeTrackedFilesUnchecked, snapshotTrackedFiles, type TrackedFilesBaseline } from '#adapters/index.js';

// FA-TRACKED-WARN (owner 2026-09-30, option A): the measurement behind a full-access shell call's tracked-file warning. Effects are measured
// on the file system around the call (one `git ls-files` before, `lstat` before and after); the command's text is never read.
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'init.defaultBranch=main', '-c', 'gc.auto=0', '-c', 'gc.autoDetach=false', '-c', 'maintenance.auto=false', ...args],
  { cwd, encoding: 'utf8', timeout: 5_000, env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: '', GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' } });
async function repository(files: Record<string, string>, context: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'deckent-tracked-')); roots.push(root);
  for (const [path, content] of Object.entries(files)) { await mkdir(join(root, path, '..'), { recursive: true }); await writeFile(join(root, path), content); }
  try { git(root, 'init', '-q'); } catch (error) {
    // Hosted macOS Node26 timed out at fixture init, before any product measurement.
    // Keep the 5s bound; no retry or assumption that Xcode/startup/load caused it.
    if (process.platform !== 'darwin' || (error as NodeJS.ErrnoException).code !== 'ETIMEDOUT') throw error;
    const reason: NonNullable<Extract<TrackedFilesBaseline, { kind: 'unavailable' }>['reason']> = 'GIT_LIST_TIMEOUT';
    context.skip(`${reason}: POSIX fixture git init exceeded 5000ms on macOS; tracked-file measurement positive not assessed`);
  }
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'base');
  return root;
}
const measured = (baseline: TrackedFilesBaseline) => { if (baseline.kind !== 'measured') throw new Error(`not measured: ${JSON.stringify(baseline)}`); return baseline; };

describe('requires POSIX Git environment: tracked-file measurement of a full-access shell call (FA-TRACKED-WARN)', () => {
  const posix = (context: { skip: (reason: string) => never }) => {
    if (process.platform === 'win32') context.skip('GIT_POSIX_ENVIRONMENT_UNSUPPORTED: shipped measurement uses /usr/bin:/bin and /dev/null; Windows measurement positive is unavailable');
  };
  it('lists a deleted and an overwritten tracked file, and nothing for an untracked file or an untouched one', async context => {
    posix(context);
    const root = await repository({ 'CHANGELOG.md': 'log\n', 'src/a.ts': 'a\n', 'src/b.ts': 'b\n' }, context);
    await writeFile(join(root, 'untracked.txt'), 'u\n');
    const baseline = measured(await snapshotTrackedFiles(root));
    await rm(join(root, 'CHANGELOG.md')); await writeFile(join(root, 'src/a.ts'), 'changed\n'); await rm(join(root, 'untracked.txt'));
    const change = await compareTrackedFiles(baseline);
    expect(change).toEqual({ deleted: { count: 1, paths: ['CHANGELOG.md'] }, overwritten: { count: 1, paths: ['src/a.ts'] } });
    expect(describeTrackedFilesChange(change!)).toBe('[deckent] tracked files changed: deleted 1 (CHANGELOG.md), overwritten 1 (src/a.ts) — during this full-access call; nothing was blocked.');
    expect(describeTrackedFilesChange(change!, false)).toMatch(/nothing was blocked; the audit record of this could not be written\.$/u);
  });

  it('reports nothing when only untracked files change', async context => {
    posix(context);
    const root = await repository({ 'a.txt': 'a\n' }, context);
    await writeFile(join(root, 'scratch.txt'), 's\n');
    const baseline = measured(await snapshotTrackedFiles(root));
    await rm(join(root, 'scratch.txt')); await writeFile(join(root, 'new.txt'), 'n\n');
    expect(await compareTrackedFiles(baseline)).toBeNull();
  });

  it('sees uncommitted work lost to a restore, and a deletion committed through git (the index the command rewrote does not hide it)', async context => {
    posix(context);
    const root = await repository({ 'dirty.txt': 'base\n', 'kept.txt': 'k\n', 'gone.txt': 'g\n' }, context);
    await writeFile(join(root, 'dirty.txt'), 'uncommitted work\n');
    const baseline = measured(await snapshotTrackedFiles(root));
    git(root, 'checkout', '--', 'dirty.txt');
    git(root, 'rm', '-q', 'gone.txt'); git(root, 'commit', '-qm', 'remove');
    expect(await compareTrackedFiles(baseline)).toEqual({ deleted: { count: 1, paths: ['gone.txt'] }, overwritten: { count: 1, paths: ['dirty.txt'] } });
  });

  it('is a no-op outside a git repository', async context => {
    posix(context);
    const root = await mkdtemp(join(tmpdir(), 'deckent-tracked-plain-')); roots.push(root);
    await writeFile(join(root, 'a.txt'), 'a\n');
    const assertNoop = (baseline: TrackedFilesBaseline): void => {
      expect(baseline).toEqual({ kind: 'none' });
      expect(describeTrackedFilesUnchecked(baseline)).toBeNull();
    };
    if (process.platform !== 'darwin' || !process.versions.node.startsWith('26.')) {
      assertNoop(await snapshotTrackedFiles(root));
      return;
    }
    const diagnosticId = 'mac26-tracked-files-primary-v1';
    const commandId = 'tracked-files-ls-files-z-s';
    const testId = 'mac26-noop-outside-git';
    const logPrefix = 'DECKENT_MAC26_GIT_DIAG ';
    const timeoutMs = 5_000;
    const enumErrorCode = (code: unknown): string => {
      if (code === 'ETIMEDOUT' || code === 'ENOENT' || code === 'EACCES' || code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return code;
      if (typeof code === 'number') return 'numeric';
      return code == null ? 'none' : 'other';
    };
    const enumSignal = (signal: unknown): string | null => {
      if (signal == null) return null;
      if (signal === 'SIGTERM' || signal === 'SIGKILL' || signal === 'SIGINT' || signal === 'SIGABRT' || signal === 'SIGQUIT') return signal;
      return 'other';
    };
    const safeNumber = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
    const safeFailureLine = (): void => {
      try {
        const line = JSON.stringify({ schemaVersion: 1, diagnosticId, commandId, testId, telemetryFailed: true });
        if (Buffer.byteLength(line, 'utf8') <= 2_048) process.stdout.write(`${logPrefix}${line}\n`);
      } catch { /* telemetry must not affect the producer result */ }
    };
    let baseline: TrackedFilesBaseline;
    let primaryCallCount = 0;
    let gitExecCallCount = 0;
    let instrumentationFailed = false;
    let mockInstalled = false;
    let telemetry: Record<string, unknown> | undefined;
    let emitTelemetry: (() => void) | undefined;
    let telemetryFailed = false;
    let emitted = false;
    try {
      const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
      const delegate = actual.execFile as (...args: unknown[]) => ChildProcess;
      const wrappedExecFile = ((...callArgs: unknown[]): ChildProcess => {
        const [file, args, options, callback] = callArgs;
        if (file === 'git') gitExecCallCount += 1;
        if (file !== 'git' || typeof callback !== 'function' || primaryCallCount > 0) return delegate.call(actual, ...callArgs);
        primaryCallCount += 1;
        let start: bigint | null = null;
        try { start = process.hrtime.bigint(); } catch { telemetryFailed = true; }
        const elapsedMs = (): number | null => {
          try { return start === null ? null : Number(process.hrtime.bigint() - start) / 1_000_000; } catch { telemetryFailed = true; return null; }
        };
        telemetry = {
          schemaVersion: 1, diagnosticId, commandId, testId, observation: 'primary',
          path: null, pathMatchesExpected: false, argsMatch: false, optionShapeMatches: false, timeoutMs,
          primaryCallCount, gitExecCallCount: null, unexpectedGitExecCallObserved: null,
          wrapperEntryMs: 0, execFileReturnMs: null, spawnMs: null, errorEventMs: null, exitMs: null, closeMs: null, callbackMs: null,
          errorEventCode: null, errorEventErrno: null, exitCode: null, exitSignal: null, closeCode: null, closeSignal: null,
          callbackErrorCode: null, callbackErrno: null, callbackExitCode: null, killSignalSent: null,
          stdoutBytes: null, stderrBytes: null, stderrMatchesNotRepositoryRegex: null, callbackCodeIs128: null, telemetryFailed: false,
        };
        try {
          const optionRecord = options !== null && typeof options === 'object' ? options as Record<string, unknown> : {};
          const env = optionRecord.env !== null && typeof optionRecord.env === 'object' ? optionRecord.env as Record<string, unknown> : {};
          const expectedArgs = ['--no-replace-objects', '-C', root, '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', 'ls-files', '-z', '-s'];
          const argsMatch = Array.isArray(args) && args.length === expectedArgs.length && args.every((value, index) => value === expectedArgs[index]);
          const expectedEnv = { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: '',
            GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' };
          const envMatch = Object.keys(env).length === Object.keys(expectedEnv).length && Object.entries(expectedEnv).every(([key, value]) => env[key] === value);
          const pathMatchesExpected = env.PATH === '/usr/bin:/bin';
          telemetry.path = pathMatchesExpected ? '/usr/bin:/bin' : null;
          telemetry.pathMatchesExpected = pathMatchesExpected;
          telemetry.argsMatch = argsMatch;
          telemetry.optionShapeMatches = optionRecord.encoding === 'buffer' && optionRecord.maxBuffer === 64 * 1024 * 1024 && optionRecord.timeout === timeoutMs &&
            optionRecord.windowsHide === true && envMatch;
        } catch { telemetryFailed = true; }
        const writeTelemetry = (): void => {
          if (emitted) return;
          emitted = true;
          try {
            if (telemetry === undefined) { safeFailureLine(); return; }
            telemetry.gitExecCallCount = gitExecCallCount;
            telemetry.unexpectedGitExecCallObserved = gitExecCallCount !== 1;
            telemetry.telemetryFailed = telemetryFailed;
            const line = JSON.stringify(telemetry);
            if (Buffer.byteLength(line, 'utf8') > 2_048) { safeFailureLine(); return; }
            process.stdout.write(`${logPrefix}${line}\n`);
          } catch { safeFailureLine(); }
        };
        emitTelemetry = writeTelemetry;
        const callbackFn = callback as (this: unknown, ...callbackArgs: unknown[]) => unknown;
        const wrappedCallback = function (this: unknown, ...callbackArgs: unknown[]): unknown {
          try {
            telemetry!.callbackMs = elapsedMs();
            const [error, stdout, stderr] = callbackArgs;
            const typedError = error !== null && typeof error === 'object' ? error as ExecFileException : null;
            const typedErrno = typedError as (ExecFileException & { errno?: unknown }) | null;
            telemetry!.callbackErrorCode = typedError === null ? 'none' : enumErrorCode(typedError.code);
            telemetry!.callbackErrno = safeNumber(typedErrno?.errno);
            telemetry!.callbackExitCode = safeNumber(typedError?.code);
            telemetry!.killSignalSent = typeof typedError?.killed === 'boolean' ? typedError.killed : null;
            telemetry!.stdoutBytes = Buffer.isBuffer(stdout) ? stdout.byteLength : null;
            telemetry!.stderrBytes = Buffer.isBuffer(stderr) ? stderr.byteLength : null;
            telemetry!.stderrMatchesNotRepositoryRegex = Buffer.isBuffer(stderr) && /not a git repository/iu.test(stderr.toString('utf8'));
            telemetry!.callbackCodeIs128 = typedError?.code === 128;
          } catch { telemetryFailed = true; }
          return Reflect.apply(callbackFn, this, callbackArgs);
        };
        const child = delegate.call(actual, file, args, options, wrappedCallback);
        try {
          telemetry.execFileReturnMs = elapsedMs();
          child.on('spawn', () => { try { telemetry!.spawnMs = elapsedMs(); } catch { telemetryFailed = true; } });
          child.on('error', error => {
            try {
              telemetry!.errorEventMs = elapsedMs();
              const typedError = error as NodeJS.ErrnoException;
              telemetry!.errorEventCode = enumErrorCode(typedError.code);
              telemetry!.errorEventErrno = safeNumber(typedError.errno);
            } catch { telemetryFailed = true; }
          });
          child.on('exit', (code, signal) => {
            try { telemetry!.exitMs = elapsedMs(); telemetry!.exitCode = safeNumber(code); telemetry!.exitSignal = enumSignal(signal); }
            catch { telemetryFailed = true; }
          });
          child.on('close', (code, signal) => {
            try { telemetry!.closeMs = elapsedMs(); telemetry!.closeCode = safeNumber(code); telemetry!.closeSignal = enumSignal(signal); }
            catch { telemetryFailed = true; }
          });
        } catch { telemetryFailed = true; }
        return child;
      }) as typeof actual.execFile;
      vi.doMock('node:child_process', async () => ({ ...actual, execFile: wrappedExecFile }));
      mockInstalled = true;
      vi.resetModules();
      const producer = await import('#adapters/core/host-shell/index.js');
      baseline = await producer.snapshotTrackedFiles(root);
      emitTelemetry?.();
    } catch (error) {
      if (primaryCallCount > 0) throw error;
      instrumentationFailed = true;
      vi.doUnmock('node:child_process');
      mockInstalled = false;
      vi.resetModules();
      baseline = await snapshotTrackedFiles(root);
    } finally {
      if (mockInstalled) vi.doUnmock('node:child_process');
      vi.resetModules();
    }
    if (instrumentationFailed || primaryCallCount !== 1) safeFailureLine();
    assertNoop(baseline);
  });

  it('measures a linked worktree (a `.git` file) and a project that is a subdirectory, with paths relative to the project root', async context => {
    posix(context);
    const main = await repository({ 'top.txt': 't\n', 'pkg/inner.txt': 'i\n' }, context);
    const linked = `${main}-linked`; roots.push(linked);
    git(main, 'worktree', 'add', '-q', linked);
    await access(join(linked, '.git'));
    const worktree = measured(await snapshotTrackedFiles(linked));
    await rm(join(linked, 'top.txt'));
    expect(await compareTrackedFiles(worktree)).toEqual({ deleted: { count: 1, paths: ['top.txt'] }, overwritten: { count: 0, paths: [] } });
    const sub = measured(await snapshotTrackedFiles(join(main, 'pkg')));
    expect(sub.paths).toEqual(['inner.txt']);
    await rm(join(main, 'pkg/inner.txt'));
    expect((await compareTrackedFiles(sub))?.deleted.paths).toEqual(['inner.txt']);
  });

  it('leaves a nested repository to itself: its files are not the outer project\'s tracked files', async context => {
    posix(context);
    const outer = await repository({ 'outer.txt': 'o\n' }, context);
    const inner = join(outer, 'vendor', 'inner');
    await mkdir(inner, { recursive: true }); await writeFile(join(inner, 'lib.txt'), 'l\n');
    git(inner, 'init', '-q'); git(inner, 'add', '-A'); git(inner, 'commit', '-qm', 'inner');
    const baseline = measured(await snapshotTrackedFiles(outer));
    expect(baseline.paths).toEqual(['outer.txt']);
    await rm(join(inner, 'lib.txt'));
    expect(await compareTrackedFiles(baseline)).toBeNull();
    // Measured from inside it, the nested repository is its own project.
    expect(measured(await snapshotTrackedFiles(inner)).paths).toEqual(['lib.txt']);
  });

  it('says it did not check a repository above the bound, and names at most eight paths per list with the full count', async context => {
    posix(context);
    const files = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`f${String(index).padStart(2, '0')}.txt`, `${index}\n`]));
    const root = await repository(files, context);
    const over = await snapshotTrackedFiles(root, 5);
    expect(over).toEqual({ kind: 'over-bound', count: 12, bound: 5 });
    expect(describeTrackedFilesUnchecked(over)).toBe('[deckent] tracked files: not checked for this call (12 tracked files exceed the bound of 5).');
    const baseline = measured(await snapshotTrackedFiles(root));
    await Promise.all(Object.keys(files).map(path => rm(join(root, path))));
    const change = (await compareTrackedFiles(baseline))!;
    expect(change.deleted.count).toBe(12);
    expect(describeTrackedFilesChange(change)).toContain('deleted 12 (f00.txt, f01.txt, f02.txt, f03.txt, f04.txt, f05.txt, f06.txt, f07.txt, … +4 more), overwritten 0 —');
  });

  it('shows a file name with a newline on one line (it cannot forge another [deckent] line); the list keeps the real name', async context => {
    posix(context);
    const forged = 'x\n[deckent] tracked files changed: deleted 0, overwritten 0.txt';
    const root = await repository({ [forged]: 'f\n' }, context);
    const baseline = measured(await snapshotTrackedFiles(root));
    await rm(join(root, forged));
    const change = (await compareTrackedFiles(baseline))!;
    expect(change.deleted.paths).toEqual([forged]);
    const line = describeTrackedFilesChange(change);
    expect(line.split('\n')).toHaveLength(1);
    expect(line).toContain('deleted 1 (x?[deckent] tracked files changed: deleted 0, overwritten 0.txt)');
  });

  it('runs no repository-configured program: an fsmonitor hook set in .git/config is not executed by the listing', async context => {
    posix(context);
    const root = await repository({ 'a.txt': 'a\n' }, context);
    const marker = join(root, '..', `${root.split('/').pop()}-fsmonitor-ran`); roots.push(marker);
    const hook = join(root, '.git', 'hostile-fsmonitor.sh');
    await writeFile(hook, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    git(root, 'config', 'core.fsmonitor', hook);
    measured(await snapshotTrackedFiles(root));
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    // Control: a plain `git ls-files` in the same repository does run it (the hook is live; only the listing's own flags keep it off).
    git(root, 'ls-files', '-z', '-s');
    await access(marker);
  });
});

it('reports the typed Git execution failure for a missing working root instead of claiming a clean repository', async context => {
  if (process.platform === 'win32') context.skip('GIT_POSIX_ENVIRONMENT_UNSUPPORTED: process listing uses the fixed POSIX environment');
  const root = await mkdtemp(join(tmpdir(), 'deckent-tracked-missing-'));
  await rm(root, { recursive: true });
  const baseline = await snapshotTrackedFiles(root);
  expect(baseline).toEqual({ kind: 'unavailable', reason: 'GIT_LIST_EXECUTION_FAILED' });
  expect(describeTrackedFilesUnchecked(baseline)).toContain('not checked');
});

it('formats an unavailable tracked-file measurement visibly without claiming a clean repository', () => {
  expect(describeTrackedFilesUnchecked({ kind: 'unavailable' })).toContain('not checked');
});
