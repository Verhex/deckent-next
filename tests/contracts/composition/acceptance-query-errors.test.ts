import { expect, it } from 'vitest';
import { CORE_WORK_CLASSES } from '#domain/index.js';
import { resolveExecutionRegistry } from '#engine/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { execution, graph } from '../domain/acceptance-fixture.js';
it('a real invalid v2 overlay admission produces the registered WORK_CLASS_OVERRIDE_DENIED error', () => {
  // A schema-valid v2 class row that redefines a Core class id (the Core seed row itself is v4 since ATAMA-1: it names a candidate list,
  // a field v2 does not have, so spreading it whole would be a schema refusal before the override rule is ever reached).
  const core = CORE_WORK_CLASSES.classes[0]!, profile = execution().workClassProfiles![0]!.profile;
  const invalid = { schemaVersion: 2, revision: 'invalid', classes: [{ id: core.id, defaultEffort: core.defaultEffort, acceptanceProfile: profile }], bindings: [] };
  try { execution(graph, invalid); throw new Error('expected admission refusal'); }
  catch (error) {
      const mapped = queryFailure(error);
      expect(mapped.code).toBe('WORK_CLASS_OVERRIDE_DENIED');
      expect(mapped.localize?.('en').message).not.toBe(mapped.localize?.('tr').message);
    }
  // The same rule on a v4 overlay: redefining a Core class, or replacing a Core candidate list without its version, is the same typed refusal.
  const v4 = { schemaVersion: 4, revision: 'invalid-v4', classes: [{ id: core.id, defaultEffort: core.defaultEffort, acceptanceProfile: profile }], bindings: [],
    evidenceExtensions: [], candidatePolicies: [] };
  const list = { ...v4, classes: [{ id: 'acme', defaultEffort: 'high', acceptanceProfile: profile }],
    candidatePolicies: [{ id: 'standard', version: 2, candidates: [{ channelId: 'c', modelId: 'm' }] }] };
  for (const overlay of [v4, list]) {
    try { execution(graph, overlay); throw new Error('expected admission refusal'); }
    catch (error) {
      const mapped = queryFailure(error);
      expect(mapped.code).toBe('WORK_CLASS_OVERRIDE_DENIED');
      expect(mapped.localize?.('en').message).not.toBe(mapped.localize?.('tr').message);
    }
  }
  expect(typeof resolveExecutionRegistry).toBe('function');
});
