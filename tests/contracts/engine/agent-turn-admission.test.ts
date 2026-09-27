import { expect, it } from 'vitest';
import { agentTurnAdmission } from '#engine/index.js';

// One admission formula for the runtime service (it admits the turn) and the terminal (it names the summarizing phase): the
// completion limit plus a 2 048-token safety margin stay free in the window; the next request needs room for the longest answer
// (a token is at most 4 UTF-8 bytes) and one user message of up to an eighth of the service input bound, at most 32 KiB.
it('derives the admission of a chat turn from the completion limit and the service input bound', () => {
  expect(agentTurnAdmission(128, 262_144)).toEqual({ outputReserveTokens: 128, safetyReserveTokens: 2_048, requestMaxBytes: 262_144,
    requestReserveBytes: 128 * 4 + 32_768 });
  expect(agentTurnAdmission(16_384, 80_000)).toEqual({ outputReserveTokens: 16_384, safetyReserveTokens: 2_048, requestMaxBytes: 80_000,
    requestReserveBytes: 16_384 * 4 + 10_000 });
  expect(Object.isFrozen(agentTurnAdmission(1, 8))).toBe(true);
});
