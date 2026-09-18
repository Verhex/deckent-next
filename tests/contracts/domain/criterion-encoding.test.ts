import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { criterionDefinitionSchema, encodeCriterionDefinition, CRITERION_TEXT_LIMITS } from '#domain/index.js';
const definition = { id: 'c', version: 1, description: 'Check', evaluator: { id: 'e', version: 1 }, parameters: {} };
it('bounds descriptions while allowing ordinary multiline text', () => {
  for (const description of ['x'.repeat(CRITERION_TEXT_LIMITS.maxCodeUnits + 1), 'bad\u001b[31m', 'bad\u009b31m', 'bad\u0000', 'bad\u007f']) {
    expect(criterionDefinitionSchema.safeParse({ ...definition, description }).success).toBe(false);
  }
  expect(criterionDefinitionSchema.safeParse({ ...definition, description: 'Line 1\r\n\tLine 2' }).success).toBe(true);
});
it('matches language-neutral JSON golden vectors for the complete versioned encoding', () => {
  const vectors = JSON.parse(readFileSync(new URL('../../fixtures/task-graph/criterion-encoding-v1.json', import.meta.url), 'utf8')) as
    { definition: unknown; encoded: string; sha256: string }[];
  for (const vector of vectors) {
    const encoded = encodeCriterionDefinition(vector.definition);
    expect(encoded).toBe(vector.encoded);
    expect(createHash('sha256').update(encoded, 'utf8').digest('hex')).toBe(vector.sha256);
  }
});
it('sorts numeric-like and Unicode keys explicitly and preserves JSON escaping and number semantics', () => {
  const parameters = JSON.parse('{"2":2,"10":10,"z":"line\\n\\t\\"","é":"é","😀":-0,"n":1e-7}');
  const output = encodeCriterionDefinition({ ...definition, parameters });
  expect(output).toBe('{"definition":{"description":"Check","evaluator":{"id":"e","version":1},"id":"c","parameters":{"10":10,"2":2,"n":1e-7,"z":"line\\n\\t\\"","é":"é","😀":0},"version":1},"encodingVersion":1}');
  expect(encodeCriterionDefinition({ ...definition, parameters: { a: '\ud800' } })).toContain('"a":"\\ud800"');
});
it('changes encoding on each semantic definition axis and ignores object insertion order', () => {
  const base = { ...definition, parameters: { b: 2, a: 1 } };
  const original = encodeCriterionDefinition(base);
  expect(encodeCriterionDefinition({ ...definition, parameters: { a: 1, b: 2 } })).toBe(original);
  for (const changed of [{ ...base, id: 'other' }, { ...base, version: 2 }, { ...base, description: 'Different' },
    { ...base, evaluator: { id: 'other', version: 1 } }, { ...base, evaluator: { id: 'e', version: 2 } }, { ...base, parameters: { a: 2, b: 2 } }]) {
    expect(encodeCriterionDefinition(changed)).not.toBe(original);
  }
});
