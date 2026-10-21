import { expect, it } from 'vitest';
import { ErrorRegistry } from '#platform/index.js';
import { runProgressionErrorText } from '#surfaces/core/cli-admin/index.js';
// PRE-7 phase 2 (lead Q5): the service journal names an environment park as a park for the environment, never "could not continue".
const query = { scopeId: 'demo', runId: 'r1' };
it('an environment refusal reads as a Run parked for its environment, naming the requirement (EN/TR); other failures keep their line', () => {
  const error = ErrorRegistry.createError('EXECUTION_ENVIRONMENT_NOT_READY', { params: { requirement: 'tsc', kind: 'executable', target: 'tsc', registered: 'yes' } });
  const en = runProgressionErrorText(query, error, 'en'), tr = runProgressionErrorText(query, error, 'tr');
  expect(en).toContain('demo/r1: Run parked for its environment: requirement tsc is not met'); expect(en).not.toContain('could not continue');
  expect(tr).toContain("demo/r1: Run ortamı için park edildi: tsc gereksinimi karşılanmıyor"); expect(tr).not.toContain('could not continue');
  // REVISE 2691: an unproven probe end is named as uncertain with its probe container, also not "could not continue".
  const uncertain = ErrorRegistry.createError('EXECUTION_ENVIRONMENT_UNCERTAIN', { params: { requirement: 'tsc', kind: 'executable', probe: 'deckent-env-abc' } });
  expect(runProgressionErrorText(query, uncertain, 'en')).toContain('demo/r1: Run parked for its environment: the probe for requirement tsc could not be proven removed (deckent-env-abc)');
  expect(runProgressionErrorText(query, uncertain, 'tr')).toContain('deckent-env-abc'); expect(runProgressionErrorText(query, uncertain, 'tr')).not.toContain('could not continue');
  const other = ErrorRegistry.createError('EXECUTION_NOT_CONFIGURED');
  expect(runProgressionErrorText(query, other, 'en')).toContain('Run progression could not continue: EXECUTION_NOT_CONFIGURED');
});
