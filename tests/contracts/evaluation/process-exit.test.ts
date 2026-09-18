import { expect, it } from 'vitest';
import {
  evaluateProcessExit, PROCESS_EXIT_EVALUATOR, validateProcessExitCriterion,
} from '#capabilities/index.js';

const criterion = (parameters = { acceptedExitCodes: [0] }) => ({
  id: 'completed', version: 1, description: 'Process completed',
  evaluator: { id: PROCESS_EXIT_EVALUATOR.id, version: PROCESS_EXIT_EVALUATOR.version }, parameters,
});

it('installs the exact process-exit evaluator and validates criterion parameters', () => {
  expect(PROCESS_EXIT_EVALUATOR).toEqual({ id: 'process-exit', version: 1, implementation: { id: 'process-exit', version: 1 } });
  expect(validateProcessExitCriterion(PROCESS_EXIT_EVALUATOR, criterion())).toBeUndefined();
  expect(validateProcessExitCriterion(PROCESS_EXIT_EVALUATOR, criterion({ acceptedExitCodes: [7, 9] }))).toBeUndefined();
});

it('rejects mismatched implementations, empty or duplicate codes, and unknown parameters', () => {
  expect(() => validateProcessExitCriterion({ id: 'other', version: 1, implementation: { id: 'other', version: 1 } }, criterion())).toThrow('PROCESS_EXIT_EVALUATOR_MISMATCH');
  expect(validateProcessExitCriterion({ id: 'custom-data', version: 9, implementation: PROCESS_EXIT_EVALUATOR.implementation }, { ...criterion(), evaluator: { id: 'custom-data', version: 9 } })).toBeUndefined();
  expect(() => validateProcessExitCriterion(PROCESS_EXIT_EVALUATOR, criterion({ acceptedExitCodes: [] }))).toThrow();
  expect(() => validateProcessExitCriterion(PROCESS_EXIT_EVALUATOR, criterion({ acceptedExitCodes: [0, 0] }))).toThrow('PROCESS_EXIT_CODES_DUPLICATE');
  expect(() => validateProcessExitCriterion(PROCESS_EXIT_EVALUATOR, criterion({ acceptedExitCodes: [0], extra: true } as never))).toThrow();
});

it('returns only deterministic pass or fail from validated exit evidence', () => {
  expect(evaluateProcessExit({ acceptedExitCodes: [0] }, { exitCode: 0 })).toBe('pass');
  expect(evaluateProcessExit({ acceptedExitCodes: [7] }, { exitCode: 0 })).toBe('fail');
  expect(evaluateProcessExit({ acceptedExitCodes: [7] }, { exitCode: 7 })).toBe('pass');
  expect(evaluateProcessExit({ acceptedExitCodes: [0] }, { exitCode: null, signal: 'SIGTERM' })).toBe('fail');
  expect(() => evaluateProcessExit({ acceptedExitCodes: [0] }, { exitCode: 0, signal: 'SIGTERM' })).toThrow();
});
