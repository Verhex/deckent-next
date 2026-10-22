import { describe, expect, it } from 'vitest';
import { MESSAGE_REGISTRY } from '#platform/index.js';

// TUI2 L3 (T-HUMAN-OUTPUT): the Turkish term glossary (.deckent/docs/architecture/terminology-tr.md) holds in the terminal and monitor catalogs:
// Run = iş, Task = görev, worker = işçi. Approval and cancel cards belong to the window lane and are not part of this sweep.
describe('Turkish glossary in terminal and monitor catalogs', () => {
  const catalog = MESSAGE_REGISTRY.catalogs.tr;
  const swept = Object.entries(catalog).filter(([key]) => /^(terminal|monitor)\./u.test(key) && !/^terminal\.(approval|cancel)\./u.test(key));
  // Placeholders, slash-command tokens and identifier-like words (`/run`, `<runId>`, `{run}`, `inspectRun`, `r:run`, `config inspection.workers`) are not prose.
  const prose = (text: string) => text.replace(/\{[^}]*\}|<[^>]*>|`[^`]*`|\/[a-z-]+|\b\w+:\w+|\binspect\w+/gu, ' ');
  it('uses işçi, iş and görev instead of worker, Run and Koşu', () => {
    const offenders = swept.filter(([, text]) => /\b(worker|Run|Koşu)\b/iu.test(prose(text))).map(([key]) => key);
    expect(offenders).toEqual([]);
  });
  // CIKTI-OKUNUR-2: worker, transcript, monitor and inspect output use işçi and (canlılık) sinyali, never the raw English words.
  it('uses işçi and sinyal instead of worker and heartbeat in worker, transcript, monitor and inspect output', () => {
    const observed = Object.entries(catalog).filter(([key]) => /^(cli\.workers\.|cli\.task\.transcript\.|cli\.worker\.|monitor\.|inspect\.follow\.)/u.test(key)
      ? key !== 'cli.workers.help' : key === 'inspect.field.heartbeat');
    const offenders = observed.filter(([, text]) => /\b(worker|heartbeat)\b/iu.test(prose(text))).map(([key]) => key);
    expect(offenders).toEqual([]);
    expect(observed.length).toBeGreaterThan(500);
  });
  it('keeps the sweep non-trivial', () => { expect(swept.length).toBeGreaterThan(300); });
});
