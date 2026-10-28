import { expect, it } from 'vitest';
import { formatBeuserReport } from '#surfaces/core/cli-beuser/index.js';

// Synthetic report data exercises presentation only; these are not measured BeUser quality or cost results.
const report = () => ({ schemaVersion: 1, simulated: true, calibrationClaim: 'uncalibrated', cohort: 'fixture',
  calibration: { revision: 'fixture-v1', cohort: 'fixture', trapHits: 0, trapTotal: 0, falseRed: 0, goodTotal: 0,
    minimumHitRate: 1, maximumFalseRedRate: 0, k: 1, retries: 0 },
  counts: { defined: 2, selected: 1, walked: 0, concurrent: 0 }, segments: [{ segment: 'onboarding', verdict: null,
    broken: [], friction: [], delight: [], evidenceRefs: [], nextOwner: 'integration' }],
  unwalked: [{ branch: 'systemd', reason: 'capability-unavailable' }],
  unknown: [{ branch: 'uninstall-backup', reason: 'BACKUP_REALM_SEALED' }], criticalCoverage: [],
  reliability: { attempted: 0, completed: 0 }, cost: null, currency: 'USD', elapsedMs: null });

it('preserves a locale-free JSON document and null measurements while human reports name unwalked and unknown branches', () => {
  const value = report(), en = formatBeuserReport(value, { json: true, locale: 'en' }), tr = formatBeuserReport(value, { json: true, locale: 'tr' });
  expect(en).toBe(tr); expect(JSON.parse(tr)).toEqual(value);
  const human = formatBeuserReport(value, { json: false, locale: 'tr' });
  expect(human).toContain('Simüle'); expect(human).toContain('kalibre edilmemiş'); expect(human).toContain('bilinmiyor');
  expect(human).toContain('systemd'); expect(human).toContain('uninstall-backup'); expect(human).toContain('BACKUP_REALM_SEALED');
  expect(human).not.toBe(formatBeuserReport(value, { json: false, locale: 'en' }));
});

it('rejects fabricated acceptance labels, impossible counts and control sequences in report identities', () => {
  const value = report();
  expect(() => formatBeuserReport({ ...value, calibrationClaim: 'verified' }, { json: true, locale: 'en' })).toThrow();
  expect(() => formatBeuserReport({ ...value, counts: { ...value.counts, walked: 2 } }, { json: false, locale: 'tr' })).toThrow();
  value.segments[0]!.segment = '\u001b]52;c;hidden\u0007onboarding\nforged';
  expect(() => formatBeuserReport(value, { json: false, locale: 'en' })).toThrow();
});

it('shows EN/TR walk/report help without a host effect and refuses incomplete, duplicate and authority-bearing arguments', async () => {
  const { beuserCommand, parseBeuserArguments } = await import('#surfaces/core/cli-beuser/index.js');
  const chunks: string[] = [], stdout = { write(value: string) { chunks.push(value); return true; } };
  for (const action of ['walk', 'report']) for (const language of ['en', 'tr'] as const) {
    await beuserCommand(['beuser', action, '--help', '--lang', language], { stdout });
    expect(chunks.at(-1)).toContain(`deckent beuser ${action}`);
  }
  expect(chunks[0]).not.toBe(chunks[1]);
  expect(() => parseBeuserArguments(['beuser', 'walk', '--journey', 'j'])).toThrow();
  expect(() => parseBeuserArguments(['beuser', 'walk', '--journey', 'j', '--candidate', '/candidate', '--principal', 'owner'])).toThrow();
  expect(() => parseBeuserArguments(['beuser', 'report', '--run', 'r', '--run', 'other'])).toThrow();
  await expect(beuserCommand(['beuser', 'walk', '--journey', 'j', '--candidate', '/candidate', '--scope', 'scope'], {})).rejects.toMatchObject({ code: 'EXECUTION_NOT_CONFIGURED' });
});
