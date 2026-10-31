import { expect, it, vi } from 'vitest';
import { beuserPersonaCoverage } from '#engine/index.js';
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
  // The token reservation basis is shown when recorded (owner 2026-10-31); an older report without it renders unchanged.
  const reserved = { ...value, reservation: { providerCount: 1, estimated: 2 } };
  expect(formatBeuserReport(reserved, { json: false, locale: 'en' })).toContain('1 counted by the provider, 2 estimated');
  expect(formatBeuserReport(reserved, { json: false, locale: 'tr' })).toContain('2 tahminle'); expect(human).not.toContain('tahminle');
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
  for (const action of ['setup', 'walk', 'report']) for (const language of ['en', 'tr'] as const) {
    await beuserCommand(['beuser', action, '--help', '--lang', language], { stdout });
    expect(chunks.at(-1)).toContain(`deckent beuser ${action}`);
  }
  expect(chunks[0]).not.toBe(chunks[1]);
  // Owner S9: --candidate is optional (default: this package's build); --journey stays required.
  expect(() => parseBeuserArguments(['beuser', 'walk', '--candidate', '/candidate'])).toThrow();
  expect(parseBeuserArguments(['beuser', 'walk', '--journey', 'j'])).toMatchObject({ journey: 'j', candidate: undefined, scope: undefined });
  expect(() => parseBeuserArguments(['beuser', 'walk', '--journey', 'j', '--candidate', '/candidate', '--principal', 'owner'])).toThrow();
  expect(() => parseBeuserArguments(['beuser', 'report', '--run', 'r', '--run', 'other'])).toThrow();
  await expect(beuserCommand(['beuser', 'walk', '--journey', 'j', '--candidate', '/candidate', '--scope', 'scope'], {})).rejects.toMatchObject({ code: 'EXECUTION_NOT_CONFIGURED' });
  const setup = vi.fn(), ttyOut = { ...stdout, isTTY: true };
  await expect(beuserCommand(['beuser', 'setup', '--profile', 'p', '--scope', 'scope'], {
    env: { CLAUDECODE: '1' }, stdin: { isTTY: true } as never, stdout: ttyOut, setupBeuser: setup,
  })).rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
  // The one-command walk (no --scope) shows the model choice and setup card: an AI-marked terminal is refused before any controller step.
  await expect(beuserCommand(['beuser', 'walk', '--journey', 'onboarding'], {
    env: { CLAUDECODE: '1' }, stdin: { isTTY: true } as never, stdout: ttyOut, setupBeuser: setup,
  })).rejects.toMatchObject({ code: 'AUTHORITY_WITNESS_REQUIRED' });
  expect(setup).not.toHaveBeenCalled();
});

it('reports a critical persona refused before its first screen as unknown, with the safe root reason in EN/TR and JSON', () => {
  const value = { ...report(), unknown: [{ branch: 'Ayse', reason: 'BEUSER_TARGET_NOT_SANDBOX' },
    { branch: 'Ayse', reason: 'BEUSER_CLEANUP_UNPROVEN' }],
    criticalCoverage: [beuserPersonaCoverage('Ayse', null)] };
  expect(value.criticalCoverage).toEqual([{ criterion: 'Ayse', walked: 0, valid: 0, invalid: 0, unknown: 1 }]);
  expect(JSON.parse(formatBeuserReport(value, { json: true, locale: 'tr' }))).toEqual(value);
  const tr = formatBeuserReport(value, { json: false, locale: 'tr' }), en = formatBeuserReport(value, { json: false, locale: 'en' });
  for (const output of [tr, en]) { expect(output).toContain('BEUSER_TARGET_NOT_SANDBOX'); expect(output).toContain('BEUSER_CLEANUP_UNPROVEN'); }
  expect(tr).toContain('hedefi reddetti'); expect(en).toContain('refused a target');
  expect(() => formatBeuserReport({ ...value, criticalCoverage: [{ criterion: 'Ayse', walked: 0, valid: 1, invalid: 0, unknown: 0 }] }, { json: true, locale: 'en' })).toThrow();
  expect(() => formatBeuserReport({ ...value, criticalCoverage: [{ criterion: 'Ayse', walked: 0, valid: 0, invalid: 0, unknown: 2 }] }, { json: true, locale: 'en' })).toThrow();
});


it('reports daemon-attested filesystem proof separately in EN/TR and locale-free JSON', () => {
  const value = { ...report(), cleanup: [{ branch: 'onboarding', state: 'destroyed', filesystemProof: { schemaVersion: 1, source: 'daemon-attested' } }] };
  expect(JSON.parse(formatBeuserReport(value, { json: true, locale: 'tr' }))).toEqual(value);
  const tr = formatBeuserReport(value, { json: false, locale: 'tr' }), en = formatBeuserReport(value, { json: false, locale: 'en' });
  expect(tr).toContain('daemon-attested'); expect(tr).toContain('bağımsız dosya sistemi kanıtı yok');
  expect(en).toContain('daemon-attested'); expect(en).toContain('no independent filesystem proof');
  expect(() => formatBeuserReport({ ...value, cleanup: [{ ...value.cleanup[0], filesystemProof: { schemaVersion: 1, source: 'rm-exit' } }] }, { json: true, locale: 'en' })).toThrow();
});
