import { describe, expect, it } from 'vitest';
import { MESSAGE_REGISTRY } from '../../../src/platform/index.js';

describe('TR plain terms for image use and branch advance', () => {
  const tr = MESSAGE_REGISTRY.catalogs.tr;
  it('does not say "benimse" for the worker image or "dala al" in the terminal delivery window', () => {
    for (const key of ['setup.execution.workerNone', 'doctor.firstJob.execution']) expect(tr[key]).not.toMatch(/benimse/i);
    for (const [key, text] of Object.entries(tr)) if (key.startsWith('terminal.delivery.') || key === 'terminal.slash.deliver') expect(text, key).not.toMatch(/dala al/i);
  });
});
