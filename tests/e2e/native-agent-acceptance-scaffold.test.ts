import { expect, it } from 'vitest';
import { a0AcceptanceMatrix } from '../fixtures/native-agent-a0/acceptance.js';

it('keeps all F01–F12 × two CLI cells UNWALKED until the assembled PTY journey has evidence', () => {
  const matrix = a0AcceptanceMatrix();
  const expected = Array.from({ length: 12 }, (_, index) => String(index + 1).padStart(2, '0')).flatMap(number => [`F${number}-C`, `F${number}-G`]);
  expect(matrix.map(cell => cell.id)).toEqual(expected);
  expect(new Set(matrix.map(cell => cell.id)).size).toBe(24);
  for (const cell of matrix) {
    expect(cell.state).toBe('UNWALKED');
    expect(cell.evidence).toEqual([]);
    expect(cell.reason).toContain('witnessed PTY');
    expect(cell.dependencies).not.toBe('');
    expect(cell.security).toMatchObject({ preserveRiskyRequest: true, requesterIsAi: true, deciderIsWitnessedPerson: true,
      approveCardThenAssert: true, assertProtectedTargetHash: true });
  }
  matrix[0]!.state = 'UNWALKED';
  matrix[0]!.evidence.push('fixture-local-mutation');
  expect(a0AcceptanceMatrix()[0]!.evidence).toEqual([]);
});
