import { expect, it, vi } from 'vitest';
import type { OnboardingPort, OnboardingPresentation } from '#surfaces/core/terminal-onboarding/index.js';

// The question card itself is Ink on a TTY; here only the answers and the shown bodies matter.
const shown: string[][] = [];
vi.mock('../../../src/surfaces/core/terminal-onboarding/internal/question.js', () => ({
  askOnboardingQuestion: async (question: { body: readonly string[] }) => { shown.push([...question.body]); return { id: 'apply' }; } }));

const model = { schemaVersion: 1, steps: [], completed: 0, total: 2, snapshot: { scopeId: 's', rights: { state: 'needed', digest: 'd'.repeat(64), rules: 4 } } } as unknown as OnboardingPresentation;
it.each([['applied', 'applied', 'Your management rights are given.'], ['conflict', 'later', 'The rights were not given (conflict']] as const)(
  'Astra D11-M1 / AYSE-R2-02: a founder-card apply that returns %s is %s, and the screen says so', async (status, outcome, text) => {
  const { guideScreen } = await import('../../../src/surfaces/core/terminal-onboarding/internal/guides.js');
  shown.length = 0; const applied: string[] = [];
  const port = { assertPerson: async () => {}, rights: async (digest: string) => { applied.push(digest); return { status }; } } as unknown as OnboardingPort;
  expect(await guideScreen(model, 'rights', port, { locale: 'en' })).toBe(outcome);
  expect(applied).toEqual(['d'.repeat(64)]); expect(shown.at(-1)!.join('\n')).toContain(text);
});
