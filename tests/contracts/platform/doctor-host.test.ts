import { describe, expect, it } from 'vitest';
import { assessNodeSupport, NODE_ENGINE_RANGE, normalizeGlobalScopePlatform, isWslHost, detectWslLinux } from '../../../src/platform/index.js';
import { renderDoctorReport } from '../../../src/surfaces/core/doctor/index.js';
import manifest from '../../../package.json' with { type: 'json' };

const base = { platform: 'linux', host: { cpuCores: 1, totalMemMB: 1, recommendedMaxWorkers: 1 }, company: { companyId: 'c' }, principal: { id: 'p' },
  secretStore: null, imageRefresh: null, installationBinding: null, shellRealm: null } as const;

describe('Node.js engine floor', () => {
  it('reads the floor from the manifest range and refuses 24.21 while accepting 24.22 and Node 26', () => {
    expect(NODE_ENGINE_RANGE).toBe(manifest.engines.node);
    expect(NODE_ENGINE_RANGE).toBe('>=24.22.0');
    expect(assessNodeSupport('v24.21.0', NODE_ENGINE_RANGE)).toEqual({ version: 'v24.21.0', floor: '24.22.0', status: 'unsupported' });
    expect(assessNodeSupport('v24.15.0', NODE_ENGINE_RANGE).status).toBe('unsupported');
    expect(assessNodeSupport('v24.22.0', NODE_ENGINE_RANGE).status).toBe('supported');
    expect(assessNodeSupport('v24.30.1', NODE_ENGINE_RANGE).status).toBe('supported');
    expect(assessNodeSupport('v26.10.0', NODE_ENGINE_RANGE).status).toBe('supported');
    expect(assessNodeSupport('v22.99.0', NODE_ENGINE_RANGE).status).toBe('unsupported');
  });
  it('is unknown, never supported, for an unparsable version or range', () => {
    expect(assessNodeSupport('banana', NODE_ENGINE_RANGE).status).toBe('unknown');
    expect(assessNodeSupport('v26.0.0', '^24').status).toBe('unknown');
  });
  it('tells the human to update Node.js in English and Turkish only when the version is unsupported', () => {
    const node = assessNodeSupport('v24.21.0', NODE_ENGINE_RANGE);
    expect(renderDoctorReport({ ...base, node }, [], 'en')).toContain('update Node.js');
    expect(renderDoctorReport({ ...base, node }, [], 'tr')).toContain('Node.js sürümünü güncelleyin');
    expect(renderDoctorReport({ ...base, node: assessNodeSupport('v26.10.0', NODE_ENGINE_RANGE) }, [], 'en')).not.toContain('update Node.js');
  });
});

describe('WSL detection without the WSL environment variables (systemd user service)', () => {
  const WSL_RELEASE = '6.18.54.1-microsoft-standard-WSL2\n', PLAIN_RELEASE = '6.8.0-45-generic\n';
  it('keeps the environment variables first and never reads the kernel when they decide', () => {
    const forbidden = () => { throw new Error('must not read'); };
    expect(normalizeGlobalScopePlatform('linux', { WSL_DISTRO_NAME: 'Ubuntu' }, forbidden)).toBe('wsl');
    expect(normalizeGlobalScopePlatform('linux', { WSL_INTEROP: '/run/WSL/1_interop' }, forbidden)).toBe('wsl');
  });
  it('falls back to the kernel identity: microsoft/WSL means wsl, anything else, unreadable or failing means linux', () => {
    expect(normalizeGlobalScopePlatform('linux', {}, () => WSL_RELEASE)).toBe('wsl');
    expect(normalizeGlobalScopePlatform('linux', {}, () => 'Linux version 5.15.0-microsoft-standard-WSL2 (gcc)')).toBe('wsl');
    expect(normalizeGlobalScopePlatform('linux', {}, () => PLAIN_RELEASE)).toBe('linux');
    expect(normalizeGlobalScopePlatform('linux', {}, () => null)).toBe('linux');
    expect(normalizeGlobalScopePlatform('linux', {}, () => { throw new Error('EACCES'); })).toBe('linux');
    expect(normalizeGlobalScopePlatform('linux', {}, () => '')).toBe('linux');
  });
  it('shares the decision with the drive-path rule and ignores the kernel for other platforms', () => {
    expect(isWslHost('linux', {}, () => WSL_RELEASE)).toBe(true);
    expect(isWslHost('linux', {}, () => PLAIN_RELEASE)).toBe(false);
    expect(isWslHost('darwin', {}, () => WSL_RELEASE)).toBe(false);
    expect(isWslHost('wsl', {}, () => null)).toBe(true);
  });
  it('bounds what it examines to the first bytes of the kernel text', () => {
    expect(detectWslLinux({}, () => 'x'.repeat(600) + 'microsoft')).toBe(false);
  });
  it('does not let a real /proc leak into an injected environment', () => {
    expect(normalizeGlobalScopePlatform('linux', {})).toBe('linux');
  });
});
