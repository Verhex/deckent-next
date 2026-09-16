import { mkdtemp, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir, userInfo, hostname } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import {
  resolveGlobalScopePaths, normalizeGlobalScopePlatform, resolveGlobalConfigPaths,
  resolveDeckentHome, resolveBrainHome, validatePath, validateExistingPath, validateTaskId,
  suggestMaxWorkers, calcRecommendedMaxWorkers, suggestMaxWorkersFromCapacity,
  detectHostMemory, getSystemProfile, detectEnvironment, resolveLocalOsPrincipal, resolveLocalOsActorId,
  principalToActor, assertActorAssurance, resolveCallerTenant, isValidTenantId, tenantIsolationPath,
  resolveTenant, withTenant, currentTenant, tenantPath,
} from '../../../src/kernel/index.js';

describe('platform and identity contracts', () => {
  it('resolves all supported platform roles with the injected path backend', () => {
    expect(resolveGlobalScopePaths('linux', { HOME: '/users/a' })).toMatchObject({ configDir: '/users/a/.config/deckent', dataDir: '/users/a/.local/share/deckent', stateDir: '/users/a/.local/state/deckent', cacheDir: '/users/a/.cache/deckent' });
    expect(resolveGlobalScopePaths('wsl', { HOME: '/users/a', XDG_CONFIG_HOME: '/cfg' }).configDir).toBe('/cfg/deckent');
    expect(resolveGlobalScopePaths('darwin', { HOME: '/Users/a' })).toMatchObject({ configDir: '/Users/a/Library/Application Support/deckent', cacheDir: '/Users/a/Library/Caches/deckent' });
    expect(resolveGlobalScopePaths('win32', { USERPROFILE: 'C:\\Users\\a' })).toMatchObject({ configDir: 'C:\\Users\\a\\AppData\\Roaming\\deckent', stateDir: 'C:\\Users\\a\\AppData\\Local\\deckent' });
    expect(resolveGlobalConfigPaths({ HOMEDRIVE: 'D:', HOMEPATH: '\\users\\a', APPDATA: 'E:\\roaming' }, 'win32')).toEqual({ platformPath: 'E:\\roaming\\deckent\\config.json', legacyPath: 'D:\\users\\a\\.deckent\\config.json' });
  });
  it('honors override and empty env semantics without pretending unsupported platforms work', () => {
    expect(resolveGlobalScopePaths('linux', { DECKENT_HOME: '/isolated' })).toMatchObject({ source: 'env-override', home: null, configDir: '/isolated', stateDir: '/isolated' });
    expect(resolveGlobalScopePaths('linux', { HOME: '/h', XDG_CONFIG_HOME: '' }).configDir).toBe('/h/.config/deckent');
    expect(normalizeGlobalScopePlatform('linux', { WSL_INTEROP: 'on' })).toBe('wsl');
    expect(() => normalizeGlobalScopePlatform('freebsd', { DECKENT_HOME: '/x' })).toThrow();
    expect(() => resolveGlobalScopePaths('linux', {})).toThrow();
  });
  it('keeps DECKENT_HOME and BRAIN_HOME independent and uses call-time overrides', () => {
    const env = { HOME: '/h', DECKENT_HOME: '/state', BRAIN_HOME: '/memory' };
    expect(resolveDeckentHome('/project', { env, platform: 'linux' })).toBe('/state');
    expect(resolveBrainHome('/project', { env, platform: 'linux' })).toBe('/memory');
    expect(resolveBrainHome('/project', { env: { ...env, BRAIN_HOME: '' }, platform: 'linux' })).toBe('/project/.brain');
    expect(resolveBrainHome(undefined, { env: { HOME: '/h', DECKENT_HOME: '/state' }, platform: 'linux' })).toBe('/h/.brain');
    expect(resolveDeckentHome('C:\\project', { env: {}, platform: 'win32' })).toBe('C:\\project\\.deckent');
  });
  it('rejects POSIX and Windows traversal, sibling-prefix tricks, drive changes and ADS', () => {
    expect(validatePath('/safe', './child', 'linux')).toBe('/safe/child');
    expect(validatePath('C:\\safe', 'child', 'win32')).toBe('C:\\safe\\child');
    expect(validatePath('C:\\safe', 'c:\\SAFE\\child', 'win32')).toBe('c:\\SAFE\\child');
    for (const path of ['../escape', '/safe-other/file', '/etc/passwd', 'x\0y']) expect(() => validatePath('/safe', path, 'linux')).toThrow();
    for (const path of ['..\\escape', 'C:\\safe-other\\file', 'D:\\safe\\file', '\\\\server\\share\\file', 'file:secret', 'child.']) expect(() => validatePath('C:\\safe', path, 'win32')).toThrow();
  });
  it('checks physical containment for existing symlinks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deckent-path-'));
    try {
      const safe = join(root, 'safe'), outside = join(root, 'outside'); await mkdir(safe); await mkdir(outside);
      await symlink(outside, join(safe, 'escape'), 'dir');
      await expect(validateExistingPath(safe, 'escape')).rejects.toMatchObject({ code: 'PATH_TRAVERSAL' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('validates identifiers without importing orchestration phase vocabularies', () => {
    expect(validateTaskId('task-001_a')).toBe('task-001_a');
    for (const id of ['', '../a', 'x'.repeat(101), 'a\0']) expect(() => validateTaskId(id)).toThrow();
  });
  it('preserves the three distinct worker-sizing algorithms and bounds pathological inputs', () => {
    expect(suggestMaxWorkers(16)).toBe(7); expect(suggestMaxWorkers(1000)).toBe(16); expect(suggestMaxWorkers(NaN)).toBe(1);
    expect(suggestMaxWorkers(4, 0)).toBe(1); expect(suggestMaxWorkers(0.5)).toBe(1);
    expect(calcRecommendedMaxWorkers(8000, 8)).toBe(7); expect(calcRecommendedMaxWorkers(999999, 128)).toBe(30);
    expect(suggestMaxWorkersFromCapacity({ totalRamGB: 12, cpuCores: 8 })).toBe(4);
    expect(suggestMaxWorkersFromCapacity({ totalRamGB: 12, cpuCores: 4 })).toBe(3);
    expect(getSystemProfile(() => ({ cpuCores: 4, totalBytes: 8 * 1024 ** 3, freeBytes: 1024 ** 3 }))).toEqual({ cpuCores: 4, totalMemMB: 8192, freeMemMB: 1024, recommendedMaxWorkers: 2 });
  });
  it('reads Linux proc memory and uses the documented OS fallback elsewhere', () => {
    expect(detectHostMemory({ platform: 'linux', readMeminfo: () => 'MemTotal: 8000000 kB\n', totalBytes: () => 1 })).toEqual({ totalGB: 8.2, source: 'meminfo' });
    expect(detectHostMemory({ platform: 'linux', readMeminfo: () => { throw new Error('denied'); }, totalBytes: () => 8e9 })).toEqual({ totalGB: 8, source: 'os.totalmem' });
    expect(detectHostMemory({ platform: 'win32', readMeminfo: () => { throw new Error('must not read'); }, totalBytes: () => 4e9 })).toEqual({ totalGB: 4, source: 'os.totalmem' });
  });
  it('preserves environment precedence under multiple host markers', () => {
    expect(detectEnvironment({ VSCODE_PID: '1', CURSOR_SESSION: '1', CODEX_SESSION: '1' })).toBe('vscode');
    expect(detectEnvironment({ CURSOR_SESSION: '1', CODEX_SESSION: '1' })).toBe('cursor');
    expect(detectEnvironment({ CODEX_SESSION: '1', GEMINI_CLI: '1' })).toBe('codex');
    expect(detectEnvironment({ GEMINI_CLI: '1', TMUX: '1' })).toBe('gemini');
    expect(detectEnvironment({ TMUX: '1' })).toBe('tmux'); expect(detectEnvironment({})).toBe('shell');
  });
  it('uses the real OS principal, degrades honestly on lookup failure and enforces only when enabled', () => {
    const principal = resolveLocalOsPrincipal('cli'); expect(principal.id).toBe(`${userInfo().username}@${hostname()}`); expect(principal.assurance).toBe('os-user');
    const degraded = resolveLocalOsPrincipal('mcp', { user: () => { throw new Error('unavailable'); }, host: () => 'test-host', uid: () => 123 });
    expect(degraded.id).toBe('local-uid-123@test-host'); expect(degraded.assurance).toBe('unverified');
    expect(resolveLocalOsActorId(() => ({}))).toBeNull();
    expect(assertActorAssurance(principalToActor(degraded), 'test')).toMatchObject({ ok: false });
    expect(() => assertActorAssurance(principalToActor(degraded), 'test', true)).toThrow();
    expect(() => assertActorAssurance(principalToActor(principal), 'test', true)).not.toThrow();
  });
  it('validates tenant identifiers at resolution and path creation and preserves precedence', () => {
    const root = '/project', env = { DECKENT_TENANT_ID: 'environment', DECKENT_HOME: '/state' };
    expect(resolveTenant(root, { tenantId: 'explicit', env, platform: 'linux' }).tenantId).toBe('explicit');
    expect(resolveTenant(root, { env, platform: 'linux' }).isolationRoot).toBe('/state/tenants/environment');
    expect(resolveTenant(root, { env: {}, platform: 'linux' }).tenantId).toBe('local');
    for (const id of ['../other', 'UPPER', '', 'a'.repeat(64)]) {
      expect(isValidTenantId(id)).toBe(false); expect(() => resolveTenant(root, { tenantId: id })).toThrow(); expect(() => tenantIsolationPath(root, id)).toThrow();
    }
    expect(() => resolveCallerTenant({ id: 'one' }, true)).toThrow();
    expect(() => resolveCallerTenant({ id: 'one', tenantId: '../bad' }, false)).toThrow();
    expect(resolveCallerTenant({ id: 'one' }, false)).toBe('local');
  });
  it('isolates concurrent async tenant scopes and refuses tenantPath escapes', async () => {
    const result = await Promise.all(['a', 'b'].map(id => withTenant(id, '/project', async () => { await sleep(5); expect(() => tenantPath('../other')).toThrow(); return currentTenant().tenantId; })));
    expect(result).toEqual(['a', 'b']);
  });
});
