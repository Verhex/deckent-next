import { describe, expect, it } from 'vitest';
import { assessNodeSupport, NODE_ENGINE_RANGE, normalizeGlobalScopePlatform, isWslHost, detectWslLinux, describeWorkerRecommendation, calcRecommendedMaxWorkers } from '../../../src/platform/index.js';
import { HOST_LIMITS_REGISTRY } from '../../../src/platform/core/common/index.js';
import { renderDoctorReport } from '../../../src/surfaces/core/doctor/index.js';
import manifest from '../../../package.json' with { type: 'json' };

const base = { platform: 'linux', host: { cpuCores: 1, totalMemMB: 1, recommendedMaxWorkers: 1 }, company: { companyId: 'c' }, principal: { id: 'p' },
  secretStore: null, imageRefresh: null, installationBinding: null, shellRealm: null } as const;

describe('Node.js engine floor', () => {
  it('reads the floor from the manifest range and refuses 24.22.0 while accepting 24.22.1 and Node 26', () => {
    expect(NODE_ENGINE_RANGE).toBe(manifest.engines.node);
    expect(NODE_ENGINE_RANGE).toBe('>=24.22.1');
    expect(assessNodeSupport('v24.21.0', NODE_ENGINE_RANGE)).toEqual({ version: 'v24.21.0', floor: '24.22.1', status: 'unsupported' });
    expect(assessNodeSupport('v24.15.0', NODE_ENGINE_RANGE).status).toBe('unsupported');
    expect(assessNodeSupport('v24.22.0', NODE_ENGINE_RANGE).status).toBe('unsupported');
    expect(assessNodeSupport('v24.22.1', NODE_ENGINE_RANGE).status).toBe('supported');
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

describe('recommended workers show both the CPU and the memory limit', () => {
  it('takes the smaller of the two and reports each, with the estimate from the registry', () => {
    expect(describeWorkerRecommendation(36_000, 16)).toEqual({ cpuBased: 15, memoryBased: 90, workerMemoryEstimateMB: HOST_LIMITS_REGISTRY.workerMemoryEstimateMB, cap: HOST_LIMITS_REGISTRY.workerCountCap, recommended: 15 });
    expect(describeWorkerRecommendation(3_000, 16)).toMatchObject({ cpuBased: 15, memoryBased: 7, recommended: 7 });
    expect(describeWorkerRecommendation(100, 16)).toMatchObject({ memoryBased: 1, recommended: 1 });
    expect(describeWorkerRecommendation(999_999, 128).recommended).toBe(HOST_LIMITS_REGISTRY.workerCountCap);
  });
  it('honours an explicit per-worker estimate and fails closed to one on bad input', () => {
    expect(describeWorkerRecommendation(36_000, 16, 4_000)).toMatchObject({ memoryBased: 9, recommended: 9 });
    for (const bad of [[NaN, 8, 400], [1000, NaN, 400], [1000, 8, 0], [1000, 8, -5]] as const) expect(describeWorkerRecommendation(...bad).recommended).toBe(1);
    expect(calcRecommendedMaxWorkers(8000, 8)).toBe(7);
  });
  it('prints both factors in the human doctor line when the report carries them', () => {
    const host = { cpuCores: 16, totalMemMB: 36_000, recommendedMaxWorkers: 15, workerBasis: { cpuBased: 15, memoryBased: 59, workerMemoryEstimateMB: 400 } };
    expect(renderDoctorReport({ ...base, host }, [], 'en')).toContain('Recommended workers: 15 (CPU allows 15, free memory allows 59 at 400 MB per worker)');
    expect(renderDoctorReport({ ...base, host }, [], 'tr')).toContain('Önerilen worker: 15 (CPU 15 izin verir');
    expect(renderDoctorReport({ ...base }, [], 'en')).toContain('Recommended workers: 1\n');
  });
});

describe('human doctor output states the overall status first', () => {
  it('prints degraded and ready in English and Turkish, and nothing when the report has no verdict', () => {
    expect(renderDoctorReport({ ...base, status: 'degraded' }, [], 'en').split('\n')[0]).toBe('Status: degraded (see the findings below)');
    expect(renderDoctorReport({ ...base, status: 'ready' }, [], 'en').split('\n')[0]).toBe('Status: ready');
    expect(renderDoctorReport({ ...base, status: 'degraded' }, [], 'tr').split('\n')[0]).toContain('Durum: degraded');
    expect(renderDoctorReport({ ...base }, [], 'en').split('\n')[0]).toBe('Platform: linux');
  });
});
