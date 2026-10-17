import { describe, expect, it } from 'vitest';
import { assessNodeSupport, NODE_ENGINE_RANGE } from '../../../src/platform/index.js';
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
