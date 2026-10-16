import { expect, it } from 'vitest';
import { CONFIG_FIELDS, createDefaultConfig, MESSAGE_REGISTRY } from '#platform/index.js';
it('defaults every queue bound in the registry, describes it in both locales, and refuses inconsistent policy', () => {
  const queue = createDefaultConfig().targetQueue;
  expect(queue.schemaVersion).toBe(1);
  expect(Object.keys(queue)).toEqual(expect.arrayContaining(['capacity', 'perTarget', 'activeTargets', 'batchSize', 'chainSize', 'leaseMs', 'ttlMs', 'verificationTimeoutMs', 'revalidations', 'candidateSlots']));
  expect(CONFIG_FIELDS.targetQueue.schema.safeParse({ ...queue, perTarget: queue.capacity + 1 }).success).toBe(false);
  expect(CONFIG_FIELDS.targetQueue.schema.safeParse({ ...queue, chainSize: queue.batchSize + 1 }).success).toBe(false);
  expect(CONFIG_FIELDS.targetQueue.schema.safeParse({ ...queue, leaseMs: 0 }).success).toBe(false);
  expect(CONFIG_FIELDS.targetQueue.schema.safeParse({ ...queue, revalidations: 0 }).success).toBe(true);
  for (const locale of ['en', 'tr'] as const) expect(MESSAGE_REGISTRY.catalogs[locale][CONFIG_FIELDS.targetQueue.metadata.descriptionKey]).toBeTruthy();
});
