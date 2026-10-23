import { describe, expect, it } from 'vitest';
import { ErrorRegistry } from '#platform/index.js';
import { WORK_CLASS_LIMITS } from '#domain/index.js';

describe('worker assignment refusal bounds its skipped list', () => {
  const params = { taskId: 't', workClass: 'feature', skipped: 'a/b: WORKER_MODEL_NOT_ACTIVE; c/d: WORKER_CHANNEL_NOT_ACTIVE' };
  it('takes the shown count from the registry limits', () => {
    expect(WORK_CLASS_LIMITS.refusalSkippedShown).toBeGreaterThan(0);
    expect(WORK_CLASS_LIMITS.refusalSkippedShown).toBeLessThan(WORK_CLASS_LIMITS.candidatesPerPolicy);
  });
  it('appends a localized "+N more" only when candidates were left out', () => {
    expect(ErrorRegistry.createError('WORKER_ASSIGNMENT_NONE', { locale: 'en', params }).message).not.toMatch(/more\)/);
    expect(ErrorRegistry.createError('WORKER_ASSIGNMENT_NONE', { locale: 'en', params: { ...params, skippedMore: 7 } }).message).toContain('WORKER_CHANNEL_NOT_ACTIVE; +7 more)');
    expect(ErrorRegistry.createError('WORKER_ASSIGNMENT_NONE', { locale: 'tr', params: { ...params, skippedMore: 7 } }).message).toContain('WORKER_CHANNEL_NOT_ACTIVE; +7 daha)');
  });
});
